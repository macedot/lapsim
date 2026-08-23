// Generational optimizer that tunes unlocked car parameters to match
// target lap times on one or more tracks with a single parameter set
// (classic system identification). Works on plain gene arrays; the app
// supplies per-track simulation functions (so the core is testable in node).

export const GENE_BOUNDS = {
  mass: [100, 3000],
  power: [20, 3000],
  maxLatG: [0.5, 8],
  maxLongG: [0.5, 10],
  rpm: [1000, 25000],
  wheelR: [0.15, 0.8],
  cda: [0, 5],
  rho: [0, 2],
  finalDrive: [0.5, 10],
  // gear slots use keys 'gears.0' … 'gears.9'
};

const GEAR_KEY = /^gears\.(\d+)$/;

export function gearKey(i) {
  return `gears.${i}`;
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/**
 * Extract the evolvable genes of a car: every unlocked parameter (filled
 * gear slots only — empty slots are ignored entirely).
 * @param {object} car car state with `locked` map
 * @returns {{ keys: string[], values: number[] }}
 */
export function buildGenome(car) {
  const keys = [];
  const values = [];
  const locked = car.locked || {};
  for (const key of Object.keys(GENE_BOUNDS)) {
    if (locked[key]) continue;
    keys.push(key);
    values.push(Number(car[key]));
  }
  (car.gears || []).forEach((g, i) => {
    const key = gearKey(i);
    if (locked[key]) return;
    if (!Number.isFinite(Number(g))) return; // empty slot = ignored
    keys.push(key);
    values.push(Number(g));
  });
  return { keys, values };
}

/**
 * Apply gene values back onto a car (clamped to bounds). Locked fields and
 * unfilled gear slots are copied untouched.
 */
export function applyGenome(car, keys, values) {
  const out = { ...car, locked: { ...(car.locked || {}) }, gears: [...(car.gears || [])] };
  keys.forEach((key, i) => {
    const v = clamp(values[i], GENE_BOUNDS[key] || [0.3, 20]);
    const m = key.match(GEAR_KEY);
    if (m) out.gears[Number(m[1])] = v;
    else out[key] = v;
  });
  return out;
}

/**
 * Create a generational optimizer for one car against a set of tracks.
 * @param {object} car starting car (defines the seed genome)
 * @param {{simFn: (car: object) => number, targetS: number}[]} tracks
 *        each track supplies a lap-time evaluator and its target; a single
 *        track behaves exactly like the old single-target optimizer
 */
export function createOptimizer(car, tracks) {
  const { keys, values } = buildGenome(car);
  const POP = 24;
  const ELITE = 2;
  const MAX_GEN = 300;
  const TOL = 0.025; // s per track (average) — tight enough that one track
  // can't absorb another's error
  const nTracks = tracks.length;

  const span = keys.map((key) => {
    const [lo, hi] = GENE_BOUNDS[key] || [0.3, 20];
    return { lo, hi, range: hi - lo };
  });

  // seed population: the car's own genome + mutated copies
  let pop = [];
  for (let i = 0; i < POP; i++) {
    pop.push(values.map((v, j) => (i === 0 ? v : mutateValue(v, span[j], 0.15))));
  }
  let gen = 0;

  function mutateValue(v, s, sigmaFrac) {
    const sigma = s.range * sigmaFrac;
    return clamp(v + gaussian() * sigma, [s.lo, s.hi]);
  }

  function gaussian() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // evaluate one candidate on every track; returns {times, err}
  function evaluate(candidate) {
    let err = 0;
    let lethal = false;
    const times = tracks.map((tr) => {
      if (lethal) return NaN;
      let t;
      try {
        t = tr.simFn(candidate);
      } catch {
        t = NaN;
      }
      if (!Number.isFinite(t)) {
        lethal = true;
        return NaN;
      }
      err += Math.abs(t - tr.targetS);
      return t;
    });
    return { times, err: lethal ? Infinity : err };
  }

  /**
   * Advance one generation.
   * @returns {{gen, bestCar, bestTimes: number[], bestTime: number|null,
   *            bestError: number|null, done, keys, values}}
   *         bestTime is the single-track lap time (tracks[0]) or null;
   *         bestError is the summed |lap − target| across tracks.
   */
  function step() {
    if (!keys.length || !nTracks) {
      // nothing evolvable — report the car as-is and stop
      const r = evaluate(car);
      return {
        gen: 0,
        bestCar: car,
        bestTimes: r.times,
        bestTime: Number.isFinite(r.times[0]) ? r.times[0] : null,
        bestError: Number.isFinite(r.err) ? r.err : null,
        done: true,
        keys,
        values: [],
      };
    }
    // evaluate fitness of every individual
    const scored = pop.map((ind) => {
      const { times, err } = evaluate(applyGenome(car, keys, ind));
      return { ind, times, err };
    });
    scored.sort((a, b) => a.err - b.err);
    const best = scored[0];

    // next generation
    const next = [];
    for (let i = 0; i < ELITE; i++) next.push([...scored[i].ind]);
    const sigmaFrac = Math.max(0.02, 0.15 * Math.pow(0.97, gen)); // 15% → 2%
    while (next.length < POP) {
      const parent = tournament(scored);
      next.push(parent.ind.map((v, j) => mutateValue(v, span[j], sigmaFrac)));
    }
    pop = next;
    gen++;

    return {
      gen,
      bestCar: applyGenome(car, keys, best.ind),
      bestTimes: best.times,
      bestTime: Number.isFinite(best.times[0]) ? best.times[0] : null,
      bestError: Number.isFinite(best.err) ? best.err : null,
      done: best.err <= TOL * nTracks || gen >= MAX_GEN,
      keys,
      values: best.ind,
    };
  }

  function tournament(scored) {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const c = scored[Math.floor(Math.random() * scored.length)];
      if (!best || c.err < best.err) best = c;
    }
    return best;
  }

  return { step, keys, MAX_GEN };
}
