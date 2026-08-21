const canvas = document.querySelector('#canvas');
// Electron 43 accepts `desynchronized`, but a stale shared runtime may reject
// optional 2D-context hints rather than simply ignore them.  Retain the fast
// path while always falling back to a standard transparent 2D canvas.
const context = canvas.getContext('2d', { alpha: true, desynchronized: true }) || canvas.getContext('2d', { alpha: true });
const liveCanvas = document.querySelector('#live-canvas');
const liveContext = liveCanvas.getContext('2d', { alpha: true, desynchronized: true }) || liveCanvas.getContext('2d', { alpha: true });
const selectionElement = document.querySelector('#selection');
const selectionPreview = document.querySelector('#selection-preview');
const selectionInkCanvas = document.querySelector('#selection-ink');
const selectionInkContext = selectionInkCanvas.getContext('2d', { alpha: true, desynchronized: true }) || selectionInkCanvas.getContext('2d', { alpha: true });
const selectionActions = document.querySelector('#selection-actions');
const brushCursor = document.querySelector('#brush-cursor');
const selectionHandCursor = document.querySelector('#selection-hand-cursor');
const BRUSH_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
let displayId = '';
let displayBounds = { x: 0, y: 0 };
let protectedCircle = null;
let tool = 'pen';
let color = '#f04e4e';
let baseSize = 4;
let penStrength = 50;
let highlighterStrength = 50;
let boardEnabled = false;
let boardMode = 'white';
let drawingEnabled = true;
let dismissToolbarPanel = false;
let strokes = [];
let redoStack = [];
let activeStroke = null;
let selection = null;
let pendingScreenshotDataUrl = '';
let dpr = window.devicePixelRatio || 1;
let lastBrushPoint = null;
let brushCursorDiameter = 0;
let suppressedBrushEndpoint = null;
let brushCursorSuppressedUntil = 0;
let brushCursorRestoreTimer = 0;
let highlighterLiveFrame = 0;
let selectionRenderFrame = 0;
let selectionCaptureFrame = 0;
let selectionCaptureTimer = 0;
let selectionInkRenderFrame = 0;
let selectionMove = null;
let spaceHeld = false;
let lastCursorPointer = null;
let textSession = null;
let textSequence = 0;
let shutterSound = null;
let shutterSoundStopTimer = 0;
const SHUTTER_SOUND_CUE_MS = 520;
// A brief visible shutter settle gives the completed rectangle a deliberate
// endpoint and covers the two-frame native-overlay concealment used by the
// clean desktop capture. It is intentionally short enough not to make the
// screenshot tool feel like it waits before working.
const SCREENSHOT_SHUTTER_HOLD_MS = 180;
const blockedPointers = new Set();
const routedPointerEvents = new WeakSet();
let inputDiagnosticEpoch = 0;
let inputDiagnosticPointerReported = false;
let inputDiagnosticStrokeReported = false;
const PENCIL_2B = Object.freeze({ hardness: 34, fineness: 68, roughness: 150 });
// Draw's normal-grip pencil keeps its alpha contact independent from travel
// direction. A mouse uses this calm, slightly diagonal held-pencil angle;
// an actual tilted stylus may replace it with the physical barrel direction.
const PENCIL_ALPHA_ANGLE = -Math.PI * .15;
// This is Draw's accepted 2B material: a worn graphite contact shape carries
// a paper-locked deposition surface.  It is deliberately not a translucent
// vector line with noise added afterwards.
const PENCIL_GRAIN_MIN = 50;
const PENCIL_GRAIN_MAX = 200;
let graphiteMaterialTileCache = null;
const graphiteMaterialSurfaceCache = new Map();
const pencilContactShapeCache = new Map();
const highlighterMaterialTileCache = new Map();
let highlighterPatternCache = new WeakMap();

function reportInputDiagnostic(kind, detail = {}) {
  window.zmark.reportOverlayDiagnostic?.({
    kind, displayId, tool, drawing: drawingEnabled, epoch: inputDiagnosticEpoch,
    ...detail
  });
}
function resetInputDiagnosticEpoch() {
  inputDiagnosticEpoch += 1;
  inputDiagnosticPointerReported = false;
  inputDiagnosticStrokeReported = false;
}
function eventInputDetail(event, route) {
  return {
    pointerType: event.pointerType || 'mouse', button: event.button,
    buttons: event.buttons, pressure: event.pressure,
    target: event.target?.id || event.target?.tagName || '', route
  };
}
function hasTipContact(event) {
  if ((event.pointerType || 'mouse') === 'pen') return Number(event.pressure) > 0 || Boolean(Number(event.buttons) & 1);
  return Boolean(Number(event.buttons) & 1);
}

function fitCanvas() {
  dpr = window.devicePixelRatio || 1;
  [canvas, liveCanvas].forEach((surface) => {
    surface.width = Math.round(innerWidth * dpr);
    surface.height = Math.round(innerHeight * dpr);
    surface.style.width = `${innerWidth}px`;
    surface.style.height = `${innerHeight}px`;
  });
  highlighterPatternCache = new WeakMap();
  renderInk();
  refreshBrushCursor();
}
function applyBoardSurface(enabled, mode) {
  boardEnabled = Boolean(enabled);
  boardMode = mode === 'black' ? 'black' : 'white';
  if (boardEnabled) document.body.dataset.boardMode = boardMode;
  else delete document.body.dataset.boardMode;
}
function pointFrom(event) {
  return {
    x: event.clientX, y: event.clientY,
    p: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : .55,
    tiltX: event.pointerType === 'pen' ? Number(event.tiltX || 0) : 0,
    tiltY: event.pointerType === 'pen' ? Number(event.tiltY || 0) : 0
  };
}
function isBrushTool() { return BRUSH_TOOLS.has(tool); }
function brushDiameter(pressure) {
  const p = pressure > 0 ? pressure : .55;
  if (tool === 'eraser') return Math.max(4, baseSize * (2.4 + p * .8));
  if (tool === 'highlighter') return Math.max(4, baseSize * 2.55);
  const penDiameter = baseSize * (.3 + p * .95);
  return Math.max(4, penDiameter);
}
function graphiteHash(x, y, seed = 0) {
  let value = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 69069)) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}
