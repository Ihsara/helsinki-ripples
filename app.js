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
import { makeProjection, eventsInWindow, RippleField, realAge, clampSkip, inBbox } from "./field.js";
import { vehiclePosition } from "./vehicles.js";

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

  // Guided-intro snapshot params: same band, but life decay disabled so the
  // whole isochrone reads at crest brightness (age varies per edge; without
  // this the far edges dim to ~0.19 of the near ones under life_tau=3).
  const INTRO_PARAMS = { ...RIPPLE_PARAMS, lifeTau: 1e9 };

  // Real-seconds visual life ceiling: crest sweep (horizon/frontSpeed = 5s)
  // + wake/life tail. Events older than this are invisible; retire them.
  const RIPPLE_LIFE_HORIZON_REAL_SEC = 8.0;

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
    const str = "aoi " + state.aoi + " | speed " + state.speed + "x" +
      (state.speed === 1 && !state.paused ? " (real-time — events are rare)" : "") +
      (state.paused ? " | paused" : "") +
      " | " + Math.round(fpsValue) + " fps";
    if (str !== lastStatusStr) {
      lastStatusStr = str;
      statusEl.textContent = str;
    }
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

  // `usableH` lets a caller confine the projection to the TOP portion of the
  // canvas (e.g. clear of the bottom-anchored #stepper-card during the guided
  // intro), so a seeded ripple never lands directly underneath opaque UI
  // chrome. Free-explore always passes the full height (default), unchanged.
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");

  // viewBbox — the bbox currently governing camera + admission + dot culls:
  // a focused district's bbox when set, else the whole AOI's bbox. Shared by
  // fitProjection, resolveStopBuffer, and both dot-cull loops so a district
  // focus and the AOI fallback can never drift apart.
  function viewBbox() {
    return state.district ? state.district.bbox : AOIS[state.aoi];
  }

  function fitProjection(usableH) {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    field.resize(w, h);
    const bb = state.district ? bboxObj(state.district.bbox) : bboxObj(AOIS[state.aoi]);
    state.proj = makeProjection(bb, w, usableH || h, 24);
    drawDistrictOutline();
  }
  window.addEventListener("resize", () => fitProjection());

  // drawDistrictOutline — the focused district's ring as a faint STATIC line,
  // drawn once per camera change (not per rAF frame: the band shader's own
  // additive stamp pipeline would animate it, and stampDots only does points —
  // a plain 2D overlay canvas is the simplest correct tool for a static shape).
  // Sized to match the map canvas every call so a resize never leaves it
  // stale/mis-scaled.
  function drawDistrictOutline() {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!state.district) return;
    octx.strokeStyle = "rgba(255,255,255,0.12)";
    octx.lineWidth = 1;
    octx.beginPath();
    const ring = state.district.ring;
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = state.proj.fn(ring[i][0], ring[i][1]);
      if (i === 0) octx.moveTo(px, py); else octx.lineTo(px, py);
    }
    octx.closePath();
    octx.stroke();
  }

  fitProjection();

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

  // ---- AOI picker: reframe the projection to the chosen city's bbox and
  // (via the rAF loop's stamp filter, below) restrict stamped ripples to
  // that city's own street segments. Region shows every city, unfiltered.
  function focusAOI(name, usableH) {
    state.district = null; // a district belongs to one city; never survives an AOI switch
    state.aoi = name;
    aoiButtons.forEach((b) => b.classList.toggle("active", b.dataset.aoi === name));
    fitProjection(usableH); // reprojects to AOIS[name] AND clears the field (field.resize)
    state.sePtr = lowerBound(eventTime, state.t); // hard re-sync, like a scrub
    clearActiveEvents(); // stale wavefronts reference the OLD AOI's resolved city buffer
    renderDistrictPicker();
  }
  aoiButtons.forEach((b) => b.addEventListener("click", () => focusAOI(b.dataset.aoi)));

  // ---- District picker (Task 6): a second chip row that appears once a city
  // AOI is focused, listing that city's major districts (from the Task 5
  // bake) as camera presets. "All" clears the focus back to the whole city.
  // Region view has no districts list, so the row stays hidden there.
  const districtPickerEl = document.getElementById("district-picker");

  function renderDistrictPicker() {
    const list = (districts && state.aoi !== "region" && districts[state.aoi]) || null;
    districtPickerEl.hidden = !list;
    districtPickerEl.textContent = "";
    if (!list) return;
    const mk = (label, dist) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.classList.toggle("active", (state.district?.name ?? null) === (dist?.name ?? null));
      b.addEventListener("click", () => focusDistrict(dist));
      districtPickerEl.appendChild(b);
    };
    mk("All", null);
    for (const dist of list) mk(dist.name, dist);
  }

  // District select = same hard-jump semantics as an AOI change: refit the
  // camera (clears the field via fitProjection->field.resize), resync the
  // event cursor, drop stale in-flight wavefronts.
  function focusDistrict(dist) {
    state.district = dist;
    fitProjection();
    state.sePtr = lowerBound(eventTime, state.t);
    clearActiveEvents();
    renderDistrictPicker();
  }

  // ---- initial cursor position --------------------------------------------
  state.sePtr = lowerBound(eventTime, state.t);
  updateScrubberFromT();
  clockEl.textContent = formatClock(state.t);
  renderDistrictPicker(); // boot state is aoi:"region" — row starts hidden

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
  const STORY_TOP_FRAC = 0.55;

  const STORY_STEPS = [
    {
      caption: "One stop, one ripple — the streets a rider can reach on foot in three minutes.",
      run() {
        setPaused(true);
        focusAOI("Helsinki", canvas.clientHeight * STORY_TOP_FRAC);
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
  // AOI filtering: region view stamps every stop (unfiltered — matches the
  // live-verified Task 8 behavior exactly). A city view stamps ONLY stops
  // whose BAKED stopCity code names that city. This must NOT be re-derived
  // from bbox containment client-side: Kauniainen's bbox nests entirely
  // inside Espoo's, so a first-match bbox test would silently steal
  // Kauniainen's stops into the Espoo view. The bake (Task 4) already
  // resolved that ambiguity once, correctly, into stopCity — trust it.
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

  // Resolve a stop's city buffer + mode, applying the AOI filter. Returns
  // null if this stop should not be stamped in the current view (wrong
  // city, no street buffer, or an empty stamp slice).
  function resolveStopBuffer(stop) {
    const cnt = stampIndex[2 * stop + 1];
    if (cnt === 0) return null;
    const cityCode = stopCity[stop];
    if (cityCode === REGION_ONLY_CITY_CODE) return null; // no street buffer for this stop
    const cityName = CITY_NAMES[cityCode];
    if (state.aoi !== "region" && cityName !== state.aoi) return null; // wrong city for this AOI
    if (state.district &&
        !inBbox(stops[2 * stop], stops[2 * stop + 1], state.district.bbox)) {
      return null; // outside the focused district — bbox test; edge spill-over
                    // from admitted stops still renders (whole-city street buffer)
    }
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
      if (age >= RIPPLE_LIFE_HORIZON_REAL_SEC || now - ev.fireTime >= 5 * horizonSec) continue;
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
    flushStamps();                      // live events, RIPPLE_PARAMS

    for (const arr of modeSegs) arr.length = 0;
    for (const arr of modeDelays) arr.length = 0;
    for (const arr of modeAges) arr.length = 0;

    restampSeededStops();
    flushStamps(INTRO_PARAMS);          // intro snapshot, life decay off

    // ---- Vehicle dots (Task 9 Part D, Option A) -----------------------------
    // Interpolate every live trip's XY in JS at state.t (ported, tested
    // vehiclePosition — see vehicles.js), AOI-cull, project, color by mode.
    // Guarded: an older bake without vehicle bins (vehData null) simply
    // skips this pass — ripples-only. Runs only while playing (a paused
    // frame has no meaningful "live" vehicle set — state.t isn't advancing).
    if (vehData && vehicleMeta && !state.paused) {
      const pts = [], cols = [];
      const bb = viewBbox();
      let pushed = 0;
      for (let ti = 0; ti < vehData.trips.length && pushed < VEHICLE_DOT_BUDGET; ti++) {
        const trip = vehData.trips[ti];
        const pos = vehiclePosition(trip, state.t, vehData);
        if (!pos) continue;
        const [x, y] = pos;
        // AOI cull: skip if outside the current projection bbox (cheap lon/lat test).
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        const [px, py] = state.proj.fn(x, y);
        const mode = MODE_CODE(vehData.routes[trip.shape].mode);
        const c = MODE_COLORS[mode];
        pts.push(px, py); cols.push(c[0], c[1], c[2], 0.55);
        pushed++;
      }
      if (pts.length) field.stampDots(Float32Array.from(pts), Float32Array.from(cols), 4.0);
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
        const cityName = CITY_NAMES[cityCode];
        if (state.aoi !== "region" && cityName !== state.aoi) continue;
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
