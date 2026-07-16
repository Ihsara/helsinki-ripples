// camera.js — the v2.2 free camera: mutable {cx, cy, scale} + pure math.
//
// Replaces the fit-once makeProjection view. cameraProjection() returns the
// SAME {s, kx, fn} shape app.js already consumes from makeProjection, so the
// render path (pushEdge, dots, outline) needs no changes — only the place the
// projection is CREATED changes.
//
// Model: equirectangular with a FROZEN kx = cos(latMid of the region bbox).
// px = w/2 + (x - cx)*kx*s ;  py = h/2 - (y - cy)*s
// Freezing kx keeps every function linear/invertible; over the region's 0.4°
// of latitude the drift is invisible.

export const MAX_VIEW_KM = 2.5; // max-zoom clamp: viewport ≈ 2.5 km across
const KM_PER_LAT_DEG = 111.32;

export function fitBboxScale(bbox, w, h, margin, kx) {
  const dataW = (bbox[2] - bbox[0]) * kx;
  const dataH = bbox[3] - bbox[1];
  const aW = w - 2 * margin, aH = h - 2 * margin;
  return Math.min(aW / dataW, aH / dataH);
}

function deriveClamps(cam, regionBbox) {
  cam.minScale = fitBboxScale(regionBbox, cam.w, cam.h, cam.margin, cam.kx);
  // max zoom: the scale at which the viewport is MAX_VIEW_KM across.
  // viewport width in lon-deg = w / (kx * s); in km = that * KM_PER_LAT_DEG * kx
  // = w * KM_PER_LAT_DEG / s  →  s = w * KM_PER_LAT_DEG / MAX_VIEW_KM.
  cam.maxScale = (cam.w * KM_PER_LAT_DEG) / MAX_VIEW_KM;
}

export function createCamera(regionBbox, w, h, margin = 24) {
  const latMid = (regionBbox[1] + regionBbox[3]) / 2;
  const kx = Math.cos((latMid * Math.PI) / 180);
  const cam = {
    cx: (regionBbox[0] + regionBbox[2]) / 2,
    cy: (regionBbox[1] + regionBbox[3]) / 2,
    scale: 0, kx, w, h, margin,
    minScale: 0, maxScale: Infinity,
    _regionBbox: regionBbox, // kept for clamp re-derivation on resize
  };
  deriveClamps(cam, regionBbox);
  cam.scale = cam.minScale;
  return cam;
}

export function cameraProjection(cam) {
  const { cx, cy, kx, scale: s, w, h } = cam;
  return { s, kx, fn: (x, y) => [w / 2 + (x - cx) * kx * s, h / 2 - (y - cy) * s] };
}

export function unproject(cam, px, py) {
  const { cx, cy, kx, scale: s, w, h } = cam;
  return [cx + (px - w / 2) / (kx * s), cy - (py - h / 2) / s];
}

export function panBy(cam, dxPx, dyPx) {
  cam.cx -= dxPx / (cam.kx * cam.scale);
  cam.cy += dyPx / cam.scale;
}

export function zoomAboutPoint(cam, px, py, factor) {
  const [gx, gy] = unproject(cam, px, py);
  cam.scale = Math.min(cam.maxScale, Math.max(cam.minScale, cam.scale * factor));
  // keep (gx,gy) under (px,py): solve for new center
  cam.cx = gx - (px - cam.w / 2) / (cam.kx * cam.scale);
  cam.cy = gy + (py - cam.h / 2) / cam.scale;
}

export function resizeCamera(cam, w, h) {
  cam.w = w; cam.h = h;
  deriveClamps(cam, cam._regionBbox);
  cam.scale = Math.min(cam.maxScale, Math.max(cam.minScale, cam.scale));
}

export function viewWidthKm(cam) {
  return (cam.w * KM_PER_LAT_DEG) / cam.scale;
}

export function visibleBbox(cam) {
  const [wLon, sLat] = unproject(cam, 0, cam.h);
  const [eLon, nLat] = unproject(cam, cam.w, 0);
  return [wLon, sLat, eLon, nLat];
}

// ---- fly-to: easeInOutCubic over (cx, cy, scale) --------------------------
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function startFlyTo(cam, bbox, durationMs = 600) {
  const toScale = Math.min(cam.maxScale, Math.max(cam.minScale,
    fitBboxScale(bbox, cam.w, cam.h, cam.margin, cam.kx)));
  return {
    bbox,
    from: { cx: cam.cx, cy: cam.cy, scale: cam.scale },
    to: { cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, scale: toScale },
    t0: null, durationMs, done: false,
  };
}

// Advance the animation to nowMs (first call sets t0). Returns true while
// animating, false once done (cam lands EXACTLY on the target framing).
export function stepFlyTo(anim, cam, nowMs) {
  if (anim.done) return false;
  if (anim.t0 === null) anim.t0 = nowMs;
  const t = Math.min(1, (nowMs - anim.t0) / anim.durationMs);
  const e = easeInOutCubic(t);
  cam.cx = anim.from.cx + (anim.to.cx - anim.from.cx) * e;
  cam.cy = anim.from.cy + (anim.to.cy - anim.from.cy) * e;
  cam.scale = anim.from.scale + (anim.to.scale - anim.from.scale) * e;
  if (t >= 1) {
    cam.cx = anim.to.cx; cam.cy = anim.to.cy; cam.scale = anim.to.scale;
    anim.done = true;
    return false;
  }
  return true;
}
