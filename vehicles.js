// web/vehicles.js — pure GTFS shape_dist_traveled interpolation, ported 1:1 from
// ripplesim/vehicles.py (vehicle_position/point_at_distance). The web player calls
// vehiclePosition(trip, s, data) each frame for every live trip (Option A: sim-in-JS,
// no baked per-frame table). Keep this math identical to the Python reference.
export function pointAtDistance(coordsXY, cumdist, d) {
  const n = cumdist.length;
  if (d <= cumdist[0]) return coordsXY[0];
  if (d >= cumdist[n - 1]) return coordsXY[n - 1];
  // segment [j, j+1] containing d (upper_bound - 1)
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cumdist[mid] <= d) lo = mid + 1; else hi = mid; }
  const j = lo - 1;
  const seg = cumdist[j + 1] - cumdist[j];
  const f = seg <= 0 ? 0 : (d - cumdist[j]) / seg;
  const [ax, ay] = coordsXY[j], [bx, by] = coordsXY[j + 1];
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

function shapePolyline(route, data) {
  const { v0, vcount } = route;
  const sc = data.shapeCoords, scd = data.shapeCumdist;
  const coords = [], cum = [];
  for (let i = 0; i < vcount; i++) {
    coords.push([sc[2 * (v0 + i)], sc[2 * (v0 + i) + 1]]);
    cum.push(scd[v0 + i]);
  }
  return [coords, cum];
}

export function vehiclePosition(trip, s, data) {
  const { b0, bcount } = trip;
  const bt = data.bpTime, bd = data.bpDist;
  const tLo = bt[b0], tHi = bt[b0 + bcount - 1];
  if (s < tLo || s > tHi) return null;
  let k = b0;
  while (k < b0 + bcount - 1 && bt[k + 1] < s) k++;
  const span = bt[k + 1] - bt[k];
  const f = span <= 0 ? 0 : (s - bt[k]) / span;
  const d = bd[k] + (bd[k + 1] - bd[k]) * f;
  const route = data.routes[trip.shape];
  const [coords, cum] = shapePolyline(route, data);
  return pointAtDistance(coords, cum, d);
}
