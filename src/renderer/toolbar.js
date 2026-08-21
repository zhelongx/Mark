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
const compactModeInput = document.querySelector('#compactMode');
const boardEnabledInput = document.querySelector('#boardEnabled');
const boardModeButtons = [...document.querySelectorAll('[data-board-mode]')];
const uiStyleInput = document.querySelector('#uiStyle');
const autoHideInput = document.querySelector('#autoHide');
const hideDelayInput = document.querySelector('#hideDelay');
const customSelects = [...document.querySelectorAll('.custom-select')];
const exitButton = document.querySelector('#exit');
const toolbarTools = [...document.querySelectorAll('.tool')];
const commandButtons = [...document.querySelectorAll('[data-command]')];
const colorSwatches = [...document.querySelectorAll('[data-color]')];
const panelCloseButtons = [...document.querySelectorAll('[data-close-panel]')];
const contextActions = [...document.querySelectorAll('[data-context-action]')];
const allButtons = [...document.querySelectorAll('button')];
const skinImages = [...document.querySelectorAll('img[data-material-src][data-flat-src]')];
const carrotImage = carrot.querySelector('img');
let expanded = false;
let drag = null;
let forwardedPointer = null;
let autoTimer;
let panelResizeTimer;
let panelMetricsFrame = 0;
let panelMetricsSettleTimer;
let lastPanelHostKey = '';
let moveFrame = 0;
let settingsFrame = 0;
let drawingSurfaceRestoreFrame = 0;
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
function openPanel() {
  return [colors, settingsPanel, contextMenu].find((panel) => panel.classList.contains('is-open')) || null;
}
function alignPanelToTool(panel) {
  const anchor = panel === colors ? colorsButton : panel === settingsPanel ? settingsButton : null;
  if (!anchor) return;
  const rackRect = rack.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  // Each owned panel sits six pixels from the rack and shares the vertical
  // centreline of its own icon.  A palette must never borrow Settings' old
  // top/bottom placement rule: both menus are spatially attached to the
  // control that opened them.
  // Absolute children are laid out from the rack's padding box, while the
  // visual gap is measured from its outside edge.  Remove the shared 2px
  // frame once so the rendered panel—not merely its CSS left value—sits 6px
  // from the rack and aligns with its owner button.
  const frameInset = rack.clientLeft;
  panel.style.left = `${Math.round(rackRect.width + 6 - frameInset)}px`;
  const anchorCentre = anchorRect.top - rackRect.top + anchorRect.height / 2;
  panel.style.top = `${Math.round(anchorCentre - panel.offsetHeight / 2 - frameInset)}px`;
  panel.style.bottom = 'auto';
}
function panelHostMetrics() {
  const panel = openPanel();
  if (!panel) return { open: false };
  alignPanelToTool(panel);
  const panelRect = panel.getBoundingClientRect();
  const rackRect = rack.getBoundingClientRect();
  const extras = [panel.querySelector('.panel-close')];
  panel.querySelectorAll('.custom-select.is-open .custom-select-options').forEach((node) => extras.push(node));
  const rects = [panelRect, ...extras.filter(Boolean).map((node) => node.getBoundingClientRect())];
  const minTop = Math.min(...rects.map((rect) => rect.top));
  const maxRight = Math.max(rackRect.right, ...rects.map((rect) => rect.right));
  const maxBottom = Math.max(rackRect.bottom, ...rects.map((rect) => rect.bottom));
  const safe = 7;
  return {
    open: true,
    width: Math.ceil(maxRight + safe),
    height: Math.ceil(Math.max(rackRect.bottom, maxBottom) + safe)
  };
}
function closePopovers({ immediate = false } = {}) {
  const wasOpen = hasOpenPopover();
  if (!wasOpen && !immediate) return;
  closeCustomSelects();
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  updatePanelWidth({ immediate });
}
function updatePanelWidth({ immediate = false } = {}) {
  clearTimeout(panelResizeTimer);
  if (hasOpenPopover()) {
    const metrics = panelHostMetrics();
    const key = `${metrics.open}:${metrics.width}:${metrics.height}`;
    if (key === lastPanelHostKey) return;
    lastPanelHostKey = key;
    return window.zmark.panelToolbar(metrics);
  }
  const closePanelHost = () => {
    if (lastPanelHostKey === 'closed') return;
    lastPanelHostKey = 'closed';
    window.zmark.panelToolbar(false);
  };
  if (immediate) return closePanelHost();
  panelResizeTimer = setTimeout(closePanelHost, POPOVER_ANIMATION_MS);
}
function schedulePanelMetrics() {
  if (panelMetricsFrame) cancelAnimationFrame(panelMetricsFrame);
  panelMetricsFrame = requestAnimationFrame(() => {
    panelMetricsFrame = 0;
    if (hasOpenPopover()) updatePanelWidth({ immediate: true });
  });
}
function settlePanelMetrics() {
  clearTimeout(panelMetricsSettleTimer);
  // Popovers animate from a 97.5% transform.  A first-frame measurement is
  // deliberately fast, then this post-transition pass measures their final
  // painted bounds, including the round close bead.
  panelMetricsSettleTimer = setTimeout(() => {
    if (hasOpenPopover()) updatePanelWidth({ immediate: true });
  }, POPOVER_ANIMATION_MS + 24);
}
const panelResizeObserver = new ResizeObserver(schedulePanelMetrics);
[colors, settingsPanel, contextMenu].forEach((panel) => panelResizeObserver.observe(panel));
// Opening a panel from the collapsed rack sends the native expand request and
// the panel-size request in the same turn. Re-measure after that native resize
// lands so the later layout cannot shrink an already-open panel back to rack
// height and crop its lower rows.
window.addEventListener('resize', () => {
  if (hasOpenPopover()) schedulePanelMetrics();
});
function togglePopover(target) {
  clearTimeout(panelResizeTimer);
  const shouldOpen = !target.classList.contains('is-open');
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  closeCustomSelects();
  target.classList.toggle('is-open', shouldOpen);
  updatePanelWidth({ immediate: shouldOpen });
  if (shouldOpen) settlePanelMetrics();
}
function openPopover(target) {
  clearTimeout(panelResizeTimer);
  if (!expanded) setExpanded(true);
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  contextMenu.classList.remove('is-open');
  contextMenu.setAttribute('aria-hidden', 'true');
  closeCustomSelects();
  target.classList.add('is-open');
  updatePanelWidth({ immediate: true });
  settlePanelMetrics();
}
function toggleContextMenu() {
  clearTimeout(panelResizeTimer);
  const shouldOpen = !contextMenu.classList.contains('is-open');
  colors.classList.remove('is-open');
  settingsPanel.classList.remove('is-open');
  closeCustomSelects();
  contextMenu.classList.toggle('is-open', shouldOpen);
  contextMenu.setAttribute('aria-hidden', String(!shouldOpen));
  updatePanelWidth({ immediate: shouldOpen });
  if (shouldOpen) settlePanelMetrics();
}
function scheduleAutoHide() {
  clearTimeout(autoTimer);
  if (!autoHideInput.checked || !expanded || annotation.drawing) return;
  autoTimer = setTimeout(() => setExpanded(false), Number(hideDelayInput.dataset.value) * 1000);
}
function flushToolbarMove() {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  if (!pendingMove) return;
  window.zmark.moveToolbar(pendingMove);
  pendingMove = null;
}
function queueToolbarMove(pointerId, clientX, clientY) {
  // Keep toolbar-local coordinates. Windows Ink's absolute screen values can
  // use physical pixels while Electron window bounds use DIPs on mixed-DPI
  // desktops; local coordinates stay stable for mouse and stylus alike.
  pendingMove = { pointerId, clientX, clientY };
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
function restoreDrawingSurfaceAfterToolbarInteraction() {
  if (!annotation.active || drawingSurfaceRestoreFrame) return;
  // Let the toolbar finish consuming its click first, then hand native focus
  // back to the existing transparent overlay. This is intentionally not a
  // mode command: Esc and the carrot remain the only drawing-exit controls.
  drawingSurfaceRestoreFrame = requestAnimationFrame(() => {
    drawingSurfaceRestoreFrame = 0;
    if (annotation.active) window.zmark.restoreDrawingSurface();
  });
}
function applyUiStyle(style) {
  const uiStyle = style === 'flat' ? 'flat' : 'material';
  document.documentElement.dataset.uiStyle = uiStyle;
  setCustomSelectValue(uiStyleInput, uiStyle);
  skinImages.forEach((image) => {
    if (image === carrotImage) return;
    image.src = uiStyle === 'flat' ? image.dataset.flatSrc : image.dataset.materialSrc;
  });
  updateCarrotVisual();
}

function hasActiveHeart(state = annotation) {
  // A screenshot selection and its constrained annotation phase both retain
  // screenshot mode. Free drawing reports drawing=true. These are exactly the
  // three live states that need the gentle working heartbeat.
  return Boolean(state.active && (state.drawing || state.mode === 'screenshot'));
}

function updateCarrotVisual() {
  const isFlat = document.documentElement.dataset.uiStyle === 'flat';
  const isActive = hasActiveHeart();
  carrot.classList.toggle('is-heart-active', isActive);
  carrotImage.src = isActive
    ? (isFlat ? carrotImage.dataset.flatHeartSrc : carrotImage.dataset.materialHeartSrc)
    : (isFlat ? carrotImage.dataset.flatSrc : carrotImage.dataset.materialSrc);
}
function applyCompactMode(compact) {
  const enabled = Boolean(compact);
  document.documentElement.dataset.compactMode = String(enabled);
  compactModeInput.checked = enabled;
}
function applyBoardSettings({ enabled = false, mode = 'white' } = {}) {
  const boardMode = mode === 'black' ? 'black' : 'white';
  boardEnabledInput.checked = Boolean(enabled);
  boardModeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.boardMode === boardMode)));
}
function closeCustomSelects(except = null) {
  customSelects.forEach((select) => {
    if (select === except) return;
    select.classList.remove('is-open');
    select.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
  });
}
function setCustomSelectValue(select, value) {
  const option = select.querySelector(`[role="option"][data-value="${value}"]`) || select.querySelector('[role="option"]');
  if (!option) return;
  select.dataset.value = option.dataset.value;
  select.querySelector('.custom-select-value').textContent = option.textContent;
  select.querySelectorAll('[role="option"]').forEach((item) => item.setAttribute('aria-selected', String(item === option)));
}
function chooseCustomSelect(select, value) {
  setCustomSelectValue(select, value);
  closeCustomSelects();
  if (select === uiStyleInput) {
    applyUiStyle(value);
    queueSettingsUpdate({ uiStyle: value }, { immediate: true });
  } else if (select === hideDelayInput) {
    queueSettingsUpdate({ hideDelay: Number(value) }, { immediate: true });
    scheduleAutoHide();
  }
  restoreDrawingSurfaceAfterToolbarInteraction();
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
  // A tap is not a drag.  In particular, do not create a native drag session
  // until the pointer has really crossed the threshold: Windows Ink can lose a
  // capture when the transparent BrowserWindow moves, and an eager session
  // used to hand the annotation surface to a neighbouring monitor on a tap.
  drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, started: false, shift: event.shiftKey };
});
carrot.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (Math.hypot(dx, dy) >= DRAG_THRESHOLD && !drag.moved) {
    drag.moved = true;
    drag.started = true;
    // Keep the original local contact point as the anchor.  The following
    // movement packets remain in toolbar-local CSS coordinates, so this works
    // unchanged across Windows displays with different DPI scales.
    window.zmark.beginToolbarDrag({ pointerId: event.pointerId, clientX: drag.startX, clientY: drag.startY });
  }
  if (drag.moved) {
    event.preventDefault();
    queueToolbarMove(event.pointerId, event.clientX, event.clientY);
  }
});
function finishCarrotPointer(event, cancelled = false) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const action = drag;
  drag = null;
  if (carrot.hasPointerCapture(event.pointerId)) carrot.releasePointerCapture(event.pointerId);
  if (action.started) {
    flushToolbarMove();
    window.zmark.endToolbarDrag({ pointerId: event.pointerId });
  }
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
// Do not terminate a real tablet drag solely because Windows transiently
// revokes capture while its native window crosses a monitor seam.  The normal
// pointerup/cancel path below is still observed by the window and commits the
// display hand-off exactly once.
window.addEventListener('pointerup', (event) => finishCarrotPointer(event));
window.addEventListener('pointercancel', (event) => finishCarrotPointer(event, true));
carrot.addEventListener('contextmenu', (event) => { event.preventDefault(); toggleContextMenu(); });
function isPrimaryToolActivation(event) {
  const kind = event.pointerType || 'mouse';
  // Pen releases may be reported as -1; a right barrel button remains the
  // only release that must not activate the tool. For an unknown/mouse event
  // a normal click fallback will run if its pointerup did not expose button 0.
  return kind === 'pen' ? event.button !== 2 : event.button === 0;
}
function activateToolbarCommand(button, event) {
  const command = button.dataset.command;
  markToolbarControl(button);
  // Tool activation is a committed intent, unlike a neutral click on the
  // desktop. Close a palette/settings pane in this same toolbar event before
  // the main process hands focus to the overlay, so the next physical pen
  // packet starts the first mark instead of merely dismissing the pane.
  closePopovers({ immediate: true });
  if (['pen', 'highlighter'].includes(command)) {
    // A pen/highlighter click is the sole explicit way to enter drawing.
    // Do not let a Windows-specific pointerup button value turn that command
    // into a passive tool selection: screenshot already proves the overlay
    // path is healthy once a session is created.
    window.zmark.selectInkTool({ tool: command, enterDrawing: true });
    return;
  }
  window.zmark.command(command);
  // Clear must leave an existing drawing session active. Like the colour and
  // settings popovers, hand focus back only after this toolbar click ends.
  if (command === 'clear') restoreDrawingSurfaceAfterToolbarInteraction();
  scheduleAutoHide();
}
commandButtons.forEach((button) => {
  button.addEventListener('pointerup', (event) => {
    if (!isPrimaryToolActivation(event)) return;
    button.lastToolbarActivation = performance.now();
    activateToolbarCommand(button, event);
  });
  button.addEventListener('click', (event) => {
    // Do not run ordinary pointer interactions twice. Keyboard activation
    // stays outside drawing entry: only a real primary click is the fallback.
    if (!event.detail || performance.now() - (button.lastToolbarActivation || 0) < 450) return;
    activateToolbarCommand(button, event);
  });
});
colorsButton.addEventListener('click', () => {
  markToolbarControl(colorsButton);
  togglePopover(colors);
  restoreDrawingSurfaceAfterToolbarInteraction();
  scheduleAutoHide();
});
settingsButton.addEventListener('click', () => {
  markToolbarControl(settingsButton);
  togglePopover(settingsPanel);
  restoreDrawingSurfaceAfterToolbarInteraction();
  scheduleAutoHide();
});
colorSwatches.forEach((button) => button.addEventListener('click', () => {
  colorSwatches.forEach((item) => item.classList.remove('selected'));
  button.classList.add('selected');
  queueSettingsUpdate({ color: button.dataset.color }, { immediate: true });
  colors.classList.remove('is-open');
  updatePanelWidth();
  restoreDrawingSurfaceAfterToolbarInteraction();
  scheduleAutoHide();
}));
customSelects.forEach((select) => {
  const trigger = select.querySelector('.custom-select-trigger');
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    const shouldOpen = !select.classList.contains('is-open');
    closeCustomSelects(select);
    select.classList.toggle('is-open', shouldOpen);
    trigger.setAttribute('aria-expanded', String(shouldOpen));
    schedulePanelMetrics();
    settlePanelMetrics();
    restoreDrawingSurfaceAfterToolbarInteraction();
  });
  select.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', (event) => {
    event.preventDefault();
    chooseCustomSelect(select, option.dataset.value);
  }));
});
panelCloseButtons.forEach((button) => button.addEventListener('click', (event) => {
  event.preventDefault();
  closePopovers();
  restoreDrawingSurfaceAfterToolbarInteraction();
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
    restoreDrawingSurfaceAfterToolbarInteraction();
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
  restoreDrawingSurfaceAfterToolbarInteraction();
});
compactModeInput.addEventListener('change', () => {
  applyCompactMode(compactModeInput.checked);
  queueSettingsUpdate({ compactMode: compactModeInput.checked }, { immediate: true });
  scheduleAutoHide();
});
boardEnabledInput.addEventListener('change', () => {
  queueSettingsUpdate({ boardEnabled: boardEnabledInput.checked }, { immediate: true });
  restoreDrawingSurfaceAfterToolbarInteraction();
});
boardModeButtons.forEach((button) => button.addEventListener('click', () => {
  const boardMode = button.dataset.boardMode === 'black' ? 'black' : 'white';
  applyBoardSettings({ enabled: boardEnabledInput.checked, mode: boardMode });
  queueSettingsUpdate({ boardMode }, { immediate: true });
  restoreDrawingSurfaceAfterToolbarInteraction();
}));
autoHideInput.addEventListener('change', (event) => {
  queueSettingsUpdate({ toolbarVisibility: event.target.checked ? 'auto' : 'keep' }, { immediate: true });
  scheduleAutoHide();
});
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
  else if (!meta && !event.altKey && key === 't') shortcut = 'text';
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
  applyUiStyle(saved.uiStyle);
  applyCompactMode(saved.compactMode);
  applyBoardSettings({ enabled: saved.boardEnabled, mode: saved.boardMode });
  themeInput.checked = saved.theme === 'dark';
  autoHideInput.checked = saved.toolbarVisibility === 'auto';
  setCustomSelectValue(hideDelayInput, String(saved.hideDelay));
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
  updateCarrotVisual();
  // Esc leaves the annotation session alive but exits drawing. It must look
  // exactly like "no tool selected": no lingering dark shadow, focus frame,
  // or pressed state on the tool used to enter drawing.
  if (!state.drawing) {
    clearToolbarSelection();
    allButtons.forEach(clearPressedState);
  }
});
window.zmark.on('toolbar:active-tool', markActive);
window.zmark.on('toolbar:ui-style', applyUiStyle);
window.zmark.on('toolbar:compact-mode', (compact) => {
  applyCompactMode(compact);
  if (hasOpenPopover()) schedulePanelMetrics();
});
window.zmark.on('toolbar:board-settings', applyBoardSettings);
window.zmark.on('toolbar:open-panel', (panel) => {
  if (panel === 'colors') openPopover(colors);
  if (panel === 'settings') openPopover(settingsPanel);
});
window.zmark.on('toolbar:close-panels', ({ immediate = true } = {}) => closePopovers({ immediate }));
window.zmark.on('toolbar:size', (size) => {
  sizeInput.value = size;
  sizeValue.textContent = size;
});
window.addEventListener('pagehide', () => {
  flushToolbarMove();
  if (drag) window.zmark.endToolbarDrag({ pointerId: drag.pointerId });
  flushSettingsUpdate();
  clearTimeout(panelMetricsSettleTimer);
  panelResizeObserver.disconnect();
});
