// app.js — the ripples app: boot, region-wide rAF loop, DOM chrome.
//
// Orchestration only: pure logic (projection, band brightness, stamp
// windowing, the WebGL field) lives in field.js; vehicle interpolation in
// vehicles.js; binary loading in data.js. This module wires those to the DOM
// and drives one requestAnimationFrame loop that plays the region-wide
// ripple field on sim-time.
//
// Model (Task 9): each frame the field is CLEARED then every in-flight
// event's edges are RE-STAMPED with that event's current age; the band
// shader (field.js STAMP_FS) recomputes crest/wake brightness per-edge from
// (delay, age) every frame — there's no accumulate/decay step. Moving
// vehicle dots are interpolated in JS at playback (Option A) and impact dots
// flash at a stop the instant its event fires.

import { loadAll } from "./data.js";
import { makeProjection, eventsInWindow, RippleField, realAge, clampSkip,
         rippleLifeHorizon, nextEventInView, whisperText } from "./field.js";
import { vehiclePosition } from "./vehicles.js";
import { createCamera, cameraProjection, panBy, zoomAboutPoint, resizeCamera,
         startFlyTo, stepFlyTo, visibleBbox, viewWidthKm } from "./camera.js";
import { createDistrictPanel } from "./panel.js";

// ---- AOI bboxes (lon/lat), mirrored from src/region.py EXACTLY -----------
const AOIS = {
  region:     [24.40, 60.05, 25.35, 60.45],
  Helsinki:   [24.78, 60.13, 25.06, 60.24],
  Espoo:      [24.50, 60.13, 24.83, 60.34],
  Vantaa:     [24.80, 60.24, 25.15, 60.35],
  Kauniainen: [24.71, 60.20, 24.76, 60.23],
};
const REGION_ONLY_CITY_CODE = 0xffff; // stop has no per-city street buffer

// mode code -> normalized RGB, matching the exact HSL hex from the design.
const MODE_COLORS = [
  [1.0, 0.6, 0.2],       // 0 metro   #ff9933
  [0.698, 0.4, 1.0],     // 1 train   #b266ff
  [0.2, 0.8, 0.4],       // 2 tram    #33cc66
  [0.561, 0.722, 0.902], // 3 bus     #8fb8e6
  [0.561, 0.722, 0.902], // 4 ferry   (reuse bus color; no ferry events expected)
];

const DATA_DIR = "./data";
const SPAWN_BUDGET = 200; // max stamped events per frame, even at 300x

// mode name -> code, matching ripplesim.vehicles._MODE_CODE / bake_ripples._MODE_CODE.
const MODE_CODE = (name) => ({ metro: 0, train: 1, tram: 2, bus: 3, ferry: 4 }[name] ?? 3);

// Recent-events look-back window (sim-sec) for the "impact dot" flash at a
// stop the instant it fires — independent of the ripple horizon (which is
// much longer). Dot alpha fades linearly to 0 over this window.
const IMPACT_FADE_SIM_SEC = 8;
const VEHICLE_DOT_BUDGET = 6000; // cap on stamped vehicle dots per frame (cost bound)

function bboxObj(arr) {
  return { minX: arr[0], minY: arr[1], maxX: arr[2], maxY: arr[3] };
}

// binary search helpers (eventTime is sorted ascending per the bake contract).
function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Scripted stops for the guided intro (Task 10). Picked from the baked
// Helsinki data: two real, nearby stops (~90m apart, different modes —
// tram + bus) whose 3-min isochrones overlap enough to make the additive
// interference bloom visible without swamping the whole street network.
const STORY_STOP_SOLO = 1893;   // tram stop, cnt=337 stamps
const STORY_STOP_PAIR = [1893, 2841]; // tram + bus, ~90m apart

