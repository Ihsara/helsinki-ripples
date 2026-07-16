// field.js — pure playback helpers (Task 6) + WebGL field (Task 7).
export function makeProjection(bbox, w, h, margin) {
  const m = margin || 10;
  const latMid = (bbox.minY + bbox.maxY) / 2;
  const kx = Math.cos((latMid * Math.PI) / 180);
  const dataW = (bbox.maxX - bbox.minX) * kx, dataH = bbox.maxY - bbox.minY;
  const aW = w - 2 * m, aH = h - 2 * m;
  const s = Math.min(aW / dataW, aH / dataH);
  const offX = m + (aW - dataW * s) / 2, offY = m + (aH - dataH * s) / 2;
  return { s, kx, fn: (x, y) => [offX + (x - bbox.minX) * kx * s, offY + (bbox.maxY - y) * s] };
}
export function decayFactor(halfLifeSec, dtSimSec) {
  return Math.pow(0.5, dtSimSec / halfLifeSec);
}
export function stampContribution(delay, intensity, ageSec) {
  return ageSec >= delay ? intensity : 0;
}
export function eventsInWindow(eventTime, ptr, tNow) {
  let hi = ptr;
  while (hi < eventTime.length && eventTime[hi] <= tNow) hi++;
  return { events: [ptr, hi], nextPtr: hi };
}
// realAge — the v2.1 "watchable at every speed" conversion. Ripple animation
// runs on REAL seconds: an event's sim-age is divided by playback speed at
// use time, so a droplet's visual life is ~7s at 1x, 60x and 300x alike.
// (v2.0 fed sim-age straight to the band shader, so at 60x a whole ripple
// lived 3 real-seconds — the "blinking lights" bug.) Sim-time still drives
// WHEN events fire; only the animation clock is real-time. Pause/scrub
// correctness is inherited from sim-time (it freezes/resyncs already).
export function realAge(simAge, speed) {
  return simAge / speed;
}
// clampSkip — the ±15min transport skip idiom: apply a delta-sec jump to t,
// clamped to the data window (same clamp shape the scrubber's frac already
// enforces via min(1,max(0,...)), just in raw sim-seconds here).
export function clampSkip(t, deltaSec, dataMin, dataMax) {
  return Math.min(dataMax, Math.max(dataMin, t + deltaSec));
}
// inBbox — inclusive lon/lat containment test against a [w,s,e,n] bbox array
// (the districts.json shape). Used both for event-admission filtering (Task 6)
// and could double for dot culls; boundary-inclusive by design (bbox tests
// admit edge spill-over — see Task 6 brief).
export function inBbox(x, y, bbox) {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}
// bandBrightness mirrors ripplesim.ripple.edge_brightness (the Python reference):
// a moving BAND — bright crest at the wavefront (front = age*frontSpeed) + a faint
// trailing wake — NOT a filled disc. This is the fix for the "whole street brightens"
// wash. The fragment shader below computes the identical formula per fragment.
export function bandBrightness(T, age, p) {
  if (age <= 0) return 0;
  const front = age * p.frontSpeed;
  if (T > front) return 0;
  let crest = 1 - Math.abs(T - front) / p.thickness;
  if (crest < 0) crest = 0;
  const wake = Math.exp(-(front - T) / p.wakeTau);
  return (crest + p.wakeLevel * wake) * Math.exp(-age / p.lifeTau);
}

