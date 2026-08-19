const rack = document.querySelector('#rack');
const carrot = document.querySelector('#carrot');
const colors = document.querySelector('#colors');
const settingsPanel = document.querySelector('#settings');
const contextMenu = document.querySelector('#contextMenu');
const colorsButton = document.querySelector('#colorsButton');
const settingsButton = document.querySelector('#settingsButton');
const sizeInput = document.querySelector('#size');
const sizeValue = document.querySelector('#sizeValue');
const penStrengthInput = document.querySelector('#penStrength');
const penStrengthValue = document.querySelector('#penStrengthValue');
const highlighterStrengthInput = document.querySelector('#highlighterStrength');
const highlighterStrengthValue = document.querySelector('#highlighterStrengthValue');
const themeInput = document.querySelector('#theme');
const autoHideInput = document.querySelector('#autoHide');
const hideDelayInput = document.querySelector('#hideDelay');
const exitButton = document.querySelector('#exit');
const toolbarTools = [...document.querySelectorAll('.tool')];
const commandButtons = [...document.querySelectorAll('[data-command]')];
const colorSwatches = [...document.querySelectorAll('[data-color]')];
const panelCloseButtons = [...document.querySelectorAll('[data-close-panel]')];
const contextActions = [...document.querySelectorAll('[data-context-action]')];
const allButtons = [...document.querySelectorAll('button')];
let expanded = false;
let drag = null;
let forwardedPointer = null;
let autoTimer;
let panelResizeTimer;
let moveFrame = 0;
let settingsFrame = 0;
let pendingMove = null;
let pendingSettings = null;
let annotation = { active: false, drawing: false };
const DRAG_THRESHOLD = 4;
const POPOVER_ANIMATION_MS = 180;

