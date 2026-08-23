<script>
  import { tick, untrack } from 'svelte';
  import {
    sampleCenterline,
    optimizeOffsets,
    buildSmoothPath,
  } from './lib/raceline.js';
  import { simulateLap, positionAt, findMarkers, locateStart } from './lib/vehicle.js';
  import { createOptimizer, buildGenome } from './lib/optimizer.js';

  let circuits = $state([]); // { id, name, markup, text, racelineD, lineVisible, lengthM, widthM, racelineSvgLen, centerlineSvgLen, strokeWidthSvg, racelinePts, startIdx, dir }
  let circuitSeq = 0;
  let active = $state(-1);
  let error = $state('');
  let dragging = $state(false);
  let stage = $state(null);
  let fileInput;
  let computing = $state(false);
  let progress = $state('');

  const RACELINE_ID = 'raceline-overlay';

  let current = $derived(active >= 0 ? circuits[active] : null);
  let displayMarkup = $derived(
    current && current.racelineD && current.lineVisible
      ? current.markup.replace(
          '</svg>',
          `<path id="${RACELINE_ID}" d="${current.racelineD}" style="fill:none;stroke:#e33;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/></svg>`
        )
      : current?.markup
  );

  // meters per SVG unit, averaged over whichever dimensions the user gave
  function circuitScale(c) {
    if (!c) return null;
    let sum = 0;
    let count = 0;
    if (c.lengthM > 0 && c.centerlineSvgLen > 0) {
      sum += c.lengthM / c.centerlineSvgLen;
      count++;
    }
    if (c.widthM > 0 && c.strokeWidthSvg > 0) {
      sum += c.widthM / c.strokeWidthSvg;
      count++;
    }
    return count ? sum / count : null;
  }

  let scale = $derived(circuitScale(current));

  let racelineM = $derived(
    scale != null && current?.racelineSvgLen ? current.racelineSvgLen * scale : null
  );

  // --- virtual vehicles ---
  let carSeq = 0;
  const CAR_COLORS = ['#e33', '#3bf', '#fc3', '#3e6', '#e6e', '#f93'];

  function makeCar(name) {
    carSeq++;
    return {
      id: carSeq,
      name,
      color: CAR_COLORS[(carSeq - 1) % CAR_COLORS.length],
      mass: 798,
      power: 750,
      maxLatG: 4.5,
      maxLongG: 5.0,
      rpm: 15000,
      wheelR: 0.36,
      cda: 1.5,
      rho: 1.225,
      finalDrive: 3.97,
      gears: [4.4, 3.3, 2.7, 2.25, 1.95, 1.7, 1.5, 1.32],
      locked: {}, // e.g. { mass: true, 'gears.0': true } — excluded from optimizer
      targets: {}, // circuit id → target lap time (s); empty = ignored
    };
  }

  let cars = $state([makeCar('F1')]);

  // raceline samples rotated so index 0 = finish line, in travel direction
  function circuitRacePts(c) {
    if (!c?.racelinePts) return null;
    const sc = circuitScale(c);
    if (sc == null) return null;
    let pts = c.racelinePts;
    const s0 = c.startIdx || 0;
    if (s0 > 0) pts = pts.slice(s0).concat(pts.slice(0, s0));
    if ((c.dir ?? 1) < 0) pts = pts.slice().reverse();
    return { pts, scale: sc };
  }

  function racePts() {
    return circuitRacePts(current)?.pts ?? null;
  }

  let sims = $derived.by(() => {
    const pts = racePts();
    if (!pts) return null;
    try {
      return cars.map((car) => simulateLap(pts, scale, car));
    } catch {
      return null;
    }
  });

  let playing = $state(false);
  let clockS = $state(0);
  let tau = 0;
  let lastFrame = 0;

  $effect(() => {
    sims; // re-run when geometry, scale or any car parameter changes
    tau = 0;
    clockS = 0;
    clearDots();
    untrack(() => {
      if (playing) drawDots();
    });
  });

  function togglePlay() {
    if (!sims) return;
    playing = !playing;
    if (playing) {
      lastFrame = performance.now();
      requestAnimationFrame(step);
    }
  }

  function step(now) {
    if (!playing) return;
    tau += (now - lastFrame) / 1000;
    lastFrame = now;
    clockS = tau;
    drawDots();
    requestAnimationFrame(step);
  }

  function resetSim() {
    playing = false;
    tau = 0;
    clockS = 0;
    clearDots();
  }

  const dotId = (i) => `car-dot-${i}`;

  function drawDots() {
    if (!sims || !stage) return;
    const svgEl = stage.querySelector('svg');
    if (!svgEl) return;
    cars.forEach((car, i) => {
      const sim = sims[i];
      if (!sim) return;
      let c = svgEl.querySelector(`[id="${dotId(i)}"]`);
      if (!c) {
        c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('id', dotId(i));
        c.setAttribute('r', 4);
        c.setAttribute('fill', car.color);
        c.setAttribute('stroke', '#111');
        c.setAttribute('stroke-width', 1);
        svgEl.appendChild(c);
      }
      const p = positionAt(sim, tau);
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
    });
  }

  function clearDots() {
    stage?.querySelectorAll('[id^="car-dot-"]').forEach((el) => el.remove());
  }

  function addCar() {
    cars.push(makeCar(`Car ${cars.length + 1}`));
  }

  function removeCar(i) {
    if (optimizingId === cars[i].id) optimizingId = null; // stops the loop
    cars.splice(i, 1);
  }

  // --- lap-time optimizer (generational, live-applied) ---
  let optimizingId = $state(null);
  let optGen = $state(0);
  let optBest = $state(null);
  let optErr = $state(null);
  let optTracks = $state(0);

  function toggleLock(car, key) {
    car.locked[key] = !car.locked[key];
  }

  // build optimizer track specs: [{ simFn, targetS }] for circuits that have
  // a raceline, a scale and a positive target in car.targets
  function carTrackSpecs(car, onlyId = null) {
    const specs = [];
    for (const c of circuits) {
      if (onlyId != null && c.id !== onlyId) continue;
      const target = Number(car.targets?.[c.id]);
      if (!(target > 0)) continue;
      const r = circuitRacePts(c);
      if (!r) continue;
      specs.push({
        simFn: (cand) => simulateLap(r.pts, r.scale, cand).lapTime,
        targetS: target,
      });
    }
    return specs;
  }

  // shared generation loop: converges cars[idx] against track specs,
  // live-applying the best genome each generation
  async function optimizeCarOnTracks(idx, specs, bail) {
    const car = cars[idx];
    if (!car || !specs.length) return;
    playing = false; // dots would stutter as the car rewrites each generation
    optimizingId = car.id;
    optGen = 0;
    optBest = null;
    optErr = null;
    const nTracks = specs.length;
    const opt = createOptimizer(car, specs);
    try {
      let res;
      do {
        await nextFrame();
        if (optimizingId !== car.id || (bail && bail())) break;
        const i = cars.findIndex((c) => c.id === car.id);
        if (i < 0) break; // removed mid-run
        res = opt.step();
        cars[i] = res.bestCar;
        optGen = res.gen;
        optBest = res.bestTimes[0];
        optErr = res.bestError;
        optTracks = nTracks;
      } while (!res.done);
    } finally {
      if (optimizingId === car.id) optimizingId = null;
    }
  }

  // optimize this car on the currently loaded track only
  async function startOptimizer(i) {
    if (!sims || optimizingId != null) return;
    const car = cars[i];
    if (!car || !current) return;
    const specs = carTrackSpecs(car, current.id);
    if (!specs.length) return;
    const activeAtStart = active;
    await optimizeCarOnTracks(i, specs, () => active !== activeAtStart);
  }

  // optimize this car on every loaded track that has a target set
  async function startOptimizerAllTracks(i) {
    if (optimizingId != null) return;
    const car = cars[i];
    if (!car) return;
    const specs = carTrackSpecs(car);
    if (!specs.length) return;
    await optimizeCarOnTracks(i, specs);
  }

  // stops whichever optimizer run is active
  function stopAnyOptimizer() {
    optimizingId = null; // running loops observe this and bail
  }

  async function loadFiles(files) {
    error = '';
    let firstNew = -1;
    let firstDupe = -1;
    // snapshot: input.files is a live FileList — clearing the input (or the
    // drag event ending) would empty it mid-loop across awaits
    const list = [...(files ?? [])];
    for (const file of list) {
      if (!file.name.toLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml') {
        error = 'Some files were skipped: only SVG files are supported.';
        continue;
      }
      const text = await file.text();
      const dupeIdx = circuits.findIndex((c) => c.text === text);
      if (dupeIdx >= 0) {
        if (firstDupe < 0) firstDupe = dupeIdx;
        error = `${file.name} is already loaded.`;
        continue;
      }
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg || doc.querySelector('parsererror')) {
        error = `Could not parse ${file.name} as SVG.`;
        continue;
      }
      // ensure a viewBox so thumbnails can scale; these files are drawn on a
      // fixed canvas given by the width/height attributes
      if (!svg.getAttribute('viewBox')) {
        const w = parseFloat(svg.getAttribute('width')) || 500;
        const h = parseFloat(svg.getAttribute('height')) || 500;
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      }
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      if (firstNew < 0) firstNew = circuits.length;
      circuitSeq++;
      circuits.push({
        id: circuitSeq,
        name: file.name,
        markup: svg.outerHTML,
        text,
        racelineD: null,
        lineVisible: false,
        lengthM: parseFloat(svg.getAttribute('data-length-m')) || null,
        widthM: parseFloat(svg.getAttribute('data-width-m')) || null,
        racelineSvgLen: null,
        centerlineSvgLen: null,
        strokeWidthSvg: null,
      });
    }
    if (firstNew >= 0) await select(firstNew);
    else if (firstDupe >= 0) await select(firstDupe);
    await computeAllRacelines();
  }

  async function select(i) {
    active = i;
    await tick();
    fitToContent();
  }

  function fitToContent() {
    const svgEl = stage?.querySelector('svg');
    if (!svgEl) return;
    try {
      const bb = svgEl.getBBox();
      const pad = Math.max(bb.width, bb.height) * 0.02;
      svgEl.setAttribute(
        'viewBox',
        `${bb.x - pad} ${bb.y - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`
      );
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    } catch {
      // getBBox failed (e.g. empty svg) — leave as-is
    }
  }

  function onPick(e) {
    loadFiles(e.target.files);
    e.target.value = '';
  }

  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    loadFiles(e.dataTransfer?.files);
  }

  function setDim(field, value) {
    if (!current) return;
    const v = parseFloat(value);
    circuits[active] = { ...current, [field]: Number.isFinite(v) && v > 0 ? v : null };
  }

  async function removeCurrent() {
    if (computing || !current) return;
    circuits.splice(active, 1);
    error = '';
    if (!circuits.length) {
      active = -1;
      return;
    }
    // keep view on the track that shifted into this slot (or the last one)
    active = Math.min(active, circuits.length - 1);
    await tick();
    fitToContent();
  }

  function findTrackPath(svgEl) {
    let best = null;
    let bestLen = 0;
    for (const p of svgEl.querySelectorAll('path')) {
      if (p.id === RACELINE_ID) continue;
      let len = 0;
      try {
        len = p.getTotalLength();
      } catch {
        continue;
      }
      if (len > bestLen) {
        bestLen = len;
        best = p;
      }
    }
    return best;
  }

  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function computeRacelineFrom(root, trackPath) {
    const { points, normals, halfWidth } = sampleCenterline(trackPath, 500);
    const a = optimizeOffsets(points, normals, halfWidth);
    const rp = points.map((pt, i) => [
      pt[0] + a[i] * normals[i][0],
      pt[1] + a[i] * normals[i][1],
    ]);
    let racelineSvgLen = 0;
    for (let i = 0; i < rp.length; i++) {
      const q = rp[(i + 1) % rp.length];
      racelineSvgLen += Math.hypot(q[0] - rp[i][0], q[1] - rp[i][1]);
    }
    const { sf, chev } = findMarkers(root, trackPath);
    const { startIdx, dir } = locateStart(rp, sf, chev);
    return {
      racelineD: buildSmoothPath(points, normals, a),
      racelineSvgLen,
      centerlineSvgLen: trackPath.getTotalLength(),
      strokeWidthSvg: halfWidth * 2,
      racelinePts: rp,
      startIdx,
      dir,
    };
  }

  async function toggleRaceline() {
    if (computing || !current) return;
    error = '';
    if (current.racelineD) {
      // already computed once — just flip visibility, never recompute
      circuits[active] = { ...current, lineVisible: !current.lineVisible };
      await tick();
      fitToContent();
      return;
    }
    const svgEl = stage?.querySelector('svg');
    const trackPath = svgEl && findTrackPath(svgEl);
    if (!trackPath) {
      error = 'No track path found in this SVG.';
      return;
    }
    computing = true;
    // let the button repaint before the (sub-second) computation blocks
    await nextFrame();
    try {
      circuits[active] = {
        ...current,
        lineVisible: true,
        ...computeRacelineFrom(stage, trackPath),
      };
      await tick();
      fitToContent();
    } catch {
      error = 'Could not compute the racing line for this file.';
    } finally {
      computing = false;
    }
  }

  async function computeAllRacelines() {
    if (computing) return;
    const pending = circuits.map((c, i) => i).filter((i) => !circuits[i].racelineD);
    if (!pending.length) return;
    computing = true;
    // geometry APIs need the SVG in the document — mount off-screen, never
    // touching the visible stage
    const holder = document.createElement('div');
    holder.setAttribute('style', 'position:fixed;left:-10000px;top:0;');
    document.body.appendChild(holder);
    let failed = 0;
    try {
      for (let n = 0; n < pending.length; n++) {
        progress = `${n + 1}/${pending.length}`;
        // yield between tracks so the UI stays responsive
        await nextFrame();
        const i = pending[n];
        try {
          holder.innerHTML = circuits[i].markup;
          const trackPath = findTrackPath(holder);
          if (!trackPath) throw new Error('no track path');
          circuits[i] = {
            ...circuits[i],
            lineVisible: true,
            ...computeRacelineFrom(holder, trackPath),
          };
        } catch {
          failed++;
        }
      }
    } finally {
      holder.remove();
      computing = false;
      progress = '';
    }
    if (failed) {
      error = `Could not compute the racing line for ${failed} file${failed > 1 ? 's' : ''}.`;
    }
    await tick();
    fitToContent();
  }