// --- WebGL2 decay-accumulate field (Task 7) ------------------------------
const QUAD_VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv=(p+1.0)*0.5; gl_Position=vec4(p,0.,1.); }`;
const DECAY_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D tex; uniform float k;
out vec4 o; void main(){ o = texture(tex, uv) * k; }`;
// GLOW_STRENGTH tunes the present shader's soft-tonemap rolloff: how quickly
// accumulated intensity saturates. Higher = brighter hubs, but still capped
// below 1.0 (exponential tonemap), so overlapping ripples never clip to a
// blown-out white blob — they read as a brighter, more saturated mode color.
// Tune here (single source of truth for the present shader).
const GLOW_STRENGTH = 2.2;
const PRESENT_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D tex; uniform float glowStrength;
out vec4 o;
void main(){
  vec4 s = texture(tex, uv);
  vec3 base = vec3(0.063,0.078,0.125);
  // Soft (exponential) tonemap: 1.0 - exp(-x*k) asymptotes to 1.0 but never
  // clips, so a hub with many overlapping ripples brightens/saturates
  // instead of blowing out to white. Base stays visible everywhere.
  vec3 glow = 1.0 - exp(-s.rgb * glowStrength);
  o = vec4(base + glow, 1.0);
}`;
// stamp: draw colored line segments, additive; intensity in a per-vertex attr.
// STAMP_BRIGHTNESS boosts the per-stamp intensity so thin (~1px) WebGL lines
// still read as a legible glow once accumulated and tonemapped, without
// resorting to a multi-tap blur (kept cheap for the Task-12 perf gate).
const STAMP_BRIGHTNESS = 1.6;
const STAMP_VS = `#version 300 es
in vec2 p; in float delay; in float age; uniform vec2 res;
out float vDelay; out float vAge;
void main(){ vDelay=delay; vAge=age;
  vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.,1.); }`;
const STAMP_FS = `#version 300 es
precision highp float;
in float vDelay; in float vAge;
uniform vec3 color; uniform float brightness;
uniform float frontSpeed, thickness, wakeTau, wakeLevel, lifeTau;
out vec4 o;
void main(){
  float T = vDelay; float age = vAge;
  float front = age * frontSpeed;
  float b = 0.0;
  if (age > 0.0 && T <= front) {
    float crest = max(1.0 - abs(T - front) / thickness, 0.0);
    float wake = exp(-(front - T) / wakeTau);
    b = (crest + wakeLevel * wake) * exp(-age / lifeTau);
  }
  b *= brightness;
  o = vec4(color * b, b);   // additive; overlapping ripples ADD
}`;

const POINT_VS = `#version 300 es
in vec2 p; in vec4 col; uniform vec2 res; uniform float size;
out vec4 vCol;
void main(){ vCol=col; vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.,1.); gl_PointSize=size; }`;
const POINT_FS = `#version 300 es
precision highp float; in vec4 vCol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = length(d);
  float a = smoothstep(0.5, 0.0, r); o = vec4(vCol.rgb * a * vCol.a, a * vCol.a); }`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class RippleField {
  constructor(gl, { width, height }) {
    this.gl = gl; this.w = width; this.h = height;
    const ext = gl.getExtension("EXT_color_buffer_float");
    if (!ext) throw new Error("RippleField: EXT_color_buffer_float unavailable (no RGBA16F render target)");
    this.decayP = compile(gl, QUAD_VS, DECAY_FS);
    this.presentP = compile(gl, QUAD_VS, PRESENT_FS);
    this.stampP = compile(gl, STAMP_VS, STAMP_FS);
    this.pointP = compile(gl, POINT_VS, POINT_FS);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    this._alloc(width, height);
    this.segBuf = gl.createBuffer(); this.intBuf = gl.createBuffer();
    this.delayBuf = gl.createBuffer(); this.ageBuf = gl.createBuffer();
    this.ptBuf = gl.createBuffer(); this.ptColBuf = gl.createBuffer();

    // Task 12 perf gate: cache all uniform/attribute locations ONCE per
    // program right after linking, instead of calling getUniformLocation /
    // getAttribLocation every frame inside decay()/stamp()/present()/
    // _drawQuad(). Each program's locations are independent (a location is
    // only valid for the program it was queried from), so these are kept in
    // per-program objects, not shared.
    this.quadLoc = {
      decay:   { p: gl.getAttribLocation(this.decayP, "p") },
      present: { p: gl.getAttribLocation(this.presentP, "p") },
    };
    this.decayLoc = {
      tex: gl.getUniformLocation(this.decayP, "tex"),
      k:   gl.getUniformLocation(this.decayP, "k"),
    };
    this.stampLoc = {
      res:        gl.getUniformLocation(this.stampP, "res"),
      color:      gl.getUniformLocation(this.stampP, "color"),
      brightness: gl.getUniformLocation(this.stampP, "brightness"),
      frontSpeed: gl.getUniformLocation(this.stampP, "frontSpeed"),
      thickness:  gl.getUniformLocation(this.stampP, "thickness"),
      wakeTau:    gl.getUniformLocation(this.stampP, "wakeTau"),
      wakeLevel:  gl.getUniformLocation(this.stampP, "wakeLevel"),
      lifeTau:    gl.getUniformLocation(this.stampP, "lifeTau"),
      p:          gl.getAttribLocation(this.stampP, "p"),
      delay:      gl.getAttribLocation(this.stampP, "delay"),
      age:        gl.getAttribLocation(this.stampP, "age"),
    };
    this.presentLoc = {
      tex:          gl.getUniformLocation(this.presentP, "tex"),
      glowStrength: gl.getUniformLocation(this.presentP, "glowStrength"),
    };
    this.pointLoc = {
      res:  gl.getUniformLocation(this.pointP, "res"),
      size: gl.getUniformLocation(this.pointP, "size"),
      p:    gl.getAttribLocation(this.pointP, "p"),
      col:  gl.getAttribLocation(this.pointP, "col"),
    };
  }
  _alloc(w, h) {
    const gl = this.gl;
    if (this.tex) for (const t of this.tex) gl.deleteTexture(t);
    if (this.fbo) for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = []; this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t); this.fbo.push(f);
    }
    this.cur = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resize(w, h) { this.w = w; this.h = h; this._alloc(w, h); }
  _drawQuad(prog, loc) {
    const gl = this.gl; gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  decay(k) {
    const gl = this.gl, src = this.cur, dst = 1 - this.cur, loc = this.decayLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]); gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND); gl.useProgram(this.decayP);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[src]);
    gl.uniform1i(loc.tex, 0);
    gl.uniform1f(loc.k, k);
    this._drawQuad(this.decayP, this.quadLoc.decay); this.cur = dst;
  }
  stamp(segVertices, delays, ages, color, params) {
    const gl = this.gl, loc = this.stampLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.stampP);
    gl.uniform2f(loc.res, this.w, this.h);
    gl.uniform3fv(loc.color, color);
    gl.uniform1f(loc.brightness, STAMP_BRIGHTNESS);
    gl.uniform1f(loc.frontSpeed, params.frontSpeed);
    gl.uniform1f(loc.thickness, params.thickness);
    gl.uniform1f(loc.wakeTau, params.wakeTau);
    gl.uniform1f(loc.wakeLevel, params.wakeLevel);
    gl.uniform1f(loc.lifeTau, params.lifeTau);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, segVertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.delayBuf);
    gl.bufferData(gl.ARRAY_BUFFER, delays, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.delay); gl.vertexAttribPointer(loc.delay, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ageBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ages, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.age); gl.vertexAttribPointer(loc.age, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, segVertices.length / 2);
  }
  stampDots(pointsXY, colorsRGBA, sizePx) {
    const gl = this.gl, loc = this.pointLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pointP);
    gl.uniform2f(loc.res, this.w, this.h);
    gl.uniform1f(loc.size, sizePx);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pointsXY, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptColBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colorsRGBA, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.col); gl.vertexAttribPointer(loc.col, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, pointsXY.length / 2);
  }
  clearField() {
    const gl = this.gl;
    for (const f of this.fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  present() {
    const gl = this.gl, loc = this.presentLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.useProgram(this.presentP);
    gl.uniform1i(loc.tex, 0);
    gl.uniform1f(loc.glowStrength, GLOW_STRENGTH);
    this._drawQuad(this.presentP, this.quadLoc.present);
  }
}
