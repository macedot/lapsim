// Minimum-curvature racing line computation.
// The track is a thick stroke: the path is the centerline and the
// drivable corridor extends stroke-width/2 to each side of it.

/**
 * Sample a rendered <path> element into evenly spaced points with normals.
 * @param {SVGPathElement} pathEl path already attached to the DOM
 * @param {number} n number of samples
 * @returns {{points: number[][], normals: number[][], halfWidth: number}}
 */
export function sampleCenterline(pathEl, n = 500) {
  const L = pathEl.getTotalLength();
  const points = [];
  for (let i = 0; i < n; i++) {
    const p = pathEl.getPointAtLength((i / n) * L);
    points.push([p.x, p.y]);
  }
  const normals = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    normals.push([-ty, tx]); // left normal
  }
  const style = pathEl.getAttribute('style') || '';
  const m = style.match(/stroke-width:([\d.]+)/);
  const sw = m
    ? parseFloat(m[1])
    : parseFloat(pathEl.getAttribute('stroke-width') || '0');
  return { points, normals, halfWidth: sw / 2 };
}

/**
 * Total squared second difference (discrete curvature^2) of a line
 * defined by centerline points + lateral offsets along the normals.
 */
export function lineCurvature(points, normals, a) {
  const n = points.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    const dx =
      points[im][0] + a[im] * normals[im][0] -
      2 * (points[i][0] + a[i] * normals[i][0]) +
      points[ip][0] + a[ip] * normals[ip][0];
    const dy =
      points[im][1] + a[im] * normals[im][1] -
      2 * (points[i][1] + a[i] * normals[i][1]) +
      points[ip][1] + a[ip] * normals[ip][1];
    sum += dx * dx + dy * dy;
  }
  return sum;
}

// F_i(a) = n_i · (d_{i-1} - 2 d_i + d_{i+1}), linear in a.
// The objective gradient is 2·F(a).
function computeF(points, normals, a) {
  const n = points.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    dx[i] =
      points[im][0] + a[im] * normals[im][0] -
      2 * (points[i][0] + a[i] * normals[i][0]) +
      points[ip][0] + a[ip] * normals[ip][0];
    dy[i] =
      points[im][1] + a[im] * normals[im][1] -
      2 * (points[i][1] + a[i] * normals[i][1]) +
      points[ip][1] + a[ip] * normals[ip][1];
  }
  const F = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    const sx = dx[im] - 2 * dx[i] + dx[ip];
    const sy = dy[im] - 2 * dy[i] + dy[ip];
    F[i] = normals[i][0] * sx + normals[i][1] * sy;
  }
  return F;
}

// H·v = 2·(F(v) - F(0)) because F is linear in a; gradient g(a) = 2·F(a).
function makeH(points, normals) {
  const n = points.length;
  const zeros = new Float64Array(n);
  const F0 = computeF(points, normals, zeros);
  return {
    F0,
    applyH(v) {
      const Fv = computeF(points, normals, v);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = 2 * (Fv[i] - F0[i]);
      return out;
    },
  };
}

// Projected Gauss-Seidel sweep with over-relaxation (SOR). Each coordinate
// update is the exact 1-D minimizer clamped to the corridor, so the
// objective never increases. Maintains d_i = q_{i-1} - 2q_i + q_{i+1}
// incrementally. Returns the objective value.
function gsSweeps(points, normals, a, dx, dy, maxA, sweeps, omega) {
  const n = points.length;
  for (let s = 0; s < sweeps; s++) {
    for (let i = 0; i < n; i++) {
      const im = (i - 1 + n) % n;
      const ip = (i + 1) % n;
      const Fi =
        normals[i][0] * (dx[im] - 2 * dx[i] + dx[ip]) +
        normals[i][1] * (dy[im] - 2 * dy[i] + dy[ip]);
      // Newton step for coordinate i (diagonal of H is 12, gradient 2·F)
      let ai = a[i] - (omega * Fi) / 6;
      ai = Math.min(maxA, Math.max(-maxA, ai));
      const delta = ai - a[i];
      if (delta === 0) continue;
      a[i] = ai;
      dx[im] += delta * normals[i][0];
      dy[im] += delta * normals[i][1];
      dx[i] -= 2 * delta * normals[i][0];
      dy[i] -= 2 * delta * normals[i][1];
      dx[ip] += delta * normals[i][0];
      dy[ip] += delta * normals[i][1];
    }
  }
}

