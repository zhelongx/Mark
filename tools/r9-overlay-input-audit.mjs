import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main.js');
const preload = read('src/preload.js');
const overlay = read('src/renderer/overlay.js');
const css = read('src/renderer/overlay.css');
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

// This regression guard protects the exact Windows failure where Mark's UI
// opened but both mouse and pen were passed through its transparent overlay.
expect(!main.includes('app.disableHardwareAcceleration()'), 'Mark must retain Chromium GPU composition for its transparent overlay.');
expect(main.includes('overlay.setIgnoreMouseEvents(false);'), 'Drawing mode must explicitly restore native mouse hit testing.');
expect(main.includes('inputOverlay.focus();'), 'Drawing mode must focus the native input overlay after the rack command.');
expect(main.includes("backgroundColor: '#ffffff03'"), 'Overlay must retain a minimally non-zero native hit surface.');
expect(overlay.includes("window.addEventListener('pointerdown', (event) => routePointerDown(event, 'window-capture'), true);"), 'Pointer down must be routed from the whole overlay window.');
expect(overlay.includes("window.addEventListener('pointermove', (event) => routePointerMove(event, 'window-capture'), true);"), 'Pointer move must be routed from the whole overlay window.');
expect(overlay.includes('function hasTipContact(event)'), 'Pressed pen moves without a replayed down event must recover a stroke.');
expect(preload.includes('reportOverlayDiagnostic'), 'The remote-machine diagnostic bridge must remain available.');
expect(css.includes('rgba(255,255,255,.0117647059)'), 'The DOM hit surface must remain non-zero and visually neutral.');

if (failures.length) {
  console.error(`Overlay input audit failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Overlay input audit passed.');
