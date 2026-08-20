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
const slimBuild = read('tools/build-slim.ps1');
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
expect(preload.includes('restoreDrawingSurface'), 'Palette and settings interactions must restore overlay focus without changing drawing mode.');
expect(preload.includes('overlayCaptureConcealed'), 'Screenshot capture must wait until overlay content is concealed.');
expect(css.includes('body{background:transparent;'), 'The DOM overlay must not tint the desktop outside intentional screenshot UI.');
expect(css.includes('body.is-capture-concealed>*{visibility:hidden!important}'), 'Screenshot capture must conceal renderer content without hiding the native overlay window.');
expect(toolbar.includes("window.zmark.selectInkTool({ tool: command, enterDrawing: true });"), 'A primary pencil/highlighter click must always create a drawing session.');
expect(main.includes("sendToolbarCommand('toolbar:active-tool', tool);\n  // Clicking a native toolbar temporarily gives that small window focus."), 'Every brush switch must restore the active transparent overlay after toolbar focus changes.');
expect(toolbar.includes('function restoreDrawingSurfaceAfterToolbarInteraction()'), 'Opening or using palette/settings must not leave the overlay unfocused.');
expect(main.includes("ipcMain.on('toolbar:restore-drawing-surface'"), 'Palette/settings focus restore must be handled without a drawing mode transition.');
expect(!toolbar.includes('screenX') && !toolbar.includes('screenY'), 'Toolbar dragging must use local coordinates, not mixed-DPI pen screen coordinates.');
expect(main.includes("const pointer = { x: windowX + payload.clientX, y: windowY + payload.clientY };"), 'Main process must reconstruct drag position in Electron DIP coordinates.');
expect(main.includes('function prewarmScreenshot(displayId)'), 'Camera activation must begin a background full-resolution source acquisition.');
expect(main.includes('prewarmScreenshot(activeDisplayId);'), 'Camera activation must start the source acquisition before a selection exists.');
expect(main.includes('const source = await captureSelectionSource(payload.displayId);'), 'Selection completion must consume the already-running screenshot source.');
expect(main.includes('sourceIncludesInk: true'), 'The prewarmed screen source must preserve existing annotation ink as part of the frozen image.');
const captureImplementation = main.slice(main.indexOf('async function captureLiveDisplay'), main.indexOf('async function saveScreenshot'));
expect(captureImplementation.includes('concealOverlayForCapture'), 'Screen capture must conceal content inside the live overlay.');
expect(!captureImplementation.includes('overlay.hide()'), 'Screen capture must not hide/show the full-screen native overlay.');
expect(overlay.includes('function renderHighlighterMaterial(target, points, width, strokeColor, withEndDeposits, strength = 50)'), 'Highlighter must use one direct material renderer for live and committed ink.');
expect(!overlay.includes("globalCompositeOperation = 'destination-in'"), 'Highlighter must not use a first-frame-sensitive destination-in mask compositor.');
expect(overlay.includes('paintHighlighterPath(target, points, width, inkLoad, highlighterPattern(target, strokeColor));'), 'Highlighter must retain its crisp felt material through the direct renderer.');
expect(overlay.includes('function primeHighlighterMaterial(nextColor = color)'), 'Highlighter material/pattern objects must be ready before the first real packet.');
expect(overlay.includes("if (command === 'highlighter') primeHighlighterMaterial(color);"), 'Selecting highlighter must prime only its direct material, never a synthetic brush stroke.');
expect(css.includes('mark-screenshot-develop'), 'Frozen screenshot preview must have a short non-blocking develop transition.');
expect(main.includes("app.setAppUserModelId('com.zhelongx.mark');"), 'Mark must own a stable Windows app identity.');
expect(slimBuild.includes('"/win32icon:$appIcon"'), 'Slim launcher must embed the purple carrot as its Explorer icon.');
expect(fs.existsSync(path.join(root, 'assets', 'icons', 'carrot-purple.ico')), 'Purple carrot ICO asset must be present for the Windows launcher.');
expect(slimBuild.includes('[string]$Revision = \'\''), 'Slim packaging must accept a visible R-number release revision.');
expect(slimBuild.includes('"ZhelongX-Mark-$version$releaseSuffix-Slim-Windows11-x64"'), 'The release revision must appear in the slim folder and zip name.');

if (failures.length) {
  console.error(`Overlay input audit failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Overlay input audit passed.');
