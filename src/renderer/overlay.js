const canvas = document.querySelector('#canvas');
// Electron 43 accepts `desynchronized`, but a stale shared runtime may reject
// optional 2D-context hints rather than simply ignore them.  Retain the fast
// path while always falling back to a standard transparent 2D canvas.
const context = canvas.getContext('2d', { alpha: true, desynchronized: true }) || canvas.getContext('2d', { alpha: true });
const liveCanvas = document.querySelector('#live-canvas');
const liveContext = liveCanvas.getContext('2d', { alpha: true, desynchronized: true }) || liveCanvas.getContext('2d', { alpha: true });
const selectionElement = document.querySelector('#selection');
const selectionPreview = document.querySelector('#selection-preview');
const selectionActions = document.querySelector('#selection-actions');
const brushCursor = document.querySelector('#brush-cursor');
const BRUSH_TOOLS = new Set(['pen', 'highlighter', 'eraser']);
let displayId = '';
let displayBounds = { x: 0, y: 0 };
let protectedCircle = null;
let tool = 'pen';
let color = '#f04e4e';
let baseSize = 4;
let penStrength = 50;
let highlighterStrength = 50;
let drawingEnabled = true;
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
const blockedPointers = new Set();
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
const highlighterMaskSurface = document.createElement('canvas');
const highlighterMaskContext = highlighterMaskSurface.getContext('2d', { alpha: true, desynchronized: true });
const highlighterHardMaskSurface = document.createElement('canvas');
const highlighterHardMaskContext = highlighterHardMaskSurface.getContext('2d', { alpha: true, desynchronized: true });
const highlighterEdgeSurface = document.createElement('canvas');
const highlighterEdgeContext = highlighterEdgeSurface.getContext('2d', { alpha: true, desynchronized: true });
const highlighterPaintSurface = document.createElement('canvas');
const highlighterPaintContext = highlighterPaintSurface.getContext('2d', { alpha: true, desynchronized: true });
let highlighterSurfaceCapacity = { width: 0, height: 0 };
const HIGHLIGHTER_EDGE_SOFTNESS = 1.3;
let highlighterEdgeNoise = null;

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
function draw2BPencilDot(point, size, strokeColor, strength) {
  draw2BPencilSegment(point, { ...point, x: point.x + .1, d: (point.d || 0) + .1 }, size, strokeColor, strength);
}
function draw2BPencilSegment(a, b, size, strokeColor, strength) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const profile = pencil2BProfile(a, b, size, strength);
  const spacing = Math.max(.55, Math.min(6, profile.minor * .22));
  const steps = Math.max(1, Math.ceil(distance / spacing));
  const alphaCeiling = .48 + (1 - profile.material.hardness / 100) * .36;
  const surface = graphiteMaterialSurface(strokeColor, profile.material, 1, profile.minor);
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.imageSmoothingEnabled = true;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const progress = Math.min(1, ((a.d || 0) + distance * t) / Math.max(8, profile.major * .25));
    const taper = .42 + .58 * progress;
    const rx = profile.major * .5 * taper;
    const ry = profile.minor * .5 * taper;
    const radius = Math.max(rx, ry) + 3;
    context.save();
    context.translate(x, y);
    context.rotate(profile.angle);
    applyPencilContactShape(context, rx, ry, profile.material);
    context.clip();
    context.rotate(-profile.angle);
    context.translate(-x, -y);
    context.globalAlpha = Math.min(alphaCeiling, .04 + profile.deposit * .33);
    drawWorldFixedMaterial(context, surface, x - radius, y - radius, radius * 2, radius * 2);
    context.restore();
  }
  context.restore();
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
function highlighterEdgeNoisePattern(target) {
  if (!highlighterEdgeNoise) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 96;
    const tileContext = tile.getContext('2d', { willReadFrequently: true });
    const pixels = tileContext.createImageData(tile.width, tile.height);
    for (let y = 0; y < tile.height; y += 1) for (let x = 0; x < tile.width; x += 1) {
      // This only ever reaches the soft outer alpha band below.  It is not a
      // second grain layer: it merely makes the otherwise mathematical edge
      // breathe by a fraction of a pixel, like felt meeting paper.
      const micro = graphiteHash(x, y, 1481);
      const field = graphiteField(x + 31, y - 17, 27, 911);
      const alpha = Math.round(234 + (micro - .5) * 8 + (field - .5) * 18);
      const index = (y * tile.width + x) * 4;
      pixels.data[index] = 255;
      pixels.data[index + 1] = 255;
      pixels.data[index + 2] = 255;
      pixels.data[index + 3] = alpha;
    }
    tileContext.putImageData(pixels, 0, 0);
    highlighterEdgeNoise = tile;
  }
  return target.createPattern(highlighterEdgeNoise, 'repeat');
}
function highlighterRenderBounds(points, width) {
  const padding = width * .5 + HIGHLIGHTER_EDGE_SOFTNESS * 3 + 4;
  let minX = points[0].x, maxX = points[0].x, minY = points[0].y, maxY = points[0].y;
  for (let index = 1; index < points.length; index += 1) {
    minX = Math.min(minX, points[index].x); maxX = Math.max(maxX, points[index].x);
    minY = Math.min(minY, points[index].y); maxY = Math.max(maxY, points[index].y);
  }
  const left = Math.max(0, Math.floor(minX - padding));
  const top = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(innerWidth, Math.ceil(maxX + padding));
  const bottom = Math.min(innerHeight, Math.ceil(maxY + padding));
  const physicalLeft = Math.floor(left * dpr);
  const physicalTop = Math.floor(top * dpr);
  const physicalRight = Math.ceil(right * dpr);
  const physicalBottom = Math.ceil(bottom * dpr);
  return {
    left, top, right, bottom, physicalLeft, physicalTop,
    width: Math.max(1, physicalRight - physicalLeft),
    height: Math.max(1, physicalBottom - physicalTop)
  };
}
function resetHighlighterSurface(target, width, height) {
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = 1;
  target.filter = 'none';
  target.clearRect(0, 0, width, height);
}
function ensureHighlighterSurfaces(width, height) {
  if (width <= highlighterSurfaceCapacity.width && height <= highlighterSurfaceCapacity.height) return;
  highlighterSurfaceCapacity = {
    width: Math.max(width, Math.ceil(highlighterSurfaceCapacity.width * 1.35), 128),
    height: Math.max(height, Math.ceil(highlighterSurfaceCapacity.height * 1.35), 128)
  };
  [highlighterMaskSurface, highlighterHardMaskSurface, highlighterEdgeSurface, highlighterPaintSurface].forEach((surface) => {
    surface.width = highlighterSurfaceCapacity.width;
    surface.height = highlighterSurfaceCapacity.height;
  });
  // Resizing a canvas invalidates its previously created CanvasPattern in
  // some Chromium builds, so rebuild the small paint-context cache only.
  highlighterPatternCache = new WeakMap();
}
function setHighlighterWorldTransform(target, bounds) {
  target.setTransform(dpr, 0, 0, dpr, -bounds.physicalLeft, -bounds.physicalTop);
}
function softenHighlighterMask(points, width, bounds) {
  resetHighlighterSurface(highlighterMaskContext, bounds.width, bounds.height);
  setHighlighterWorldTransform(highlighterMaskContext, bounds);
  // White is the alpha shape only.  The pigment is drawn later without blur,
  // which keeps every felt pore crisp while the perimeter remains soft.
  paintHighlighterPath(highlighterMaskContext, points, width, 1, '#fff', HIGHLIGHTER_EDGE_SOFTNESS);

  resetHighlighterSurface(highlighterHardMaskContext, bounds.width, bounds.height);
  setHighlighterWorldTransform(highlighterHardMaskContext, bounds);
  paintHighlighterPath(highlighterHardMaskContext, points, width, 1, '#fff');

  // Separate only the blur fringe from the opaque core.  A very low-contrast
  // alpha pattern is applied to this fringe—not to the colored material—so
  // the soft boundary is just slightly organic without becoming ragged.
  resetHighlighterSurface(highlighterEdgeContext, bounds.width, bounds.height);
  highlighterEdgeContext.drawImage(highlighterMaskSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  highlighterEdgeContext.globalCompositeOperation = 'destination-out';
  highlighterEdgeContext.drawImage(highlighterHardMaskSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  highlighterEdgeContext.globalCompositeOperation = 'destination-in';
  highlighterEdgeContext.fillStyle = highlighterEdgeNoisePattern(highlighterEdgeContext);
  highlighterEdgeContext.fillRect(0, 0, bounds.width, bounds.height);

  // Preserve the original continuous blurred-alpha transition inside the
  // contact edge.  Only the narrow fringe outside it is replaced with its
  // subtly varied counterpart; using a hard opaque core here would make the
  // inner half of an otherwise soft edge look mechanically cut out.
  resetHighlighterSurface(highlighterPaintContext, bounds.width, bounds.height);
  highlighterPaintContext.drawImage(highlighterMaskSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  highlighterPaintContext.globalCompositeOperation = 'destination-in';
  highlighterPaintContext.drawImage(highlighterHardMaskSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  resetHighlighterSurface(highlighterMaskContext, bounds.width, bounds.height);
  highlighterMaskContext.drawImage(highlighterPaintSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  highlighterMaskContext.drawImage(highlighterEdgeSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
}
function renderHighlighterMaterial(target, points, width, color, withEndDeposits, strength = 50) {
  const bounds = highlighterRenderBounds(points, width);
  ensureHighlighterSurfaces(bounds.width, bounds.height);
  softenHighlighterMask(points, width, bounds);

  resetHighlighterSurface(highlighterPaintContext, bounds.width, bounds.height);
  setHighlighterWorldTransform(highlighterPaintContext, bounds);
  highlighterPaintContext.globalCompositeOperation = 'source-over';
  highlighterPaintContext.globalAlpha = highlighterStrengthAlpha(strength);
  highlighterPaintContext.fillStyle = highlighterPattern(highlighterPaintContext, color);
  highlighterPaintContext.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  if (withEndDeposits) {
    paintHighlighterEndDeposit(highlighterPaintContext, points, width, color, true);
    paintHighlighterEndDeposit(highlighterPaintContext, points, width, color, false);
  }
  highlighterPaintContext.setTransform(1, 0, 0, 1, 0, 0);
  highlighterPaintContext.globalCompositeOperation = 'destination-in';
  highlighterPaintContext.globalAlpha = 1;
  highlighterPaintContext.drawImage(highlighterMaskSurface, 0, 0, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

  // All local surfaces are in backing-store pixels. Blitting them 1:1 avoids
  // filtering the pigment a second time and prevents an old local surface
  // rectangle from leaking into the screen canvas.
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = 1;
  target.imageSmoothingEnabled = false;
  target.drawImage(highlighterPaintSurface, 0, 0, bounds.width, bounds.height, bounds.physicalLeft, bounds.physicalTop, bounds.width, bounds.height);
  target.restore();
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
  // Softness is used exclusively for the white alpha mask. The pigment pass
  // below is never filtered, so felt texture remains optically crisp.
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
function paintHighlighterEndDeposit(target, points, width, color, atStart) {
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
  // The density rise stays in the crisp pigment layer. The shared alpha mask
  // is solely responsible for its soft outer boundary.
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
  const points = markerPoints(activeStroke.points, activeStroke.size * 2.55, false);
  const width = activeStroke.size * 2.55;
  // The live canvas gets the same local pigment/mask compositor as the final
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
  document.body.classList.remove('is-brush-ready');
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
    if (!drawingEnabled || activeStroke || !isBrushTool() || !point || point.protected) return hideBrushCursor();
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
  const visible = drawingEnabled && isBrushTool() && !activeStroke && lastBrushPoint && !lastBrushPoint.protected;
  brushCursor.classList.toggle('is-visible', Boolean(visible));
  document.body.classList.toggle('is-brush-ready', Boolean(visible));
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
  // The size indicator is useful while aiming.  During an actual drag it
  // must never sit on the terminal pixel and be mistaken for brush material.
  if (event.buttons & 1) return hideBrushCursor();
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
  const dx = event.screenX - protectedCircle.x;
  const dy = event.screenY - protectedCircle.y;
  return (dx * dx) + (dy * dy) <= protectedCircle.radius * protectedCircle.radius;
}
function drawSegment(a, b, selectedTool, strokeColor, size, strength) {
  if (selectedTool === 'pen') return draw2BPencilSegment(a, b, size, strokeColor, strength);
  const pressure = Math.max(.12, (a.p + b.p) / 2);
  const erasing = selectedTool === 'eraser';
  const highlighter = selectedTool === 'highlighter';
  const width = erasing ? size * (2.4 + pressure * .8) : highlighter ? size * 2.55 : size * (.3 + pressure * .95);
  context.save();
  context.lineCap = highlighter ? 'butt' : 'round'; context.lineJoin = highlighter ? 'miter' : 'round';
  context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
  context.strokeStyle = strokeColor;
  context.globalAlpha = erasing ? 1 : (highlighter ? highlighterStrengthAlpha(strength) : Math.min(.94, .36 + pressure * .65));
  context.lineWidth = width;
  context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
  context.restore();
}
function drawStroke(stroke) {
  if (stroke.tool === 'highlighter') return drawHighlighterStroke(context, stroke);
  if (stroke.points.length === 1) {
    const point = stroke.points[0]; const erasing = stroke.tool === 'eraser';
    if (stroke.tool === 'pen') return draw2BPencilDot(point, stroke.size, stroke.color, stroke.strength);
    context.save(); context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'; context.fillStyle = stroke.color; context.globalAlpha = erasing ? 1 : (stroke.tool === 'highlighter' ? .3 : .7);
    if (stroke.tool === 'highlighter') {
      const side = stroke.size * 2.55;
      context.globalAlpha = highlighterStrengthAlpha(stroke.strength);
      context.fillRect(point.x - side / 2, point.y - side / 2, side, side);
    } else {
      context.beginPath(); context.arc(point.x, point.y, stroke.size * (erasing ? 1.5 : (.35 + point.p)), 0, Math.PI * 2); context.fill();
    }
    context.restore();
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) drawSegment(stroke.points[index - 1], stroke.points[index], stroke.tool, stroke.color, stroke.size, stroke.strength);
}
function renderInk() {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, innerWidth, innerHeight);
  strokes.forEach(drawStroke);
  if (activeStroke && activeStroke.tool !== 'highlighter') drawStroke(activeStroke);
  renderLiveHighlighter();
}
function selectionBounds(start, end) {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}
function clearSelection() {
  if (selectionRenderFrame) cancelAnimationFrame(selectionRenderFrame);
  selectionRenderFrame = 0;
  selection = null;
  pendingScreenshotDataUrl = '';
  selectionPreview.removeAttribute('src');
  selectionElement.classList.remove('is-frozen');
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
  const isConfirming = selection.phase === 'confirming';
  selectionActions.classList.toggle('is-visible', isConfirming);
  selectionActions.setAttribute('aria-hidden', String(!isConfirming));
  if (!isConfirming) return;
  const actionWidth = 190;
  const actionHeight = 40;
  const left = Math.max(8, Math.min(innerWidth - actionWidth - 8, bounds.left + (bounds.width - actionWidth) / 2));
  const below = bounds.top + bounds.height + 10;
  const top = below + actionHeight <= innerHeight - 8 ? below : Math.max(8, bounds.top - actionHeight - 8);
  Object.assign(selectionActions.style, { left: `${left}px`, top: `${top}px` });
}
function compositeLiveScreen(screenshot, bounds) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!bounds) {
        const output = document.createElement('canvas');
        output.width = canvas.width;
        output.height = canvas.height;
        const outputContext = output.getContext('2d');
        outputContext.imageSmoothingEnabled = false;
        outputContext.drawImage(image, 0, 0, output.width, output.height);
        outputContext.drawImage(canvas, 0, 0);
        resolve(output.toDataURL('image/png'));
        return;
      }
      const left = Math.max(0, Math.floor(bounds.left * dpr));
      const top = Math.max(0, Math.floor(bounds.top * dpr));
      const width = Math.max(1, Math.min(canvas.width - left, Math.floor(bounds.width * dpr)));
      const height = Math.max(1, Math.min(canvas.height - top, Math.floor(bounds.height * dpr)));
      const crop = document.createElement('canvas');
      crop.width = width; crop.height = height;
      const cropContext = crop.getContext('2d');
      cropContext.imageSmoothingEnabled = false;
      const sourceX = left * image.naturalWidth / canvas.width;
      const sourceY = top * image.naturalHeight / canvas.height;
      const sourceWidth = width * image.naturalWidth / canvas.width;
      const sourceHeight = height * image.naturalHeight / canvas.height;
      cropContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      cropContext.drawImage(canvas, left, top, width, height, 0, 0, width, height);
      resolve(crop.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('无法读取实时屏幕')); image.src = screenshot;
  });
}
function finishSelection() {
  const bounds = selectionBounds(selection.start, selection.end);
  if (bounds.width >= 4 && bounds.height >= 4) {
    selection.phase = 'capturing';
    renderSelection();
    window.zmark.requestSelectionCapture({ displayId, bounds });
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
  for (const item of samples) {
    if (!(item.buttons & 1)) continue;
    const nextPoint = pointFrom(item);
    const previousPoint = activeStroke.points.at(-1);
    nextPoint.d = (previousPoint?.d || 0) + (previousPoint ? Math.hypot(nextPoint.x - previousPoint.x, nextPoint.y - previousPoint.y) : 0);
    activeStroke.points.push(nextPoint);
    if (previousPoint && activeStroke.tool === 'highlighter') {
      // Tablet packets arrive far more often than mouse packets. Append just
      // their new contact segment instead of replaying the whole live stroke.
      scheduleLiveHighlighterRender();
    } else if (previousPoint) drawSegment(previousPoint, nextPoint, activeStroke.tool, activeStroke.color, activeStroke.size, activeStroke.strength);
  }
}
function commitActiveStroke() {
  if (!activeStroke) return;
  const completedStroke = activeStroke;
  if (completedStroke.tool === 'highlighter') {
    // The preview and committed mark share the same contact-dab engine; only
    // the live canvas is transient while the pointer is still down.
    drawHighlighterStroke(context, completedStroke);
    clearLiveHighlighter();
  }
  strokes.push(completedStroke);
  redoStack = [];
  activeStroke = null;
  if (completedStroke.points.length === 1 && completedStroke.tool !== 'highlighter') drawStroke(completedStroke);
}
function beginPointer(event) {
  const protectedPoint = isProtectedPoint(event);
  updateBrushCursor(event, protectedPoint);
  if (!drawingEnabled || (event.button !== 0 && event.pointerType !== 'pen')) return;
  if (protectedPoint) {
    blockedPointers.add(event.pointerId);
    return false;
  }
  if (tool === 'screenshot' && !selection) { selection = { start: pointFrom(event), end: pointFrom(event), phase: 'selecting' }; renderSelection(); return true; }
  if (selection) return false;
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = 0;
  clearBrushCursorRestore();
  activeStroke = {
    pointerId: event.pointerId, tool, color, size: baseSize,
    strength: tool === 'highlighter' ? highlighterStrength : penStrength,
    points: [{ ...pointFrom(event), d: 0 }]
  };
  hideBrushCursor();
  if (tool === 'highlighter') renderLiveHighlighter();
  return true;
}
function movePointer(event) {
  const protectedPoint = isProtectedPoint(event);
  updateBrushCursor(event, protectedPoint);
  if (!drawingEnabled) return;
  if (activeStroke && event.pointerId !== activeStroke.pointerId) return;
  if (blockedPointers.has(event.pointerId)) return;
  if (protectedPoint) {
    if (selection?.phase === 'selecting') clearSelection();
    commitActiveStroke();
    blockedPointers.add(event.pointerId);
    return;
  }
  if (selection?.phase === 'selecting') { selection.end = pointFrom(event); scheduleSelectionRender(); return; }
  appendCoalesced(event);
}
function endPointer(event) {
  if (blockedPointers.delete(event.pointerId)) return;
  if (selection?.phase === 'selecting') return finishSelection();
  // A PointerEvent release is the canonical completion signal.  Do not let a
  // duplicate legacy mouseup (or a second native release routed by Windows)
  // hide the cursor that the first completion just restored.
  if (!activeStroke || event.pointerId !== activeStroke.pointerId) return;
  const endpoint = activeStroke?.points.at(-1);
  const completedTool = activeStroke.tool;
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
    suppressedBrushEndpoint = { x: endpoint.x, y: endpoint.y, radius: Math.max(12, brushDiameter(endpoint.p) * 1.15) };
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
  const interruptedStroke = activeStroke;
  blockedPointers.delete(event.pointerId);
  hideBrushCursor();
  suppressedBrushEndpoint = null;
  brushCursorSuppressedUntil = performance.now() + 800;
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
canvas.addEventListener('pointerdown', (event) => {
  if (beginPointer(event)) canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', movePointer);
// Transparent always-on-top windows on Windows can route the release outside
// the canvas even after an accepted down.  The release must still commit the
// mark and clear the visual size ring, so observe it at the window boundary.
window.addEventListener('pointerup', endPointer, true);
window.addEventListener('pointercancel', cancelPointer, true);
selectionActions.addEventListener('pointerdown', (event) => event.stopPropagation());
selectionActions.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-screenshot-action]')?.dataset.screenshotAction;
  if (!action || !selection || selection.phase !== 'confirming') return;
  event.preventDefault();
  event.stopPropagation();
  selectionActions.classList.add('is-busy');
  const result = await window.zmark.screenshotAction({ action, displayId, dataUrl: pendingScreenshotDataUrl });
  if (!result?.completed) selectionActions.classList.remove('is-busy');
});
window.addEventListener('keydown', (event) => {
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
  else if (!meta && !event.altKey && key === 'c' && event.shiftKey) shortcut = 'screenshot';
  else if (!meta && !event.altKey && key === 'c') shortcut = 'palette';
  else if (!meta && !event.altKey && event.key === '[') shortcut = 'size-down';
  else if (!meta && !event.altKey && event.key === ']') shortcut = 'size-up';
  if (!shortcut) return;
  event.preventDefault();
  window.zmark.annotationShortcut(shortcut);
});
window.addEventListener('resize', fitCanvas);
window.zmark.on('overlay:initialize', (payload) => {
  displayId = payload.displayId; displayBounds = payload.displayBounds || displayBounds; protectedCircle = payload.circle || null; color = payload.color; baseSize = payload.size; penStrength = payload.penStrength ?? payload.strength ?? penStrength; highlighterStrength = payload.highlighterStrength ?? payload.strength ?? highlighterStrength; tool = payload.tool || 'pen'; drawingEnabled = payload.drawing;
  document.documentElement.dataset.theme = payload.theme || 'light';
  document.body.classList.toggle('is-screenshot', tool === 'screenshot'); fitCanvas(); refreshBrushCursor(); window.zmark.overlayReady(displayId);
});
window.zmark.on('overlay:selection-source', ({ screenshot, bounds }) => {
  compositeLiveScreen(screenshot, bounds).then((dataUrl) => {
    if (!selection) return;
    pendingScreenshotDataUrl = dataUrl;
    selection.phase = 'confirming';
    selectionPreview.src = dataUrl;
    selectionElement.classList.add('is-frozen');
    renderSelection();
  }).catch(() => clearSelection());
});
window.zmark.on('overlay:command', ({ command, ...detail }) => {
  if (['pen', 'highlighter', 'eraser', 'screenshot'].includes(command)) {
    if (command !== 'screenshot') clearSelection();
    tool = command;
    document.body.classList.toggle('is-screenshot', command === 'screenshot');
    if (command === 'screenshot') hideBrushCursor();
    else refreshBrushCursor();
  }
  if (command === 'undo' && strokes.length) { redoStack.push(strokes.pop()); renderInk(); }
  if (command === 'redo' && redoStack.length) { strokes.push(redoStack.pop()); renderInk(); }
  if (command === 'clear') { strokes = []; redoStack = []; activeStroke = null; renderInk(); }
  if (command === 'drawing:off') { commitActiveStroke(); drawingEnabled = false; blockedPointers.clear(); clearSelection(); hideBrushCursor(); }
  if (command === 'drawing:on') { drawingEnabled = true; refreshBrushCursor(); }
  if (command === 'settings') { color = detail.color; baseSize = detail.size; penStrength = detail.penStrength ?? detail.strength ?? penStrength; highlighterStrength = detail.highlighterStrength ?? detail.strength ?? highlighterStrength; document.documentElement.dataset.theme = detail.theme || document.documentElement.dataset.theme || 'light'; refreshBrushCursor(); }
  if (command === 'handle:protected') protectedCircle = detail.circle || null;
  if (command === 'reset') { strokes = []; redoStack = []; activeStroke = null; blockedPointers.clear(); clearSelection(); hideBrushCursor(); tool = 'pen'; renderInk(); }
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
