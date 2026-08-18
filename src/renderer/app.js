const shell = document.querySelector('#toolbarShell');
const handle = document.querySelector('#handle');
const colorTrigger = document.querySelector('#colorTrigger');
const settingsTrigger = document.querySelector('#settingsTrigger');
const colorPopover = document.querySelector('#colorPopover');
const settingsPopover = document.querySelector('#settingsPopover');
const selectedColor = document.querySelector('#selectedColor');
const weight = document.querySelector('#weight');
const weightValue = document.querySelector('#weightValue');
const delayControl = document.querySelector('#delayControl');
const hideDelay = document.querySelector('#hideDelay');
const darkMode = document.querySelector('#darkMode');
let autoHideTimer;

function closePopovers() { colorPopover.classList.remove('is-open'); settingsPopover.classList.remove('is-open'); }
function openToolbar() { shell.classList.remove('is-collapsed'); handle.setAttribute('aria-label', '收起标注工具栏'); refreshAutoHide(); }
function closeToolbar() { shell.classList.add('is-collapsed'); closePopovers(); window.clearTimeout(autoHideTimer); }
function refreshAutoHide() {
  window.clearTimeout(autoHideTimer);
  if (document.querySelector('input[name="visibility"]:checked').value === 'auto') {
    autoHideTimer = window.setTimeout(closeToolbar, Number(hideDelay.value) * 1000);
  }
}
handle.addEventListener('click', () => shell.classList.contains('is-collapsed') ? openToolbar() : closeToolbar());
colorTrigger.addEventListener('click', (event) => { event.stopPropagation(); settingsPopover.classList.remove('is-open'); colorPopover.classList.toggle('is-open'); refreshAutoHide(); });
settingsTrigger.addEventListener('click', (event) => { event.stopPropagation(); colorPopover.classList.remove('is-open'); settingsPopover.classList.toggle('is-open'); refreshAutoHide(); });
document.querySelectorAll('.tool[data-tool]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.tool[data-tool]').forEach((item) => item.classList.remove('is-active')); button.classList.add('is-active'); refreshAutoHide(); }));
document.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-color]').forEach((item) => item.classList.remove('is-selected')); button.classList.add('is-selected'); selectedColor.style.background = button.dataset.color; refreshAutoHide(); }));
weight.addEventListener('input', () => { weightValue.textContent = `${weight.value} px`; refreshAutoHide(); });
document.querySelectorAll('input[name="visibility"]').forEach((radio) => radio.addEventListener('change', () => { const isAuto = radio.value === 'auto' && radio.checked; delayControl.classList.toggle('is-disabled', !isAuto); hideDelay.disabled = !isAuto; refreshAutoHide(); }));
document.addEventListener('click', (event) => { if (!event.target.closest('.popover, .round-tool')) closePopovers(); });
shell.addEventListener('pointermove', refreshAutoHide);
darkMode.addEventListener('change', () => {
  document.documentElement.dataset.theme = darkMode.checked ? 'dark' : 'light';
});
