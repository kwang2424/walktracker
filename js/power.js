// Battery helpers. Pure logic, no DOM, so it can be unit tested.
import { haversine } from './geo.js';

// Decides when you've stopped moving (waiting at a light, sitting in a cafe) so
// the app can drop to low-power location, and when you've started again.
export class StillnessDetector {
  constructor({ radius = 20, stillMs = 90000, wakeDist = 30 } = {}) {
    this.radius = radius; // wander less than this and you're "not moving"
    this.stillMs = stillMs; // ...for this long
    this.wakeDist = wakeDist; // move this far (beyond GPS error) to wake back up
    this.state = 'moving';
    this.anchor = null;
  }

  // p = [lat, lon, timeMs]; accuracy in meters. Returns 'moving' or 'still'.
  update(p, accuracy = 0) {
    if (!this.anchor) {
      this.anchor = p;
      return this.state;
    }
    const d = haversine(this.anchor, p);
    if (this.state === 'still') {
      if (d - accuracy > this.wakeDist) {
        this.state = 'moving';
        this.anchor = p;
      }
    } else if (d > this.radius) {
      this.anchor = p;
    } else if (p[2] - this.anchor[2] >= this.stillMs) {
      this.state = 'still';
    }
    return this.state;
  }

  reset() {
    this.state = 'moving';
    this.anchor = null;
  }
}

// Calls fn at most once per `ms`, always delivering the latest call.
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const wait = last + ms - Date.now();
    clearTimeout(timer);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else {
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait);
    }
  };
}

// Uses the motion sensor (far cheaper than GPS) to notice when you start walking
// again while GPS is off. Feed it acceleration magnitudes; it returns true once
// the last couple of seconds look like steps rather than a phone held still.
export class MotionWake {
  constructor({ windowMs = 2000, threshold = 1.0, minSamples = 15 } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold; // m/s² standard deviation
    this.minSamples = minSamples;
    this.samples = [];
  }

  update(magnitude, t) {
    this.samples.push([t, magnitude]);
    while (this.samples.length && t - this.samples[0][0] > this.windowMs) this.samples.shift();
    if (this.samples.length < this.minSamples) return false;
    if (t - this.samples[0][0] < this.windowMs * 0.75) return false;
    const n = this.samples.length;
    const mean = this.samples.reduce((s, x) => s + x[1], 0) / n;
    const variance = this.samples.reduce((s, x) => s + (x[1] - mean) ** 2, 0) / n;
    return Math.sqrt(variance) > this.threshold;
  }

  reset() {
    this.samples = [];
  }
}
