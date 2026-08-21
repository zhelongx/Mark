const { app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, screen, ipcMain, dialog, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

// Mark's annotation layer is a transparent native window.  Keep Chromium's
// normal GPU/compositor path enabled: Draw uses that same Electron 43 path,
// while forcing the software compositor can leave a transparent layered window
// visibly present but non-interactive on some Windows machines.

const APP_NAME = 'ZhelongX / Mark';
app.setAppUserModelId('com.zhelongx.mark');
const TOOLBAR_WIDTH = 60;
const COLLAPSED_SIZE = 60;
// The visible rack remains compact; the transparent host needs extra room
// only while the colour popover includes both compact strength sliders.
const TOOLBAR_HEIGHT = 448;
const COLLAPSED_HEIGHT = COLLAPSED_SIZE;
const PANEL_WIDTH = 276;
// The normal rack is deliberately denser than the original 60 px layout.
// Compact mode remains its established 70% original geometry; popovers stay
// readable at their own measured size in both modes.
const NORMAL_TOOLBAR_SCALE = 0.8;
const COMPACT_TOOLBAR_SCALE = 0.7;
const CAPTURE_CONCEAL_TIMEOUT_MS = 96;
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
let screenshotReviewActive = false;
let activeTool = 'pen';
let lastInkTool = 'pen';
let openPanelMetrics;
// When a rack popover is open, the active-display overlay becomes a
// transparent one-click dismissal surface. This is intentionally separate
// from annotation input: opening a palette must never change drawing mode.
let panelDismissActive = false;
let panelDismissGeneration = 0;
let panelDismissReleasePending = 0;
let settingsSaveTimer;
let settingsSyncTimer;
// A drag is anchored to the pointer rather than accumulated from window
// movement.  Accumulated deltas work on one monitor but can be clamped back
// to the old display at a seam, especially when the displays have different
// scale factors.
let toolbarDrag;
const INPUT_DIAGNOSTIC_LIMIT_BYTES = 96 * 1024;
let lastOverlayInputState = '';
const captureConcealWaiters = new Map();
let handleCircleSyncTimer;

const stateFile = () => path.join(app.getPath('userData'), 'zmark-settings.json');
const inputDiagnosticFile = () => path.join(app.getPath('userData'), 'zmark-input-diagnostic.log');
const defaultState = { toolbar: { x: 36, y: 180 }, theme: 'light', uiStyle: 'material', compactMode: false, boardEnabled: false, boardMode: 'white', toolbarVisibility: 'keep', hideDelay: 5, color: '#f04e4e', size: 4, penStrength: 50, highlighterStrength: 50 };
let settings = { ...defaultState };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDrawing = () => annotationActive && inputMode === 'drawing';
const acceptsPointerInput = () => annotationActive && (inputMode === 'drawing' || inputMode === 'screenshot');
const toolbarScale = () => settings.compactMode ? COMPACT_TOOLBAR_SCALE : NORMAL_TOOLBAR_SCALE;
const toolbarWidth = () => Math.round(TOOLBAR_WIDTH * toolbarScale());
const toolbarHeight = () => Math.round(TOOLBAR_HEIGHT * toolbarScale());
const collapsedToolbarSize = () => Math.round(COLLAPSED_SIZE * toolbarScale());
const panelToolbarWidth = () => PANEL_WIDTH - TOOLBAR_WIDTH + toolbarWidth();
const panelToolbarHeight = () => toolbarHeight();
function panelHostSize(metrics = openPanelMetrics) {
  const width = Number(metrics?.width);
  const height = Number(metrics?.height);
  return {
    // The renderer measures its actual visible panel, including pop-out close
    // beads and open option lists.  The constants are only a startup fallback
    // while a renderer has not reported yet; they are never a content cap.
    width: Math.max(toolbarWidth(), Number.isFinite(width) && width > 0 ? Math.ceil(width) : panelToolbarWidth()),
    height: Math.max(toolbarHeight(), Number.isFinite(height) && height > 0 ? Math.ceil(height) : panelToolbarHeight())
  };
}

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
      uiStyle: saved.uiStyle === 'flat' ? 'flat' : 'material',
      compactMode: Boolean(saved.compactMode),
      boardEnabled: Boolean(saved.boardEnabled),
      boardMode: saved.boardMode === 'black' ? 'black' : 'white',
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
  if (compatiblePatch.uiStyle !== undefined) compatiblePatch.uiStyle = compatiblePatch.uiStyle === 'flat' ? 'flat' : 'material';
  if (compatiblePatch.compactMode !== undefined) compatiblePatch.compactMode = Boolean(compatiblePatch.compactMode);
  if (compatiblePatch.boardEnabled !== undefined) compatiblePatch.boardEnabled = Boolean(compatiblePatch.boardEnabled);
  if (compatiblePatch.boardMode !== undefined) compatiblePatch.boardMode = compatiblePatch.boardMode === 'black' ? 'black' : 'white';
  settings = { ...settings, ...compatiblePatch };
  scheduleSettingsSave();
  scheduleSettingsSync();
  if (Object.prototype.hasOwnProperty.call(compatiblePatch, 'uiStyle')) sendToolbarCommand('toolbar:ui-style', settings.uiStyle);
  if (Object.prototype.hasOwnProperty.call(compatiblePatch, 'compactMode')) {
    sendToolbarCommand('toolbar:compact-mode', settings.compactMode);
    resizeToolbarForScale();
  }
  if (Object.prototype.hasOwnProperty.call(compatiblePatch, 'boardEnabled') || Object.prototype.hasOwnProperty.call(compatiblePatch, 'boardMode')) {
    sendToolbarCommand('toolbar:board-settings', { enabled: settings.boardEnabled, mode: settings.boardMode });
    // Enabling a board is an explicit request for an editable full-screen
    // surface. It owns only the monitor under the carrot, just like ink.
    if (settings.boardEnabled && !annotationActive) startSession('drawing');
    else if (settings.boardEnabled && inputMode === 'paused') setInputMode('drawing');
  }
}
function clampToolbarPositionInDisplay(x, y, display, width = toolbarWidth(), height = collapsedToolbarSize()) {
  const visibleHeight = Math.min(Math.max(1, height), display.workArea.height);
  return {
    x: Math.round(Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - width))),
    y: Math.round(Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - visibleHeight)))
  };
}
function clampToolbarPosition(x, y, width = toolbarWidth(), height = collapsedToolbarSize()) {
  return clampToolbarPositionInDisplay(x, y, screen.getDisplayNearestPoint({ x, y }), width, height);
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
function discardInactiveOverlays(activeId) {
  // Mark is deliberately a single-monitor tool: the carrot decides which
  // display owns the one live annotation surface.  Keeping hidden canvases on
  // previously visited monitors makes their state leak back through focus and
  // capture transitions on mixed-DPI Windows desktops.
  for (const [id, overlay] of overlays) {
    if (id === activeId || overlay.isDestroyed()) continue;
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.hide();
    overlays.delete(id);
    waitingForOverlays.delete(id);
    overlay.destroy();
  }
}
function selectToolbarDisplay() {
  const display = toolbarDisplay();
  const id = String(display.id);
  const changed = activeDisplayId !== id;
  activeDisplayId = id;
  discardInactiveOverlays(id);
  const existingOverlay = overlays.get(id);
  const hasOverlay = Boolean(existingOverlay && !existingOverlay.isDestroyed());
  if (!hasOverlay && existingOverlay) overlays.delete(id);
  if (!hasOverlay) createOverlay(display);
  else {
    // Display metrics can change independently of a toolbar drag (for
    // example when a docking station negotiates a different DPI).  Keep the
    // sole live surface exactly on the display that owns the carrot.
    overlays.get(id)?.setBounds(display.bounds);
  }
  // The only live overlay stays aligned with the carrot display.  Refresh its
  // transient brush state after a monitor transition; a newly created surface
  // receives the same state through overlay:initialize once it is ready.
  if (changed && hasOverlay && (annotationActive || panelDismissActive)) {
    if (annotationActive) {
      sendOverlayCommand('settings', settings);
      sendOverlayCommand(activeTool);
      sendOverlayCommand(inputMode === 'paused' ? 'drawing:off' : 'drawing:on');
    }
    sendOverlayCommand('panel:dismiss', { active: panelDismissActive, generation: panelDismissGeneration });
  }
  return changed;
}
function handleCircle() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return null;
  const [x, y] = toolbarWindow.getPosition();
  const scale = toolbarScale();
  return {
    x: x + Math.round(HANDLE_CIRCLE.x * scale),
    y: y + Math.round(HANDLE_CIRCLE.y * scale),
    radius: Math.round(HANDLE_CIRCLE.radius * scale)
  };
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
function sendPanelDismissCommand() {
  sendOverlayCommand('panel:dismiss', { active: panelDismissActive, generation: panelDismissGeneration });
}
function setPanelDismissActive(active, { waitForRenderer = true } = {}) {
  const next = Boolean(active);
  if (panelDismissActive === next) return;
  panelDismissActive = next;
  panelDismissGeneration += 1;
  // Do not make the drawing surface interactive again until its renderer has
  // actually cleared the one-click cancellation flag. Without this small
  // acknowledgement, a very fast first pen contact can arrive between the
  // main-process message and the renderer update and be mistaken for Cancel.
  panelDismissReleasePending = next || !waitForRenderer ? 0 : panelDismissGeneration;
  sendPanelDismissCommand();
  syncOverlayInteractivity();
}
function dismissOpenToolbarPanelForTool() {
  if (!panelDismissActive) return;
  setPanelDismissActive(false);
  // Keyboard and mouse tool activation share this path. The renderer-side
  // close makes the visual animation start in the same interaction, while the
  // acknowledgement above protects the next physical ink packet.
  sendToolbarCommand('toolbar:close-panels', { immediate: true });
}
function syncHandleCircle() {
  const send = () => sendOverlayCommand('handle:protected', { circle: handleCircle() });
  // A pen can emit many more move samples than the native toolbar can present.
  // Coalesce only the transient protected-circle updates during a drag; the
  // final position is still sent synchronously when the pointer is released.
  if (toolbarDrag) {
    if (handleCircleSyncTimer) return;
    handleCircleSyncTimer = setTimeout(() => {
      handleCircleSyncTimer = undefined;
      send();
    }, 24);
    return;
  }
  if (handleCircleSyncTimer) {
    clearTimeout(handleCircleSyncTimer);
    handleCircleSyncTimer = undefined;
  }
  send();
}
function raiseToolbarAboveOverlay() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarWindow.setAlwaysOnTop(true, TOOLBAR_WINDOW_LEVEL);
  toolbarWindow.moveTop();
}
function resizeToolbarForScale() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  const bounds = toolbarWindow.getBounds();
  // A collapsed rack is always at most 60px high; every expanded form is far
  // taller.  This keeps its current open/panel state while changing scale.
  const collapsed = bounds.height <= COLLAPSED_HEIGHT + 2;
  const panelOpen = bounds.width > TOOLBAR_WIDTH + 20;
  const panelSize = panelHostSize();
  const width = panelOpen ? panelSize.width : toolbarWidth();
  const height = collapsed ? collapsedToolbarSize() : panelOpen ? panelSize.height : toolbarHeight();
  const next = clampToolbarPosition(bounds.x, bounds.y, width, height);
  toolbarWindow.setBounds({ x: next.x, y: next.y, width, height });
  syncHandleCircle();
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
    const dismissesOpenPanel = panelDismissActive && id === activeDisplayId;
    const waitsForPanelDismissal = !panelDismissActive && panelDismissReleasePending && id === activeDisplayId;
    if ((!annotationActive && !dismissesOpenPanel) || id !== activeDisplayId) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.hide();
      continue;
    }
    if (dismissesOpenPanel) {
      // A palette/settings pane belongs to the whole active display, not just
      // the small native toolbar host.  The first click anywhere outside that
      // host is consumed here and closes the pane without drawing beneath it.
      overlay.setIgnoreMouseEvents(false);
      // On Windows, an inactive transparent window can remain visible yet
      // fail native hit-testing. Use the same real show/focus hand-off as
      // drawing, then immediately raise the rack above it below.
      overlay.setFocusable(true);
      overlay.show();
      overlay.moveTop();
      overlay.focus();
      continue;
    }
    if (waitsForPanelDismissal) {
      // A release acknowledgement normally arrives in the same event turn.
      // Until it does, do not feed a stale renderer cancellation flag a pen
      // packet. The next sync after its acknowledgement enables drawing.
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.showInactive();
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
  if (annotationActive || panelDismissActive) {
    toolbarWindow?.showInactive();
    toolbarWindow?.setIgnoreMouseEvents(false);
    toolbarWindow?.setOpacity(1);
    raiseToolbarAboveOverlay();
  }
  const inputState = `${annotationActive}:${inputMode}:${panelDismissActive}:${panelDismissReleasePending}:${activeDisplayId || ''}:${inputOverlay ? 'ready' : 'none'}`;
  if (inputState !== lastOverlayInputState) {
    lastOverlayInputState = inputState;
    recordInputDiagnostic('main:overlay-sync', {
      displayId: activeDisplayId, mode: inputMode, overlays: overlays.size,
      route: inputOverlay ? 'input-enabled' : panelDismissActive ? 'panel-dismiss' : panelDismissReleasePending ? 'panel-sync' : 'click-through',
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
    width: toolbarWidth(), height: toolbarHeight(), x: position.x, y: position.y,
    frame: false, transparent: true, backgroundColor: '#00000000', resizable: false,
    maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'icons', 'carrot-purple.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  toolbarWindow.setAlwaysOnTop(true, TOOLBAR_WINDOW_LEVEL);
  toolbarWindow.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'));
  toolbarWindow.on('moved', () => {
    const [x, y] = toolbarWindow.getPosition();
    settings.toolbar = { x, y };
    scheduleSettingsSave();
    // Native pen screen coordinates can be in a different unit from window
    // bounds on mixed-DPI desktops.  While the carrot is actively dragged,
    // defer the monitor hand-off until release so the overlay cannot bounce
    // between displays and flash under the stylus.
    if (!toolbarDrag) {
      selectToolbarDisplay();
      syncOverlayInteractivity();
    }
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
    icon: path.join(__dirname, '..', 'assets', 'icons', 'carrot-purple.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  overlay.setAlwaysOnTop(true, OVERLAY_WINDOW_LEVEL);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { displayId: id } });
  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('overlay:initialize', {
      displayId: id, displayBounds: display.bounds, theme: settings.theme, boardEnabled: settings.boardEnabled, boardMode: settings.boardMode, color: settings.color, size: settings.size,
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
    overlay.webContents.send('overlay:command', { command: 'panel:dismiss', active: panelDismissActive && String(displayId) === activeDisplayId, generation: panelDismissGeneration });
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
  screenshotReviewActive = false;
  sendToolbarState();
  syncOverlayInteractivity();
  showToolbar();
}
function activateBrush(tool, { enterDrawing = false } = {}) {
  dismissOpenToolbarPanelForTool();
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
  // Clicking a native toolbar temporarily gives that small window focus.
  // On some mixed-display Windows setups Chromium then stops presenting the
  // transparent full-screen canvas until the next mode transition.  A brush
  // change is itself a mode-preserving transition, so explicitly hand focus
  // and z-order back to the active overlay every time.
  syncOverlayInteractivity();
}
function activateScreenshot() {
  dismissOpenToolbarPanelForTool();
  // A frozen screenshot can switch between its camera/move state and local
  // brushes. Preserve the mode that existed before the screenshot began;
  // returning to the camera must not redefine the eventual return target.
  if (!screenshotReviewActive) screenshotReturnMode = annotationActive && inputMode === 'drawing' ? 'drawing' : 'paused';
  screenshotReviewActive = true;
  activeTool = 'screenshot';
  if (!annotationActive) startSession('screenshot');
  else setInputMode('screenshot');
  sendOverlayCommand('screenshot');
  sendToolbarCommand('toolbar:active-tool', 'screenshot');
}
function activateText() {
  dismissOpenToolbarPanelForTool();
  activeTool = 'text';
  if (!annotationActive) startSession('drawing');
  else if (inputMode !== 'drawing') setInputMode('drawing');
  sendOverlayCommand('text');
  sendToolbarCommand('toolbar:active-tool', 'text');
  // Like brushes, direct DOM text entry needs the overlay to regain focus
  // immediately after its compact native toolbar button was clicked.
  syncOverlayInteractivity();
}
function finishScreenshot() {
  activeTool = 'pen';
  sendOverlayCommand('pen');
  sendToolbarCommand('toolbar:active-tool', 'pen');
  setInputMode(screenshotReturnMode);
  screenshotReturnMode = 'paused';
  screenshotReviewActive = false;
}
function cancelScreenshot() { finishScreenshot(); }
function adjustStrokeSize(delta) {
  if (!isDrawing()) return;
  const size = Math.max(1, Math.min(12, Number(settings.size) + delta));
  if (size === settings.size) return;
  updateSettings({ size });
  sendToolbarCommand('toolbar:size', size);
}
function awaitOverlayConcealed(displayId) {
  const id = String(displayId);
  return new Promise((resolve) => {
    let finish;
    const timeout = setTimeout(() => {
      if (captureConcealWaiters.get(id) === finish) captureConcealWaiters.delete(id);
      resolve(false);
    }, CAPTURE_CONCEAL_TIMEOUT_MS);
    finish = () => {
      clearTimeout(timeout);
      if (captureConcealWaiters.get(id) === finish) captureConcealWaiters.delete(id);
      resolve(true);
    };
    captureConcealWaiters.set(id, finish);
  });
}
async function concealOverlayForCapture(overlay, displayId) {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return false;
  const concealed = awaitOverlayConcealed(displayId);
  overlay.webContents.send('overlay:command', { command: 'capture:conceal' });
  await concealed;
  return true;
}
function cropDisplayCapture(image, display, bounds) {
  if (!bounds) return image.toDataURL();
  const sourceSize = image.getSize();
  const scaleX = sourceSize.width / Math.max(1, display.bounds.width);
  const scaleY = sourceSize.height / Math.max(1, display.bounds.height);
  const left = Math.max(0, Math.min(sourceSize.width - 1, Math.floor(bounds.left * scaleX)));
  const top = Math.max(0, Math.min(sourceSize.height - 1, Math.floor(bounds.top * scaleY)));
  const width = Math.max(1, Math.min(sourceSize.width - left, Math.ceil(bounds.width * scaleX)));
  const height = Math.max(1, Math.min(sourceSize.height - top, Math.ceil(bounds.height * scaleY)));
  // Sending a full monitor PNG through IPC and cropping it a second time in
  // Chromium was the long pause after mouse-up. Crop the native bitmap before
  // PNG/base64 encoding so the renderer receives only the requested pixels.
  return image.crop({ x: left, y: top, width, height }).toDataURL();
}
async function captureLiveDisplay(displayId, bounds) {
  const display = screen.getAllDisplays().find((item) => String(item.id) === String(displayId));
  if (!display) throw new Error('目标显示器已不可用');
  const overlay = overlays.get(String(displayId));
  const overlayWasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  // The rack remains exactly where the user placed it throughout selection
  // and capture.  It is an intentional part of the live desktop rather than
  // an obstacle that screenshots should evade or briefly blink away from.
  const overlayConcealed = await concealOverlayForCapture(overlayWasVisible ? overlay : undefined, displayId);
  // Two renderer frames in `concealOverlayForCapture` already guarantee a
  // painted transparent overlay. Adding a third fixed frame here created a
  // visible pause without making the capture cleaner.
  try {
    const width = Math.round(display.bounds.width * display.scaleFactor);
    const height = Math.round(display.bounds.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source) throw new Error('无法读取目标显示器');
    return cropDisplayCapture(source.thumbnail, display, bounds);
  } finally {
    if (overlayConcealed && overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:command', { command: 'capture:restore' });
    syncOverlayInteractivity();
  }
}
async function saveScreenshot(dataUrl) {
  const { canceled, filePath } = await dialog.showSaveDialog(toolbarWindow, {
    title: '保存标注截图', defaultPath: path.join(app.getPath('pictures'), `ZhelongX-Mark-${new Date().toISOString().replace(/[:.]/g, '-')}.png`), filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (canceled || !filePath) return false;
  // Encoding is already complete when this handler is reached.  Keep the
  // potentially large disk write off the main-process event turn so the rack
  // and active overlay remain responsive while a screenshot is saved.
  await fs.promises.writeFile(filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
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
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !payload || !Number.isFinite(payload.clientX) || !Number.isFinite(payload.clientY)) return;
    toolbarDrag = {
      pointerId: payload.pointerId,
      offsetX: payload.clientX,
      offsetY: payload.clientY
    };
  });
  ipcMain.on('toolbar:move', (_, payload) => {
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarDrag || !payload || toolbarDrag.pointerId !== payload.pointerId) return;
    if (!Number.isFinite(payload.clientX) || !Number.isFinite(payload.clientY)) return;
    // Renderer pointer screen coordinates are unreliable for pen input when
    // Windows displays use different scale factors.  Reconstruct the pointer
    // from the toolbar's own CSS coordinate space and its native bounds;
    // those values share Electron's DIP coordinate system.
    const [windowX, windowY] = toolbarWindow.getPosition();
    const pointer = { x: windowX + payload.clientX, y: windowY + payload.clientY };
    const display = screen.getDisplayNearestPoint(pointer);
    const next = clampToolbarPositionInDisplay(
      pointer.x - toolbarDrag.offsetX,
      pointer.y - toolbarDrag.offsetY,
      display,
      toolbarWindow.getBounds().width,
      toolbarWindow.getBounds().height
    );
    toolbarWindow.setPosition(next.x, next.y);
    // The rack is already at the screen-saver window level. Calling moveTop
    // for every tablet packet forces Windows to restack native surfaces and
    // is the source of the visible jump/flicker during a carrot drag.
  });
  ipcMain.on('toolbar:drag-end', (_, payload) => {
    if (toolbarDrag && payload && toolbarDrag.pointerId !== payload.pointerId) return;
    toolbarDrag = undefined;
    // Commit one deterministic display hand-off after the pen/mouse release.
    selectToolbarDisplay();
    syncOverlayInteractivity();
    syncHandleCircle();
  });
  ipcMain.on('toolbar:layout', (_, expanded) => {
    const [x, y] = toolbarWindow.getPosition();
    const width = expanded ? toolbarWidth() : collapsedToolbarSize();
    const height = expanded ? toolbarHeight() : collapsedToolbarSize();
    const next = clampToolbarPosition(x, y, width, height);
    toolbarWindow.setBounds({
      x: next.x, y: next.y, width, height
    });
    syncHandleCircle();
  });
  ipcMain.on('toolbar:panel', (_, payload) => {
    const open = typeof payload === 'boolean' ? payload : Boolean(payload?.open);
    openPanelMetrics = open && payload && typeof payload === 'object' ? payload : undefined;
    const panelSize = panelHostSize();
    const width = open ? panelSize.width : toolbarWidth();
    const height = open ? panelSize.height : toolbarHeight();
    const [x, y] = toolbarWindow.getPosition();
    const next = clampToolbarPosition(x, y, width, height);
    toolbarWindow.setBounds({ x: next.x, y: next.y, width, height });
    setPanelDismissActive(open);
    syncHandleCircle();
  });
  ipcMain.on('overlay:dismiss-toolbar-panel', (_, payload) => {
    if (!panelDismissActive) return;
    // A live brush gesture clears its flag inside the overlay before sending
    // this message, so it can keep its very first contact and draw through
    // the panel dismissal. Neutral/text clicks still wait for the renderer
    // acknowledgement and remain pure Cancel.
    setPanelDismissActive(false, { waitForRenderer: !Boolean(payload?.continueDrawing) });
    // The overlay captured a click outside the rack host. Close its owned
    // panel synchronously so this one click behaves exactly like Cancel.
    sendToolbarCommand('toolbar:close-panels', { immediate: true });
  });
  ipcMain.on('overlay:panel-dismiss-synced', (_, payload) => {
    const generation = Number(payload?.generation);
    if (String(payload?.displayId) !== activeDisplayId || generation !== panelDismissGeneration || Boolean(payload?.active) !== panelDismissActive) return;
    if (!panelDismissActive && panelDismissReleasePending === generation) {
      panelDismissReleasePending = 0;
      syncOverlayInteractivity();
    }
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
    if (command === 'text') return activateText();
    if (command === 'screenshot') return activateScreenshot();
    if (command === 'clear') {
      dismissOpenToolbarPanelForTool();
      sendOverlayCommand('clear');
      // Clear is destructive only to ink, never to the current drawing mode.
      // Return native focus after the toolbar click so a pen can immediately
      // continue drawing without a second brush selection.
      if (annotationActive) setTimeout(syncOverlayInteractivity, 0);
      return;
    }
    sendOverlayCommand(command);
  });
  ipcMain.on('toolbar:restore-drawing-surface', () => {
    // Opening/using a palette or settings popover must never be a drawing-mode
    // transition. It can only hand native focus back to the already-active
    // overlay after the toolbar consumed the click.
    if (annotationActive) syncOverlayInteractivity();
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
    if (shortcut === 'text') return activateText();
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
  ipcMain.on('overlay:capture-concealed', (_, displayId) => {
    captureConcealWaiters.get(String(displayId))?.();
  });
  ipcMain.on('overlay:selection-request', async (_, payload) => {
    try {
      if (String(payload.displayId) !== activeDisplayId) throw new Error('目标显示器不是当前标注屏幕');
      // Entering selection remains completely idle. Only after the user
      // completes the rectangle do we acquire the display, while the renderer
      // supplies the brief screenshot flash/freeze transition.
      const boardMode = settings.boardEnabled ? settings.boardMode : '';
      const screenshot = boardMode ? '' : await captureLiveDisplay(payload.displayId, payload.bounds);
      activeOverlay()?.webContents.send('overlay:selection-source', { screenshot, bounds: payload.bounds, sourceIsSelection: true, sourceIncludesInk: false, boardMode });
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
  if (settings.boardEnabled) startSession('drawing');
  screen.on('display-added', () => selectToolbarDisplay());
  screen.on('display-removed', () => {
    if (!screen.getAllDisplays().some((display) => String(display.id) === activeDisplayId)) selectToolbarDisplay();
    syncOverlayInteractivity();
  });
  screen.on('display-metrics-changed', () => {
    selectToolbarDisplay();
    syncOverlayInteractivity();
  });
});
app.on('activate', showToolbar);
app.on('before-quit', flushSettingsSave);
app.on('window-all-closed', () => {});