/**
 * Find lateral offsets minimizing curvature, clamped to the corridor.
 * Two phases: monotone Gauss-Seidel/SOR warm start, then a CG polish with
 * a fix-only active set for the corridor bounds. The best (lowest-curvature)
 * in-bounds solution ever seen is returned, so the result can never be
 * worse than the centerline itself.
 * @returns {Float64Array} offsets a_i in [-maxA, maxA]
 */
export function optimizeOffsets(points, normals, halfWidth, margin = 1.5) {
  const n = points.length;
  const maxA = Math.max(halfWidth - margin, 0);
  const a = new Float64Array(n);
  // d at a = 0
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const im = (i - 1 + n) % n;
    const ip = (i + 1) % n;
    dx[i] = points[im][0] - 2 * points[i][0] + points[ip][0];
    dy[i] = points[im][1] - 2 * points[i][1] + points[ip][1];
  }
  let best = new Float64Array(a);
  let bestE = lineCurvature(points, normals, a);

  // --- phase 1: GS/SOR warm start (monotone) ---
  let prevE = bestE;
  for (let block = 0; block < 10; block++) {
    gsSweeps(points, normals, a, dx, dy, maxA, 1000, 1.7);
    const E = lineCurvature(points, normals, a);
    if (E < bestE) {
      bestE = E;
      best = new Float64Array(a);
    }
    if (prevE - E < prevE * 1e-4) break; // tail convergence is slow; stop early
    prevE = E;
  }

  // --- phase 2: CG polish with fix-only active set ---
  const { F0, applyH } = makeH(points, normals);
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (a[i] >= maxA - 1e-9 || a[i] <= -maxA + 1e-9) fixed[i] = 1;
  }
  let stagnant = 0;
  for (let round = 0; round < 10; round++) {
    // CG on free variables: minimize E(a) = aᵀHa/2 + bᵀa + c, b = 2·F0
    const Ha = applyH(a);
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = fixed[i] ? 0 : -(Ha[i] + 2 * F0[i]);
    const p = new Float64Array(r);
    let rs = 0;
    for (let i = 0; i < n; i++) rs += r[i] * r[i];
    const rs0 = rs;
    for (let iter = 0; iter < 20000 && rs > rs0 * 1e-12; iter++) {
      const Hp = applyH(p);
      let pHp = 0;
      for (let i = 0; i < n; i++) pHp += p[i] * Hp[i];
      if (pHp <= 1e-30) break;
      const alpha = rs / pHp;
      let rsNew = 0;
      for (let i = 0; i < n; i++) {
        a[i] += alpha * p[i];
        r[i] -= alpha * Hp[i];
        if (fixed[i]) r[i] = 0; // keep clamped variables out of the search space
        rsNew += r[i] * r[i];
      }
      const beta = rsNew / rs;
      for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
      rs = rsNew;
    }
    // clamp violators into bounds and fix them (fix-only: set only grows,
    // so this loop always terminates)
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (a[i] > maxA) {
        a[i] = maxA;
        if (!fixed[i]) {
          fixed[i] = 1;
          changed = true;
        }
      } else if (a[i] < -maxA) {
        a[i] = -maxA;
        if (!fixed[i]) {
          fixed[i] = 1;
          changed = true;
        }
      }
    }
    const E = lineCurvature(points, normals, a);
    if (E < bestE - 1e-9) {
      bestE = E;
      best = new Float64Array(a);
      stagnant = 0;
    } else if (++stagnant >= 3) {
      break;
    }
    if (!changed) break;
  }
  return best;
}

/**
 * Build a smooth closed SVG path (Catmull-Rom -> cubic Bezier)
 * through centerline points displaced by the offsets.
 */
export function buildSmoothPath(points, normals, a) {
  const n = points.length;
  const p = points.map((pt, i) => [
    pt[0] + a[i] * normals[i][0],
    pt[1] + a[i] * normals[i][1],
  ]);
  const f = (v) => Math.round(v * 100) / 100;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}