function graphiteChannels(color) {
  const value = String(color || '#292725').replace('#', '');
  const hex = value.length === 3 ? value.split('').map((part) => part + part).join('') : value.padEnd(6, '0').slice(0, 6);
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function graphiteSmoothStep(from, to, value) {
  const t = Math.max(0, Math.min(1, (value - from) / Math.max(.0001, to - from)));
  return t * t * (3 - 2 * t);
}
function graphiteField(x, y, cells, seed) {
  const sx = x / 256 * cells;
  const sy = y / 256 * cells;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = graphiteSmoothStep(0, 1, sx - ix);
  const fy = graphiteSmoothStep(0, 1, sy - iy);
  const a = graphiteHash(ix, iy, seed);
  const b = graphiteHash(ix + 1, iy, seed);
  const c = graphiteHash(ix, iy + 1, seed);
  const d = graphiteHash(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function graphiteMaterialTile(color, material, concentration = 1) {
  const density = Math.round(Math.max(.65, Math.min(1, concentration)) * 100) / 100;
  const cacheKey = `${color}-${material.hardness}-${material.fineness}-${material.roughness}-${density}`;
  if (graphiteMaterialTileCache?.key === cacheKey) return graphiteMaterialTileCache.tile;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  const tileContext = tile.getContext('2d', { willReadFrequently: true });
  const pixels = tileContext.createImageData(tile.width, tile.height);
  const [red, green, blue] = graphiteChannels(color);
  const hardness = material.hardness / 100;
  const fineness = material.fineness / 100;
  const roughness = Math.min(1, material.roughness / 200);
  const fineCells = Math.round(70 + fineness * 150);
  const midCells = Math.round(22 + fineness * 28);
  const threshold = Math.max(.10, Math.min(.46, .21 + (roughness - .30) * .24 + (hardness - .62) * .04 + (1 - density) * .08));
  const range = .46 - roughness * .06;
  for (let y = 0; y < tile.height; y += 1) for (let x = 0; x < tile.width; x += 1) {
    const micro = graphiteHash(x, y, 137);
    const fine = graphiteField(x, y, fineCells, 53);
    const mid = graphiteField(x, y, midCells, 97);
    const warp = graphiteField(x, y, 8, 211) - .5;
    const fibre = .5 + .5 * Math.sin((((x / tile.width) * (42 + fineness * 28)) + ((y / tile.height) * (15 + fineness * 10)) + warp * .45) * Math.PI * 2);
    const field = micro * .50 + fine * .34 + mid * .12 + fibre * .04;
    const coverage = graphiteSmoothStep(threshold, threshold + range, field);
    const minimum = Math.round(18 + (1 - roughness) * 72);
    const alpha = Math.max(minimum, Math.round(255 * Math.pow(coverage, .80 + hardness * .16)));
    const index = (y * tile.width + x) * 4;
    pixels.data[index] = red;
    pixels.data[index + 1] = green;
    pixels.data[index + 2] = blue;
    pixels.data[index + 3] = alpha;
  }
  tileContext.putImageData(pixels, 0, 0);
  graphiteMaterialTileCache = { key: cacheKey, tile };
  return tile;
}
function graphiteMaterialSurface(color, material, concentration = 1, contactMinor = 8) {
  const density = Math.round(Math.max(.65, Math.min(1, concentration)) * 100) / 100;
  const fineness = material.fineness / 100;
  const grainAmount = (material.roughness - PENCIL_GRAIN_MIN) / (PENCIL_GRAIN_MAX - PENCIL_GRAIN_MIN);
  const grainSize = 1.15 + Math.max(0, Math.min(1, grainAmount)) * 1.85;
  const contactDetail = .60 + .40 * graphiteSmoothStep(2.1, 5, contactMinor);
  const scale = Math.max(.18, Math.min(3.10, .48 * Math.pow(4, .82 - fineness) * contactDetail * grainSize));
  const cacheKey = `${color}-${material.hardness}-${material.fineness}-${material.roughness}-${density}`;
  let sheet = graphiteMaterialSurfaceCache.get(cacheKey);
  if (!sheet) {
    const tile = graphiteMaterialTile(color, material, density);
    sheet = document.createElement('canvas');
    sheet.width = sheet.height = 512;
    const sheetContext = sheet.getContext('2d');
    for (let y = 0; y < sheet.height; y += tile.height) for (let x = 0; x < sheet.width; x += tile.width) sheetContext.drawImage(tile, x, y);
    graphiteMaterialSurfaceCache.set(cacheKey, sheet);
  }
  return { sheet, displaySize: Math.max(32, Math.round(sheet.width * scale)) };
}
function drawWorldFixedMaterial(target, surface, left, top, width, height) {
  const period = surface.displaySize;
  const startX = Math.floor(left / period) * period;
  const startY = Math.floor(top / period) * period;
  const right = left + width;
  const bottom = top + height;
  for (let y = startY; y < bottom; y += period) for (let x = startX; x < right; x += period) target.drawImage(surface.sheet, x, y, period, period);
}
function pencilContactShape(material) {
  const cacheKey = `${material.hardness}-${material.fineness}-${material.roughness}`;
  const cached = pencilContactShapeCache.get(cacheKey);
  if (cached) return cached;
  const roughness = Math.min(1, material.roughness / 200);
  const hardness = material.hardness / 100;
  const fineness = material.fineness / 100;
  const amplitude = Math.max(.003, Math.min(.06, .0105 + (roughness - .30) * (.034 + (1 - hardness) * .014)));
  const fineFrequency = Math.round(17 + fineness * 14);
  const points = [];
  for (let index = 0; index <= 72; index += 1) {
    const angle = index / 72 * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const radius = 1 + amplitude * Math.sin(angle * 5 + .4) + amplitude * .58 * Math.sin(angle * 11 + 1.7) + amplitude * .34 * Math.sin(angle * fineFrequency + .8);
    points.push({ cosine, cosineShape: Math.sign(cosine) * Math.pow(Math.abs(cosine), .62), sineShape: Math.sign(sine) * Math.pow(Math.abs(sine), .62), radius });
  }
  const shape = { hardness, points };
  pencilContactShapeCache.set(cacheKey, shape);
  return shape;
}
function applyPencilContactShape(target, rx, ry, material) {
  const shape = pencilContactShape(material);
  const sideBias = graphiteSmoothStep(1.8, 2.3, rx / Math.max(.001, ry));
  const section = .98 - .20 * sideBias;
  const asymmetry = .18 + (.20 + shape.hardness * .08) * sideBias;
  target.beginPath();
  shape.points.forEach((point, index) => {
    const x = point.cosineShape * rx * point.radius;
    const y = point.sineShape * ry * (section + asymmetry * point.cosine) * point.radius;
    if (index) target.lineTo(x, y); else target.moveTo(x, y);
  });
  target.closePath();
}
function pencilStrengthGain(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) / 100));
  // Same response as Draw: 50 is the natural 2B deposition reference; the
  // slider changes graphite density, never the configured contact size.
  return .05 + 1.65 * normalized + .5 * normalized * normalized;
}
function highlighterStrengthAlpha(value) {
  // 50 is the legacy Mark appearance.  The shared strength control now
  // changes marker ink load as well as graphite density, without affecting
  // the felt texture or its soft edge.
  return .18 + Math.max(0, Math.min(1, Number(value) / 100)) * .72;
}
function pencil2BProfile(a, b, size, strength = 50) {
  const pressure = Math.min(1, Math.max(.015, ((a.p || .55) + (b.p || .55)) / 2));
  const tiltX = ((a.tiltX || 0) + (b.tiltX || 0)) / 2;
  const tiltY = ((a.tiltY || 0) + (b.tiltY || 0)) / 2;
  const tilt = Math.min(1, Math.hypot(tiltX, tiltY) / 70);
  const normalGrip = 45 / 70;
  const ordinaryTilt = graphiteSmoothStep(0, normalGrip, tilt);
  const side = tilt <= normalGrip ? 0 : graphiteSmoothStep(normalGrip, 1, tilt);
  const pressureScale = 1 + (pressure - .5) * .30 * (1 - ordinaryTilt);
  const major = size * (.70 + .30 * ordinaryTilt + 4 * side) * pressureScale;
  const hardness = PENCIL_2B.hardness / 100;
  const sideRatio = ((.72 + tilt * .82) / (.35 + Math.min(.11, pressure * .08) + tilt * .24)) / (1 + pressure * .60 * (1 - tilt)) * (.94 + hardness * .10);
  const minor = Math.max(.55, major / sideRatio);
  const softness = .62 - hardness;
  const hardnessDeposit = Math.max(.45, Math.min(2.35, 1 + softness * 1.55 + Math.max(0, softness) * Math.max(0, softness) * 1.35));
  const speed = Math.hypot(b.x - a.x, b.y - a.y);
  const tiltFlow = tilt <= normalGrip ? 1 - .50 * (tilt / normalGrip) : .50 - .49 * ((tilt - normalGrip) / (1 - normalGrip));
  const deposit = pencilStrengthGain(strength) * (.10 + Math.pow(pressure, 1.08) * .92) * .9588 * hardnessDeposit * tiltFlow * (speed > 30 ? .92 : 1);
  // Crucially, travel angle never participates here. The alpha oval stays in
  // the held-pencil direction, while actual stylus tilt alone supplies a
  // physical side-front rotation and broad side contact.
  const angle = tilt > .06 ? Math.atan2(tiltY, tiltX) : PENCIL_ALPHA_ANGLE;
  return { pressure, tilt, major, minor, deposit, angle, material: PENCIL_2B };
}
function draw2BPencilDot(target, point, size, strokeColor, strength) {
  draw2BPencilSegment(target, point, { ...point, x: point.x + .1, d: (point.d || 0) + .1 }, size, strokeColor, strength);
}
function draw2BPencilSegment(target, a, b, size, strokeColor, strength) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const profile = pencil2BProfile(a, b, size, strength);
  const spacing = Math.max(.55, Math.min(6, profile.minor * .22));
  const steps = Math.max(1, Math.ceil(distance / spacing));
  const alphaCeiling = .48 + (1 - profile.material.hardness / 100) * .36;
  const surface = graphiteMaterialSurface(strokeColor, profile.material, 1, profile.minor);
  target.save();
  target.globalCompositeOperation = 'source-over';
  target.imageSmoothingEnabled = true;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const progress = Math.min(1, ((a.d || 0) + distance * t) / Math.max(8, profile.major * .25));
    const taper = .42 + .58 * progress;
    const rx = profile.major * .5 * taper;
    const ry = profile.minor * .5 * taper;
    const radius = Math.max(rx, ry) + 3;
    target.save();
    target.translate(x, y);
    target.rotate(profile.angle);
    applyPencilContactShape(target, rx, ry, profile.material);
    target.clip();
    target.rotate(-profile.angle);
    target.translate(-x, -y);
    target.globalAlpha = Math.min(alphaCeiling, .04 + profile.deposit * .33);
    drawWorldFixedMaterial(target, surface, x - radius, y - radius, radius * 2, radius * 2);
    target.restore();
  }
  target.restore();
}
function highlighterMaterialTile(color) {
  const cached = highlighterMaterialTileCache.get(color);
  if (cached) return cached;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 192;
  const tileContext = tile.getContext('2d', { willReadFrequently: true });
  const pixels = tileContext.createImageData(tile.width, tile.height);
  const [red, green, blue] = graphiteChannels(color);
  for (let y = 0; y < tile.height; y += 1) for (let x = 0; x < tile.width; x += 1) {
    // A marker has an even loaded field, with many tiny parallel felt fibres
    // and sparse pores—not paper-sized stains or random speckles.  Make that
    // material strong enough to survive normal screen scale, while keeping
    // every variation inside a narrow, uniform density band.
    const pore = graphiteHash(x, y, 451);
    const fine = graphiteField(x, y, 104, 617);
    const grain = graphiteField(x + 37, y - 19, 52, 739);
    const fleck = graphiteHash(Math.floor(x / 2), Math.floor(y / 2), 887);
    // Keep variation isotropic: a felt nib has little pores and a lightly
    // mottled ink load, but it must never resolve into directional stripes.
    const material = pore * .17 + fine * .37 + grain * .31 + fleck * .15;
    const felt = Math.max(.61, Math.min(.94, .79 + (material - .5) * .28));
    const index = (y * tile.width + x) * 4;
    pixels.data[index] = red;
    pixels.data[index + 1] = green;
    pixels.data[index + 2] = blue;
    pixels.data[index + 3] = Math.round(255 * felt);
  }
  tileContext.putImageData(pixels, 0, 0);
  highlighterMaterialTileCache.set(color, tile);
  return tile;
}
function highlighterPattern(target, color) {
  let patterns = highlighterPatternCache.get(target);
  if (!patterns) { patterns = new Map(); highlighterPatternCache.set(target, patterns); }
  const cached = patterns.get(color);
  if (cached) return cached;
  const pattern = target.createPattern(highlighterMaterialTile(color), 'repeat');
  pattern.setTransform(new DOMMatrix([.82, 0, 0, .82, 0, 0]));
  patterns.set(color, pattern);
  return pattern;
}
function primeHighlighterMaterial(nextColor = color) {
  // Only initialise the small material and pattern objects here. This is not
  // a synthetic stroke and has no blending side effects; it simply keeps the
  // first real pen packet on the same ready direct renderer as every later
  // packet.
  const key = String(nextColor || color);
  highlighterMaterialTile(key);
  highlighterPattern(context, key);
  highlighterPattern(liveContext, key);
  highlighterPattern(selectionInkContext, key);
}
function markerPoints(points, width = 18, isComplete = false) {
  // Same three stages used by mature freehand engines: discard sub-pixel pen
  // noise, reject a tiny reversal at lift-off, then streamline and resample a
  // centreline before generating an outline. A raw Windows Ink packet stream
  // is not itself a usable polygon centreline.
  const minimumDistance = Math.max(.65, Math.min(1.25, width * .045));
  const recoilLength = Math.max(5, width * .72);
  const filtered = [];
  points.forEach((point) => {
    const candidate = { ...point };
    const previous = filtered.at(-1);
    if (!previous) { filtered.push(candidate); return; }
    const distance = Math.hypot(candidate.x - previous.x, candidate.y - previous.y);
    if (distance < minimumDistance) return;
    if (filtered.length > 1) {
      const before = filtered.at(-2);
      const incoming = normalizedVector(previous.x - before.x, previous.y - before.y);
      const outgoing = normalizedVector(candidate.x - previous.x, candidate.y - previous.y);
      // A short backward flick at lift-off creates self-intersecting wide
      // polygons. Keep deliberate turns, but discard only these tiny recoils.
      if (incoming.x * outgoing.x + incoming.y * outgoing.y < -.18 && distance < recoilLength) return;
    }
    filtered.push(candidate);
  });
  if (filtered.length === 1) filtered.push({ ...filtered[0], x: filtered[0].x + .08 });
  // Causal streamlining is important while the pen is moving: unlike a
  // symmetric average it never rewrites already visible path points when the
  // next tablet packet arrives, so the brush does not visibly tremble.
  const follow = isComplete ? .80 : .68;
  const streamlined = [filtered[0]];
  for (let index = 1; index < filtered.length; index += 1) {
    const target = filtered[index];
    const previous = streamlined.at(-1);
    streamlined.push({ ...target, x: previous.x + (target.x - previous.x) * follow, y: previous.y + (target.y - previous.y) * follow });
  }
  const spacing = Math.max(1.6, Math.min(3, width * .14));
  const resampled = [streamlined[0]];
  for (let index = 1; index < streamlined.length; index += 1) {
    const from = resampled.at(-1);
    const to = streamlined[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      resampled.push({ ...to, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return resampled;
}
function normalizedVector(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}
function traceHighlighterPath(target, points) {
  target.beginPath();
  target.moveTo(points[0].x, points[0].y);
  // Dense, bevel-joined segments preserve the marker's flat chisel behavior
  // on a reversal. Quadratic interpolation turns a backtrack into a round U.
  for (let index = 1; index < points.length; index += 1) target.lineTo(points[index].x, points[index].y);
}
function paintHighlighterPath(target, points, width, alpha, strokeStyle, softness = 0) {
  target.save();
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = alpha;
  // The soft pass is the pigment's own low-alpha perimeter, not a halo layer.
  // The main material pass below remains unfiltered so the felt grain stays
  // visible at normal screen scale.
  target.filter = softness ? `blur(${softness}px)` : 'none';
  target.strokeStyle = strokeStyle;
  target.lineWidth = width;
  target.lineCap = 'butt';
  // A highlighter is a chisel nib. Bevel joins keep retraced / back-and-forth
  // movement flat and stable instead of inflating it into round blobs.
  target.lineJoin = 'bevel';
  traceHighlighterPath(target, points);
  target.stroke();
  target.restore();
}
function markerEndSegment(points, width, atStart) {
  const endpoint = points[atStart ? 0 : points.length - 1];
  const maximum = Math.max(5, width * .38);
  if (atStart) {
    for (let index = 1; index < points.length; index += 1) {
      const inside = points[index];
      if (Math.hypot(inside.x - endpoint.x, inside.y - endpoint.y) >= maximum) return { endpoint, inside };
    }
    return { endpoint, inside: points.at(-1) };
  }
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const inside = points[index];
    if (Math.hypot(inside.x - endpoint.x, inside.y - endpoint.y) >= maximum) return { endpoint, inside };
  }
  return { endpoint, inside: points[0] };
}
function paintHighlighterEndDeposit(target, points, width, color, atStart, alpha = 1) {
  // Native butt-capped terminal stroke: no self-intersecting polygon, no cap
  // extrusion, just a restrained felt-density rise that fades inward.
  const { endpoint, inside } = markerEndSegment(points, width, atStart);
  const direction = normalizedVector(inside.x - endpoint.x, inside.y - endpoint.y);
  const inward = { x: endpoint.x + direction.x * width * .46, y: endpoint.y + direction.y * width * .46 };
  const [red, green, blue] = graphiteChannels(color);
  const gradient = target.createLinearGradient(endpoint.x, endpoint.y, inward.x, inward.y);
  gradient.addColorStop(0, `rgba(${red},${green},${blue},.32)`);
  gradient.addColorStop(.42, `rgba(${red},${green},${blue},.14)`);
  gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`);
  target.save();
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = alpha;
  // The density rise stays in the crisp pigment layer; the preceding low-alpha
  // felt pass supplies the terminal's restrained outer falloff.
  target.filter = 'none';
  target.strokeStyle = gradient;
  target.lineWidth = width * .91;
  target.lineCap = 'butt';
  target.beginPath();
  target.moveTo(endpoint.x, endpoint.y);
  target.lineTo(inward.x, inward.y);
  target.stroke();
  target.restore();
}
function renderHighlighterMaterial(target, points, width, strokeColor, withEndDeposits, strength = 50) {
  const inkLoad = highlighterStrengthAlpha(strength);
  // Keep the same continuous path for both the live and committed canvases.
  // This intentionally avoids the old offscreen mask/destination-in chain:
  // on some Windows GPU paths its very first composition produced a hollow
  // outline, then corrected itself only after another real stroke.
  //
  // The first pass is only the shallow alpha falloff of a felt edge.  It uses
  // the actual pigment at a very low density, so it cannot read as a glow.
  paintHighlighterPath(target, points, width + 1.15, inkLoad * .14, strokeColor, .72);
  // The central contact uses the unblurred paper-locked material.  Its pores
  // remain crisp, while the perimeter above stays naturally soft.
  paintHighlighterPath(target, points, width, inkLoad, highlighterPattern(target, strokeColor));
  if (withEndDeposits) {
    paintHighlighterEndDeposit(target, points, width, strokeColor, true, inkLoad);
    paintHighlighterEndDeposit(target, points, width, strokeColor, false, inkLoad);
  }
}
function drawHighlighterStroke(target, stroke) {
  const width = stroke.size * 2.55;
  const points = markerPoints(stroke.points, width, true);
  renderHighlighterMaterial(target, points, width, stroke.color, true, stroke.strength);
  return 1;
}
function clearLiveHighlighter() {
  // Clear in backing-store pixels, not CSS coordinates.  When Chromium has
  // just reset the canvas transform during a high-DPI resize, CSS-space
  // clearing can leave earlier live frames behind and turn one gesture into
  // a fan of false marker bands.
  liveContext.setTransform(1, 0, 0, 1, 0, 0);
  liveContext.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  liveContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (highlighterLiveFrame) {
    cancelAnimationFrame(highlighterLiveFrame);
    highlighterLiveFrame = 0;
  }
}
function renderLiveHighlighter() {
  clearLiveHighlighter();
  if (activeStroke?.tool !== 'highlighter') return;
  // Use the exact committed geometry while the pen is down. Previously the
  // live path used a looser smoothing factor and was replaced at pointer-up
  // by a tighter final path, producing a small but visible highlighter flash.
  const points = markerPoints(activeStroke.points, activeStroke.size * 2.55, true);
  const width = activeStroke.size * 2.55;
  // The live canvas gets exactly the same direct felt renderer as the final
  // mark, without end deposits until the pointer is lifted.
  renderHighlighterMaterial(liveContext, points, width, activeStroke.color, false, activeStroke.strength);
}
function scheduleLiveHighlighterRender() {
  if (highlighterLiveFrame) return;
  highlighterLiveFrame = requestAnimationFrame(() => {
    highlighterLiveFrame = 0;
    renderLiveHighlighter();
  });
}
function clearBrushCursorRestore() {
  if (!brushCursorRestoreTimer) return;
  clearTimeout(brushCursorRestoreTimer);
  brushCursorRestoreTimer = 0;
}
function concealBrushCursor() {
  lastBrushPoint = null;
  brushCursorDiameter = 0;
  brushCursor.classList.remove('is-visible');
  document.body.classList.remove('is-brush-ready', 'is-selection-brush-ready');
  document.body.classList.add('is-brush-suppressed');
}
function hideBrushCursor() {
  clearBrushCursorRestore();
  concealBrushCursor();
  document.body.classList.remove('is-brush-suppressed');
}
function restoreBrushCursor(point, { delay = 0 } = {}) {
  clearBrushCursorRestore();
  const apply = () => {
    brushCursorRestoreTimer = 0;
    if (!drawingEnabled || activeStroke || !isBrushTool() || !point || point.protected
      || (isSelectionAnnotating() && (!isSelectionCoordinateInside(point.x, point.y) || spaceHeld || tool === 'screenshot' || selectionMove))) return hideBrushCursor();
    suppressedBrushEndpoint = null;
    brushCursorSuppressedUntil = 0;
    lastBrushPoint = point;
    refreshBrushCursor();
  };
  if (!delay) return apply();
  concealBrushCursor();
  brushCursorRestoreTimer = setTimeout(apply, delay);
}
function refreshBrushCursor() {
  const selectionBrushPoint = !isSelectionAnnotating() || (lastBrushPoint && isSelectionCoordinateInside(lastBrushPoint.x, lastBrushPoint.y)
    && !spaceHeld && tool !== 'screenshot' && !selectionMove);
  // Draw keeps a DOM ring over its canvas.  Frozen screenshots use the same
  // fast transform-only indicator even while the tip is down, so neither
  // mouse nor Windows Ink ever falls back to Chromium's crosshair.
  const selectionStrokeActive = activeStroke?.surface === 'selection' && isBrushTool();
  const visible = drawingEnabled && isBrushTool() && (!activeStroke || selectionStrokeActive) && lastBrushPoint && !lastBrushPoint.protected && selectionBrushPoint;
  brushCursor.classList.toggle('is-visible', Boolean(visible));
  document.body.classList.toggle('is-brush-ready', Boolean(visible));
  document.body.classList.toggle('is-selection-brush-ready', Boolean(visible && isSelectionAnnotating()));
  if (visible) document.body.classList.remove('is-brush-suppressed');
  if (!visible) return;
  const diameter = brushDiameter(lastBrushPoint.pressure);
  if (diameter !== brushCursorDiameter) {
    brushCursorDiameter = diameter;
    brushCursor.style.setProperty('--cursor-diameter', `${diameter}px`);
  }
  brushCursor.style.transform = `translate3d(${lastBrushPoint.x - diameter / 2}px, ${lastBrushPoint.y - diameter / 2}px, 0)`;
}
function updateBrushCursor(event, protectedPoint = isProtectedPoint(event)) {
  if (!drawingEnabled || !isBrushTool()) return hideBrushCursor();
  if (isSelectionAnnotating() && (!isPointInsideSelection(event) || spaceHeld || tool === 'screenshot' || selectionMove)) return hideBrushCursor();
  const selectionStrokeActive = activeStroke?.surface === 'selection' && activeStroke.pointerId === event.pointerId;
  // Outside a frozen screenshot, keep the endpoint clean by hiding the ring
  // under the tip.  Inside the card it is a DOM-only guide and is never
  // composited into the saved PNG, so it remains visible during the stroke.
  if ((event.buttons & 1) && !selectionStrokeActive) return hideBrushCursor();
  // Windows may enqueue one or more zero-button mouse moves immediately
  // after the release.  They arrive at the terminal pixel after the mark is
  // committed, so never let them resurrect the size ring over the end cap.
  if (performance.now() < brushCursorSuppressedUntil) return concealBrushCursor();
  if (suppressedBrushEndpoint) {
    const distance = Math.hypot(event.clientX - suppressedBrushEndpoint.x, event.clientY - suppressedBrushEndpoint.y);
    if (distance < suppressedBrushEndpoint.radius) return concealBrushCursor();
    suppressedBrushEndpoint = null;
    clearBrushCursorRestore();
  }
  lastBrushPoint = {
    x: event.clientX,
    y: event.clientY,
    pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : .55,
    protected: protectedPoint
  };
  refreshBrushCursor();
}
function isProtectedPoint(event) {
  if (!protectedCircle) return false;
  // Stay in the BrowserWindow/DIP coordinate system. PointerEvent.screenX
  // may use physical pixels for Windows Ink on a mixed-DPI desktop.
  const dx = displayBounds.x + event.clientX - protectedCircle.x;
  const dy = displayBounds.y + event.clientY - protectedCircle.y;
  return (dx * dx) + (dy * dy) <= protectedCircle.radius * protectedCircle.radius;
}
const TEXT_FONT_FAMILY = '"Microsoft YaHei UI", "Segoe UI", sans-serif';
const TEXT_LINE_HEIGHT = 1.28;
function textFont(item) {
  return `${item.italic ? 'italic ' : ''}${item.bold ? 700 : 500} ${item.fontSize}px ${item.fontFamily || TEXT_FONT_FAMILY}`;
}
function textLines(item) { return String(item.text || '').replace(/\r/g, '').split('\n'); }
function textMetrics(target, item) {
  target.save();
  target.font = textFont(item);
  const width = Math.max(1, ...textLines(item).map((line) => target.measureText(line || ' ').width));
  target.restore();
  return { width, height: Math.max(1, textLines(item).length) * item.fontSize * TEXT_LINE_HEIGHT };
}
function drawTextItem(target, item) {
  if (textSession?.item === item) return;
  target.save();
  target.font = textFont(item);
  target.fillStyle = item.color;
  target.textBaseline = 'top';
  target.textAlign = 'left';
  target.globalAlpha = 1;
  textLines(item).forEach((line, index) => target.fillText(line, item.x, item.y + index * item.fontSize * TEXT_LINE_HEIGHT));
  target.restore();
}
function textItemBounds(target, item) {
  const metric = textMetrics(target, item);
  return { left: item.x, top: item.y, right: item.x + metric.width, bottom: item.y + metric.height };
}
function textSurfaceItems(surface) { return surface === 'selection' ? selection?.strokes : strokes; }
function textSurfaceRedo(surface) { return surface === 'selection' ? selection?.redoStack : redoStack; }
function textPointForEvent(event, surface) { return surface === 'selection' ? selectionPointFrom(event) : pointFrom(event); }
function textScreenPoint(surface, point) {
  if (surface !== 'selection' || !selection) return { x: point.x, y: point.y };
  const bounds = selectionBounds(selection.start, selection.end);
  return { x: bounds.left + point.x, y: bounds.top + point.y };
}
function textTargetContext(surface) { return surface === 'selection' ? selectionInkContext : context; }
function findTextItemAt(event, surface) {
  const point = textPointForEvent(event, surface);
  const items = textSurfaceItems(surface) || [];
  const target = textTargetContext(surface);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.tool !== 'text') continue;
    const bounds = textItemBounds(target, item);
    if (point.x >= bounds.left - 6 && point.x <= bounds.right + 6 && point.y >= bounds.top - 6 && point.y <= bounds.bottom + 6) return item;
  }
  return null;
}
function refreshTextEditor() {
  const session = textSession;
  if (!session) return;
  const { editor, toolbar, style, surface, at } = session;
  const point = textScreenPoint(surface, at);
  editor.style.left = `${Math.round(point.x)}px`;
  editor.style.top = `${Math.round(point.y)}px`;
  editor.style.color = style.color;
  editor.style.font = textFont(style);
  editor.style.lineHeight = String(TEXT_LINE_HEIGHT);
  editor.style.fontStyle = style.italic ? 'italic' : 'normal';
  editor.dataset.empty = String(!editor.textContent);
  const size = toolbar.querySelector('[data-text-size]');
  const color = toolbar.querySelector('[data-text-color] i');
  const bold = toolbar.querySelector('[data-text-bold]');
  const italic = toolbar.querySelector('[data-text-italic]');
  size.value = String(style.fontSize);
  color.style.background = style.color;
  bold.classList.toggle('is-active', style.bold); bold.setAttribute('aria-pressed', String(style.bold));
  italic.classList.toggle('is-active', style.italic); italic.setAttribute('aria-pressed', String(style.italic));
  requestAnimationFrame(() => {
    if (textSession !== session) return;
    const width = toolbar.offsetWidth || 174;
    const height = toolbar.offsetHeight || 32;
    toolbar.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, Math.round(point.x)))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, Math.round(point.y - height - 9)))}px`;
  });
}
function redrawTextSurface(surface) {
  if (surface === 'selection') renderSelectionInk();
  else renderInk();
}
function closeTextEditor({ commit = true } = {}) {
  const session = textSession;
  if (!session) return false;
  const content = session.editor.innerText.replace(/\n$/, '');
  session.editor.remove();
  session.toolbar.remove();
  textSession = null;
  const items = textSurfaceItems(session.surface) || [];
  const redo = textSurfaceRedo(session.surface);
  if (!commit) {
    if (session.item && session.original) Object.assign(session.item, session.original);
  } else if (!content.trim()) {
    if (session.item) {
      const index = items.indexOf(session.item);
      if (index >= 0) items.splice(index, 1);
      redo.length = 0;
    }
  } else {
    const next = {
      tool: 'text', id: session.item?.id || `text-${Date.now()}-${++textSequence}`,
      text: content, x: session.at.x, y: session.at.y,
      fontSize: session.style.fontSize, fontFamily: session.style.fontFamily,
      color: session.style.color, bold: session.style.bold, italic: session.style.italic
    };
    if (session.item) Object.assign(session.item, next);
    else items.push(next);
    redo.length = 0;
  }
  redrawTextSurface(session.surface);
  return true;
}
function startTextEditor(event, surface) {
  if (!drawingEnabled || tool !== 'text') return false;
  if (surface === 'selection' && !isSelectionAnnotating()) return false;
  closeTextEditor({ commit: true });
  const at = textPointForEvent(event, surface);
  const item = findTextItemAt(event, surface);
  const source = item || {
    text: '', x: at.x, y: at.y, fontSize: 28, fontFamily: TEXT_FONT_FAMILY,
    color, bold: false, italic: false
  };
  const editor = document.createElement('div');
  const toolbar = document.createElement('section');
  editor.className = 'mark-text-editor';
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  editor.setAttribute('aria-label', '直接编辑文字');
  editor.textContent = source.text;
  toolbar.className = 'mark-text-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '文字输入');
  toolbar.innerHTML = '<label class="mark-text-size"><button class="mark-text-step" type="button" data-text-size-down aria-label="减小字号">−</button><input data-text-size type="text" inputmode="numeric" aria-label="字号"/><button class="mark-text-step" type="button" data-text-size-up aria-label="增大字号">+</button></label><i class="mark-text-separator" aria-hidden="true"></i><button type="button" data-text-color aria-label="文字颜色"><i aria-hidden="true"></i></button><button type="button" data-text-bold aria-label="粗体" aria-pressed="false">B</button><button type="button" data-text-italic aria-label="斜体" aria-pressed="false">I</button>';
  textSession = {
    surface, item, original: item ? { ...item } : null, at: { x: source.x, y: source.y },
    style: { fontSize: source.fontSize, fontFamily: source.fontFamily || TEXT_FONT_FAMILY, color: source.color, bold: Boolean(source.bold), italic: Boolean(source.italic) },
    editor, toolbar
  };
  const stop = (inputEvent) => inputEvent.stopPropagation();
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((type) => editor.addEventListener(type, stop));
  editor.addEventListener('input', refreshTextEditor);
  editor.addEventListener('keydown', (keyEvent) => {
    keyEvent.stopPropagation();
    // Confirming a Chinese/Japanese IME candidate also delivers Enter. That
    // remains text input; only a completed composition submits the box.
    if (keyEvent.isComposing) return;
    if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); closeTextEditor({ commit: false }); return; }
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) { keyEvent.preventDefault(); document.execCommand('insertLineBreak'); refreshTextEditor(); return; }
    if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); closeTextEditor({ commit: true }); }
  });
  const size = toolbar.querySelector('[data-text-size]');
  const setTextSize = (value) => {
    if (!textSession) return;
    textSession.style.fontSize = Math.max(8, Math.min(160, Number(value) || 28));
    refreshTextEditor();
  };
  size.addEventListener('input', () => setTextSize(size.value));
  size.addEventListener('keydown', (sizeEvent) => {
    if (sizeEvent.key !== 'ArrowUp' && sizeEvent.key !== 'ArrowDown') return;
    sizeEvent.preventDefault();
    setTextSize((textSession?.style.fontSize || 28) + (sizeEvent.key === 'ArrowUp' ? 1 : -1));
  });
  toolbar.querySelector('[data-text-size-down]').addEventListener('click', () => setTextSize((textSession?.style.fontSize || 28) - 1));
  toolbar.querySelector('[data-text-size-up]').addEventListener('click', () => setTextSize((textSession?.style.fontSize || 28) + 1));
  toolbar.querySelector('[data-text-color]').addEventListener('click', () => window.zmark.annotationShortcut('palette'));
  toolbar.querySelector('[data-text-bold]').addEventListener('click', () => { if (textSession) { textSession.style.bold = !textSession.style.bold; refreshTextEditor(); textSession.editor.focus({ preventScroll: true }); } });
  toolbar.querySelector('[data-text-italic]').addEventListener('click', () => { if (textSession) { textSession.style.italic = !textSession.style.italic; refreshTextEditor(); textSession.editor.focus({ preventScroll: true }); } });
  toolbar.addEventListener('pointerdown', (toolbarEvent) => toolbarEvent.stopPropagation());
  document.body.append(editor, toolbar);
  redrawTextSurface(surface);
  refreshTextEditor();
  requestAnimationFrame(() => {
    if (textSession?.editor !== editor) return;
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(editor); range.collapse(false);
    const documentSelection = getSelection();
    documentSelection?.removeAllRanges(); documentSelection?.addRange(range);
  });
  return true;
}
function drawSegment(target, a, b, selectedTool, strokeColor, size, strength) {
  if (selectedTool === 'pen') return draw2BPencilSegment(target, a, b, size, strokeColor, strength);
  const pressure = Math.max(.12, (a.p + b.p) / 2);
  const erasing = selectedTool === 'eraser';
  const highlighter = selectedTool === 'highlighter';
  const width = erasing ? size * (2.4 + pressure * .8) : highlighter ? size * 2.55 : size * (.3 + pressure * .95);
  target.save();
  target.lineCap = highlighter ? 'butt' : 'round'; target.lineJoin = highlighter ? 'miter' : 'round';
  target.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  target.strokeStyle = strokeColor;
  target.globalAlpha = erasing ? 1 : (highlighter ? highlighterStrengthAlpha(strength) : Math.min(.94, .36 + pressure * .65));
  target.lineWidth = width;
  target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
  target.restore();
}
function drawStroke(target, stroke, { live = false } = {}) {
  if (stroke.tool === 'text') return drawTextItem(target, stroke);
  if (stroke.tool === 'highlighter') {
    if (!live) return drawHighlighterStroke(target, stroke);
    const width = stroke.size * 2.55;
    return renderHighlighterMaterial(target, markerPoints(stroke.points, width, true), width, stroke.color, false, stroke.strength);
  }
  if (stroke.points.length === 1) {
    const point = stroke.points[0]; const erasing = stroke.tool === 'eraser';
    if (stroke.tool === 'pen') return draw2BPencilDot(target, point, stroke.size, stroke.color, stroke.strength);
    target.save(); target.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'; target.fillStyle = stroke.color; target.globalAlpha = erasing ? 1 : (stroke.tool === 'highlighter' ? .3 : .7);
    if (stroke.tool === 'highlighter') {
      const side = stroke.size * 2.55;
      target.globalAlpha = highlighterStrengthAlpha(stroke.strength);
      target.fillRect(point.x - side / 2, point.y - side / 2, side, side);
    } else {
      target.beginPath(); target.arc(point.x, point.y, stroke.size * (erasing ? 1.5 : (.35 + point.p)), 0, Math.PI * 2); target.fill();
    }
    target.restore();
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) drawSegment(target, stroke.points[index - 1], stroke.points[index], stroke.tool, stroke.color, stroke.size, stroke.strength);
}
function renderInk() {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, innerWidth, innerHeight);
  strokes.forEach((stroke) => drawStroke(context, stroke));
  if (activeStroke && activeStroke.surface !== 'selection' && activeStroke.tool !== 'highlighter') drawStroke(context, activeStroke);
  renderLiveHighlighter();
}
function selectionBounds(start, end) {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}
function isSelectionAnnotating() { return selection?.phase === 'annotating'; }
function isSelectionCoordinateInside(x, y) {
  if (!isSelectionAnnotating()) return false;
  const bounds = selectionBounds(selection.start, selection.end);
  return x >= bounds.left && x <= bounds.left + bounds.width && y >= bounds.top && y <= bounds.top + bounds.height;
}
function isPointInsideSelection(event) {
  return isSelectionCoordinateInside(event.clientX, event.clientY);
}
function hideSelectionHandCursor() {
  selectionHandCursor.classList.remove('is-visible', 'is-grabbing');
  document.body.classList.remove('is-selection-move-ready', 'is-selection-moving');
}
function updateSelectionHandCursor(event) {
  if (event) {
    lastCursorPointer = {
      x: event.clientX, y: event.clientY, pointerId: event.pointerId,
      buttons: Number(event.buttons || 0), pointerType: event.pointerType || 'mouse'
    };
  }
  const point = lastCursorPointer;
  const moveMode = Boolean(point && isSelectionAnnotating() && isSelectionCoordinateInside(point.x, point.y)
    && (spaceHeld || tool === 'screenshot' || selectionMove));
  const grabbing = Boolean(moveMode && selectionMove?.pointerId === point?.pointerId && (point.buttons & 1));
  selectionHandCursor.classList.toggle('is-visible', moveMode);
  selectionHandCursor.classList.toggle('is-grabbing', grabbing);
  document.body.classList.toggle('is-selection-move-ready', moveMode);
  document.body.classList.toggle('is-selection-moving', grabbing);
  if (!moveMode) return;
  // Preserve Chromium's original 32px CUR hotspot (13, 13), so both DOM
  // states stay precisely under a mouse or stylus rather than trailing it.
  selectionHandCursor.style.transform = `translate3d(${point.x - 13}px, ${point.y - 13}px, 0)`;
}
function refreshSelectionHandCursor() { updateSelectionHandCursor(); }
function selectionPointFrom(event) {
  const bounds = selectionBounds(selection.start, selection.end);
  const source = pointFrom(event);
  return {
    ...source,
    x: Math.max(0, Math.min(bounds.width, source.x - bounds.left)),
    y: Math.max(0, Math.min(bounds.height, source.y - bounds.top))
  };
}
function configureSelectionInk() {
  if (!selection) return;
  const bounds = selectionBounds(selection.start, selection.end);
  const width = Math.max(1, Math.round(bounds.width * dpr));
  const height = Math.max(1, Math.round(bounds.height * dpr));
  selectionInkCanvas.width = width;
  selectionInkCanvas.height = height;
  selection.inkScaleX = width / Math.max(1, bounds.width);
  selection.inkScaleY = height / Math.max(1, bounds.height);
  selectionInkContext.setTransform(1, 0, 0, 1, 0, 0);
  selectionInkContext.clearRect(0, 0, width, height);
  selectionInkContext.setTransform(selection.inkScaleX, 0, 0, selection.inkScaleY, 0, 0);
  highlighterPatternCache.delete?.(selectionInkContext);
}
function clearSelectionInkSurface() {
  if (selectionInkRenderFrame) cancelAnimationFrame(selectionInkRenderFrame);
  selectionInkRenderFrame = 0;
  selectionInkContext.setTransform(1, 0, 0, 1, 0, 0);
  selectionInkContext.clearRect(0, 0, selectionInkCanvas.width, selectionInkCanvas.height);
  selectionInkCanvas.width = selectionInkCanvas.height = 1;
}
function renderSelectionInk() {
  if (!isSelectionAnnotating()) return;
  selectionInkContext.setTransform(1, 0, 0, 1, 0, 0);
  selectionInkContext.clearRect(0, 0, selectionInkCanvas.width, selectionInkCanvas.height);
  selectionInkContext.setTransform(selection.inkScaleX || dpr, 0, 0, selection.inkScaleY || dpr, 0, 0);
  selection.strokes.forEach((stroke) => drawStroke(selectionInkContext, stroke));
  if (activeStroke?.surface === 'selection') drawStroke(selectionInkContext, activeStroke, { live: true });
}
function scheduleSelectionInkRender() {
  if (selectionInkRenderFrame) return;
  selectionInkRenderFrame = requestAnimationFrame(() => {
    selectionInkRenderFrame = 0;
    renderSelectionInk();
  });
}
function beginSelectionAnnotation(event) {
  if (!isPointInsideSelection(event) || !isBrushTool()) return false;
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = 0;
  clearBrushCursorRestore();
  activeStroke = {
    pointerId: event.pointerId, tool, color, size: baseSize,
    strength: tool === 'highlighter' ? highlighterStrength : penStrength,
    points: [{ ...selectionPointFrom(event), d: 0 }], surface: 'selection'
  };
  updateBrushCursor(event, false);
  scheduleSelectionInkRender();
  return true;
}
function beginSelectionMove(event) {
  if (!isSelectionAnnotating() || !isPointInsideSelection(event)) return false;
  const bounds = selectionBounds(selection.start, selection.end);
  selectionMove = {
    pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    start: { ...selection.start }, end: { ...selection.end }, width: bounds.width, height: bounds.height, moved: false
  };
  hideBrushCursor();
  updateSelectionHandCursor(event);
  return true;
}
function moveSelectionFrame(event) {
  if (!selectionMove || !selection || selectionMove.pointerId !== event.pointerId) return false;
  if (!selectionMove.moved && Math.hypot(event.clientX - selectionMove.startX, event.clientY - selectionMove.startY) < 3) return true;
  selectionMove.moved = true;
  const edge = 24;
  const left = Math.max(-selectionMove.width + edge, Math.min(innerWidth - edge, selectionMove.start.x + event.clientX - selectionMove.startX));
  const top = Math.max(-selectionMove.height + edge, Math.min(innerHeight - edge, selectionMove.start.y + event.clientY - selectionMove.startY));
  const dx = left - selectionMove.start.x;
  const dy = top - selectionMove.start.y;
  selection.start = { ...selectionMove.start, x: left, y: top };
  selection.end = { ...selectionMove.end, x: selectionMove.end.x + dx, y: selectionMove.end.y + dy };
  renderSelection();
  updateSelectionHandCursor(event);
  return true;
}
function clearSelection() {
  if (textSession?.surface === 'selection') closeTextEditor({ commit: true });
  if (selectionRenderFrame) cancelAnimationFrame(selectionRenderFrame);
  selectionRenderFrame = 0;
  if (selectionCaptureFrame) cancelAnimationFrame(selectionCaptureFrame);
  selectionCaptureFrame = 0;
  if (selectionCaptureTimer) clearTimeout(selectionCaptureTimer);
  selectionCaptureTimer = 0;
  selectionMove = null;
  lastCursorPointer = null;
  hideSelectionHandCursor();
  clearSelectionInkSurface();
  selection = null;
  pendingScreenshotDataUrl = '';
  selectionPreview.removeAttribute('src');
  selectionElement.classList.remove('is-frozen', 'is-capture-committing');
  document.body.classList.remove('is-screenshot-capturing');
  selectionActions.classList.remove('is-visible', 'is-busy');
  selectionActions.setAttribute('aria-hidden', 'true');
  renderSelection();
}
function scheduleSelectionRender() {
  if (selectionRenderFrame) return;
  selectionRenderFrame = requestAnimationFrame(() => {
    selectionRenderFrame = 0;
    renderSelection();
  });
}
function renderSelection() {
  if (!selection) {
    selectionElement.classList.remove('is-visible');
    return;
  }
  const bounds = selectionBounds(selection.start, selection.end);
  Object.assign(selectionElement.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  selectionElement.classList.add('is-visible');
  const isAnnotating = selection.phase === 'annotating';
  selectionActions.classList.toggle('is-visible', isAnnotating);
  selectionActions.setAttribute('aria-hidden', String(!isAnnotating));
  if (!isAnnotating) return;
  const actionWidth = 190;
  const actionHeight = 40;
  const left = Math.max(8, Math.min(innerWidth - actionWidth - 8, bounds.left + (bounds.width - actionWidth) / 2));
  const below = bounds.top + bounds.height + 10;
  const top = below + actionHeight <= innerHeight - 8 ? below : Math.max(8, bounds.top - actionHeight - 8);
  Object.assign(selectionActions.style, { left: `${left}px`, top: `${top}px` });
}
function compositeSelectionCapture(screenshot, bounds, { sourceIncludesInk = false, boardMode: capturedBoardMode = '' } = {}) {
  const left = Math.max(0, Math.floor(bounds.left * dpr));
  const top = Math.max(0, Math.floor(bounds.top * dpr));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(bounds.width * dpr)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(bounds.height * dpr)));
  // A board is generated locally instead of hiding its opaque overlay and
  // reading the desktop below it. Its frozen card therefore always matches
  // the editable surface and enters without a capture pause.
  if (capturedBoardMode) {
    const crop = document.createElement('canvas');
    crop.width = width; crop.height = height;
    const cropContext = crop.getContext('2d');
    cropContext.fillStyle = capturedBoardMode === 'black' ? '#292826' : '#f5ecda';
    cropContext.fillRect(0, 0, width, height);
    cropContext.drawImage(canvas, left, top, width, height, 0, 0, width, height);
    return Promise.resolve(crop.toDataURL('image/png'));
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const crop = document.createElement('canvas');
      // Main sends an already cropped native bitmap. Keep its true pixel size
      // instead of decoding a full desktop PNG only to throw most away here.
      crop.width = image.naturalWidth; crop.height = image.naturalHeight;
      const cropContext = crop.getContext('2d');
      cropContext.imageSmoothingEnabled = false;
      cropContext.drawImage(image, 0, 0, crop.width, crop.height);
      if (!sourceIncludesInk) cropContext.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height);
      resolve(crop.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('无法读取实时屏幕')); image.src = screenshot;
  });
}
function composeSelectionAnnotation() {
  if (!selection || !pendingScreenshotDataUrl) return Promise.reject(new Error('截图尚未准备好'));
  renderSelectionInk();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const output = document.createElement('canvas');
      output.width = image.naturalWidth; output.height = image.naturalHeight;
      const outputContext = output.getContext('2d');
      outputContext.imageSmoothingEnabled = true;
      outputContext.drawImage(image, 0, 0);
      outputContext.drawImage(selectionInkCanvas, 0, 0, output.width, output.height);
      resolve(output.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('无法合成截图标注'));
    image.src = pendingScreenshotDataUrl;
  });
}
function primeShutterSound() {
  if (shutterSound) return shutterSound;
  try {
    shutterSound = new Audio('../../assets/audio/shutter-f4-cc0.mp3');
    shutterSound.preload = 'auto';
    shutterSound.volume = .54;
    shutterSound.load();
    return shutterSound;
  } catch { return null; }
}
function playShutterSound() {
  // A verified CC0 Nikon F4 field recording is preloaded while the overlay
  // initializes, then cued only at a completed selection. The audible slice
  // ends before the long motor-drive tail, keeping it a compact shutter cue.
  const sound = primeShutterSound();
  if (!sound) return;
  try {
    if (shutterSoundStopTimer) clearTimeout(shutterSoundStopTimer);
    sound.pause(); sound.currentTime = 0;
    sound.play().catch(() => {});
    shutterSoundStopTimer = setTimeout(() => {
      sound.pause(); sound.currentTime = 0; shutterSoundStopTimer = 0;
    }, SHUTTER_SOUND_CUE_MS);
  } catch { /* Sound is a garnish; capture must remain available without audio. */ }
}
function finishSelection() {
  const bounds = selectionBounds(selection.start, selection.end);
  if (bounds.width >= 4 && bounds.height >= 4) {
    selection.phase = 'capturing';
    // Keep entry to rectangle selection entirely idle. Only at completion do
    // we play the short camera flash, then acquire the frozen source. It is
    // deliberately an acknowledgement of the completed gesture, never a
    // blocker before the user can start dragging.
    selectionElement.classList.add('is-capture-committing');
    document.body.classList.add('is-screenshot-capturing');
    playShutterSound();
    renderSelection();
    // Paint the finished frame before capture begins, then let one short,
    // continuous shutter settle absorb the native overlay's clean-conceal
    // hand-off. The rectangle remains visibly present throughout that beat;
    // it only vanishes while the underlying desktop pixels are read, so the
    // saved PNG never contains the selection chrome.
    selectionCaptureFrame = requestAnimationFrame(() => {
      selectionCaptureFrame = 0;
      selectionCaptureTimer = setTimeout(() => {
        selectionCaptureTimer = 0;
        selectionElement.classList.remove('is-capture-committing');
        document.body.classList.remove('is-screenshot-capturing');
        if (!selection || selection.phase !== 'capturing') return;
        window.zmark.requestSelectionCapture({ displayId, bounds });
      }, SCREENSHOT_SHUTTER_HOLD_MS);
    });
  } else {
    clearSelection();
    tool = 'pen';
    document.body.classList.remove('is-screenshot');
  }
}
function appendCoalesced(event) {
  if (!activeStroke || event.pointerId !== activeStroke.pointerId) return;
  // Windows Ink can emit a zero-button hover move (and stale coalesced
  // samples) immediately after a pen leaves the tablet. A marker's square
  // terminal makes that phantom tail very visible, while mouse events do not
  // normally carry it. Highlighter therefore accepts only the live pressed
  // sample; its own 2.4px resampler supplies the missing density smoothly.
  if (!(event.buttons & 1)) return;
  // Pen packets are often delivered in coalesced batches. Dropping them was
  // the direct cause of the marker's stair-stepped live path; stale hover
  // packets are already rejected below by their released button state.
  const events = event.getCoalescedEvents?.() || [];
  const samples = events.length ? [...events] : [event];
  const latest = samples.at(-1);
  if (!latest || Math.abs(latest.clientX - event.clientX) > .01 || Math.abs(latest.clientY - event.clientY) > .01) samples.push(event);
  const selectionStroke = activeStroke.surface === 'selection';
  for (const item of samples) {
    if (!(item.buttons & 1)) continue;
    const nextPoint = selectionStroke ? selectionPointFrom(item) : pointFrom(item);
    const previousPoint = activeStroke.points.at(-1);
    nextPoint.d = (previousPoint?.d || 0) + (previousPoint ? Math.hypot(nextPoint.x - previousPoint.x, nextPoint.y - previousPoint.y) : 0);
    activeStroke.points.push(nextPoint);
    if (selectionStroke) {
      scheduleSelectionInkRender();
    } else if (previousPoint && activeStroke.tool === 'highlighter') {
      // Tablet packets arrive far more often than mouse packets. Append just
      // their new contact segment instead of replaying the whole live stroke.
      scheduleLiveHighlighterRender();
    } else if (previousPoint) drawSegment(context, previousPoint, nextPoint, activeStroke.tool, activeStroke.color, activeStroke.size, activeStroke.strength);
  }
}
function commitActiveStroke() {
  if (!activeStroke) return;
  const completedStroke = activeStroke;
  if (completedStroke.surface === 'selection') {
    if (isSelectionAnnotating()) {
      selection.strokes.push(completedStroke);
      selection.redoStack = [];
    }
    activeStroke = null;
    renderSelectionInk();
    return;
  }
  if (completedStroke.tool === 'highlighter') {
    // The preview and committed mark share the same contact-dab engine; only
    // the live canvas is transient while the pointer is still down.
    drawHighlighterStroke(context, completedStroke);
    clearLiveHighlighter();
  }
  strokes.push(completedStroke);
  redoStack = [];
  activeStroke = null;
  if (!inputDiagnosticStrokeReported) {
    inputDiagnosticStrokeReported = true;
    reportInputDiagnostic('stroke-committed', { phase: completedStroke.tool, pointerType: completedStroke.pointerType || '' });
  }
  if (completedStroke.points.length === 1 && completedStroke.tool !== 'highlighter') drawStroke(context, completedStroke);
}
function beginPointer(event) {
  const protectedPoint = isProtectedPoint(event);
  updateSelectionHandCursor(event);
  updateBrushCursor(event, protectedPoint);
  if (!drawingEnabled || (event.button !== 0 && event.pointerType !== 'pen')) return;
  if (protectedPoint) {
    blockedPointers.add(event.pointerId);
    return false;
  }
  if (tool === 'text') {
    if (selection?.phase === 'selecting') clearSelection();
    if (selection && !isSelectionAnnotating()) return false;
    return startTextEditor(event, isSelectionAnnotating() ? 'selection' : 'screen');
  }
  if (tool === 'screenshot' && !selection) { selection = { start: pointFrom(event), end: pointFrom(event), phase: 'selecting' }; renderSelection(); return true; }
  if (isSelectionAnnotating()) {
    if (spaceHeld || tool === 'screenshot') return beginSelectionMove(event);
    return beginSelectionAnnotation(event);
  }
  if (selection) return false;
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = 0;
  clearBrushCursorRestore();
  activeStroke = {
    pointerId: event.pointerId, tool, color, size: baseSize,
    strength: tool === 'highlighter' ? highlighterStrength : penStrength,
    points: [{ ...pointFrom(event), d: 0 }]
  };
  if (!inputDiagnosticStrokeReported) reportInputDiagnostic('stroke-begin', eventInputDetail(event, 'overlay'));
  hideBrushCursor();
  if (tool === 'highlighter') renderLiveHighlighter();
  return true;
}
function movePointer(event) {
  const protectedPoint = isProtectedPoint(event);
  updateSelectionHandCursor(event);
  updateBrushCursor(event, protectedPoint);
  if (!drawingEnabled) return;
  if (moveSelectionFrame(event)) return;
  if (activeStroke && event.pointerId !== activeStroke.pointerId) return;
  if (blockedPointers.has(event.pointerId)) return;
  if (protectedPoint) {
    if (selection?.phase === 'selecting') clearSelection();
    commitActiveStroke();
    blockedPointers.add(event.pointerId);
    return;
  }
  if (selection?.phase === 'selecting') { selection.end = pointFrom(event); scheduleSelectionRender(); return; }
  // Some Windows Ink stacks expose the first tip contact as a pressed move
  // after a transparent window gains focus.  Start that contact directly
  // rather than waiting for a pointerdown that will never be replayed.
  if (!activeStroke && hasTipContact(event)) {
    if (beginPointer(event)) {
      try { canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
    }
    return;
  }
  appendCoalesced(event);
}
function endPointer(event) {
  if (blockedPointers.delete(event.pointerId)) return;
  if (selectionMove?.pointerId === event.pointerId) { selectionMove = null; updateSelectionHandCursor(event); refreshBrushCursor(); return; }
  if (selection?.phase === 'selecting') return finishSelection();
  // A PointerEvent release is the canonical completion signal.  Do not let a
  // duplicate legacy mouseup (or a second native release routed by Windows)
  // hide the cursor that the first completion just restored.
  if (!activeStroke || event.pointerId !== activeStroke.pointerId) return;
  const endpoint = activeStroke?.points.at(-1);
  const completedTool = activeStroke.tool;
  const selectionStroke = activeStroke.surface === 'selection';
  commitActiveStroke();
  // A marker's flat terminal must stay free of the round aiming ring. Pencil
  // and eraser do not have that ambiguity, so their circle cursor returns at
  // the lifted pointer position even if the mouse remains still.
  if (completedTool === 'highlighter' && endpoint) {
    const point = {
      x: Number.isFinite(event.clientX) ? event.clientX : endpoint.x,
      y: Number.isFinite(event.clientY) ? event.clientY : endpoint.y,
      pressure: endpoint.p ?? .55,
      protected: isProtectedPoint(event)
    };
    const terminal = selectionStroke ? { x: event.clientX, y: event.clientY, p: endpoint.p } : endpoint;
    suppressedBrushEndpoint = { x: terminal.x, y: terminal.y, radius: Math.max(12, brushDiameter(terminal.p) * 1.15) };
    brushCursorSuppressedUntil = performance.now() + 140;
    restoreBrushCursor(point, { delay: 140 });
    return;
  }
  if (!drawingEnabled || !BRUSH_TOOLS.has(completedTool)) return hideBrushCursor();
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = 0;
  restoreBrushCursor({
      x: Number.isFinite(event.clientX) ? event.clientX : endpoint?.x,
      y: Number.isFinite(event.clientY) ? event.clientY : endpoint?.y,
    pressure: endpoint?.p ?? (event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : .55),
    protected: isProtectedPoint(event)
  });
}
function cancelPointer(event) {
  if (selectionMove?.pointerId === event.pointerId) {
    selectionMove = null;
    updateSelectionHandCursor(event);
    refreshBrushCursor();
    return;
  }
  const interruptedStroke = activeStroke;
  blockedPointers.delete(event.pointerId);
  hideBrushCursor();
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = performance.now() + 800;
  if (interruptedStroke?.surface === 'selection') {
    activeStroke = null;
    renderSelectionInk();
    refreshBrushCursor();
    return;
  }
  clearSelection();
  activeStroke = null;
  clearLiveHighlighter();
  renderInk();
  if (!drawingEnabled || !interruptedStroke || !BRUSH_TOOLS.has(interruptedStroke.tool)) return;
  const endpoint = interruptedStroke.points.at(-1);
  if (!endpoint) return;
  const point = { x: endpoint.x, y: endpoint.y, pressure: endpoint.p ?? .55, protected: false };
  if (interruptedStroke.tool === 'highlighter') {
    suppressedBrushEndpoint = { x: endpoint.x, y: endpoint.y, radius: Math.max(12, brushDiameter(endpoint.p) * 1.15) };
    brushCursorSuppressedUntil = performance.now() + 140;
    restoreBrushCursor(point, { delay: 140 });
    return;
  }
  restoreBrushCursor(point);
}
function isTextSessionTarget(target) {
  return Boolean(textSession && (textSession.editor.contains(target) || textSession.toolbar.contains(target)));
}
function routePointerDown(event, route) {
  if (dismissToolbarPanel) {
    // A popup's first canvas contact has two deliberate variants. A live
    // brush owns that contact, so it closes the popup *and* uses the same
    // packet as the first mark. With no brush (including Text) it is a pure
    // Cancel and must never create an accidental mark beneath the popup.
    const continueDrawing = drawingEnabled && BRUSH_TOOLS.has(tool);
    dismissToolbarPanel = false;
    window.zmark.dismissToolbarPanel({ continueDrawing });
    if (!continueDrawing) {
      routedPointerEvents.add(event);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  if (routedPointerEvents.has(event) || selectionActions.contains(event.target) || isTextSessionTarget(event.target)) return;
  routedPointerEvents.add(event);
  if (drawingEnabled && !inputDiagnosticPointerReported) {
    inputDiagnosticPointerReported = true;
    reportInputDiagnostic('pointer-down', eventInputDetail(event, route));
  }
  if (beginPointer(event)) {
    try { canvas.setPointerCapture(event.pointerId); } catch { /* optional */ }
  }
}
function routePointerMove(event, route) {
  if (routedPointerEvents.has(event)) return;
  if (isTextSessionTarget(event.target)) return;
  if (selectionActions.contains(event.target)) {
    lastCursorPointer = null;
    hideSelectionHandCursor();
    hideBrushCursor();
    return;
  }
  routedPointerEvents.add(event);
  movePointer(event);
}
// A transparent always-on-top window can occasionally target BODY or HTML
// instead of the fully sized canvas on Windows.  Route from the window in the
// capture phase so the entire overlay has one Pointer Events contract; canvas
// listeners remain as a normal-event fallback and the WeakSet de-duplicates
// their shared event object.
window.addEventListener('pointerdown', (event) => routePointerDown(event, 'window-capture'), true);
window.addEventListener('pointermove', (event) => routePointerMove(event, 'window-capture'), true);
canvas.addEventListener('pointerdown', (event) => routePointerDown(event, 'canvas'));
canvas.addEventListener('pointermove', (event) => routePointerMove(event, 'canvas'));
// Transparent always-on-top windows on Windows can route the release outside
// the canvas even after an accepted down.  The release must still commit the
// mark and clear the visual size ring, so observe it at the window boundary.
window.addEventListener('pointerup', endPointer, true);
window.addEventListener('pointercancel', cancelPointer, true);
window.addEventListener('pointerleave', () => {
  lastCursorPointer = null;
  hideSelectionHandCursor();
  hideBrushCursor();
}, true);
selectionActions.addEventListener('pointerdown', (event) => event.stopPropagation());
selectionActions.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-screenshot-action]')?.dataset.screenshotAction;
  if (!action || !selection || selection.phase !== 'annotating') return;
  event.preventDefault();
  event.stopPropagation();
  selectionActions.classList.add('is-busy');
  try {
    const dataUrl = action === 'cancel' ? '' : await composeSelectionAnnotation();
    const result = await window.zmark.screenshotAction({ action, displayId, dataUrl });
    if (result?.completed) clearSelection();
    else selectionActions.classList.remove('is-busy');
  } catch {
    selectionActions.classList.remove('is-busy');
  }
});
window.addEventListener('keydown', (event) => {
  if (isTextSessionTarget(event.target)) return;
  if (isSelectionAnnotating() && event.code === 'Space') {
    spaceHeld = true;
    refreshSelectionHandCursor();
    refreshBrushCursor();
    event.preventDefault();
    return;
  }
  if (!drawingEnabled) return;
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
window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  spaceHeld = false;
  if (isSelectionAnnotating()) {
    refreshSelectionHandCursor();
    refreshBrushCursor();
    event.preventDefault();
  }
});
window.addEventListener('resize', fitCanvas);
window.zmark.on('overlay:initialize', (payload) => {
  displayId = payload.displayId; displayBounds = payload.displayBounds || displayBounds; protectedCircle = payload.circle || null; color = payload.color; baseSize = payload.size; penStrength = payload.penStrength ?? payload.strength ?? penStrength; highlighterStrength = payload.highlighterStrength ?? payload.strength ?? highlighterStrength; tool = payload.tool || 'pen'; drawingEnabled = payload.drawing;
  document.documentElement.dataset.theme = payload.theme || 'light';
  applyBoardSurface(payload.boardEnabled, payload.boardMode);
  document.body.classList.toggle('is-screenshot', tool === 'screenshot'); document.body.classList.toggle('is-text-tool', tool === 'text'); primeShutterSound(); fitCanvas(); refreshBrushCursor(); resetInputDiagnosticEpoch(); reportInputDiagnostic('initialized', { phase: 'ready', route: 'renderer', dpr, viewport: `${innerWidth}x${innerHeight}` }); window.zmark.overlayReady(displayId);
});
window.zmark.on('overlay:selection-source', ({ screenshot, bounds, sourceIsSelection = false, sourceIncludesInk = false, boardMode: capturedBoardMode = '' }) => {
  if (!sourceIsSelection) return clearSelection();
  compositeSelectionCapture(screenshot, bounds, { sourceIncludesInk, boardMode: capturedBoardMode }).then((dataUrl) => {
    if (!selection) return;
    pendingScreenshotDataUrl = dataUrl;
    selection.phase = 'annotating';
    selection.strokes = [];
    selection.redoStack = [];
    configureSelectionInk();
    selectionElement.classList.remove('is-capture-committing');
    document.body.classList.remove('is-screenshot-capturing');
    selectionPreview.src = dataUrl;
    selectionElement.classList.add('is-frozen');
    renderSelection();
    refreshSelectionHandCursor();
    refreshBrushCursor();
  }).catch(() => clearSelection());
});
window.zmark.on('overlay:command', ({ command, ...detail }) => {
  if (command === 'panel:dismiss') {
    dismissToolbarPanel = Boolean(detail.active);
    window.zmark.panelDismissSynced?.({ displayId, active: dismissToolbarPanel, generation: detail.generation });
  }
  if (['pen', 'highlighter', 'eraser', 'screenshot', 'text'].includes(command)) {
    // Tool selection is a positive drawing action. It must never inherit a
    // previous palette's one-click cancellation state.
    dismissToolbarPanel = false;
    if (textSession && command !== 'text') closeTextEditor({ commit: true });
    if (command !== 'screenshot' && !isSelectionAnnotating()) clearSelection();
    if (command === 'highlighter') primeHighlighterMaterial(color);
    tool = command;
    document.body.classList.toggle('is-screenshot', command === 'screenshot');
    document.body.classList.toggle('is-text-tool', command === 'text');
    if (command === 'screenshot') hideBrushCursor();
    else refreshBrushCursor();
    refreshSelectionHandCursor();
  }
  if (command === 'undo') {
    if (isSelectionAnnotating() && selection.strokes.length) { selection.redoStack.push(selection.strokes.pop()); renderSelectionInk(); }
    else if (strokes.length) { redoStack.push(strokes.pop()); renderInk(); }
  }
  if (command === 'redo') {
    if (isSelectionAnnotating() && selection.redoStack.length) { selection.strokes.push(selection.redoStack.pop()); renderSelectionInk(); }
    else if (redoStack.length) { strokes.push(redoStack.pop()); renderInk(); }
  }
  if (command === 'clear') {
    closeTextEditor({ commit: true });
    if (isSelectionAnnotating()) { selection.strokes = []; selection.redoStack = []; activeStroke = null; renderSelectionInk(); }
    else { strokes = []; redoStack = []; activeStroke = null; renderInk(); }
  }
  if (command === 'drawing:off') { closeTextEditor({ commit: true }); commitActiveStroke(); drawingEnabled = false; blockedPointers.clear(); clearSelection(); hideBrushCursor(); reportInputDiagnostic('drawing-off', { phase: command, route: 'renderer' }); }
  if (command === 'drawing:on') { drawingEnabled = true; resetInputDiagnosticEpoch(); refreshBrushCursor(); reportInputDiagnostic('drawing-on', { phase: command, route: 'renderer' }); }
  if (command === 'settings') { color = detail.color; baseSize = detail.size; penStrength = detail.penStrength ?? detail.strength ?? penStrength; highlighterStrength = detail.highlighterStrength ?? detail.strength ?? highlighterStrength; document.documentElement.dataset.theme = detail.theme || document.documentElement.dataset.theme || 'light'; applyBoardSurface(detail.boardEnabled, detail.boardMode); if (textSession) { textSession.style.color = color; refreshTextEditor(); textSession.editor.focus({ preventScroll: true }); } refreshBrushCursor(); }
  if (command === 'capture:conceal') {
    closeTextEditor({ commit: true });
    document.body.classList.add('is-capture-concealed');
    hideBrushCursor();
    requestAnimationFrame(() => requestAnimationFrame(() => window.zmark.overlayCaptureConcealed(displayId)));
  }
  if (command === 'capture:restore') {
    document.body.classList.remove('is-capture-concealed');
    refreshBrushCursor();
  }
  if (command === 'handle:protected') protectedCircle = detail.circle || null;
  if (command === 'reset') { closeTextEditor({ commit: false }); strokes = []; redoStack = []; activeStroke = null; blockedPointers.clear(); clearSelection(); hideBrushCursor(); tool = 'pen'; document.body.classList.remove('is-text-tool'); renderInk(); }
});
window.zmark.on('overlay:proxy-pointer', (payload) => {
  const event = {
    pointerId: payload.pointerId, pointerType: payload.pointerType || 'mouse', pressure: payload.pressure || 0,
    button: payload.button ?? 0, buttons: payload.buttons ?? 0,
    screenX: payload.x, screenY: payload.y,
    clientX: payload.x - displayBounds.x, clientY: payload.y - displayBounds.y
  };
  event.getCoalescedEvents = () => [event];
  if (payload.phase === 'down') beginPointer(event);
  if (payload.phase === 'move') movePointer(event);
  if (payload.phase === 'up') endPointer(event);
  if (payload.phase === 'cancel') cancelPointer(event);
});
