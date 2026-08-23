// Virtual vehicle: quasi-steady-state lap simulation on a sampled raceline.
// All inputs metric: mass kg, power kW, G limits unitless, lengths m.

const G = 9.81;

/**
 * Detect the finish line (small filled path) and direction chevron
 * (small thin-stroked path) among an SVG's paths, excluding the track itself.
 * @param {Element} root element containing the circuit markup
 * @param {SVGPathElement} trackPath the detected track path
 * @returns {{sf: SVGPathElement|null, chev: SVGPathElement|null}}
 */
export function findMarkers(root, trackPath) {
  let sf = null;
  let sfArea = Infinity;
  let chev = null;
  let chevArea = Infinity;
  for (const p of root.querySelectorAll('path')) {
    if (p === trackPath || p.id === 'raceline-overlay') continue;
    let len = 0;
    try {
      len = p.getTotalLength();
    } catch {
      continue;
    }
    if (!len) continue;
    const bb = p.getBBox();
    const area = bb.width * bb.height;
    const style = p.getAttribute('style') || '';
    const fill = style.match(/fill:\s*([^;]+)/)?.[1]?.trim() || 'none';
    const sw = parseFloat(
      style.match(/stroke-width:\s*([\d.]+)/)?.[1] ??
        p.getAttribute('stroke-width') ??
        '0'
    );
    if (fill !== 'none' && area < sfArea) {
      sf = p;
      sfArea = area;
    } else if (fill === 'none' && sw > 0 && sw < 10 && area < chevArea) {
      chev = p;
      chevArea = area;
    }
  }
  return { sf, chev };
}

/**
 * Locate lap start on the raceline samples using the finish line and the
 * direction chevron. Falls back to index 0 / forward.
 * @param {number[][]} pts raceline points in SVG units
 * @returns {{startIdx: number, dir: 1|-1}}
 */
export function locateStart(pts, sfEl, chevEl) {
  const n = pts.length;
  let startIdx = 0;
  let dir = 1;
  try {
    if (sfEl) {
      const bb = sfEl.getBBox();
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (pts[i][0] - cx) ** 2 + (pts[i][1] - cy) ** 2;
        if (d < best) {
          best = d;
          startIdx = i;
        }
      }
    }
    if (chevEl) {
      const L = chevEl.getTotalLength();
      const a = chevEl.getPointAtLength(0);
      const m = chevEl.getPointAtLength(L / 2);
      const b = chevEl.getPointAtLength(L);
      // chevron apex points along travel direction
      const dx = m.x - (a.x + b.x) / 2;
      const dy = m.y - (a.y + b.y) / 2;
      const t = pts[(startIdx + 1) % n];
      const p = pts[(startIdx - 1 + n) % n];
      if (dx * (t[0] - p[0]) + dy * (t[1] - p[1]) < 0) dir = -1;
    }
  } catch {
    // geometry unavailable — keep defaults
  }
  return { startIdx, dir };
}

/**
 * Quasi-steady-state lap simulation.
 * Speed limits per sample from corner curvature, gearing and drag; closed-loop
 * forward (power/grip accel) and backward (brake) sweeps; then time integration.
 * @param {number[][]} points raceline points in SVG units, index 0 = start line
 * @param {number} scale meters per SVG unit
 * @param {object} car { mass, power(kW), maxLatG, maxLongG, rpm, wheelR, cda, rho, finalDrive, gears[] }
 * @returns {{points, v: Float64Array, t: Float64Array, lapTime: number, n: number}}
 */
export function simulateLap(points, scale, car) {
  const mass = Number(car.mass);
  const power = Number(car.power) * 1000;
  const aLat = Number(car.maxLatG) * G;
  const aLong = Number(car.maxLongG) * G;
  if (!(mass > 0) || !(power > 0) || !(aLat > 0) || !(aLong > 0) || !(scale > 0)) {
    throw new Error('invalid car or scale');
  }

  const n = points.length;

  // segment lengths (m)
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    ds[i] = Math.hypot(q[0] - p[0], q[1] - p[1]) * scale;
  }

  // curvature (1/m) via circumcircle through consecutive samples: κ = 4A/(abc)
  const kap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const ax = (p1[0] - p0[0]) * scale;
    const ay = (p1[1] - p0[1]) * scale;
    const bx = (p2[0] - p1[0]) * scale;
    const by = (p2[1] - p1[1]) * scale;
    const cx = (p2[0] - p0[0]) * scale;
    const cy = (p2[1] - p0[1]) * scale;
    const a = Math.hypot(ax, ay);
    const b = Math.hypot(bx, by);
    const c = Math.hypot(cx, cy);
    const area2 = Math.abs(ax * cy - cx * ay); // 2·triangle area (m²)
    if (a * b * c < 1e-12 || area2 < 1e-12) continue;
    kap[i] = (2 * area2) / (a * b * c);
  }

  // top speed: highest gear cap and drag equilibrium v³ = 2P/(ρ·CdA)
  let vTop = Infinity;
  const gears = (car.gears || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (gears.length && car.finalDrive > 0 && car.wheelR > 0 && car.rpm > 0) {
    const top = Math.min(...gears); // lowest ratio = highest gear = top speed
    vTop = Math.min(vTop, ((car.rpm / 60) * 2 * Math.PI * car.wheelR) / (top * car.finalDrive));
  }
  const cda = Number(car.cda) || 0;
  const rho = Number(car.rho) || 0;
  if (cda > 0 && rho > 0) {
    vTop = Math.min(vTop, Math.cbrt((2 * power) / (rho * cda)));
  }

  // per-sample speed limits: cornering v = sqrt(aLat/κ), capped at vTop
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = kap[i] > 1e-6 ? Math.min(vTop, Math.sqrt(aLat / kap[i])) : vTop;
  }

  const accel = (vv) => {
    let a = aLong;
    if (vv > 0.1) a = Math.min(a, power / (mass * vv));
    a -= (rho * cda * vv * vv) / (2 * mass);
    return Math.max(0, a);
  };
  const brake = aLong;

  // closed-loop sweeps: forward (accel) then backward (brake), monotone down
  for (let it = 0; it < 100; it++) {
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const cand = Math.sqrt(v[i] * v[i] + 2 * accel(v[i]) * ds[i]);
      if (cand < v[j]) {
        delta = Math.max(delta, v[j] - cand);
        v[j] = cand;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const cand = Math.sqrt(v[j] * v[j] + 2 * brake * ds[i]);
      if (cand < v[i]) {
        delta = Math.max(delta, v[i] - cand);
        v[i] = cand;
      }
    }
    if (delta < 1e-6) break;
  }
  for (let i = 0; i < n; i++) v[i] = Math.max(v[i], 3);

  // time integration (trapezoidal on segment speeds)
  const t = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    t[i + 1] = t[i] + (2 * ds[i]) / (v[i] + v[j]);
  }

  return { points, v, t, lapTime: t[n], n };
}

/**
 * Interpolated position (SVG units) at lap time τ.
 * @param {{points: number[][], t: Float64Array, lapTime: number, n: number}} sim
 */
export function positionAt(sim, tau) {
  const { points, t, n, lapTime } = sim;
  let tt = tau;
  if (lapTime > 0) tt = (((tau % lapTime) + lapTime) % lapTime);
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tt) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const j = (i + 1) % n;
  const span = t[i + 1] - t[i] || 1;
  const f = Math.min(1, Math.max(0, (tt - t[i]) / span));
  return {
    x: points[i][0] + (points[j][0] - points[i][0]) * f,
    y: points[i][1] + (points[j][1] - points[i][1]) * f,
  };
}
