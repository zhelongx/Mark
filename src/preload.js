const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zmark', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.send('settings:update', patch),
  beginToolbarDrag: (pointer) => ipcRenderer.send('toolbar:drag-start', pointer),
  moveToolbar: (pointer) => ipcRenderer.send('toolbar:move', pointer),
  endToolbarDrag: (pointer) => ipcRenderer.send('toolbar:drag-end', pointer),
  layoutToolbar: (expanded) => ipcRenderer.send('toolbar:layout', expanded),
  panelToolbar: (open) => ipcRenderer.send('toolbar:panel', open),
  hideToolbar: () => ipcRenderer.send('toolbar:hide'),
  endAnnotationSession: () => ipcRenderer.send('toolbar:end-session'),
  command: (command) => ipcRenderer.send('toolbar:command', command),
  selectInkTool: (payload) => ipcRenderer.send('toolbar:ink-tool', payload),
  forwardToolbarPointer: (payload) => ipcRenderer.send('toolbar:pointer', payload),
  annotationShortcut: (shortcut) => ipcRenderer.send('annotation:shortcut', shortcut),
  overlayReady: (displayId) => ipcRenderer.send('overlay:ready', displayId),
  // Invisible, bounded input telemetry used only to diagnose differences in
  // Windows Ink routing across machines.  It never carries screen contents or
  // pointer coordinates.
  reportOverlayDiagnostic: (payload) => ipcRenderer.send('overlay:diagnostic', payload),
  requestSelectionCapture: (payload) => ipcRenderer.send('overlay:selection-request', payload),
  screenshotAction: (payload) => ipcRenderer.invoke('overlay:screenshot-action', payload),
  on: (channel, callback) => ipcRenderer.on(channel, (_, payload) => callback(payload))
});
