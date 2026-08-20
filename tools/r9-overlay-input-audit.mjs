import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main.js');
const preload = read('src/preload.js');
const overlay = read('src/renderer/overlay.js');
const toolbar = read('src/renderer/toolbar.js');
const css = read('src/renderer/overlay.css');
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

// This regression guard protects the exact Windows failure where Mark's UI
// opened but both mouse and pen were passed through its transparent overlay.
expect(!main.includes('app.disableHardwareAcceleration()'), 'Mark must retain Chromium GPU composition for its transparent overlay.');
expect(main.includes('overlay.setIgnoreMouseEvents(false);'), 'Drawing mode must explicitly restore native mouse hit testing.');
expect(main.includes('inputOverlay.focus();'), 'Drawing mode must focus the native input overlay after the rack command.');
expect(main.includes('function discardInactiveOverlays(activeId)'), 'Only the carrot display may retain a live annotation overlay.');
expect(main.includes('discardInactiveOverlays(id);'), 'Moving the carrot across displays must dispose of the previous display overlay.');
expect(main.includes("backgroundColor: '#00000000'"), 'Overlay must remain fully transparent outside intentional screenshot UI.');
expect(!main.includes("backgroundColor: '#ffffff03'"), 'Electron reads 8-digit native window colours as #AARRGGBB; this value creates an opaque yellow overlay.');
expect(overlay.includes("window.addEventListener('pointerdown', (event) => routePointerDown(event, 'window-capture'), true);"), 'Pointer down must be routed from the whole overlay window.');
expect(overlay.includes("window.addEventListener('pointermove', (event) => routePointerMove(event, 'window-capture'), true);"), 'Pointer move must be routed from the whole overlay window.');
expect(overlay.includes('function hasTipContact(event)'), 'Pressed pen moves without a replayed down event must recover a stroke.');
expect(preload.includes('reportOverlayDiagnostic'), 'The remote-machine diagnostic bridge must remain available.');
expect(css.includes('body{background:transparent;'), 'The DOM overlay must not tint the desktop outside intentional screenshot UI.');
expect(toolbar.includes("window.zmark.selectInkTool({ tool: command, enterDrawing: true });"), 'A primary pencil/highlighter click must always create a drawing session.');
expect(main.includes("sendToolbarCommand('toolbar:active-tool', tool);\n  // Clicking a native toolbar temporarily gives that small window focus."), 'Every brush switch must restore the active transparent overlay after toolbar focus changes.');
expect(!toolbar.includes('screenX') && !toolbar.includes('screenY'), 'Toolbar dragging must use local coordinates, not mixed-DPI pen screen coordinates.');
expect(main.includes("const pointer = { x: windowX + payload.clientX, y: windowY + payload.clientY };"), 'Main process must reconstruct drag position in Electron DIP coordinates.');
expect(!main.includes('prewarmScreenshot'), 'Entering screenshot mode must not capture the entire display before a selection exists.');
expect(main.includes('const screenshot = await captureLiveDisplay(payload.displayId);'), 'The display must be captured only after the selection rectangle is completed.');

if (failures.length) {
  console.error(`Overlay input audit failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Overlay input audit passed.');
