const { app, BrowserWindow, Tray, Menu, nativeImage, desktopCapturer, screen, ipcMain, dialog, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const APP_NAME = 'ZhelongX / Mark';
const TOOLBAR_WIDTH = 60;
// The visible rack remains compact; the transparent host needs extra room
// only while the colour popover includes the Draw-style strength slider.
const TOOLBAR_HEIGHT = 400;
const COLLAPSED_HEIGHT = 58;
const PANEL_WIDTH = 276;
const CAPTURE_SETTLE_MS = 34;
const SETTINGS_SAVE_DELAY_MS = 280;
const SETTINGS_SYNC_DELAY_MS = 16;
const TOOLBAR_WINDOW_LEVEL = 'screen-saver';
const OVERLAY_WINDOW_LEVEL = 'floating';
const HANDLE_CIRCLE = { x: 30, y: 27, radius: 27 };
const INK_TOOLS = new Set(['pen', 'highlighter']);
let toolbarWindow;
let tray;
const overlays = new Map();
const waitingForOverlays = new Set();
let annotationActive = false;
let inputMode = 'paused'; // paused | drawing | screenshot
let screenshotReturnMode = 'paused';
let activeTool = 'pen';
let lastInkTool = 'pen';
let settingsSaveTimer;
let settingsSyncTimer;

const stateFile = () => path.join(app.getPath('userData'), 'zmark-settings.json');
const defaultState = { toolbar: { x: 36, y: 180 }, theme: 'light', toolbarVisibility: 'keep', hideDelay: 5, color: '#f04e4e', size: 4, strength: 50 };
let settings = { ...defaultState };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDrawing = () => annotationActive && inputMode === 'drawing';
const acceptsPointerInput = () => annotationActive && (inputMode === 'drawing' || inputMode === 'screenshot');

function loadSettings() {
  try { settings = { ...defaultState, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; }
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
  settings = { ...settings, ...patch };
  scheduleSettingsSave();
  scheduleSettingsSync();
}
function clampToolbarPosition(x, y, width = TOOLBAR_WIDTH) {
  const display = screen.getDisplayNearestPoint({ x, y });
  return {
    x: Math.round(Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - width))),
    y: Math.round(Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - COLLAPSED_HEIGHT)))
  };
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
  for (const overlay of overlays.values()) {
    if (!overlay.isDestroyed()) overlay.webContents.send('overlay:command', { command, ...detail });
  }
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
  for (const overlay of overlays.values()) {
    if (overlay.isDestroyed()) continue;
    if (!annotationActive) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.hide();
      continue;
    }
    overlay.setIgnoreMouseEvents(!acceptsPointerInput(), { forward: true });
    overlay.showInactive();
  }
  if (annotationActive) {
    toolbarWindow?.showInactive();
    toolbarWindow?.setIgnoreMouseEvents(false);
    toolbarWindow?.setOpacity(1);
    raiseToolbarAboveOverlay();
  }
  syncHandleCircle();
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
    syncHandleCircle();
  });
  toolbarWindow.on('close', (event) => { if (!app.isQuitting) { event.preventDefault(); toolbarWindow.hide(); } });
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
      displayId: id, displayBounds: display.bounds, theme: settings.theme, color: settings.color, size: settings.size, strength: settings.strength,
      tool: activeTool, drawing: acceptsPointerInput(), circle: handleCircle()
    });
  });
  overlay.on('closed', () => { overlays.delete(id); waitingForOverlays.delete(id); });
  overlays.set(id, overlay);
  waitingForOverlays.add(id);
}
function ensureOverlayPool() {
  for (const display of screen.getAllDisplays()) {
    if (!overlays.has(String(display.id))) createOverlay(display);
  }
}
function revealReadyOverlay(displayId) {
  waitingForOverlays.delete(String(displayId));
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
  annotationActive = true;
  inputMode = mode;
  ensureOverlayPool();
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
  sendOverlayCommand('reset');
  annotationActive = false;
  inputMode = 'paused';
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
}
function finishScreenshot() {
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
async function captureLiveDisplays() {
  const overlaysToRestore = [...overlays.values()].filter((overlay) => !overlay.isDestroyed() && overlay.isVisible());
  const toolbarVisible = toolbarWindow?.isVisible();
  for (const overlay of overlaysToRestore) overlay.hide();
  if (toolbarVisible) {
    toolbarWindow.setIgnoreMouseEvents(true, { forward: true });
    toolbarWindow.setOpacity(0);
  }
  await delay(CAPTURE_SETTLE_MS);
  try {
    const displays = screen.getAllDisplays();
    const width = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)));
    const height = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
    return new Map(displays.map((display, index) => [String(display.id), (sources.find((source) => source.display_id === String(display.id)) || sources[index])?.thumbnail.toDataURL()]));
  } finally {
    if (toolbarVisible) {
      toolbarWindow.setOpacity(1);
      toolbarWindow.setIgnoreMouseEvents(false);
    }
    syncOverlayInteractivity();
  }
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
  const display = screen.getDisplayNearestPoint({ x: payload.x, y: payload.y });
  overlays.get(String(display.id))?.webContents.send('overlay:proxy-pointer', payload);
}
function setupIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.on('settings:update', (_, patch) => updateSettings(patch));
  ipcMain.on('toolbar:move', (_, delta) => {
    const [x, y] = toolbarWindow.getPosition();
    const next = clampToolbarPosition(x + delta.dx, y + delta.dy, toolbarWindow.getBounds().width);
    toolbarWindow.setPosition(next.x, next.y);
    raiseToolbarAboveOverlay();
  });
  ipcMain.on('toolbar:layout', (_, expanded) => {
    toolbarWindow.setSize(TOOLBAR_WIDTH, expanded ? TOOLBAR_HEIGHT : COLLAPSED_HEIGHT);
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
  ipcMain.on('overlay:selection-request', async (_, payload) => {
    try {
      const sources = await captureLiveDisplays();
      overlays.get(payload.displayId)?.webContents.send('overlay:selection-source', { screenshot: sources.get(payload.displayId), bounds: payload.bounds });
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
  ensureOverlayPool();
  screen.on('display-added', ensureOverlayPool);
});
app.on('activate', showToolbar);
app.on('before-quit', flushSettingsSave);
app.on('window-all-closed', () => {});
