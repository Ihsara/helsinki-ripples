// app.js — the ripples app: boot, region-wide rAF loop, DOM chrome.
//
// Orchestration only: pure logic (projection, decay, stamp windowing, the
// WebGL field) lives in field.js; binary loading lives in data.js. This
// module wires those to the DOM and drives one requestAnimationFrame loop
// that plays the region-wide ripple field on sim-time.

import { loadAll } from "./data.js";
import { makeProjection, decayFactor, eventsInWindow, RippleField } from "./field.js";

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

// Visual half-life for the decay-accumulate field (Task 11 tuning), decoupled
// from the bake's manifest.tau_sec (the physics isochrone decay constant).
// A lone ripple should visually live ~4-8 REAL seconds at the default 60x
// speed preset; at 60x, RIPPLE_HALF_LIFE_SIM_SEC / 60 = real seconds per
// half-life. 300 sim-sec / 60 = 5 real-sec per half-life (a ripple reads for
// several half-lives, so ~10-15 real-sec total fade, clearly visible without
// lingering forever). Tune here — do not read tau_sec directly for display.
const RIPPLE_HALF_LIFE_SIM_SEC = 300;

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
  // Note: manifest.tau_sec is the physics isochrone decay constant (baked into
  // stamp intensities); it is NOT used for the display fade — see
  // RIPPLE_HALF_LIFE_SIM_SEC above, which is a separate, tunable visual value.

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
  const horizonSec = manifest.horizon_sec;

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
  function fitProjection(usableH) {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    field.resize(w, h);
    state.proj = makeProjection(bboxObj(AOIS[state.aoi]), w, usableH || h, 24);
  }
  window.addEventListener("resize", () => fitProjection());
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
    playPauseEl.textContent = p ? "▶" : "❬❬";
    playPauseEl.setAttribute("aria-pressed", String(p));
  }
  playPauseEl.addEventListener("click", () => setPaused(!state.paused));
  setPaused(false);
  setSpeed(60);

  // ---- AOI picker: reframe the projection to the chosen city's bbox and
  // (via the rAF loop's stamp filter, below) restrict stamped ripples to
  // that city's own street segments. Region shows every city, unfiltered.
  function focusAOI(name, usableH) {
    state.aoi = name;
    aoiButtons.forEach((b) => b.classList.toggle("active", b.dataset.aoi === name));
    fitProjection(usableH); // reprojects to AOIS[name] AND clears the field (field.resize)
    state.sePtr = lowerBound(eventTime, state.t); // hard re-sync, like a scrub
    clearActiveEvents(); // stale wavefronts reference the OLD AOI's resolved city buffer
  }
  aoiButtons.forEach((b) => b.addEventListener("click", () => focusAOI(b.dataset.aoi)));

  // ---- initial cursor position --------------------------------------------
  state.sePtr = lowerBound(eventTime, state.t);
  updateScrubberFromT();
  clockEl.textContent = formatClock(state.t);
  introBeginEl.focus();

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
    playPauseEl.focus();
  }

  introBeginEl.addEventListener("click", beginStory);
  stepNextEl.addEventListener("click", () => {
    if (storyStep < STORY_STEPS.length - 1) {
      storyStep++;
      renderStep();
    }
  });
  stepExploreEl.addEventListener("click", endStory);

  // Per-mode scratch buffers, reused across frames to avoid GC churn.
  const modeSegs = [[], [], [], [], []];
  const modeIntens = [[], [], [], [], []];

  // Resolve one edge (stamp-slice entry k, belonging to `stop`) into a
  // projected line segment + intensity, pushed into the per-mode scratch
  // buffers. Shared by both the all-at-once seed path and the wavefront
  // (crossing) path below — the only difference between them is WHICH k's
  // get pushed each call, not how a k becomes pixels.
  //
  // AOI filtering: region view stamps every stop (unfiltered — matches the
  // live-verified Task 8 behavior exactly). A city view stamps ONLY stops
  // whose BAKED stopCity code names that city. This must NOT be re-derived
  // from bbox containment client-side: Kauniainen's bbox nests entirely
  // inside Espoo's, so a first-match bbox test would silently steal
  // Kauniainen's stops into the Espoo view. The bake (Task 4) already
  // resolved that ambiguity once, correctly, into stopCity — trust it.
  function pushEdge(segArr, mode, k) {
    const edgeIdx = stampEdge[k];
    const base = 4 * edgeIdx;
    const ax = segArr[base], ay = segArr[base + 1];
    const bx = segArr[base + 2], by = segArr[base + 3];
    const proj = state.proj;
    const [pax, pay] = proj.fn(ax, ay);
    const [pbx, pby] = proj.fn(bx, by);
    const inten = stampIntensity[k] / 65535;
    modeSegs[mode].push(pax, pay, pbx, pby);
    modeIntens[mode].push(inten, inten);
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
    const segArr = streets[cityName];
    if (!segArr) return null;
    return { segArr, mode: stopMode[stop], off: stampIndex[2 * stop], cnt };
  }

  // Stamp a stop's ENTIRE isochrone at once, full intensity, no wavefront —
  // the didactic "here's everything reachable in 3 minutes" snapshot used
  // ONLY by the paused guided-intro steps (see seedStopRipple below). Live
  // playback never calls this; it uses the wavefront-crossing path instead.
  function stampEventAllAtOnce(stop) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return;
    for (let k = buf.off; k < buf.off + buf.cnt; k++) pushEdge(buf.segArr, buf.mode, k);
  }

  // Draw whatever pushEdge() has accumulated into modeSegs/modeIntens,
  // grouped by mode (one draw call per mode, additive blend). Shared by
  // the rAF loop and the scripted intro (seedStopRipple).
  function flushStamps() {
    for (let m = 0; m < modeSegs.length; m++) {
      if (modeSegs[m].length === 0) continue;
      field.stamp(Float32Array.from(modeSegs[m]), Float32Array.from(modeIntens[m]), MODE_COLORS[m]);
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
    for (const arr of modeIntens) arr.length = 0;
    for (const stop of stops) stampEventAllAtOnce(stop);
    flushStamps();
  }

  // ---- Live wavefront propagation (final-review) --------------------------
  // Every stop-event lights its isochrone edges progressively, as the
  // walking wavefront reaches them — NOT all at once. `stampDelay[k]` is the
  // baked one-way walking delay (seconds) for edge k in a stop's slice; an
  // edge should light exactly once, at the sim-frame where the walking-time
  // age (age = state.t - fireTime) reaches stampDelay[k].
  //
  // activeEvents holds one entry per recently-fired event still "in
  // flight" (age < horizonSec, i.e. its wavefront hasn't finished sweeping
  // past every one of its edges yet).
  //
  // COST-BOUND DESIGN NOTE: a naive version of this ("for each active
  // event, scan ALL its edges every frame, testing if delay has been
  // crossed") would NOT be constant-cost — activeEvents.length grows with
  // local event DENSITY (roughly density x horizonSec, unbounded by
  // SPAWN_BUDGET, which only throttles per-frame ADMISSION, not the
  // resident population), so a busy rush-hour period would scan far more
  // edges per frame than a quiet one even though only ~SPAWN_BUDGET-worth
  // of NEW crossings occur per frame. To avoid that, each event's edges
  // are sorted by delay ONCE at activation time (order = stampEdge indices
  // sorted ascending by stampDelay), and each event carries a single
  // cursor into that order. Advancing an event then means: walk the
  // cursor forward while stampDelay[order[cursor]] <= age, stamping exactly
  // those edges, and stop — NO scan over not-yet-crossed edges. Total work
  // across an event's lifetime is still exactly its edge count (each edge
  // visited once, ever), but now the PER-FRAME cost is exactly bounded by
  // the number of edges that cross this frame, summed over all active
  // events — which is bounded by (their combined edge counts) / (frames
  // spent in flight), i.e. proportional to admitted throughput
  // (<=SPAWN_BUDGET/frame amortized), not to resident population. This is
  // the same total work as the old all-at-once stamp, just spread out, and
  // per-frame cost no longer depends on how many events happen to be
  // in-flight simultaneously.
  let activeEvents = []; // { fireTime, buf: {segArr, mode, order, delays}, cursor }

  function clearActiveEvents() {
    activeEvents = [];
  }

  // Activate a newly-fired event: resolve its city/mode buffer (AOI filter
  // applied here, at activation time — matches the old stampEvent
  // semantics), pre-sort its stamp-slice entries by delay ONCE (paid at
  // activation, not per-frame), and push it onto the active ring.
  function activateEvent(stop, fireTime) {
    const buf = resolveStopBuffer(stop);
    if (!buf) return; // wrong AOI / no street buffer / empty slice — nothing to track
    const { off, cnt } = buf;
    const order = new Array(cnt);
    for (let i = 0; i < cnt; i++) order[i] = off + i;
    order.sort((a, b) => stampDelay[a] - stampDelay[b]);
    activeEvents.push({ fireTime, buf, order, cursor: 0 });
  }

  // Advance every active event by this frame's sim-time step. For each
  // event, walk its delay-sorted cursor forward while the next edge's
  // delay has been reached by `age` — stamping ONLY edges that cross the
  // wavefront this frame, never re-scanning edges already stamped or not
  // yet due. Retires events whose cursor has exhausted every edge (or
  // whose age has passed the horizon — belt-and-suspenders, since every
  // edge's delay is baked <= horizonSec, the cursor should always exhaust
  // by then too). Pushes into the shared modeSegs/modeIntens scratch
  // buffers (caller flushes).
  function advanceWavefronts() {
    const now = state.t;
    let write = 0;
    for (let i = 0; i < activeEvents.length; i++) {
      const ev = activeEvents[i];
      const age = now - ev.fireTime;
      const { segArr, mode } = ev.buf;
      const order = ev.order;
      // The cursor-based crossing test below (stampDelay[order[ev.cursor]] <= age)
      // is the inline equivalent of the tested helper stampContribution(delay, intensity, age).
      while (ev.cursor < order.length && stampDelay[order[ev.cursor]] <= age) {
        pushEdge(segArr, mode, order[ev.cursor]);
        ev.cursor++;
      }
      if (ev.cursor < order.length && age < horizonSec) {
        activeEvents[write++] = ev; // edges remain AND still inside the horizon — keep
      }
      // else: either every edge has crossed (cursor exhausted) or the
      // horizon has passed (defensive) — retire either way.
    }
    activeEvents.length = write;
  }

  // ---- Task 12: hidden-tab pause -------------------------------------------
  // A backgrounded tab still gets rAF callbacks (throttled by the browser,
  // but not zero), so without this guard the field keeps decaying/stamping
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

    field.decay(decayFactor(RIPPLE_HALF_LIFE_SIM_SEC, dtSim));

    if (dtSim > 0) {
      for (const arr of modeSegs) arr.length = 0;
      for (const arr of modeIntens) arr.length = 0;

      // Activate newly-fired events (same forward-only sweep + stride
      // sampling as before — SPAWN_BUDGET still caps how many events join
      // the active ring per frame, even at 300x). Activation does NOT
      // stamp anything yet; it just registers the event so its wavefront
      // starts advancing from the NEXT line below.
      const { events, nextPtr } = eventsInWindow(eventTime, state.sePtr, state.t);
      const [lo, hi] = events;
      const pending = hi - lo;
      if (pending > 0) {
        const stride = pending > SPAWN_BUDGET ? Math.ceil(pending / SPAWN_BUDGET) : 1;
        for (let i = lo; i < hi; i += stride) {
          activateEvent(eventStop[i], eventTime[i]);
        }
      }
      state.sePtr = nextPtr; // forward-only: never re-stamp an already-swept event

      // Advance every active event's wavefront by this frame's dtSim,
      // stamping only the edges the wavefront crosses THIS frame (see
      // advanceWavefronts' doc comment for the constant-cost argument).
      advanceWavefronts();

      flushStamps();
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
