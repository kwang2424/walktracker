// Cleaning up GPS before it counts toward walked streets. Pure functions, no DOM.
//
// Points are [lat, lon, timeMs, accuracyM?, steps?]. Accuracy (meters) and a
// running step count come from the iPhone app; older walks and browsers have
// only the first three, and everything here still works without them.
//
// 1. Rides: a stretch where you moved a long way but took (almost) no steps was
//    a train, bus, car or bike, not a walk. The phone's step counter is far
//    more reliable for this than guessing from speed or the motion sensor.
// 2. Smoothing: a Kalman filter (constant velocity, walking-sized accelerations)
//    weighs each fix by its reported accuracy, so zigzags from tall buildings
//    flatten out, and single far-off fixes ("spikes") are dropped.
import { haversine, makeProjector } from './geo.js';

const RIDE_WINDOW_MS = 45000; // look back this far when comparing distance and steps
const RIDE_MIN_M = 30; // ignore shorter moves (GPS wobble while standing)
const METERS_PER_STEP_MAX = 3; // walking and running stay well under this

// Returns a new list without the points reached by riding rather than walking.
export function dropRides(points) {
  const out = [];
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    while (j < i && p[2] - points[j][2] > RIDE_WINDOW_MS) j++;
    if (isRiding(points[j], p)) {
      j = i; // look back no further than the ride, so walking right after it counts
      continue;
    }
    out.push(p);
  }
  return out;
}

// Was the move from a to b made without walking? Unknown (no step counts) = no.
export function isRiding(a, b) {
  if (!a || a === b || a[4] == null || b[4] == null) return false;
  const steps = b[4] - a[4];
  if (steps < 0) return false; // the step counter restarted
  const d = haversine(a, b);
  return d >= RIDE_MIN_M && steps < d / METERS_PER_STEP_MAX;
}

// ---- Kalman filter -----------------------------------------------------------

const ACCEL = 1.2; // m/s²: how sharply a walker can change speed or direction
const DEFAULT_ACC = 12; // m, when a point carries no accuracy
const GATE_SIGMAS = 3.5; // fixes further than this from the prediction are spikes...
const GATE_MIN_M = 25; // ...if also at least this far off
const MAX_REJECTS = 3; // after this many in a row, trust the new position
const RESET_GAP_MS = 60000; // after a long gap, start over

// One axis: position and velocity with a 2x2 covariance.
class Axis {
  constructor(p, varP) {
    this.p = p; this.v = 0;
    this.pp = varP; this.pv = 0; this.vv = 4; // velocity unknown: ~2 m/s
  }

  predict(dt) {
    const q = ACCEL * ACCEL;
    this.p += this.v * dt;
    const pp = this.pp + 2 * dt * this.pv + dt * dt * this.vv + (q * dt ** 4) / 4;
    const pv = this.pv + dt * this.vv + (q * dt ** 3) / 2;
    const vv = this.vv + q * dt * dt;
    this.pp = pp; this.pv = pv; this.vv = vv;
  }

  update(z, r) {
    const s = this.pp + r;
    const kp = this.pp / s, kv = this.pv / s;
    const y = z - this.p;
    this.p += kp * y;
    this.v += kv * y;
    const pp = (1 - kp) * this.pp;
    const pv = (1 - kp) * this.pv;
    const vv = this.vv - kv * this.pv;
    this.pp = pp; this.pv = pv; this.vv = vv;
  }
}

// Smooths points one at a time (so a live walk and a saved one come out the
// same). push() returns the smoothed point, or null for a spike.
export class LiveFilter {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = null;
    this.rejects = 0;
  }

  push(point) {
    const [lat, lon, t, acc = DEFAULT_ACC] = point;
    // Without a time there's no speed to reason about: pass it through as is.
    if (!Number.isFinite(t)) return point;
    const r = Math.max(acc, 3) ** 2;
    if (!this.project) {
      this.project = makeProjector(lat);
      this.lat0 = lat;
    }
    const [mx, my] = this.project([lat, lon]);
    if (!this.x || t - this.t > RESET_GAP_MS || t < this.t) {
      this.x = new Axis(mx, r);
      this.y = new Axis(my, r);
      this.t = t;
      this.rejects = 0;
      return this._out(point);
    }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    // Predict on copies, so a rejected spike leaves the filter untouched.
    const px = Object.assign(Object.create(Axis.prototype), this.x);
    const py = Object.assign(Object.create(Axis.prototype), this.y);
    px.predict(dt);
    py.predict(dt);
    const off = Math.hypot(mx - px.p, my - py.p);
    const spread = Math.sqrt((px.pp + py.pp) / 2 + r);
    if (off > GATE_MIN_M && off > GATE_SIGMAS * spread && this.rejects < MAX_REJECTS) {
      this.rejects++;
      return null;
    }
    if (this.rejects >= MAX_REJECTS) {
      // Several "spikes" in a row agree with each other: we really moved.
      this.x = new Axis(mx, r);
      this.y = new Axis(my, r);
    } else {
      px.update(mx, r);
      py.update(my, r);
      this.x = px;
      this.y = py;
    }
    this.rejects = 0;
    this.t = t;
    return this._out(point);
  }

  _out(point) {
    // Back from local meters to lat/lon (inverse of makeProjector).
    const R = 6371000;
    const lat = (this.y.p / R) * (180 / Math.PI);
    const lon = (this.x.p / (R * Math.cos((this.lat0 * Math.PI) / 180))) * (180 / Math.PI);
    const out = [round6(lat), round6(lon), point[2]];
    if (point.length > 3) out.push(...point.slice(3));
    return out;
  }
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The whole clean-up for a finished list of points.
export function cleanTrack(points) {
  const filter = new LiveFilter();
  const out = [];
  for (const p of dropRides(points)) {
    const q = filter.push(p);
    if (q) out.push(q);
  }
  return out;
}