</script>

<svelte:window
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false;
  }}
  ondrop={onDrop}
/>

<main class:dragging>
  {#if current}
    <div class="stage" bind:this={stage}>
      {@html displayMarkup}
    </div>
    <button
      class="raceline-btn"
      onclick={toggleRaceline}
      disabled={computing}
    >
      {#if computing}Computing{progress ? ' ' + progress : ''}…{:else if current.lineVisible}Hide line{:else if current.racelineD}Show line{:else}Ideal line{/if}
    </button>
    <div class="dims">
      <label>
        Length (m)
        <input
          type="number"
          min="0"
          step="any"
          placeholder="—"
          value={current.lengthM ?? ''}
          onchange={(e) => setDim('lengthM', e.target.value)}
        />
      </label>
      <label>
        Width (m)
        <input
          type="number"
          min="0"
          step="any"
          placeholder="—"
          value={current.widthM ?? ''}
          onchange={(e) => setDim('widthM', e.target.value)}
        />
      </label>
      {#if racelineM != null}
        <span class="readout">Raceline: {Math.round(racelineM).toLocaleString()} m</span>
      {/if}
    </div>
    <div class="cars">
      <div class="cars-head">
        <strong>Vehicles</strong>
        <button onclick={togglePlay} disabled={!sims}>{playing ? 'Pause' : 'Play'}</button>
        <button onclick={resetSim} disabled={!sims}>Reset</button>
        <span class="clock">{clockS.toFixed(1)} s</span>
      </div>
      {#each cars as car, i (car.id)}
        <details>
          <summary>
            <span class="dot" style="background:{car.color}"></span>
            <span class="car-name">{car.name}</span>
            {#if sims}
              <span class="lap">{sims[i].lapTime.toFixed(2)} s</span>
            {/if}
          </summary>
          <div class="car-form">
            <label>Name<input bind:value={car.name} /></label>
            {#each [['Mass (kg)', 'mass'], ['Power (kW)', 'power'], ['Max lat G', 'maxLatG'], ['Max long G', 'maxLongG'], ['Redline (rpm)', 'rpm'], ['Wheel R (m)', 'wheelR'], ['CdA (m²)', 'cda'], ['Air ρ (kg/m³)', 'rho'], ['Final drive', 'finalDrive']] as [label, key] (key)}
              <label>
                {label}
                <span class="field">
                  <input type="number" min="0" step="any" bind:value={car[key]} />
                  <button
                    class="lock"
                    class:on={car.locked[key]}
                    title={car.locked[key] ? 'Locked — optimizer keeps this value' : 'Lock (exclude from optimizer)'}
                    onclick={() => toggleLock(car, key)}
                  >L</button>
                </span>
              </label>
            {/each}
            <div class="gears">
              <span>Gears (empty = ignored)</span>
              <div class="gear-grid">
                {#each Array.from({ length: 10 }) as _, g (g)}
                  <div class="gear-cell">
                    <input type="number" min="0" step="any" placeholder="—" bind:value={car.gears[g]} />
                    <button
                      class="lock"
                      class:on={car.locked['gears.' + g]}
                      title={car.locked['gears.' + g] ? 'Locked — optimizer keeps this value' : 'Lock (exclude from optimizer)'}
                      onclick={() => toggleLock(car, 'gears.' + g)}
                    >L</button>
                  </div>
                {/each}
              </div>
            </div>
            <div class="opt">
              <span>Target lap (s) per circuit</span>
              {#if circuits.length}
                <div class="targets">
                  {#each circuits as c (c.id)}
                    <label class:selected={c.id === current?.id} title={c.name}>
                      <span class="t-name">{c.name}</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="—"
                        bind:value={car.targets[c.id]}
                        disabled={optimizingId === car.id}
                      />
                    </label>
                  {/each}
                </div>
              {:else}
                <p class="car-hint">Load circuits to set targets.</p>
              {/if}
              {#if optimizingId === car.id}
                <button class="opt-btn running" onclick={stopAnyOptimizer}>Stop</button>
                <span class="opt-read">
                  gen {optGen} · {optTracks > 1
                    ? `ΣΔ${optErr != null ? optErr.toFixed(2) : '—'} · ${optTracks} tracks`
                    : `${optBest != null ? optBest.toFixed(2) + ' s' : '—'} · Δ${optErr != null ? optErr.toFixed(2) : '—'}`}
                </span>
              {:else}
                <div class="opt-actions">
                  <button
                    class="opt-btn"
                    onclick={() => startOptimizer(i)}
                    disabled={!sims || !buildGenome(car).keys.length || !(Number(car.targets[current?.id]) > 0)}
                  >Optimize this track</button>
                  <button
                    class="opt-btn"
                    onclick={() => startOptimizerAllTracks(i)}
                    disabled={!buildGenome(car).keys.length || !carTrackSpecs(car).length}
                  >Optimize all tracks</button>
                </div>
                {#if !buildGenome(car).keys.length}
                  <span class="opt-read">All parameters locked.</span>
                {:else if !carTrackSpecs(car).length}
                  <span class="opt-read">Set a target on at least one circuit.</span>
                {/if}
              {/if}
            </div>
            <button class="rm-car" onclick={() => removeCar(i)}>Remove car</button>
          </div>
        </details>
      {/each}
      <button class="add-car" onclick={addCar}>+ Add car</button>
      {#if !sims}
        <p class="car-hint">Enter track length or width to simulate laps.</p>
      {/if}
    </div>
    <div class="dock">
      {#if circuits.length > 1}
        <div class="thumbs">
          {#each circuits as c, i}
            <button
              class="thumb"
              class:selected={i === active}
              title={c.name}
              onclick={() => select(i)}
            >
              {@html c.markup}
            </button>
          {/each}
        </div>
      {/if}
      <div class="bar">
        <span class="name">{current.name}</span>
        {#if error}<span class="error">{error}</span>{/if}
        <button onclick={removeCurrent} disabled={computing}>Close</button>
        <button onclick={() => fileInput.click()}>Add SVGs</button>
      </div>
    </div>
  {:else}
    <button class="hint" onclick={() => fileInput.click()}>
      {#if error}<p class="error">{error}</p>{/if}
      <p>Drop SVG circuits here, or click to upload</p>
    </button>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept=".svg,image/svg+xml"
    onchange={onPick}
    multiple
    hidden
  />
</main>

<style>
  main {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px;
    box-sizing: border-box;
    position: relative;
  }

  main.dragging {
    outline: 2px dashed #555;
    outline-offset: -10px;
  }

  .stage {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .stage :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }

  .raceline-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    background: rgba(17, 17, 17, 0.7);
    border: 1px solid #555;
    color: #aaa;
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }

  .raceline-btn:hover {
    color: #eee;
    border-color: #888;
  }

  .raceline-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .dims {
    position: absolute;
    top: 48px;
    right: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(17, 17, 17, 0.7);
    border: 1px solid #555;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 0.8rem;
    color: #aaa;
  }

  .dims label {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dims input {
    width: 72px;
    background: none;
    border: 1px solid #555;
    border-radius: 4px;
    color: #eee;
    padding: 2px 6px;
    font: inherit;
  }

  .dims input:focus {
    outline: none;
    border-color: #888;
  }

  .dims .readout {
    color: #ccc;
  }

  .cars {
    position: absolute;
    top: 10px;
    left: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: rgba(17, 17, 17, 0.7);
    border: 1px solid #555;
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 0.8rem;
    color: #aaa;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    min-width: 220px;
    max-width: 280px;
  }

  .cars-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cars-head strong {
    flex: 1;
    color: #ccc;
  }

  .cars-head button {
    background: none;
    border: 1px solid #555;
    color: #aaa;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
  }

  .cars-head button:hover:not(:disabled) {
    color: #eee;
    border-color: #888;
  }

  .cars-head button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .targets {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 130px;
    overflow-y: auto;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 4px;
  }

  .targets label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 1px 2px;
    border-radius: 3px;
  }

  .targets label.selected {
    background: rgba(119, 135, 170, 0.2);
  }

  .targets .t-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #999;
    font-size: 0.72rem;
  }

  .targets input {
    width: 64px;
    background: none;
    border: 1px solid #555;
    border-radius: 4px;
    color: #eee;
    padding: 1px 4px;
    font: inherit;
    font-size: 0.72rem;
  }

  .targets input:focus {
    outline: none;
    border-color: #888;
  }

  .opt-actions {
    display: flex;
    gap: 6px;
  }

  .clock {
    font-variant-numeric: tabular-nums;
    color: #ccc;
  }

  .cars details {
    border-top: 1px solid #333;
    padding-top: 4px;
  }

  .cars summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    list-style: none;
  }

  .cars summary::-webkit-details-marker {
    display: none;
  }

  .cars .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .car-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lap {
    font-variant-numeric: tabular-nums;
    color: #ccc;
  }

  .car-form {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0 2px;
  }

  .car-form label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .car-form .field {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .lock {
    width: 18px;
    height: 18px;
    padding: 0;
    background: none;
    border: 1px solid #555;
    border-radius: 3px;
    color: #666;
    font: inherit;
    font-size: 0.6rem;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .lock:hover {
    border-color: #888;
    color: #aaa;
  }

  .lock.on {
    background: #4a5570;
    border-color: #7787aa;
    color: #dde4f2;
  }

  .opt {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid #333;
    padding-top: 6px;
  }

  .opt label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .opt-btn {
    align-self: flex-start;
    background: none;
    border: 1px solid #555;
    color: #aa7;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
  }

  .opt-btn.running {
    color: #e88;
    border-color: #a55;
  }

  .opt-btn:hover:not(:disabled) {
    color: #eee;
    border-color: #888;
  }

  .opt-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .opt-read {
    font-variant-numeric: tabular-nums;
    color: #999;
    font-size: 0.72rem;
  }

  .car-form input {
    width: 90px;
    background: none;
    border: 1px solid #555;
    border-radius: 4px;
    color: #eee;
    padding: 2px 6px;
    font: inherit;
    font-size: 0.75rem;
  }

  .car-form input:focus {
    outline: none;
    border-color: #888;
  }

  .gears {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .gear-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
  }

  .gear-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .gear-grid input {
    width: 100%;
    box-sizing: border-box;
  }

  .rm-car,
  .add-car {
    background: none;
    border: 1px solid #555;
    color: #aa7;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
    align-self: flex-start;
  }

  .add-car {
    align-self: stretch;
    color: #aaa;
  }

  .rm-car:hover,
  .add-car:hover {
    color: #eee;
    border-color: #888;
  }

  .car-hint {
    margin: 0;
    color: #777;
    font-size: 0.75rem;
  }

  .dock {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    max-width: 100%;
  }

  .thumbs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    max-width: 100%;
    padding: 4px;
    background: rgba(17, 17, 17, 0.7);
    border-radius: 6px;
  }

  .thumb {
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    padding: 2px;
    background: none;
    border: 1px solid #333;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.6;
  }

  .thumb:hover {
    opacity: 0.9;
  }

  .thumb.selected {
    border-color: #999;
    opacity: 1;
  }

  .thumb :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }

  .hint {
    background: none;
    border: none;
    color: #888;
    font: inherit;
    font-size: 1.1rem;
    cursor: pointer;
  }

  .hint:hover {
    color: #ccc;
  }

  .error {
    color: #e66;
  }

  .bar {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.8rem;
    color: #777;
    background: rgba(17, 17, 17, 0.7);
    padding: 4px 10px;
    border-radius: 6px;
  }

  .bar button {
    background: none;
    border: 1px solid #555;
    color: #aaa;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
  }

  .bar button:hover {
    color: #eee;
    border-color: #888;
  }

  .bar button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
