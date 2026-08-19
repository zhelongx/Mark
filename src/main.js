const { app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, screen, ipcMain, dialog, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

// Mark's annotation layer is a transparent native window.  Keep Chromium's
// normal GPU/compositor path enabled: Draw uses that same Electron 43 path,
// while forcing the software compositor can leave a transparent layered window
// visibly present but non-interactive on some Windows machines.

const APP_NAME = 'ZhelongX / Mark';
const TOOLBAR_WIDTH = 60;
const COLLAPSED_SIZE = 60;
// The visible rack remains compact; the transparent host needs extra room
// only while the colour popover includes both compact strength sliders.
const TOOLBAR_HEIGHT = 408;
const COLLAPSED_HEIGHT = COLLAPSED_SIZE;
const PANEL_WIDTH = 276;
const CAPTURE_SETTLE_MS = 34;
const SETTINGS_SAVE_DELAY_MS = 280;
const SETTINGS_SYNC_DELAY_MS = 16;
const TOOLBAR_WINDOW_LEVEL = 'screen-saver';
const OVERLAY_WINDOW_LEVEL = 'floating';
const HANDLE_CIRCLE = { x: 30, y: 30, radius: 27 };
const INK_TOOLS = new Set(['pen', 'highlighter']);
let toolbarWindow;
let tray;
const overlays = new Map();
const waitingForOverlays = new Set();
let activeDisplayId;
let annotationActive = false;
let inputMode = 'paused'; // paused | drawing | screenshot
let screenshotReturnMode = 'paused';
let activeTool = 'pen';
let lastInkTool = 'pen';
let settingsSaveTimer;
let settingsSyncTimer;
// A drag is anchored to the pointer rather than accumulated from window
// movement.  Accumulated deltas work on one monitor but can be clamped back
// to the old display at a seam, especially when the displays have different
// scale factors.
let toolbarDrag;
// A full desktop thumbnail is the expensive part of selection capture. Keep
// one short-lived, full-resolution snapshot while the user is drawing the
// selection rectangle so confirm never stalls on a second capture.
const screenshotPrewarms = new Map();
const INPUT_DIAGNOSTIC_LIMIT_BYTES = 96 * 1024;
let lastOverlayInputState = '';

const stateFile = () => path.join(app.getPath('userData'), 'zmark-settings.json');
const inputDiagnosticFile = () => path.join(app.getPath('userData'), 'zmark-input-diagnostic.log');
const defaultState = { toolbar: { x: 36, y: 180 }, theme: 'light', toolbarVisibility: 'keep', hideDelay: 5, color: '#f04e4e', size: 4, penStrength: 50, highlighterStrength: 50 };
let settings = { ...defaultState };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDrawing = () => annotationActive && inputMode === 'drawing';
const acceptsPointerInput = () => annotationActive && (inputMode === 'drawing' || inputMode === 'screenshot');

// Keep a small local, content-free trail of the native input hand-off.  This
// is intentionally not a visible error surface: the rack must stay quiet, but
// a failing machine can tell us whether a brush command, overlay activation,
// and first PointerEvent each actually arrived.
function recordInputDiagnostic(source, detail = {}) {
  const safe = {
    at: new Date().toISOString(), source: String(source || '').slice(0, 48),
    displayId: String(detail.displayId ?? '').slice(0, 32),
    mode: String(detail.mode ?? inputMode).slice(0, 20),
    tool: String(detail.tool ?? activeTool).slice(0, 20),
    drawing: Boolean(detail.drawing ?? isDrawing()),
    pointerType: String(detail.pointerType ?? '').slice(0, 20),
    phase: String(detail.phase ?? '').slice(0, 32),
    button: Number.isFinite(detail.button) ? detail.button : undefined,
    buttons: Number.isFinite(detail.buttons) ? detail.buttons : undefined,
    pressure: Number.isFinite(detail.pressure) ? Number(detail.pressure.toFixed(3)) : undefined,
    target: String(detail.target ?? '').slice(0, 24),
    route: String(detail.route ?? '').slice(0, 24),
    overlays: Number.isFinite(detail.overlays) ? detail.overlays : undefined
  };
  try {
    const file = inputDiagnosticFile();
    if (fs.existsSync(file) && fs.statSync(file).size > INPUT_DIAGNOSTIC_LIMIT_BYTES) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  } catch { /* Diagnostics must never affect drawing. */ }
}

function normalizedStrength(value, fallback = 50) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
}
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // Version 0.05 originally had one shared strength field. Preserve that
    // choice by seeding both independent brush controls from it on upgrade.
    const legacyStrength = normalizedStrength(saved.strength, defaultState.penStrength);
    settings = {
      ...defaultState,
      ...saved,
      penStrength: normalizedStrength(saved.penStrength, legacyStrength),
      highlighterStrength: normalizedStrength(saved.highlighterStrength, legacyStrength)
    };
  }
  catch { settings = { ...defaultState }; }
}
function saveSettings() { fs.writeFileSync(stateFile(), JSON.stringify(settings, null, 2)); }
function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = undefined;
    saveSettings();
  }, SETTINGS_SAVE_DELAY_MS);
}
function flushSettingsSave() {
  if (!settingsSaveTimer) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = undefined;
  saveSettings();
}
function scheduleSettingsSync() {
  if (settingsSyncTimer) return;
  settingsSyncTimer = setTimeout(() => {
    settingsSyncTimer = undefined;
    sendOverlayCommand('settings', settings);
  }, SETTINGS_SYNC_DELAY_MS);
}
function updateSettings(patch) {
  const compatiblePatch = { ...patch };
  if (Number.isFinite(compatiblePatch.strength)) {
    compatiblePatch.penStrength ??= compatiblePatch.strength;
    compatiblePatch.highlighterStrength ??= compatiblePatch.strength;
    delete compatiblePatch.strength;
  }
  settings = { ...settings, ...compatiblePatch };
  scheduleSettingsSave();
  scheduleSettingsSync();
}
function clampToolbarPositionInDisplay(x, y, display, width = TOOLBAR_WIDTH) {
  return {
    x: Math.round(Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - width))),
    y: Math.round(Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - COLLAPSED_HEIGHT)))
  };
}
function clampToolbarPosition(x, y, width = TOOLBAR_WIDTH) {
  return clampToolbarPositionInDisplay(x, y, screen.getDisplayNearestPoint({ x, y }), width);
}
function toolbarDisplay() {
  const circle = handleCircle();
  if (circle) return screen.getDisplayNearestPoint({ x: circle.x, y: circle.y });
  return screen.getDisplayNearestPoint({ x: settings.toolbar.x, y: settings.toolbar.y });
}
function activeOverlay() {
  const overlay = overlays.get(activeDisplayId);
  return overlay && !overlay.isDestroyed() ? overlay : undefined;
}
function selectToolbarDisplay() {
  const display = toolbarDisplay();
  const id = String(display.id);
  const changed = activeDisplayId !== id;
  activeDisplayId = id;
  const hasOverlay = overlays.has(id);
  if (!hasOverlay) createOverlay(display);
  // A previously visited monitor keeps its canvas in memory so its ink can
  // reappear if the carrot returns there. Refresh its transient brush state
  // before exposing it again; a newly created overlay receives the same
  // state in overlay:initialize once its document is ready.
  if (changed && hasOverlay && annotationActive) {
    sendOverlayCommand('settings', settings);
    sendOverlayCommand(activeTool);
    sendOverlayCommand(inputMode === 'paused' ? 'drawing:off' : 'drawing:on');
  }
  return changed;
}
function handleCircle() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return null;
  const [x, y] = toolbarWindow.getPosition();
  return { x: x + HANDLE_CIRCLE.x, y: y + HANDLE_CIRCLE.y, radius: HANDLE_CIRCLE.radius };
}
function sendToolbarState() {
  sendToolbarCommand('toolbar:annotation-state', { active: annotationActive, drawing: isDrawing(), mode: inputMode });
}
function sendToolbarCommand(channel, payload) {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarWindow.webContents.send(channel, payload);
}
function showToolbar() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarWindow.show();
  toolbarWindow.setOpacity(1);
  toolbarWindow.setIgnoreMouseEvents(false);
  raiseToolbarAboveOverlay();
}
function sendOverlayCommand(command, detail = {}) {
  activeOverlay()?.webContents.send('overlay:command', { command, ...detail });
}
function sendOverlayCommandToAll(command, detail = {}) {
  for (const overlay of overlays.values()) if (!overlay.isDestroyed()) overlay.webContents.send('overlay:command', { command, ...detail });
}
function syncHandleCircle() { sendOverlayCommand('handle:protected', { circle: handleCircle() }); }
function raiseToolbarAboveOverlay() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarWindow.setAlwaysOnTop(true, TOOLBAR_WINDOW_LEVEL);
  toolbarWindow.moveTop();
}
function syncOverlayInteractivity() {
  // A newly created display overlay may still be loading, but its native
  // window already exists.  Do not leave the whole screen click-through while
  // it reports readiness: on Windows that lets the user's first real stylus
  // or mouse stroke fall into the app underneath the annotation canvas.
  // The renderer still receives its initialization message independently.
  let inputOverlay;
  for (const [id, overlay] of overlays) {
    if (overlay.isDestroyed()) continue;
    // Mark owns exactly one display at a time: the display under the carrot.
    // Other monitors must remain visually and interactively untouched.
    if (!annotationActive || id !== activeDisplayId) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.hide();
      continue;
    }
    const acceptsInput = acceptsPointerInput();
    if (acceptsInput) {
      // Do not carry the click-through forwarding options into the active
      // state. Electron documents that forwarding is meaningful only while
      // ignore=true; using the explicit inverse transition keeps Windows'
      // native hit-test state deterministic for both mouse and pen.
      overlay.setIgnoreMouseEvents(false);
      overlay.setFocusable(true);
      overlay.show();
      inputOverlay = overlay;
    } else {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.showInactive();
    }
  }
  if (annotationActive) {
    toolbarWindow?.showInactive();
    toolbarWindow?.setIgnoreMouseEvents(false);
    toolbarWindow?.setOpacity(1);
    raiseToolbarAboveOverlay();
  }
  const inputState = `${annotationActive}:${inputMode}:${activeDisplayId || ''}:${inputOverlay ? 'ready' : 'none'}`;
  if (inputState !== lastOverlayInputState) {
    lastOverlayInputState = inputState;
    recordInputDiagnostic('main:overlay-sync', {
      displayId: activeDisplayId, mode: inputMode, overlays: overlays.size,
      route: inputOverlay ? 'input-enabled' : 'click-through',
      phase: inputOverlay ? `${inputOverlay.isVisible() ? 'visible' : 'hidden'}:${inputOverlay.isFocused() ? 'focused' : 'unfocused'}` : ''
    });
  }
  syncHandleCircle();
  // A transparent inactive BrowserWindow can visibly sit above the desktop
  // while still missing native pen packets on some Windows/DPI combinations.
  // Give the active drawing surface a real input activation after the toolbar
  // click completes, then immediately restore the rack to the higher window
  // level so every toolbar control remains clickable.
  if (inputOverlay) {
    setTimeout(() => {
      if (!acceptsPointerInput() || activeOverlay() !== inputOverlay || inputOverlay.isDestroyed()) return;
      inputOverlay.setIgnoreMouseEvents(false);
      inputOverlay.show();
      inputOverlay.moveTop();
      inputOverlay.focus();
      recordInputDiagnostic('main:overlay-focused', {
        displayId: activeDisplayId, mode: inputMode,
        phase: `${inputOverlay.isVisible() ? 'visible' : 'hidden'}:${inputOverlay.isFocused() ? 'focused' : 'unfocused'}`,
        route: 'native-input'
      });
      raiseToolbarAboveOverlay();
    }, 0);
  }
}
function createToolbar() {
  const position = clampToolbarPosition(settings.toolbar.x, settings.toolbar.y);
  toolbarWindow = new BrowserWindow({
    width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT, x: position.x, y: position.y,
    frame: false, transparent: true, backgroundColor: '#00000000', resizable: false,
    maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  toolbarWindow.setAlwaysOnTop(true, TOOLBAR_WINDOW_LEVEL);
  toolbarWindow.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'));
  toolbarWindow.on('moved', () => {
    const [x, y] = toolbarWindow.getPosition();
    settings.toolbar = { x, y };
    scheduleSettingsSave();
    selectToolbarDisplay();
    syncOverlayInteractivity();
    syncHandleCircle();
  });
  toolbarWindow.on('close', (event) => {
    toolbarDrag = undefined;
    if (!app.isQuitting) { event.preventDefault(); toolbarWindow.hide(); }
  });
}
function quitApplication() { app.isQuitting = true; app.quit(); }
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icons', 'carrot-purple.png')).resize({ width: 20, height: 20 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示工具架', click: showToolbar },
    { type: 'separator' }, { label: '退出', click: quitApplication }
  ]));
  tray.on('click', showToolbar);
}
function createOverlay(display) {
  const { x, y, width, height } = display.bounds;
  const id = String(display.id);
  const overlay = new BrowserWindow({
    x, y, width, height, show: false, frame: false, fullscreenable: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    skipTaskbar: true, focusable: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  overlay.setAlwaysOnTop(true, OVERLAY_WINDOW_LEVEL);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { displayId: id } });
  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('overlay:initialize', {
      displayId: id, displayBounds: display.bounds, theme: settings.theme, color: settings.color, size: settings.size,
      penStrength: settings.penStrength, highlighterStrength: settings.highlighterStrength,
      tool: activeTool, drawing: acceptsPointerInput(), circle: handleCircle()
    });
  });
  overlay.on('closed', () => { overlays.delete(id); waitingForOverlays.delete(id); });
  overlays.set(id, overlay);
  waitingForOverlays.add(id);
}
function revealReadyOverlay(displayId) {
  waitingForOverlays.delete(String(displayId));
  // `BrowserWindow` exists before its renderer starts listening.  A fast
  // first tap on a brush can otherwise send its state while the overlay is
  // still loading.  Replaying the authoritative state at the ready boundary
  // makes the first pen or mouse contact as reliable as every later one.
  const overlay = overlays.get(String(displayId));
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('overlay:command', { command: 'settings', ...settings });
    overlay.webContents.send('overlay:command', { command: activeTool });
    overlay.webContents.send('overlay:command', {
      command: acceptsPointerInput() && String(displayId) === activeDisplayId ? 'drawing:on' : 'drawing:off'
    });
    overlay.webContents.send('overlay:command', { command: 'handle:protected', circle: handleCircle() });
  }
  recordInputDiagnostic('main:overlay-ready', { displayId, mode: inputMode, overlays: overlays.size });
  syncOverlayInteractivity();
}
function setInputMode(mode) {
  inputMode = mode;
  if (mode === 'paused') sendOverlayCommand('drawing:off');
  else sendOverlayCommand('drawing:on');
  sendToolbarState();
  syncOverlayInteractivity();
}
function startSession(mode) {
  selectToolbarDisplay();
  annotationActive = true;
  inputMode = mode;
  recordInputDiagnostic('main:session-start', { displayId: activeDisplayId, mode, overlays: overlays.size });
  sendToolbarState();
  sendOverlayCommand('drawing:on');
  sendOverlayCommand(activeTool);
  syncOverlayInteractivity();
}
function pauseDrawing() {
  if (!annotationActive) return;
  if (inputMode === 'screenshot') return cancelScreenshot();
  if (inputMode === 'drawing') setInputMode('paused');
}
function closeAnnotationSession() {
  if (!annotationActive) return;
  // A session can have visited more than one monitor.  Its hidden canvases
  // must not leak old ink when a later session returns to that monitor.
  sendOverlayCommandToAll('reset');
  annotationActive = false;
  inputMode = 'paused';
  recordInputDiagnostic('main:session-close', { displayId: activeDisplayId, mode: inputMode, overlays: overlays.size });
  screenshotReturnMode = 'paused';
  sendToolbarState();
  syncOverlayInteractivity();
  showToolbar();
}
function activateBrush(tool, { enterDrawing = false } = {}) {
  if (INK_TOOLS.has(tool)) lastInkTool = tool;
  activeTool = tool;
  if (!annotationActive) {
    if (!enterDrawing) return;
    startSession('drawing');
  } else if (inputMode !== 'drawing' && enterDrawing) {
    setInputMode('drawing');
  }
  sendOverlayCommand(tool);
  sendToolbarCommand('toolbar:active-tool', tool);
}
function activateScreenshot() {
  screenshotReturnMode = annotationActive && inputMode === 'drawing' ? 'drawing' : 'paused';
  activeTool = 'screenshot';
  if (!annotationActive) startSession('screenshot');
  else setInputMode('screenshot');
  sendOverlayCommand('screenshot');
  sendToolbarCommand('toolbar:active-tool', 'screenshot');
  const displayId = activeDisplayId;
  setTimeout(() => {
    if (inputMode === 'screenshot' && activeDisplayId === displayId) prewarmScreenshot(displayId);
  }, 0);
}
function finishScreenshot() {
  screenshotPrewarms.clear();
  activeTool = 'pen';
  sendOverlayCommand('pen');
  sendToolbarCommand('toolbar:active-tool', 'pen');
  setInputMode(screenshotReturnMode);
  screenshotReturnMode = 'paused';
}
function cancelScreenshot() { finishScreenshot(); }
function adjustStrokeSize(delta) {
  if (!isDrawing()) return;
  const size = Math.max(1, Math.min(12, Number(settings.size) + delta));
  if (size === settings.size) return;
  updateSettings({ size });
  sendToolbarCommand('toolbar:size', size);
}
async function captureLiveDisplay(displayId) {
  const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
  if (!display) throw new Error('目标显示器已不可用');
  const overlay = overlays.get(String(displayId));
  const overlayWasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  const toolbarVisible = toolbarWindow?.isVisible();
  if (overlayWasVisible) overlay.hide();
  if (toolbarVisible) {
    toolbarWindow.setIgnoreMouseEvents(true, { forward: true });
    toolbarWindow.setOpacity(0);
  }
  await delay(CAPTURE_SETTLE_MS);
  try {
    const width = Math.round(display.bounds.width * display.scaleFactor);
    const height = Math.round(display.bounds.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source) throw new Error('无法读取目标显示器');
    return source.thumbnail.toDataURL();
  } finally {
    if (toolbarVisible) {
      toolbarWindow.setOpacity(1);
      toolbarWindow.setIgnoreMouseEvents(false);
    }
    syncOverlayInteractivity();
  }
}
function prewarmScreenshot(displayId) {
  const id = String(displayId);
  if (!id || screenshotPrewarms.has(id)) return screenshotPrewarms.get(id);
  const capture = captureLiveDisplay(id);
  screenshotPrewarms.set(id, capture);
  // Retain a fulfilled result only until the active selection uses it or
  // cancels.  Failures intentionally fall back to a normal capture later.
  capture.catch(() => {
    if (screenshotPrewarms.get(id) === capture) screenshotPrewarms.delete(id);
  });
  return capture;
}
function takePrewarmedScreenshot(displayId) {
  const id = String(displayId);
  const capture = screenshotPrewarms.get(id);
  screenshotPrewarms.delete(id);
  return capture || captureLiveDisplay(id);
}
async function saveScreenshot(dataUrl) {
  const { canceled, filePath } = await dialog.showSaveDialog(toolbarWindow, {
    title: '保存标注截图', defaultPath: path.join(app.getPath('pictures'), `ZhelongX-Mark-${new Date().toISOString().replace(/[:.]/g, '-')}.png`), filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return true;
}
function forwardToolbarPointer(payload) {
  if (!isDrawing() || !payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return;
  activeOverlay()?.webContents.send('overlay:proxy-pointer', payload);
}
function setupIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.on('settings:update', (_, patch) => updateSettings(patch));
  ipcMain.on('toolbar:drag-start', (_, payload) => {
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !payload || !Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return;
    const [x, y] = toolbarWindow.getPosition();
    toolbarDrag = {
      pointerId: payload.pointerId,
      offsetX: payload.screenX - x,
      offsetY: payload.screenY - y
    };
  });
  ipcMain.on('toolbar:move', (_, payload) => {
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarDrag || !payload || toolbarDrag.pointerId !== payload.pointerId) return;
    if (!Number.isFinite(payload.screenX) || !Number.isFinite(payload.screenY)) return;
    // Select the display from the live pointer, not the rack's previous
    // top-left corner. This lets the rack cross a monitor seam in one smooth
    // drag while still keeping the handle reachable inside the new work area.
    const display = screen.getDisplayNearestPoint({ x: payload.screenX, y: payload.screenY });
    const next = clampToolbarPositionInDisplay(
      payload.screenX - toolbarDrag.offsetX,
      payload.screenY - toolbarDrag.offsetY,
      display,
      toolbarWindow.getBounds().width
    );
    toolbarWindow.setPosition(next.x, next.y);
    raiseToolbarAboveOverlay();
  });
  ipcMain.on('toolbar:drag-end', (_, payload) => {
    if (!toolbarDrag || !payload || toolbarDrag.pointerId === payload.pointerId) toolbarDrag = undefined;
  });
  ipcMain.on('toolbar:layout', (_, expanded) => {
    const [x, y] = toolbarWindow.getPosition();
    toolbarWindow.setBounds({
      x, y,
      width: expanded ? TOOLBAR_WIDTH : COLLAPSED_SIZE,
      height: expanded ? TOOLBAR_HEIGHT : COLLAPSED_HEIGHT
    });
    syncHandleCircle();
  });
  ipcMain.on('toolbar:panel', (_, open) => {
    const width = open ? PANEL_WIDTH : TOOLBAR_WIDTH;
    const [x, y] = toolbarWindow.getPosition();
    const next = clampToolbarPosition(x, y, width);
    toolbarWindow.setBounds({ x: next.x, y: next.y, width, height: TOOLBAR_HEIGHT });
    syncHandleCircle();
  });
  ipcMain.on('toolbar:hide', () => toolbarWindow.hide());
  ipcMain.on('toolbar:end-session', closeAnnotationSession);
  ipcMain.on('toolbar:ink-tool', (_, { tool, enterDrawing }) => {
    if (!INK_TOOLS.has(tool)) return;
    recordInputDiagnostic('main:toolbar-ink-tool', { tool, phase: enterDrawing ? 'enter' : 'select', overlays: overlays.size });
    activateBrush(tool, { enterDrawing: Boolean(enterDrawing) });
  });
  ipcMain.on('toolbar:command', (_, command) => {
    if (command === 'quit') return quitApplication();
    if (command === 'exit') return pauseDrawing();
    if (command === 'eraser') {
      return activateBrush('eraser', { enterDrawing: true });
    }
    if (command === 'screenshot') return activateScreenshot();
    if (command === 'clear') return sendOverlayCommand('clear');
    sendOverlayCommand(command);
  });
  ipcMain.on('toolbar:pointer', (_, payload) => forwardToolbarPointer(payload));
  ipcMain.on('annotation:shortcut', (_, shortcut) => {
    if (shortcut === 'escape') return pauseDrawing();
    if (!isDrawing()) return;
    if (shortcut === 'undo') return sendOverlayCommand('undo');
    if (shortcut === 'redo') return sendOverlayCommand('redo');
    if (shortcut === 'clear') return sendOverlayCommand('clear');
    if (shortcut === 'pen') return activateBrush('pen', { enterDrawing: true });
    if (shortcut === 'highlighter') return activateBrush('highlighter', { enterDrawing: true });
    if (shortcut === 'toggle-eraser') return activateBrush(activeTool === 'eraser' ? lastInkTool : 'eraser');
    if (shortcut === 'screenshot') return activateScreenshot();
    if (shortcut === 'palette') return sendToolbarCommand('toolbar:open-panel', 'colors');
    if (shortcut === 'settings') return sendToolbarCommand('toolbar:open-panel', 'settings');
    if (shortcut === 'size-down') return adjustStrokeSize(-1);
    if (shortcut === 'size-up') return adjustStrokeSize(1);
  });
  ipcMain.on('overlay:ready', (_, displayId) => revealReadyOverlay(displayId));
  ipcMain.on('overlay:diagnostic', (_, payload) => {
    if (!payload || typeof payload !== 'object') return;
    recordInputDiagnostic(`overlay:${payload.kind || 'event'}`, payload);
  });
  ipcMain.on('overlay:selection-request', async (_, payload) => {
    try {
      if (String(payload.displayId) !== activeDisplayId) throw new Error('目标显示器不是当前标注屏幕');
      const screenshot = await takePrewarmedScreenshot(payload.displayId);
      activeOverlay()?.webContents.send('overlay:selection-source', { screenshot, bounds: payload.bounds });
    } catch (error) { sendToolbarCommand('toolbar:error', `无法截图：${error.message}`); }
  });
  ipcMain.handle('overlay:screenshot-action', async (_, payload) => {
    const { action, dataUrl } = payload || {};
    if (!['clipboard', 'cancel', 'save'].includes(action)) return { completed: false };
    if (action === 'clipboard' && dataUrl) clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    if (action === 'save') {
      if (!dataUrl || !(await saveScreenshot(dataUrl))) return { completed: false };
    }
    finishScreenshot();
    if (action === 'clipboard') sendToolbarCommand('toolbar:toast', '选区已复制到剪贴板');
    if (action === 'save') sendToolbarCommand('toolbar:toast', '截图已保存为 PNG');
    return { completed: true };
  });
}
app.whenReady().then(() => {
  loadSettings();
  createToolbar();
  createTray();
  setupIpc();
  selectToolbarDisplay();
  screen.on('display-added', () => selectToolbarDisplay());
  screen.on('display-removed', () => {
    if (!screen.getAllDisplays().some((display) => String(display.id) === activeDisplayId)) selectToolbarDisplay();
    syncOverlayInteractivity();
  });
});
app.on('activate', showToolbar);
app.on('before-quit', flushSettingsSave);
app.on('window-all-closed', () => {});
