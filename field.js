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
in vec2 p; in float inten; uniform vec2 res; out float vI;
void main(){ vI=inten; vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.,1.); }`;
const STAMP_FS = `#version 300 es
precision highp float; in float vI; uniform vec3 color; uniform float brightness;
out vec4 o;
void main(){ float b = vI * brightness; o = vec4(color * b, b); }`;

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
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    this._alloc(width, height);
    this.segBuf = gl.createBuffer(); this.intBuf = gl.createBuffer();

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
      p:          gl.getAttribLocation(this.stampP, "p"),
      inten:      gl.getAttribLocation(this.stampP, "inten"),
    };
    this.presentLoc = {
      tex:          gl.getUniformLocation(this.presentP, "tex"),
      glowStrength: gl.getUniformLocation(this.presentP, "glowStrength"),
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
  stamp(segVertices, intensities, color) {
    const gl = this.gl, loc = this.stampLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.stampP);
    gl.uniform2f(loc.res, this.w, this.h);
    gl.uniform3fv(loc.color, color);
    gl.uniform1f(loc.brightness, STAMP_BRIGHTNESS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, segVertices, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.intBuf);
    gl.bufferData(gl.ARRAY_BUFFER, intensities, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.inten); gl.vertexAttribPointer(loc.inten, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, segVertices.length / 2);
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