async function initApp() {
  const canvas = document.getElementById("map");
  const statusEl = document.getElementById("status");
  const clockEl = document.getElementById("clock");
  const whisperEl = document.getElementById("whisper");
  const scrubberEl = document.getElementById("scrubber");
  const playPauseEl = document.getElementById("play-pause");
  const skipBackEl = document.getElementById("skip-back");
  const skipFwdEl = document.getElementById("skip-fwd");
  const speedButtons = Array.from(document.querySelectorAll("#speed-presets button"));
  const aoiButtons = Array.from(document.querySelectorAll("#aoi-picker button"));
  const chromeEl = document.getElementById("chrome");
  const introEl = document.getElementById("intro");
  const introBeginEl = document.getElementById("intro-begin");
  const stepperEl = document.getElementById("stepper");
  const stepNumEl = document.getElementById("step-num");
  const stepCaptionEl = document.getElementById("step-caption");
  const stepNextEl = document.getElementById("step-next");
  const stepExploreEl = document.getElementById("step-explore");
  const helpBtnEl = document.getElementById("help-btn");
  const INTRO_SEEN_KEY = "hr-intro-seen";

  // ---- WebGL2 availability check (self-review requirement) --------------
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    if (statusEl) statusEl.textContent = "This visualization needs WebGL2 with float render targets.";
    return;
  }

  // ---- load baked data ----------------------------------------------------
  const d = await loadAll(DATA_DIR);
  const manifest = d.manifest;
  const dataMin = manifest.data_min;
  const dataMax = manifest.data_max;
  const dataSpan = Math.max(1, dataMax - dataMin);
  // Note: manifest.tau_sec is the physics isochrone decay constant baked into
  // stamp_delay/stamp_intensity at bake time. Display fade is now driven
  // live by the band shader's life_tau (see RIPPLE_PARAMS below, sourced
  // from manifest.ripple.life_tau) — there is no separate visual half-life
  // constant anymore (the old decay-accumulate model's RIPPLE_HALF_LIFE_SIM_SEC
  // was retired in Task 9's clear+re-stamp rewrite).

  // city code -> name, matching the bake's city_list.index(city) order.
  // Derived from the manifest (not hardcoded) so a bake reorder can't
  // silently mis-map a stop to the wrong city's street buffer.
  const CITY_NAMES = Object.keys(manifest.cities);

  // stampIndex is a flat [off0,cnt0, off1,cnt1, ...] per stop.
  const stampIndex = d.stampIndex;
  const stampEdge = d.stampEdge;
  const stampIntensity = d.stampIntensity;
  const stampDelay = d.stampDelay;
  const stopMode = d.stopMode;
  const stopCity = d.stopCity;
  const eventStop = d.eventStop;
  const eventTime = d.eventTime;
  const streets = d.streets;
  const stops = d.stops; // flat [x0,y0, x1,y1, ...] per stop (lon/lat)
  const horizonSec = manifest.horizon_sec;
  const districts = d.districts; // Task 5 bake: {source, <city>: [{name,bbox,ring}...]} or null (older deploy)

  // v2.1: band params are REAL-seconds tuned (see field.js realAge). Prefer
  // the manifest's ripple_real block; fall back to the same values hardcoded
  // so an older cached manifest can't resurrect the sim-seconds blink.
  const rp = manifest.ripple_real || {};
  const RIPPLE_PARAMS = {
    frontSpeed: rp.front_speed ?? 36.0,
    thickness: rp.thickness ?? 14.0,
    wakeTau: rp.wake_tau ?? 45.0,
    wakeLevel: rp.wake_level ?? 0.35,
    lifeTau: rp.life_tau ?? 3.0,
  };

  // 1x: the 14 s real-time horizon is otherwise eaten by lifeTau=3
  // (exp(-14/3) ≈ 0.9%); at 1x the ripple should linger as a visible glow.
  const RIPPLE_PARAMS_1X = { ...RIPPLE_PARAMS, lifeTau: 6.0 };

  // Guided-intro snapshot params: same band, but life decay disabled so the
  // whole isochrone reads at crest brightness (age varies per edge; without
  // this the far edges dim to ~0.19 of the near ones under life_tau=3).
  const INTRO_PARAMS = { ...RIPPLE_PARAMS, lifeTau: 1e9 };

  // Vehicle data (Task 9, Option A: sim-in-JS interpolation). Guarded: an
  // older bake without vehicle bins/manifest.vehicle leaves vehData null,
  // and the vehicle-dot pass below is skipped entirely — ripples-only.
  const vehicleMeta = manifest.vehicle || null; // {mode:"sim-in-js", window:[t0,t1]}
  const vehData = (d.trips && d.routes && d.vehicleTripBpTime && d.vehicleTripBpDist &&
                   d.vehicleShapeCoords && d.vehicleShapeCumdist) ? {
    routes: d.routes, trips: d.trips,
    shapeCoords: d.vehicleShapeCoords, shapeCumdist: d.vehicleShapeCumdist,
    bpTime: d.vehicleTripBpTime, bpDist: d.vehicleTripBpDist,
  } : null;

  // Boot-time sanity check (T10 rollup / final-review item 7): the guided
  // intro hardcodes two baked stop indices (STORY_STOP_SOLO/PAIR). If a
  // future re-bake reorders stops, these could silently point at a stop
  // with no street buffer, and the "one ripple" teaching step would just
  // show nothing with no error. Warn loudly rather than fail silently;
  // don't hard-crash the whole app over a demo-step data mismatch.
  for (const idx of [STORY_STOP_SOLO, ...STORY_STOP_PAIR]) {
    if (stampIndex[2 * idx + 1] === 0) {
      console.warn(
        `STORY stop index ${idx} has an empty stamp slice (stampIndex[2*${idx}+1]===0) — ` +
        "the guided intro's seeded ripple will render nothing for this stop. " +
        "Likely cause: a re-bake reordered/renumbered stops; re-pick STORY_STOP_SOLO/PAIR."
      );
    }
  }

  // ---- mutable app state --------------------------------------------------
  const state = {
    t: 18000, // 08:00 sim-sec — a busy frame, inside [dataMin, dataMax]
    speed: 60,
    paused: false,
    aoi: "region",
    district: null, // null | {name, bbox, ring} — a focused district within state.aoi's city
    sePtr: 0,
    proj: null,
    lastFrameTs: null,
  };

  // ---- Task 12: rolling FPS meter -----------------------------------------
  // Rolling average over the last ~30 frame samples (not instantaneous),
  // so the on-page readout is a real, pollable measurement the controller
  // can screenshot under CPU throttle, not a jittery single-frame number.
  const FPS_WINDOW = 30;
  const fpsSamples = []; // recent per-frame dt (ms), oldest first
  let fpsValue = 0;
  function recordFrameDt(dtMs) {
    if (dtMs <= 0) return; // paused / hidden-tab frames don't count
    fpsSamples.push(dtMs);
    if (fpsSamples.length > FPS_WINDOW) fpsSamples.shift();
    const avgMs = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
    fpsValue = avgMs > 0 ? 1000 / avgMs : 0;
  }

  // ---- Task 12: status write throttle -------------------------------------
  // Rebuilding + writing #status every rAF (60/sec) is wasted DOM work and
  // makes the FPS digits an unreadable blur. Update the readout on a fixed
  // ~4x/sec cadence, and only touch the DOM when the string actually changed.
  const STATUS_INTERVAL_MS = 250;
  let lastStatusTs = 0;
  let lastStatusStr = null;
  function maybeUpdateStatus(ts) {
    if (!statusEl) return;
    if (ts - lastStatusTs < STATUS_INTERVAL_MS) return;
    lastStatusTs = ts;
    const widthKm = viewWidthKm(camera);
    const widthText = widthKm < 10 ? widthKm.toFixed(1) : String(Math.round(widthKm));
    const str = "view " + widthText + " km | speed " + state.speed + "x" +
      (state.paused ? " | paused" : "") +
      " | " + Math.round(fpsValue) + " fps";
    if (str !== lastStatusStr) {
      lastStatusStr = str;
      statusEl.textContent = str;
    }

    // 1x whisper (spec §4): only at real time, only while playing; human
    // phrasing, never engine terms. delta is SIM seconds, which at 1x IS
    // real seconds.
    let w = "";
    if (state.speed === 1 && !state.paused) {
      const nxt = nextEventInView(eventTime, eventStop, stops, state.sePtr, viewBbox());
      if (nxt) {
        const dsec = Math.max(0, Math.round(nxt.simSec - state.t));
        w = whisperText(dsec);
      }
    }
    if (whisperEl && w !== whisperEl.textContent) whisperEl.textContent = w;
  }

  // ---- WebGL field + projection ------------------------------------------
  let field;
  try {
    field = new RippleField(gl, { width: canvas.clientWidth || window.innerWidth,
                                   height: canvas.clientHeight || window.innerHeight });
  } catch (err) {
    if (statusEl) statusEl.textContent = "This visualization needs WebGL2 with float render targets.";
    console.error("RippleField init failed", err);
    return;
  }

  // The guided intro confines its snapshot projection (introProj) to the TOP
  // portion of the canvas (clear of the bottom-anchored #stepper-card) so a
  // seeded ripple never lands directly underneath opaque UI chrome — see
  // STORY_TOP_FRAC / STORY_STEPS below. Free-explore's camera always uses
  // the full canvas height.
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");

  // ---- v2.2 free camera ----------------------------------------------------
  const camera = createCamera(AOIS.region, canvas.clientWidth || window.innerWidth,
                              canvas.clientHeight || window.innerHeight, 24);
  let flyAnim = null;   // in-flight fly-to animation or null
  let introProj = null; // guided-intro override projection (top-cropped) or null
  const STORY_TOP_FRAC = 0.55;

  // viewBbox — the current VIEWPORT extent (spec Q4-A): culling follows the
  // camera, not an AOI/district selection. Districts are navigation only.
  function viewBbox() {
    return visibleBbox(camera);
  }

  function syncProjection() {
    state.proj = introProj || cameraProjection(camera);
    drawDistrictOutline();
  }

  function fitProjection() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    field.resize(w, h);
    resizeCamera(camera, w, h);
    if (introProj !== null) {
      introProj = makeProjection(bboxObj(AOIS.Helsinki), w, h * STORY_TOP_FRAC, 24);
    }
    if (flyAnim && !flyAnim.done) {
      flyAnim = startFlyTo(camera, flyAnim.bbox, 600);
    }
    syncProjection();
  }
  window.addEventListener("resize", () => fitProjection());

  // flyToBbox — animated camera move (spec §1). NO field clear, NO sePtr
  // resync: playback and camera are orthogonal; the world keeps rippling
  // while the camera moves.
  function flyToBbox(bbox) {
    flyAnim = startFlyTo(camera, bbox, 600);
  }

  // drawDistrictOutline — static 2D overlay: the SELECTED district's ring
  // (soft white) + the HOVERED row's ring (brighter pre-glow). Redrawn on
  // camera change / selection / hover — never per rAF frame. The selection
  // ring fades out once the camera center leaves its bbox by more than one
  // bbox-width (it is a hint, not a mode — spec §3).
  function ringPath(ring) {
    octx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = state.proj.fn(ring[i][0], ring[i][1]);
      if (i === 0) octx.moveTo(px, py); else octx.lineTo(px, py);
    }
    octx.closePath();
  }
  function selectionAlpha(bbox) {
    const cx = camera.cx, cy = camera.cy;
    const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
    const dx = Math.max(0, Math.max(bbox[0] - cx, cx - bbox[2])) / Math.max(w, 1e-9);
    const dy = Math.max(0, Math.max(bbox[1] - cy, cy - bbox[3])) / Math.max(h, 1e-9);
    return Math.max(0, 1 - Math.max(dx, dy)); // 1 inside, 0 one bbox-width away
  }
  function drawDistrictOutline() {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!state.proj) return;
    if (state.district) {
      const a = selectionAlpha(state.district.bbox);
      if (a > 0.01) {
        octx.strokeStyle = `rgba(255,255,255,${(0.14 * a).toFixed(3)})`;
        octx.lineWidth = 1;
        ringPath(state.district.ring);
        octx.stroke();
      }
    }
    if (state.hoverDistrict && state.hoverDistrict !== state.district) {
      octx.strokeStyle = "rgba(111,211,230,0.35)"; // #6fd3e6 pre-glow
      octx.lineWidth = 1.5;
      ringPath(state.hoverDistrict.ring);
      octx.stroke();
    }
  }

  // ---- v2.2 district panel: navigation + highlight only ------------------
  state.hoverDistrict = null; // pre-glow outline (hover), independent of selection

  const panelRoot = document.getElementById("district-panel");
  const districtPanel = createDistrictPanel(panelRoot,
    (districts && districts.schema === 2) ? districts : null, {
    onSelect(entry) {
      state.district = entry;
      districtPanel.setActive(entry);
      flyToBbox(entry.bbox);
      drawDistrictOutline();
    },
    onHover(entry) {
      state.hoverDistrict = entry;
      drawDistrictOutline();
    },
  });

  fitProjection();

  // ---- camera input: drag = pan, wheel = zoom-about-cursor, pinch = zoom.
  // Attached to #overlay's parent stack via window-level pointer events on
  // the canvas (the overlay canvas is pointer-events:none). Any manual
  // camera input cancels an in-flight fly-to (the user grabbed the wheel).
  // Camera is LOCKED while the intro card or the guided tour is showing (the
  // canvas still receives pointer events under that chrome).
  const pointers = new Map(); // pointerId -> {x, y}
  let lastPinchDist = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    flyAnim = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      panBy(camera, -(e.clientX - p.x), -(e.clientY - p.y));
      syncProjection();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY; // update first, measure both below
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist !== null && dist > 0) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        zoomAboutPoint(camera, mx, my, dist / lastPinchDist);
        syncProjection();
      }
      lastPinchDist = dist;
      return; // don't fall through to the single-pointer position update
    }
    p.x = e.clientX; p.y = e.clientY;
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDist = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault(); // always stop page-scroll, even while locked
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    flyAnim = null;
    const factor = Math.exp(-e.deltaY * 0.0015); // smooth, ~1.16x per notch
    zoomAboutPoint(camera, e.clientX, e.clientY, factor);
    syncProjection();
  }, { passive: false });

  canvas.addEventListener("dblclick", (e) => {
    if (!introEl.hidden || !stepperEl.hidden) return; // camera locked during intro/tour
    flyAnim = null;
    zoomAboutPoint(camera, e.clientX, e.clientY, 1.6);
    syncProjection();
  });

  // ---- clock / scrubber formatting ---------------------------------------
  function formatClock(t) {
    const s = t + manifest.sim_origin_sec; // seconds since midnight
    const hh = Math.floor(s / 3600) % 24;
    const mm = Math.floor((s % 3600) / 60);
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }
  function updateScrubberFromT() {
    const frac = (state.t - dataMin) / dataSpan;
    scrubberEl.value = String(Math.min(1, Math.max(0, frac)));
  }

  // scrubber -> t (hard jump: clear the field, resync sePtr)
  scrubberEl.addEventListener("input", () => {
    const frac = parseFloat(scrubberEl.value);
    state.t = dataMin + frac * dataSpan;
    state.sePtr = lowerBound(eventTime, state.t);
    field.resize(canvas.width, canvas.height); // clears both textures
    clearActiveEvents(); // no stale in-flight wavefronts should survive a scrub
  });

  // ---- speed / pause controls ---------------------------------------------
  function setSpeed(v) {
    state.speed = v;
    speedButtons.forEach((b) => b.classList.toggle("active", parseFloat(b.dataset.speed) === v));
  }
  speedButtons.forEach((b) => b.addEventListener("click", () => setSpeed(parseFloat(b.dataset.speed))));

  function setPaused(p) {
    state.paused = p;
    playPauseEl.textContent = p ? "▶" : "⏸";
    playPauseEl.title = p ? "Play (Space)" : "Pause (Space)";
    playPauseEl.setAttribute("aria-pressed", String(p));
  }
  playPauseEl.addEventListener("click", () => setPaused(!state.paused));
  setPaused(false);
  setSpeed(60);

  // ---- ±15min skip: identical hard-jump idiom to the scrubber handler
  // above (clear the field, resync sePtr, drop stale in-flight wavefronts).
  function skipBy(deltaSec) {
    state.t = clampSkip(state.t, deltaSec, dataMin, dataMax);
    state.sePtr = lowerBound(eventTime, state.t);
    field.resize(canvas.width, canvas.height); // clears both textures
    clearActiveEvents();
    updateScrubberFromT();
    clockEl.textContent = formatClock(state.t);
  }
  skipBackEl.addEventListener("click", () => skipBy(-900));
  skipFwdEl.addEventListener("click", () => skipBy(900));

  // ---- Space toggles pause, unless the user is interacting with an input
  // or a button (native Space-activates-focused-button behavior wins there
  // so we don't fight it / double-toggle).
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "BUTTON") return;
    e.preventDefault();
    setPaused(!state.paused);
  });

  // AOI chips are fly-to shortcuts now (spec Q4-A): no filtering, no field
  // clear, no sePtr resync — the camera just travels. state.district stays
  // in the state object for Task 5's panel (the highlighted district).
  function focusAOI(name) {
    state.aoi = name;
    state.district = null;
    districtPanel.setActive(null);
    aoiButtons.forEach((b) => b.classList.toggle("active", b.dataset.aoi === name));
    flyToBbox(AOIS[name]);
    drawDistrictOutline();
  }
  aoiButtons.forEach((b) => b.addEventListener("click", () => focusAOI(b.dataset.aoi)));

  // ---- initial cursor position --------------------------------------------
  state.sePtr = lowerBound(eventTime, state.t);
  updateScrubberFromT();
  clockEl.textContent = formatClock(state.t);

  // v2.1 intro: ONE dismissible card, sim PLAYING behind it, remembered.
  // The 3-step guided tour still exists — now opt-in behind the ? button.
  function dismissIntro() {
    introEl.hidden = true;
    chromeEl.hidden = false;
    try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch (_) {}
    playPauseEl.focus();
  }
  let introSeen = false;
  try { introSeen = localStorage.getItem(INTRO_SEEN_KEY) === "1"; } catch (_) {}
  if (introSeen) {
    introEl.hidden = true;
    chromeEl.hidden = false;
  } else {
    introBeginEl.focus();
  }
  introBeginEl.addEventListener("click", dismissIntro);

  helpBtnEl.addEventListener("click", () => {
    const wasPaused = state.paused;
    chromeEl.hidden = true;
    beginStory(); // 3-step tour; steps 1-2 pause (as designed, now opt-in)
    tourResumePaused = wasPaused;
  });

  // ---- guided intro: 3-step click-stepper (Task 10) -----------------------
  // Bremer/Visual Cinnamon click-stepper: a step counter + a single "Next"
  // button. The user drives the pace; nothing hijacks scroll or auto-advances
  // on a timer. Each step is a small script over the SAME state/field the
  // free-explore chrome uses, so "Explore" at the end is a plain handoff —
  // no separate demo mode to fall out of sync with.
  // Guided steps 1-2 confine the projection to the TOP portion of the canvas
  // (clear of the bottom-anchored #stepper-card) so the seeded Helsinki-stop
  // ripple never lands directly underneath the opaque card — it lit up
  // correctly all along, just hidden behind the chrome. See STORY_TOP_FRAC.
  const STORY_STEPS = [
    {
      caption: "One stop, one ripple — the streets a rider can reach on foot in three minutes.",
      run() {
        setPaused(true);
        // Top-cropped STATIC projection for the seeded ripple (clear of the
        // bottom stepper card) — the camera is bypassed during the tour.
        introProj = makeProjection(bboxObj(AOIS.Helsinki), canvas.clientWidth,
                                   canvas.clientHeight * STORY_TOP_FRAC, 24);
        syncProjection();
        field.resize(canvas.width, canvas.height);
        seedStopRipple(STORY_STOP_SOLO);
      },
    },
    {
      caption: "Where two ripples meet, they add — brighter means more reachable. This tram stop and bus stop sit metres apart; their walking-reach overlaps.",
      run() {
        setPaused(true);
        // stays focused on Helsinki from step 1 (same top-cropped projection);
        // re-stamp fresh so the solo ripple's decay doesn't dim the pair
        // unevenly.
        field.resize(canvas.width, canvas.height);
        seedStopRipple(STORY_STOP_PAIR);
      },
    },
    {
      caption: "Now the whole morning — thousands of ripples, the city breathing in light.",
      run() {
        introProj = null;         // hand the view back to the free camera
        focusAOI("region");
        setSpeed(60);
        setPaused(false);
      },
    },
  ];
  let storyStep = 0;
  let tourResumePaused = false;

  function renderStep() {
    stepNumEl.textContent = String(storyStep + 1);
    const step = STORY_STEPS[storyStep];
    stepCaptionEl.textContent = step.caption;
    step.run();
    const isLast = storyStep === STORY_STEPS.length - 1;
    stepNextEl.hidden = isLast;
    stepExploreEl.hidden = !isLast;
    (isLast ? stepExploreEl : stepNextEl).focus();
  }

  function beginStory() {
    introEl.hidden = true;
    stepperEl.hidden = false;
    storyStep = 0;
    renderStep();
  }

  function endStory() {
    // A user who exits the tour early via Explore (mid step 1/2) must get
    // the free camera back — introProj may still be set to the top-cropped
    // override.
    introProj = null;
    syncProjection();
    stepperEl.hidden = true;
    chromeEl.hidden = false;
    // Hand off cleanly to free-explore: resync the sim cursor to "now" so
    // playback continues forward from state.t instead of re-sweeping
    // whatever the scripted steps left sePtr pointing at.
    state.sePtr = lowerBound(eventTime, state.t);
    setPaused(tourResumePaused); // restore whatever play state ? was clicked in
    playPauseEl.focus();
  }

  stepNextEl.addEventListener("click", () => {
    if (storyStep < STORY_STEPS.length - 1) {
      storyStep++;
      renderStep();
    }
  });
  stepExploreEl.addEventListener("click", endStory);

  // Per-mode scratch buffers, reused across frames to avoid GC churn.
  const modeSegs = [[], [], [], [], []];
  const modeDelays = [[], [], [], [], []];
  const modeAges = [[], [], [], [], []];

  // Resolve one edge (stamp-slice entry k, belonging to `stop`) into a
  // projected line segment + its baked delay + the event's current age,
  // pushed into the per-mode scratch buffers. Shared by both the all-at-once
  // seed path and the live wavefront path below — the only difference
  // between them is WHICH k's get pushed (and what age is passed), not how
  // a k becomes pixels.
  //
  // Band-shader model (Task 8/9): brightness at an edge is recomputed EVERY
  // FRAME from (delay, age) by the shader, not accumulated by decay(). So
  // `delay` here is the RAW stampDelay[k] value in seconds (the walking-time
  // offset at which this edge sits on the wavefront) — NOT divided by 65535;
  // that /65535 normalization was for the old scalar intensity model, which
  // the band model no longer uses.
  //
  // Every stop stamps unconditionally (v2.2 retired AOI/district admission
  // filtering — spec Q4-A): resolveStopBuffer only decides WHICH city street
  // buffer a stop's edges live in (via the baked stopCity code — never
  // re-derived from bbox containment client-side, since Kauniainen's bbox
  // nests entirely inside Espoo's), not WHETHER to stamp it.
  function pushEdge(segArr, mode, k, age) {
    const edgeIdx = stampEdge[k];
    const base = 4 * edgeIdx;
    const ax = segArr[base], ay = segArr[base + 1];
    const bx = segArr[base + 2], by = segArr[base + 3];
    const proj = state.proj;
    const [pax, pay] = proj.fn(ax, ay);
    const [pbx, pby] = proj.fn(bx, by);
    const delay = stampDelay[k];
    modeSegs[mode].push(pax, pay, pbx, pby);
    modeDelays[mode].push(delay, delay);
    modeAges[mode].push(age, age);
  }

  // Resolve a stop's city street-buffer + mode. Returns null if this stop
  // cannot be stamped at all (no street buffer or an empty stamp slice) —
  // NOT an AOI/district admission test: v2.2 retired admission filtering
  // (spec Q4-A). Districts and AOI chips are navigation-only; culling is by
  // the live viewport (see viewBbox/visibleBbox), not by selection.
  function resolveStopBuffer(stop) {
    const cnt = stampIndex[2 * stop + 1];
    if (cnt === 0) return null;
    const cityCode = stopCity[stop];
    if (cityCode === REGION_ONLY_CITY_CODE) return null; // no street buffer for this stop
    const cityName = CITY_NAMES[cityCode];
    const segArr = streets[cityName];
    if (!segArr) return null;
    return { segArr, mode: stopMode[stop], off: stampIndex[2 * stop], cnt };
  }

  // Stamp a stop's ENTIRE isochrone at once, full intensity, no wavefront —
  // the didactic "here's everything reachable in 3 minutes" snapshot used
  // ONLY by the paused guided-intro steps (see seedStopRipple below). Live
  // playback never calls this; it uses the live re-stamp path instead.
  //
  // Age choice for the paused snapshot: pass age = each edge's OWN delay
  // (age === T), which sits every edge exactly AT its own crest (T === front
  // in the band formula, since front = age*frontSpeed and frontSpeed==1 by
  // default gives front===delay). That lights every edge in the isochrone at
  // full crest brightness simultaneously — the "here's everything reachable"
  // snapshot the caption describes — without needing a running demo clock.
  function stampEventAllAtOnce(stop) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return;
    for (let k = buf.off; k < buf.off + buf.cnt; k++) {
      const age = stampDelay[k] / RIPPLE_PARAMS.frontSpeed;
      pushEdge(buf.segArr, buf.mode, k, age);
    }
  }

  // Draw whatever pushEdge() has accumulated into modeSegs/modeDelays/modeAges,
  // grouped by mode (one draw call per mode, additive blend). Shared by
  // the rAF loop and the scripted intro (seedStopRipple).
  function flushStamps(params = RIPPLE_PARAMS) {
    for (let m = 0; m < modeSegs.length; m++) {
      if (modeSegs[m].length === 0) continue;
      field.stamp(
        Float32Array.from(modeSegs[m]),
        Float32Array.from(modeDelays[m]),
        Float32Array.from(modeAges[m]),
        MODE_COLORS[m],
        params
      );
    }
  }

  // Seed a ripple for one or more stops on demand, bypassing the sim-time
  // event stream entirely — used by the guided intro (steps 1-2) to bloom
  // a clean, deterministic droplet (or two, for the interference demo)
  // regardless of where state.t/sePtr happen to be. Reuses the exact same
  // stamp-resolution + additive draw path as the live rAF loop so the
  // scripted ripple looks identical to a "real" one.
  //
  // Design choice (final-review item 6): these guided-intro steps are
  // PAUSED (setPaused(true)) — sim-time never advances while they're shown,
  // so a wavefront driven by `state.t - fireTime` would never animate here
  // anyway without extra machinery (a separate rAF-driven demo clock). The
  // steps' captions are explicitly about the FULL reachable area ("the
  // streets a rider can reach on foot in three minutes" / "their walking-
  // reach overlaps") — an all-at-once snapshot is exactly what they teach.
  // Only the LIVE region/AOI playback (the frame() loop below) gets the
  // propagating wavefront.
  function seedStopRipple(stopIndices) {
    const stops = Array.isArray(stopIndices) ? stopIndices : [stopIndices];
    for (const arr of modeSegs) arr.length = 0;
    for (const arr of modeDelays) arr.length = 0;
    for (const arr of modeAges) arr.length = 0;
    for (const stop of stops) stampEventAllAtOnce(stop);
    flushStamps(INTRO_PARAMS);
    // Also persist the resolved buffers so the rAF loop's per-frame
    // field.clearField() doesn't wipe this seed on the very next frame (see
    // restampSeededStops below) — a one-shot stampEventAllAtOnce alone only
    // lasts until the next clear, which for a PAUSED intro step is the very
    // next frame. Replaces any prior seed (step 2 supersedes step 1's).
    seededStops = stops.map(resolveStopBuffer).filter((buf) => buf !== null);
  }

  // ---- Live ripple re-stamp (Task 9 rewrite) -------------------------------
  // Band-shader model (Task 8): brightness at an edge is `bandBrightness(T =
  // stampDelay[k], age, params)`, recomputed fresh every frame from `age` —
  // there is no accumulated/decaying field state to advance incrementally
  // anymore. So instead of stamping each edge ONCE when its delay is crossed
  // (the old cursor-based wavefront-crossing model) and letting field.decay()
  // fade the accumulated texture, the field is CLEARED and every edge of
  // every in-flight event is RE-STAMPED each frame with that event's current
  // age. The shader's own crest/wake formula zeros out edges outside the
  // band, so the visible result is still a moving ring, not a wash — the
  // wavefront motion now lives in the shader, not in which edges get pushed.
  //
  // activeEvents holds one entry per recently-fired event still "in flight"
  // (age < horizonSec — after that every one of its edges has decayed under
  // life_tau well past visibility, so it's dropped to bound per-frame cost).
  //
  // COST-BOUND DESIGN NOTE: per-frame cost is the SUM of edge counts over all
  // active events (not just the crossings admitted this frame), since every
  // edge of every in-flight event is pushed every frame. This is bounded by
  // (local event rate) x horizonSec x (avg edges/event) — the same resident
  // population the old cursor model was careful about growing, but now each
  // resident event costs its FULL edge count per frame instead of amortizing
  // that cost across the frames it takes to cross. This is the necessary
  // trade for switching to a per-frame-recomputed band (there's no cheaper
  // way to represent "brightness is a function of age" without baking a
  // decaying accumulator, which is exactly what produced the wash). The
  // population itself stays bounded via horizonSec + SPAWN_BUDGET admission,
  // matching prior behavior; in-flight edge totals remain the same order of
  // magnitude as before (thousands), not O(all edges) or O(all stops).
  let activeEvents = []; // { fireTime, buf: {segArr, mode, off, cnt} }

  // Persistent guided-intro seed (Task 10 fix): unlike activeEvents (live,
  // time-driven, retired by horizonSec), seededStops holds the paused
  // intro's snapshot buffers so restampSeededStops() below can re-stamp them
  // every frame — surviving the per-frame field.clearField() the same way
  // activeEvents does. At most 2 entries (STORY_STOP_SOLO / STORY_STOP_PAIR).
  let seededStops = [];

  function clearActiveEvents() {
    activeEvents = [];
    seededStops = []; // any stale guided-intro seed must not survive a scrub/AOI-change/wrap either
  }

  // Activate a newly-fired event: resolve its city/mode buffer (AOI filter
  // applied here, at activation time — matches the old stampEvent
  // semantics), and push it onto the active ring. No per-edge sort needed
  // anymore (the old cursor model sorted by delay to advance incrementally;
  // the re-stamp model pushes every edge every frame regardless of order).
  function activateEvent(stop, fireTime) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return; // wrong AOI / no street buffer / empty slice — nothing to track
    activeEvents.push({ fireTime, buf });
  }

  // Re-stamp every active event's full edge set this frame, using the
  // event's current age (age = state.t - fireTime, same value for every edge
  // of that event — the band shader is what differentiates brightness across
  // edges via each edge's own stampDelay). Retires events whose age has
  // passed horizonSec. Pushes into the shared modeSegs/modeDelays/modeAges
  // scratch buffers (caller flushes).
  function restampActiveEvents() {
    const now = state.t;
    let write = 0;
    for (let i = 0; i < activeEvents.length; i++) {
      const ev = activeEvents[i];
      const age = realAge(now - ev.fireTime, state.speed);
      // retire on REAL age (visual life over) OR a sim-age cap so scrubbing
      // far ahead can't keep a huge stale population alive at high speed.
      if (age >= rippleLifeHorizon(state.speed) || now - ev.fireTime >= 5 * horizonSec) continue;
      const { segArr, mode, off, cnt } = ev.buf;
      for (let k = off; k < off + cnt; k++) pushEdge(segArr, mode, k, age);
      activeEvents[write++] = ev;
    }
    activeEvents.length = write;
  }

  // Re-stamp the guided-intro's seeded stops (see seededStops above) every
  // frame, same reason as restampActiveEvents: the field is cleared each
  // frame, so anything not re-pushed vanishes on the next frame. Age is
  // pinned to each edge's own delay (age === T, matching stampEventAllAtOnce)
  // so the full isochrone sits at crest brightness simultaneously — the
  // static "here's everything reachable" snapshot the intro captions
  // describe, not an animating wavefront.
  function restampSeededStops() {
    for (let i = 0; i < seededStops.length; i++) {
      const { segArr, mode, off, cnt } = seededStops[i];
      for (let k = off; k < off + cnt; k++) {
        const age = stampDelay[k] / RIPPLE_PARAMS.frontSpeed;
        pushEdge(segArr, mode, k, age);
      }
    }
  }

  // ---- Task 12: hidden-tab pause -------------------------------------------
  // A backgrounded tab still gets rAF callbacks (throttled by the browser,
  // but not zero), so without this guard the field keeps clearing/re-stamping
  // off-screen — wasted GPU/battery. Skip all sim work while hidden.
  //
  // On resume, reset lastFrameTs to null so the next visible frame treats
  // itself as the "first" frame (dtRealMs = 0) instead of computing a dt
  // spanning the entire hidden interval, which would otherwise produce a
  // huge dtSim jump (e.g. minutes of sim-time in one step).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) state.lastFrameTs = null;
  });

  // ---- rAF loop ------------------------------------------------------------
  function frame(ts) {
    if (document.hidden) {
      // Don't accumulate a dt spike across the hidden interval; just wait
      // for the tab to become visible again (visibilitychange resets
      // lastFrameTs so the resume frame doesn't jump sim-time).
      requestAnimationFrame(frame);
      return;
    }

    if (state.lastFrameTs === null) state.lastFrameTs = ts;
    const dtRealMs = state.paused ? 0 : ts - state.lastFrameTs;
    state.lastFrameTs = ts;
    recordFrameDt(dtRealMs);

    // v2.2: advance an in-flight fly-to; sync the projection every frame the
    // camera is animating (manual input syncs eagerly in its own handlers).
    if (flyAnim) {
      const flying = stepFlyTo(flyAnim, camera, ts);
      if (!flying) flyAnim = null;
      syncProjection();
    }

    const dtSim = (dtRealMs * state.speed) / 1000;

    if (dtSim > 0) {
      let tNext = state.t + dtSim;
      if (tNext > dataMax) {
        // Hard jump: wrap to the start of the data window and clear the
        // field (a stale, high-value field would otherwise "teleport" a
        // bright wash of un-decayed light back to t=dataMin).
        tNext = dataMin;
        field.resize(canvas.width, canvas.height);
        state.sePtr = lowerBound(eventTime, tNext);
        clearActiveEvents(); // no stale in-flight wavefronts should survive the wrap
      }
      state.t = tNext;
    }

    // Band-shader model: brightness is recomputed from age every frame, so
    // the field must be CLEARED then RE-STAMPED from scratch each frame
    // (no accumulate/decay step anymore — see restampActiveEvents' doc
    // comment). A paused frame still clears+re-stamps (so the guided-intro
    // snapshot stays lit while paused); only sim-time advancement and event
    // activation are gated on dtSim > 0 below.
    field.clearField();

    for (const arr of modeSegs) arr.length = 0;
    for (const arr of modeDelays) arr.length = 0;
    for (const arr of modeAges) arr.length = 0;

    if (dtSim > 0) {
      // Activate newly-fired events (same forward-only sweep + stride
      // sampling as before — SPAWN_BUDGET still caps how many events join
      // the active ring per frame, even at 300x). Activation does NOT
      // stamp anything yet; it just registers the event so it starts being
      // re-stamped from the NEXT line below.
      const { events, nextPtr } = eventsInWindow(eventTime, state.sePtr, state.t);
      const [lo, hi] = events;
      const pending = hi - lo;
      if (pending > 0) {
        const stride = pending > SPAWN_BUDGET ? Math.ceil(pending / SPAWN_BUDGET) : 1;
        for (let i = lo; i < hi; i += stride) {
          activateEvent(eventStop[i], eventTime[i]);
        }
      }
      state.sePtr = nextPtr; // forward-only: never re-activate an already-swept event
    }

    // Re-stamp every active event's full edge set at its current age (see
    // restampActiveEvents' doc comment for the cost-bound argument). This
    // runs even when paused (dtSim === 0) so the field stays lit between
    // frames instead of flashing empty (clearField() above wiped it).
    //
    // Live and seeded (guided-intro) stamps are flushed SEPARATELY, each with
    // its own params (RIPPLE_PARAMS for live, INTRO_PARAMS — life decay off —
    // for the paused snapshot): a single shared flush would force one lifeTau
    // on both, either blinking the live ripples or freezing the intro's decay.
    restampActiveEvents();
    flushStamps(state.speed === 1 ? RIPPLE_PARAMS_1X : RIPPLE_PARAMS); // live events

    for (const arr of modeSegs) arr.length = 0;
    for (const arr of modeDelays) arr.length = 0;
    for (const arr of modeAges) arr.length = 0;

    restampSeededStops();
    flushStamps(INTRO_PARAMS);          // intro snapshot, life decay off

    // ---- Vehicle dots (Task 9 Part D, Option A) -----------------------------
    // Interpolate every live trip's XY in JS at state.t (ported, tested
    // vehiclePosition — see vehicles.js), viewport-cull, project, color by mode.
    // Guarded: an older bake without vehicle bins (vehData null) simply
    // skips this pass — ripples-only. Runs only while playing (a paused
    // frame has no meaningful "live" vehicle set — state.t isn't advancing).
    if (vehData && vehicleMeta && !state.paused) {
      const pts = [], cols = [];
      const bb = viewBbox();
      let pushed = 0;
      // 1x: vehicles are the visible life at real time — bigger, brighter (spec §4).
      const oneX = state.speed === 1;
      const oneXAlpha = oneX ? 0.8 : 0.55;
      for (let ti = 0; ti < vehData.trips.length && pushed < VEHICLE_DOT_BUDGET; ti++) {
        const trip = vehData.trips[ti];
        const pos = vehiclePosition(trip, state.t, vehData);
        if (!pos) continue;
        const [x, y] = pos;
        // Viewport cull: skip if outside the current camera bbox (cheap lon/lat test).
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        const [px, py] = state.proj.fn(x, y);
        const mode = MODE_CODE(vehData.routes[trip.shape].mode);
        const c = MODE_COLORS[mode];
        pts.push(px, py); cols.push(c[0], c[1], c[2], oneXAlpha);
        pushed++;
      }
      if (pts.length) field.stampDots(Float32Array.from(pts), Float32Array.from(cols),
                                      oneX ? 6.0 : 4.0);
    }

    // ---- Impact dots ---------------------------------------------------------
    // A bright flash at the exact stop coordinate the instant an event fires,
    // fading out linearly over IMPACT_FADE_SIM_SEC — a short, independent
    // look-back over the tail of already-activated events (bounded by how
    // many events fired in the last few sim-sec, not by activeEvents' full
    // in-flight population).
    {
      const cutoff = state.t - IMPACT_FADE_SIM_SEC;
      let lo = lowerBound(eventTime, cutoff);
      const hi = state.sePtr; // events up to (not including) the not-yet-activated tail
      const pts = [], cols = [];
      const bb = viewBbox();
      for (let i = lo; i < hi; i++) {
        const et = eventTime[i];
        if (et > state.t) continue; // defensive: shouldn't happen (sePtr is forward-only)
        const age = state.t - et;
        if (age < 0 || age >= IMPACT_FADE_SIM_SEC) continue;
        const stop = eventStop[i];
        const cityCode = stopCity[stop];
        if (cityCode === REGION_ONLY_CITY_CODE) continue;
        const x = stops[2 * stop], y = stops[2 * stop + 1];
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        const [px, py] = state.proj.fn(x, y);
        const alpha = (1 - age / IMPACT_FADE_SIM_SEC) * 0.6;
        const c = MODE_COLORS[stopMode[stop]];
        pts.push(px, py); cols.push(c[0], c[1], c[2], alpha);
      }
      if (pts.length) field.stampDots(Float32Array.from(pts), Float32Array.from(cols), 7.0);
    }

    field.present();

    clockEl.textContent = formatClock(state.t);
    if (!state.paused) updateScrubberFromT();
    maybeUpdateStatus(ts);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Boot guard: app.js must not throw when #map is absent (e.g. a harness that
// loads this module without the app chrome).
if (typeof document !== "undefined" && document.getElementById("map")) {
  initApp().catch((err) => {
    console.error("app init failed", err);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "ERROR: " + (err && err.message ? err.message : err);
  });
}