function setExpanded(next) {
  if (next) window.zmark.layoutToolbar(true);
  expanded = next;
  rack.classList.toggle('is-collapsed', !next);
  carrot.setAttribute('aria-label', next ? '收起工具架' : '展开工具架');
  if (!next) {
    closePopovers();
    setTimeout(() => window.zmark.layoutToolbar(false), 290);
  }
  if (next) scheduleAutoHide();
}
function hasOpenPopover() {
  return colors.classList.contains('is-open') || settingsPanel.classList.contains('is-open') || contextMenu.classList.contains('is-open');
}
function closePopovers({ immediate = false } = {}) {
  const wasOpen = hasOpenPopover();
  if (!wasOpen && !immediate) return;
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  updatePanelWidth({ immediate });
}
function updatePanelWidth({ immediate = false } = {}) {
  clearTimeout(panelResizeTimer);
  if (hasOpenPopover()) return window.zmark.panelToolbar(true);
  if (immediate) return window.zmark.panelToolbar(false);
  panelResizeTimer = setTimeout(() => window.zmark.panelToolbar(false), POPOVER_ANIMATION_MS);
}
function togglePopover(target) {
  clearTimeout(panelResizeTimer);
  const shouldOpen = !target.classList.contains('is-open');
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  target.classList.toggle('is-open', shouldOpen);
  updatePanelWidth({ immediate: shouldOpen });
}
function openPopover(target) {
  clearTimeout(panelResizeTimer);
  if (!expanded) setExpanded(true);
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  target.classList.add('is-open');
  updatePanelWidth({ immediate: true });
}
function toggleContextMenu() {
  clearTimeout(panelResizeTimer);
  const shouldOpen = !contextMenu.classList.contains('is-open');
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.toggle('is-open', shouldOpen);
  contextMenu.setAttribute('aria-hidden', String(!shouldOpen));
  updatePanelWidth({ immediate: shouldOpen });
}
function scheduleAutoHide() {
  clearTimeout(autoTimer);
  if (!autoHideInput.checked || !expanded || annotation.drawing) return;
  autoTimer = setTimeout(() => setExpanded(false), Number(hideDelayInput.value) * 1000);
}
function flushToolbarMove() {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  if (!pendingMove) return;
  window.zmark.moveToolbar(pendingMove);
  pendingMove = null;
}
function queueToolbarMove(pointerId, screenX, screenY) {
  // Keep the newest absolute pointer location for this animation frame.  The
  // main process derives the window position from it, so moving the native
  // window cannot corrupt the next drag delta at a display boundary.
  pendingMove = { pointerId, screenX, screenY };
  if (!moveFrame) moveFrame = requestAnimationFrame(flushToolbarMove);
}
function flushSettingsUpdate() {
  if (settingsFrame) cancelAnimationFrame(settingsFrame);
  settingsFrame = 0;
  if (!pendingSettings) return;
  window.zmark.updateSettings(pendingSettings);
  pendingSettings = null;
}
function queueSettingsUpdate(patch, { immediate = false } = {}) {
  pendingSettings = { ...pendingSettings, ...patch };
  if (immediate) return flushSettingsUpdate();
  if (!settingsFrame) settingsFrame = requestAnimationFrame(flushSettingsUpdate);
}
function markActive(command) {
  toolbarTools.forEach((item) => item.classList.toggle('is-active', item.dataset.command === command));
}
function markToolbarControl(button) {
  toolbarTools.forEach((item) => item.classList.toggle('is-active', item === button));
}
function clearToolbarSelection() {
  toolbarTools.forEach((item) => item.classList.remove('is-active'));
}
function clearPressedState(button) {
  clearTimeout(button.pressTimer);
  button.pressTimer = undefined;
  button.classList.remove('is-pressed');
}
carrot.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  carrot.setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moved: false, shift: event.shiftKey };
  window.zmark.beginToolbarDrag({ pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY });
});
carrot.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.screenX - drag.startX;
  const dy = event.screenY - drag.startY;
  if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) drag.moved = true;
  if (drag.moved) {
    event.preventDefault();
    queueToolbarMove(event.pointerId, event.screenX, event.screenY);
  }
});
function finishCarrotPointer(event, cancelled = false) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const action = drag;
  drag = null;
  if (carrot.hasPointerCapture(event.pointerId)) carrot.releasePointerCapture(event.pointerId);
  flushToolbarMove();
  window.zmark.endToolbarDrag({ pointerId: event.pointerId });
  if (cancelled || action.moved) return;
  if (action.shift) {
    clearToolbarSelection();
    return window.zmark.hideToolbar();
  }
  if (annotation.mode === 'screenshot') {
    clearToolbarSelection();
    window.zmark.command('exit');
    return;
  }
  if (annotation.drawing) {
    clearToolbarSelection();
    window.zmark.command('exit');
    return;
  }
  clearToolbarSelection();
  setExpanded(!expanded);
}
carrot.addEventListener('pointerup', (event) => finishCarrotPointer(event));
carrot.addEventListener('pointercancel', (event) => finishCarrotPointer(event, true));
carrot.addEventListener('lostpointercapture', () => {
  const pointerId = drag?.pointerId;
  flushToolbarMove();
  drag = null;
  if (pointerId !== undefined) window.zmark.endToolbarDrag({ pointerId });
});
carrot.addEventListener('contextmenu', (event) => { event.preventDefault(); toggleContextMenu(); });
function activateToolbarCommand(button, event, { clickFallback = false } = {}) {
  const command = button.dataset.command;
  markToolbarControl(button);
  if (['pen', 'highlighter'].includes(command)) {
    // Some Windows Ink stacks report a pen release as button -1 even though
    // its primary contact began on this exact tool.  Mouse still requires a
    // left release, while pen accepts the primary/-1 packet and rejects a
    // barrel-button (right) release.
    const enterDrawing = clickFallback || event.pointerType === 'mouse'
      ? event.button === 0
      : event.pointerType === 'pen' && event.button !== 2;
    // A DOM click is synthesized only for a completed primary contact.  It
    // is the compatibility path for Windows Ink configurations that deliver
    // a click to Chromium but lose the matching pointerup packet.
    window.zmark.selectInkTool({ tool: command, enterDrawing: clickFallback || enterDrawing });
    return;
  }
  window.zmark.command(command);
  scheduleAutoHide();
}
commandButtons.forEach((button) => {
  button.addEventListener('pointerup', (event) => {
    button.lastToolbarActivation = performance.now();
    activateToolbarCommand(button, event);
  });
  button.addEventListener('click', (event) => {
    // Do not run ordinary pointer interactions twice. Keyboard activation
    // stays outside drawing entry: only a real primary click is the fallback.
    if (!event.detail || performance.now() - (button.lastToolbarActivation || 0) < 450) return;
    activateToolbarCommand(button, event, { clickFallback: true });
  });
});
colorsButton.addEventListener('click', () => {
  markToolbarControl(colorsButton);
  togglePopover(colors);
  scheduleAutoHide();
});
settingsButton.addEventListener('click', () => {
  markToolbarControl(settingsButton);
  togglePopover(settingsPanel);
  scheduleAutoHide();
});
colorSwatches.forEach((button) => button.addEventListener('click', () => {
  colorSwatches.forEach((item) => item.classList.remove('selected'));
  button.classList.add('selected');
  queueSettingsUpdate({ color: button.dataset.color }, { immediate: true });
  colors.classList.remove('is-open');
  updatePanelWidth();
  scheduleAutoHide();
}));
panelCloseButtons.forEach((button) => button.addEventListener('click', (event) => {
  event.preventDefault();
  closePopovers();
}));
document.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.popover,.context-menu,#colorsButton,#settingsButton')) return;
  closePopovers();
});
contextActions.forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.contextAction;
  closePopovers();
  if (action === 'hide') return window.zmark.hideToolbar();
  if (action === 'end') return window.zmark.endAnnotationSession();
  if (action === 'quit') return window.zmark.command('quit');
}));
sizeInput.addEventListener('input', (event) => {
  sizeValue.textContent = event.target.value;
  queueSettingsUpdate({ size: Number(event.target.value) });
});
penStrengthInput.addEventListener('input', (event) => {
  penStrengthValue.textContent = event.target.value;
  queueSettingsUpdate({ penStrength: Number(event.target.value) });
});
highlighterStrengthInput.addEventListener('input', (event) => {
  highlighterStrengthValue.textContent = event.target.value;
  queueSettingsUpdate({ highlighterStrength: Number(event.target.value) });
});
function setRangeValueFromPointer(input, event) {
  const bounds = input.getBoundingClientRect();
  if (!bounds.width) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const step = Number(input.step || 1);
  const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const value = min + (max - min) * progress;
  input.value = String(Math.round(value / step) * step);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function installRangePointerControl(input) {
  let pointerId = null;
  input.addEventListener('pointerdown', (event) => {
    // Chromium's native range control has a Windows Ink regression where a
    // pen contact can focus the slider without moving its thumb.  Resolve it
    // from the physical pointer for pen and mouse alike, while leaving
    // keyboard range controls untouched.
    if (!['mouse', 'pen'].includes(event.pointerType)) return;
    event.preventDefault();
    // Never leave Chromium's native Windows Ink focus/tap treatment behind.
    // Keyboard focus still works when the slider is reached by Tab.
    input.blur();
    pointerId = event.pointerId;
    input.setPointerCapture(pointerId);
    setRangeValueFromPointer(input, event);
  });
  input.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    setRangeValueFromPointer(input, event);
  });
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    setRangeValueFromPointer(input, event);
    if (input.hasPointerCapture(pointerId)) input.releasePointerCapture(pointerId);
    pointerId = null;
  };
  input.addEventListener('pointerup', finish);
  input.addEventListener('pointercancel', finish);
}
installRangePointerControl(sizeInput);
installRangePointerControl(penStrengthInput);
installRangePointerControl(highlighterStrengthInput);
themeInput.addEventListener('change', (event) => {
  document.documentElement.dataset.theme = event.target.checked ? 'dark' : 'light';
  queueSettingsUpdate({ theme: event.target.checked ? 'dark' : 'light' }, { immediate: true });
});
autoHideInput.addEventListener('change', (event) => {
  queueSettingsUpdate({ toolbarVisibility: event.target.checked ? 'auto' : 'keep' }, { immediate: true });
  scheduleAutoHide();
});
hideDelayInput.addEventListener('change', (event) => queueSettingsUpdate({ hideDelay: Number(event.target.value) }, { immediate: true }));
exitButton.addEventListener('click', () => {
  flushSettingsUpdate();
  window.zmark.command('quit');
});
allButtons.forEach((button) => {
  button.addEventListener('pointerdown', () => {
    button.classList.add('is-pressed');
    clearTimeout(button.pressTimer);
    // Preserve a tangible, short scale response without leaving an Ink
    // press-state behind when a pen's release is routed to another window.
    button.pressTimer = setTimeout(() => clearPressedState(button), 150);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((eventName) => {
    button.addEventListener(eventName, () => clearPressedState(button));
  });
});
toolbarTools.forEach((tool) => {
  tool.addEventListener('pointerenter', () => tool.classList.add('is-hovered'));
  tool.addEventListener('pointerleave', () => tool.classList.remove('is-hovered'));
});
// The toolbar is a real input surface while drawing.  Forwarding the blank
// gaps into the transparent overlay lets a release/move be joined to a live
// stroke on Windows, producing false diagonal marks.  The rack therefore
// owns every hit inside its bounds; the canvas remains available everywhere
// around it and every tool stays immediately clickable.
function stopForwardedPointer() { forwardedPointer = null; }
rack.addEventListener('pointerdown', stopForwardedPointer);
rack.addEventListener('pointerup', stopForwardedPointer);
rack.addEventListener('pointercancel', stopForwardedPointer);
rack.addEventListener('pointermove', scheduleAutoHide);
window.addEventListener('keydown', (event) => {
  if (!annotation.drawing) return;
  const key = event.key.toLowerCase();
  const meta = event.ctrlKey || event.metaKey;
  let shortcut = '';
  if (event.key === 'Escape') shortcut = 'escape';
  else if (meta && key === 'z' && event.shiftKey) shortcut = 'redo';
  else if (meta && key === 'z') shortcut = 'undo';
  else if (meta && key === 'e') shortcut = 'clear';
  else if (meta && key === 'r') shortcut = 'settings';
  else if (event.key === 'Backspace') shortcut = 'clear';
  else if (!meta && !event.altKey && key === 'e') shortcut = 'toggle-eraser';
  else if (!meta && !event.altKey && key === 'b') shortcut = 'pen';
  else if (!meta && !event.altKey && key === 'm') shortcut = 'highlighter';
  else if (!meta && !event.altKey && key === 'c' && event.shiftKey) shortcut = 'screenshot';
  else if (!meta && !event.altKey && key === 'c') shortcut = 'palette';
  else if (!meta && !event.altKey && event.key === '[') shortcut = 'size-down';
  else if (!meta && !event.altKey && event.key === ']') shortcut = 'size-up';
  if (!shortcut) return;
  event.preventDefault();
  window.zmark.annotationShortcut(shortcut);
});
window.zmark.getSettings().then((saved) => {
  document.documentElement.dataset.theme = saved.theme;
  themeInput.checked = saved.theme === 'dark';
  autoHideInput.checked = saved.toolbarVisibility === 'auto';
  hideDelayInput.value = saved.hideDelay;
  sizeInput.value = saved.size;
  sizeValue.textContent = saved.size;
  penStrengthInput.value = saved.penStrength ?? saved.strength ?? 50;
  penStrengthValue.textContent = saved.penStrength ?? saved.strength ?? 50;
  highlighterStrengthInput.value = saved.highlighterStrength ?? saved.strength ?? 50;
  highlighterStrengthValue.textContent = saved.highlighterStrength ?? saved.strength ?? 50;
  colorSwatches.find((button) => button.dataset.color === saved.color)?.classList.add('selected');
  window.zmark.layoutToolbar(false);
});
window.zmark.on('toolbar:annotation-state', (state) => {
  annotation = state;
  rack.classList.toggle('is-annotating', state.active);
  rack.classList.toggle('is-drawing', state.drawing);
  // Esc leaves the annotation session alive but exits drawing. It must look
  // exactly like "no tool selected": no lingering dark shadow, focus frame,
  // or pressed state on the tool used to enter drawing.
  if (!state.drawing) {
    clearToolbarSelection();
    allButtons.forEach(clearPressedState);
  }
});
window.zmark.on('toolbar:active-tool', markActive);
window.zmark.on('toolbar:open-panel', (panel) => {
  if (panel === 'colors') openPopover(colors);
  if (panel === 'settings') openPopover(settingsPanel);
});
window.zmark.on('toolbar:size', (size) => {
  sizeInput.value = size;
  sizeValue.textContent = size;
});
window.addEventListener('pagehide', () => {
  flushToolbarMove();
  if (drag) window.zmark.endToolbarDrag({ pointerId: drag.pointerId });
  flushSettingsUpdate();
});
