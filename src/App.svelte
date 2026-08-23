<script>
  import { tick } from 'svelte';
  import {
    sampleCenterline,
    optimizeOffsets,
    buildSmoothPath,
  } from './lib/raceline.js';

  let svgMarkup = $state(null);
  let fileName = $state('');
  let error = $state('');
  let dragging = $state(false);
  let stage = $state(null);
  let fileInput;
  let racelineD = $state(null);
  let computing = $state(false);

  const RACELINE_ID = 'raceline-overlay';

  async function loadFile(file) {
    error = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml') {
      error = 'Please provide an SVG file.';
      return;
    }
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg || doc.querySelector('parsererror')) {
      error = 'Could not parse that file as SVG.';
      return;
    }
    fileName = file.name;
    racelineD = null;
    svgMarkup = svg.outerHTML;
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
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
    } catch {
      // getBBox failed (e.g. empty svg) — leave as-is
    }
  }

  function onPick(e) {
    loadFile(e.target.files?.[0]);
    e.target.value = '';
  }

  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    loadFile(e.dataTransfer?.files?.[0]);
  }

  let displayMarkup = $derived(
    svgMarkup && racelineD
      ? svgMarkup.replace(
          '</svg>',
          `<path id="${RACELINE_ID}" d="${racelineD}" style="fill:none;stroke:#e33;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/></svg>`
        )
      : svgMarkup
  );

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

  async function toggleRaceline() {
    if (computing) return;
    error = '';
    if (racelineD) {
      racelineD = null;
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
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const { points, normals, halfWidth } = sampleCenterline(trackPath, 500);
      const a = optimizeOffsets(points, normals, halfWidth);
      racelineD = buildSmoothPath(points, normals, a);
      await tick();
      fitToContent();
    } catch {
      error = 'Could not compute the racing line for this file.';
    } finally {
      computing = false;
    }
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
  {#if svgMarkup}
    <div class="stage" bind:this={stage}>
      {@html displayMarkup}
    </div>
    <div class="bar">
      <span class="name">{fileName}</span>
      {#if error}<span class="error">{error}</span>{/if}
      <button onclick={toggleRaceline} disabled={computing}>
        {#if computing}Computing…{:else if racelineD}Hide line{:else}Ideal line{/if}
      </button>
      <button onclick={() => fileInput.click()}>Load another</button>
    </div>
  {:else}
    <button class="hint" onclick={() => fileInput.click()}>
      {#if error}<p class="error">{error}</p>{/if}
      <p>Drop an SVG circuit here, or click to upload</p>
    </button>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept=".svg,image/svg+xml"
    onchange={onPick}
    hidden
  />
</main>

<style>
  main {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  main.dragging {
    outline: 2px dashed #555;
    outline-offset: -10px;
  }

  .stage {
    width: calc(100vw - 20px);
    height: calc(100vh - 20px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .stage :global(svg) {
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
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
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
