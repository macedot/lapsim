<script>
  import { tick } from 'svelte';
  import {
    sampleCenterline,
    optimizeOffsets,
    buildSmoothPath,
  } from './lib/raceline.js';

  let circuits = $state([]); // { name, markup, text, racelineD, lineVisible, lengthM, widthM, racelineSvgLen, centerlineSvgLen, strokeWidthSvg }
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
  let scale = $derived.by(() => {
    if (!current) return null;
    let sum = 0;
    let count = 0;
    if (current.lengthM > 0 && current.centerlineSvgLen > 0) {
      sum += current.lengthM / current.centerlineSvgLen;
      count++;
    }
    if (current.widthM > 0 && current.strokeWidthSvg > 0) {
      sum += current.widthM / current.strokeWidthSvg;
      count++;
    }
    return count ? sum / count : null;
  });

  let racelineM = $derived(
    scale != null && current?.racelineSvgLen ? current.racelineSvgLen * scale : null
  );

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
      circuits.push({
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

  function computeRacelineFrom(trackPath) {
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
    return {
      racelineD: buildSmoothPath(points, normals, a),
      racelineSvgLen,
      centerlineSvgLen: trackPath.getTotalLength(),
      strokeWidthSvg: halfWidth * 2,
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
        ...computeRacelineFrom(trackPath),
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
            ...computeRacelineFrom(trackPath),
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
