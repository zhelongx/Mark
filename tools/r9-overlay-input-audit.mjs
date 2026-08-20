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
const toolbarHtml = read('src/renderer/toolbar.html');
const toolbarCss = read('src/renderer/toolbar-fixes.css');
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
expect(toolbar.includes('crossed the threshold') && toolbar.includes('started: false'), 'A carrot tap must not create a native drag session before a real drag starts.');
expect(toolbar.includes("if (action.started) {\n    flushToolbarMove();\n    window.zmark.endToolbarDrag"), 'Only a real carrot drag may commit a monitor hand-off.');
expect(!toolbar.includes("carrot.addEventListener('lostpointercapture'"), 'Tablet pointer-capture changes must not prematurely end a carrot drag.');
expect(!main.includes('prewarmScreenshot'), 'Entering screenshot mode must not compete with an immediate full-screen capture.');
expect(main.includes('const screenshot = await captureLiveDisplay(payload.displayId);'), 'The full-resolution source must be acquired only after the selection rectangle is complete.');
expect(main.includes('sourceIncludesInk: false'), 'The post-flash screenshot path must use the exact overlay-concealed composition source.');
const captureImplementation = main.slice(main.indexOf('async function captureLiveDisplay'), main.indexOf('async function saveScreenshot'));
expect(captureImplementation.includes('concealOverlayForCapture'), 'Screen capture must conceal content inside the live overlay.');
expect(!captureImplementation.includes('overlay.hide()'), 'Screen capture must not hide/show the full-screen native overlay.');
expect(overlay.includes('function renderHighlighterMaterial(target, points, width, strokeColor, withEndDeposits, strength = 50)'), 'Highlighter must use one direct material renderer for live and committed ink.');
expect(!overlay.includes("globalCompositeOperation = 'destination-in'"), 'Highlighter must not use a first-frame-sensitive destination-in mask compositor.');
expect(overlay.includes('paintHighlighterPath(target, points, width, inkLoad, highlighterPattern(target, strokeColor));'), 'Highlighter must retain its crisp felt material through the direct renderer.');
expect(overlay.includes('function primeHighlighterMaterial(nextColor = color)'), 'Highlighter material/pattern objects must be ready before the first real packet.');
expect(overlay.includes("if (command === 'highlighter') primeHighlighterMaterial(color);"), 'Selecting highlighter must prime only its direct material, never a synthetic brush stroke.');
expect(overlay.includes('markerPoints(activeStroke.points, activeStroke.size * 2.55, true)'), 'Live highlighter geometry must match the committed geometry and avoid an end-of-stroke flash.');
expect(overlay.includes('is-screenshot-capturing'), 'Completing a selection must enter a short screenshot acknowledgement state.');
expect(css.includes('mark-screenshot-flash'), 'Completing a selection must show a short iPhone-like flash before capture.');
expect(main.includes('Clear is destructive only to ink, never to the current drawing mode.'), 'Clear must retain the active drawing session.');
expect(toolbar.includes("if (command === 'clear') restoreDrawingSurfaceAfterToolbarInteraction();"), 'Clear toolbar focus must return to drawing without exiting the mode.');
expect(!main.includes('raiseToolbarAboveOverlay();\n  });\n  ipcMain.on(\'toolbar:drag-end\''), 'Toolbar dragging must not restack the native window every move packet.');
expect(main.includes("app.setAppUserModelId('com.zhelongx.mark');"), 'Mark must own a stable Windows app identity.');
expect(slimBuild.includes('"/win32icon:$appIcon"'), 'Slim launcher must embed the purple carrot as its Explorer icon.');
expect(fs.existsSync(path.join(root, 'assets', 'icons', 'carrot-purple.ico')), 'Purple carrot ICO asset must be present for the Windows launcher.');
expect(slimBuild.includes('[string]$Revision = \'\''), 'Slim packaging must accept a visible R-number release revision.');
expect(slimBuild.includes('"ZhelongX-Mark-$version$releaseSuffix-Slim-Windows11-x64"'), 'The release revision must appear in the slim folder and zip name.');
expect(main.includes("uiStyle: 'material'"), 'Material UI must remain Mark\'s default appearance.');
expect(toolbarHtml.includes('id="uiStyle"'), 'Settings must expose the optional UI style selector.');
expect(toolbar.includes('function applyUiStyle(style)'), 'Changing UI style must swap only bitmap presentation assets.');
expect(!toolbarHtml.includes('data-flat-src="../../assets/icons/flat/carrot-flat.png"'), 'The original skeuomorphic purple carrot must remain unchanged in the flat skin.');
expect(toolbarCss.includes(':root[data-ui-style="flat"]'), 'The optional flat UI must have a scoped skin and leave the material UI untouched.');
for (const icon of ['pencil-flat.png', 'eraser-flat.png', 'highlighter-flat.png', 'clear-flat.png', 'camera-flat.png', 'palette-flat.png', 'gear-flat.png']) {
  expect(fs.existsSync(path.join(root, 'assets', 'icons', 'flat', icon)), `Flat bitmap icon must be packaged: ${icon}.`);
  expect(slimBuild.includes(`'${icon}'`), `Slim package must include flat bitmap icon: ${icon}.`);
}

if (failures.length) {
  console.error(`Overlay input audit failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Overlay input audit passed.');
