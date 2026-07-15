// data.js — fetch baked binaries into typed arrays. Fetches are RELATIVE
// (Pages-safe). dtype maps to the little-endian packing from src/packing.py.
const CTOR = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, i32: Int32Array };

export async function loadManifest(dir) {
  const r = await fetch(`${dir}/manifest.json`);
  if (!r.ok) throw new Error(`Failed to fetch manifest.json: ${r.status} ${r.statusText}`);
  return r.json();
}
export async function loadBin(dir, name, dtype) {
  const r = await fetch(`${dir}/${name}.bin`);
  if (!r.ok) throw new Error(`Failed to fetch ${name}.bin: ${r.status} ${r.statusText}`);
  const buf = await r.arrayBuffer();
  return new CTOR[dtype](buf);
}
export async function loadAll(dir) {
  const manifest = await loadManifest(dir);
  const [stops, stopMode, stopCity, stampEdge, stampDelay, stampIntensity,
         stampIndex, eventStop, eventTime] = await Promise.all([
    loadBin(dir, "stops", "f32"), loadBin(dir, "stop_mode", "u16"),
    loadBin(dir, "stop_city", "u16"), loadBin(dir, "stamp_edge", "u32"),
    loadBin(dir, "stamp_delay", "u16"), loadBin(dir, "stamp_intensity", "u16"),
    loadBin(dir, "stamp_index", "u32"), loadBin(dir, "event_stop", "u32"),
    loadBin(dir, "event_time", "u32"),
  ]);
  const streets = {};
  for (const city of Object.keys(manifest.cities)) {
    streets[city] = await loadBin(dir, `street_${city}_seg`, "f32");
  }
  return { manifest, stops, stopMode, stopCity, stampEdge, stampDelay,
           stampIntensity, stampIndex, eventStop, eventTime, streets };
}
