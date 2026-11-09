/**
 * Milestone 1 wiring.
 *
 * Two tiers of change, exactly as DESIGN.md §10 specifies:
 *   - bake-tier params mark the atlas dirty and light up the Bake button
 *   - display-tier params re-render from the existing atlas, immediately
 * Keeping that split honest from the first milestone is the only reason the
 * auditioner will stay responsive once erosion lands in M4.
 */

import { bake } from './core/bake';
import { erosionStats } from './core/passes/erosion';
import { createField, measureColumnHonesty } from './core/field';
import {
  compareVariants, envelopeBySeeds, envelopeDrift, radialSensitivity, sensitivity,
  sweepDriftByRegion, sweepRegionSize, sweepTalus,
} from './core/variants';
import type { VariantSpec } from './core/variants';
import type { BakeResult } from './core/bake';
import { DEFAULT_PARAMS, cloneParams } from './core/params';
import type { WorldParams } from './core/params';
import { hashU32, seedFromString } from './core/hash';
import { BIOMES, biomeById } from './core/biomes';
import { partitionStats } from './core/passes/biomePartition';
import { MapView } from './ui/mapView';
import { buildPanel } from './ui/controls';
import type { SectionSpec } from './ui/controls';
import { DEFAULT_RENDER, renderAtlas } from './ui/render';
import type { LayerName, RenderOptions } from './ui/render';

const params: WorldParams = cloneParams(DEFAULT_PARAMS);
const render: RenderOptions = { ...DEFAULT_RENDER };

let seedText = 'driftwood';
params.seed = seedFromString(seedText);

let result: BakeResult | null = null;
let img: ImageData | null = null;
let dirty = true;
/** Index into result.stages, or -1 for the final atlas. */
let stageView = -1;

const mapEl = document.getElementById('map') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;
const readoutEl = document.getElementById('readout') as HTMLElement;
const bakeBtn = document.getElementById('bake') as HTMLButtonElement;
const rerollBtn = document.getElementById('reroll') as HTMLButtonElement;
const controlsEl = document.getElementById('controls') as HTMLElement;

const view = new MapView(mapEl);
view.onCursor = (c) => {
  if (!c) { readoutEl.textContent = ''; return; }
  const b = biomeById(c.biomeId);
  readoutEl.textContent =
    `x ${c.wx.toFixed(0).padStart(6)} m   y ${c.wy.toFixed(0).padStart(6)} m\n` +
    `h ${c.height.toFixed(1).padStart(6)} m   ${c.height >= params.seaLevel ? 'land' : 'water'}` +
    (c.inside ? '' : '   (outside disc)') +
    `\n${(b?.name ?? 'unassigned').padEnd(12)} edge ${c.boundaryDist.toFixed(0)} m`;
};

// --- stats + stage table -------------------------------------------------

const statsHost = document.createElement('div');
const stageHost = document.createElement('div');
const legendHost = document.createElement('div');
const geoHost = document.createElement('div');

function renderStats(): void {
  if (!result) { statsHost.innerHTML = ''; return; }
  const s = result.stats;
  const mb = (s.atlasBytes / (1024 * 1024)).toFixed(1);
  const unresolved = partitionStats.unresolved;
  const warn = unresolved > 0 ? ' style="color:var(--warn)"' : '';
  // The seam test: border slope well above interior slope means the blend is
  // failing somewhere, which a hillshade alone will not reliably show you.
  const seam = s.slopeP99SoftBorder - s.slopeP99Interior;
  const seamWarn = seam > 8 ? ' style="color:var(--warn)"' : '';
  const seamNote = seam > 8 ? '(seam)' : '(ok)';
  statsHost.innerHTML = `
    <div><span>atlas</span><b>${result.atlas.res}&sup2; &middot; ${s.cellSize.toFixed(2)} m/cell</b></div>
    <div><span>memory</span><b>${mb} MB</b></div>
    <div><span>bake</span><b>${result.totalMs.toFixed(0)} ms</b></div>
    <div><span>height range</span><b>${s.minHeight.toFixed(0)} / ${s.maxHeight.toFixed(0)} m</b></div>
    <div><span>land</span><b>${(s.landFraction * 100).toFixed(1)} %</b></div>
    <div><span>shore band</span><b>${(s.shoreFraction * 100).toFixed(1)} %</b></div>
    <div><span>worley sites</span><b>${partitionStats.sites}</b></div>
    <div${partitionStats.landSites < 48 ? ' style="color:var(--warn)"' : ''}><span>land sites</span><b>${partitionStats.landSites} (${(partitionStats.landSites / 8).toFixed(1)}/biome)</b></div>
    <div><span>adjacency repairs</span><b>${partitionStats.repairs} in ${partitionStats.sweeps} sweeps</b></div>
    <div${warn}><span>unresolved borders</span><b>${unresolved}</b></div>
    <div><span>slope p99 interior</span><b>${s.slopeP99Interior.toFixed(0)}&deg;</b></div>
    <div${seamWarn}><span>slope p99 soft border</span><b>${s.slopeP99SoftBorder.toFixed(0)}&deg; ${seamNote}</b></div>
    <div><span>slope p99 hard border</span><b>${s.slopeP99HardBorder.toFixed(0)}&deg; <span style="opacity:.5">by design</span></b></div>`;
}

/**
 * Area by biome. Land-only share is the one that matters — a biome can own a
 * lot of the disc and almost none of it be walkable.
 */
function renderLegend(): void {
  if (!result) { legendHost.innerHTML = ''; return; }
  const partitioned = BIOMES.filter((b) => b.weight > 0);
  const rows = partitioned.map((b, idx) => {
    const land = (result!.stats.biomeAreaLand.get(b.id) ?? 0) * 100;
    const target = (partitionStats.targetShare[idx] ?? 0) * 100;
    const mean = result!.stats.biomeMeanElev.get(b.id) ?? 0;
    const sw = `background:rgb(${b.colour[0]},${b.colour[1]},${b.colour[2]})`;
    // Flag any biome that missed its quota by more than half — that is the
    // signal the terrain simply had nowhere to put it.
    const off = target > 0 && Math.abs(land - target) > target * 0.5;
    const style = land < 0.05 ? 'opacity:.4' : off ? 'color:var(--warn)' : '';
    return `<div style="${style}" title="mean elevation ${mean.toFixed(0)} m">
      <span><i style="${sw};display:inline-block;width:10px;height:10px;
        border-radius:2px;margin-right:6px;vertical-align:-1px"></i>${b.name}</span>
      <b>${land.toFixed(1)} % <span style="opacity:.5">/ ${target.toFixed(1)}</span>
         <span style="opacity:.5;margin-left:6px">${mean.toFixed(0)}m</span></b>
    </div>`;
  });
  legendHost.innerHTML =
    rows.join('') +
    `<div style="opacity:.5;border:0;padding-top:6px">
       <span>achieved land share / target</span><b></b></div>`;
}

function renderStageTable(): void {
  if (!result) { stageHost.innerHTML = ''; return; }
  const rows = result.stages.map((st, i) => {
    const active = i === stageView || (stageView === -1 && i === lastImplemented());
    const writes = st.writes.length ? ` <span style="opacity:.45">${st.writes.join(', ')}</span>` : '';
    const name = st.implemented ? `${st.name}${writes}` : `${st.name} <i>(not yet)</i>`;
    const right = st.implemented ? `${st.ms.toFixed(0)} ms` : '&mdash;';
    const colour = st.implemented ? (active ? 'color:var(--accent)' : '') : 'opacity:.45';
    const cursor = st.implemented ? 'cursor:pointer' : '';
    return `<div data-stage="${i}" style="${colour};${cursor}"><span>${st.id}. ${name}</span><b>${right}</b></div>`;
  });
  stageHost.innerHTML = rows.join('');
  stageHost.querySelectorAll<HTMLElement>('[data-stage]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.stage);
      if (!result || !result.stages[i].implemented) return;
      if (!result.stages[i].heightSnapshot) return; // no height to scrub to
      stageView = i === lastImplemented() ? -1 : i;
      redraw();
      renderStageTable();
    });
  });
}

function lastImplemented(): number {
  if (!result) return -1;
  for (let i = result.stages.length - 1; i >= 0; i--) if (result.stages[i].implemented) return i;
  return -1;
}

function activeField(): Float32Array {
  if (!result) throw new Error('no bake');
  if (stageView >= 0) {
    const snap = result.stages[stageView].heightSnapshot;
    if (snap) return snap;
  }
  return result.atlas.baseHeight;
}

/** Height as of the last stage BEFORE `index` that wrote any — the diff base. */
function previousHeight(index: number): Float32Array | null {
  if (!result) return null;
  for (let k = index - 1; k >= 0; k--) {
    const h = result.stages[k].heightSnapshot;
    if (h) return h;
  }
  return null;
}

/**
 * Per-biome geomorphology after erosion — the §6 instrument (see metrics.ts).
 * Reported rather than eyeballed, because a hillshade cannot tell you whether
 * biomes differ BECAUSE of erodibility or merely because of their relief.
 */
function renderGeomorph(): void {
  if (!result) { geoHost.innerHTML = ''; return; }
  const g = result.geomorph;
  if (!g.biomes.length) { geoHost.innerHTML = '<div>no erosion data</div>'; return; }
  const rows = g.biomes.map((b) => {
    const def = biomeById(b.id);
    const c = def ? `rgb(${def.colour[0]},${def.colour[1]},${def.colour[2]})` : '#888';
    return `<div title="erodibility ${b.erodibility} · slope ${b.meanSlopeDeg.toFixed(1)}&deg; · drainage ${b.drainageDensity.toFixed(3)}">
      <span><i style="background:${c};display:inline-block;width:10px;height:10px;
        border-radius:2px;margin-right:6px;vertical-align:-1px"></i>${b.name}</span>
      <b>${b.meanAbsDelta.toFixed(2)}m <span style="opacity:.5">r${b.roughness.toFixed(1)}</span></b>
    </div>`;
  });
  geoHost.innerHTML =
    rows.join('') +
    `<div style="opacity:.5;border:0;padding-top:6px">
       <span>eroded / roughness</span><b>rho ${g.rhoRoughness.toFixed(2)}</b></div>`;
}

// --- bake / draw ---------------------------------------------------------

function setStatus(text: string, busy = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('busy', busy);
}

function markDirty(): void {
  dirty = true;
  bakeBtn.disabled = false;
  bakeBtn.textContent = 'Bake — params changed';
}

function redraw(): void {
  if (!result) return;
  const t0 = performance.now();
  const res = result.atlas.res;
  if (!img || img.width !== res) img = new ImageData(res, res);
  render.snapshot = stageView >= 0 ? result.stages[stageView].heightSnapshot : null;
  render.diffBase = previousHeight(stageView >= 0 ? stageView : result.stages.length);
  renderAtlas(result.atlas, params, render, img);
  view.setImage(img, activeField());
  setStatus(`draw ${(performance.now() - t0).toFixed(0)} ms`);
}

function runBake(): void {
  setStatus('baking…', true);
  bakeBtn.disabled = true;
  bakeBtn.textContent = 'Baking…';
  // Yield so the status paints before we block the thread. setTimeout, not
  // requestAnimationFrame: rAF does not fire at all while the page is
  // render-suspended (backgrounded tab, hidden pane), which leaves the app
  // stuck on "baking…" forever with an idle main thread. setTimeout is
  // throttled in that state but still fires.
  setTimeout(() => { void runBakeAsync(); }, 0);
}

async function runBakeAsync(): Promise<void> {
  {
    result = await bake(params);
    stageView = -1;
    dirty = false;
    const res = result.atlas.res;
    img = new ImageData(res, res);
    render.snapshot = null;
    renderAtlas(result.atlas, params, render, img);
    view.setAtlas(result.atlas, params, img, activeField());
    bakeBtn.textContent = 'Bake';
    bakeBtn.disabled = true;
    setStatus(`baked in ${result.totalMs.toFixed(0)} ms`);
    renderStats();
    renderStageTable();
    renderLegend();
    renderGeomorph();
  }
}

function onChange(needsBake: boolean): void {
  if (needsBake) markDirty();
  else redraw();
}

// --- panel ---------------------------------------------------------------

const sections: SectionSpec[] = [
  {
    title: 'World',
    controls: [
      { kind: 'text', label: 'seed', bake: true,
        get: () => seedText,
        set: (v) => { seedText = v; params.seed = seedFromString(v); } },
      { kind: 'select', label: 'atlas resolution', bake: true,
        options: [
          { value: '512', label: '512 (19.5 m/cell)' },
          { value: '1024', label: '1024 (9.8 m/cell)' },
          { value: '2048', label: '2048 (4.9 m/cell)' },
        ],
        get: () => String(params.atlasRes),
        set: (v) => { params.atlasRes = Number(v); } },
      { kind: 'slider', label: 'world radius', min: 2000, max: 8000, step: 250, bake: true,
        get: () => params.worldRadius, set: (v) => { params.worldRadius = v; },
        format: (v) => `${(v * 2) / 1000} km` },
      { kind: 'slider', label: 'sea level', min: -60, max: 60, step: 1, bake: true,
        get: () => params.seaLevel, set: (v) => { params.seaLevel = v; },
        format: (v) => `${v} m` },
    ],
  },
  {
    title: 'Island clusters',
    controls: [
      { kind: 'slider', label: 'seed spacing', min: 300, max: 2000, step: 10, bake: true,
        get: () => params.islandSpacing, set: (v) => { params.islandSpacing = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'jitter', min: 0, max: 1.4, step: 0.01, bake: true,
        get: () => params.islandJitter, set: (v) => { params.islandJitter = v; } },
      { kind: 'slider', label: 'radius min', min: 80, max: 1200, step: 10, bake: true,
        get: () => params.islandRadiusMin, set: (v) => { params.islandRadiusMin = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'radius max', min: 200, max: 2400, step: 10, bake: true,
        get: () => params.islandRadiusMax, set: (v) => { params.islandRadiusMax = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'cluster scale', min: 1200, max: 9000, step: 100, bake: true,
        get: () => 1 / params.clusterFrequency,
        set: (v) => { params.clusterFrequency = 1 / v; },
        format: (v) => `${(v / 1000).toFixed(1)} km` },
      { kind: 'slider', label: 'cluster threshold', min: -0.5, max: 0.5, step: 0.005, bake: true,
        get: () => params.clusterThreshold, set: (v) => { params.clusterThreshold = v; } },
      { kind: 'slider', label: 'cluster sharpness', min: 0.4, max: 8, step: 0.1, bake: true,
        get: () => params.clusterSharpness, set: (v) => { params.clusterSharpness = v; } },
      { kind: 'slider', label: 'seed variance', min: 0, max: 1.2, step: 0.01, bake: true,
        get: () => params.islandVariance, set: (v) => { params.islandVariance = v; } },
      { kind: 'slider', label: 'merge softness', min: 0, max: 1, step: 0.01, bake: true,
        get: () => params.mergeSoftness, set: (v) => { params.mergeSoftness = v; } },
    ],
  },
  {
    title: 'Continental detail',
    controls: [
      { kind: 'slider', label: 'octaves', min: 1, max: 9, step: 1, bake: true,
        get: () => params.continentFbm.octaves, set: (v) => { params.continentFbm.octaves = v; } },
      { kind: 'slider', label: 'wavelength', min: 300, max: 5000, step: 50, bake: true,
        get: () => 1 / params.continentFbm.frequency,
        set: (v) => { params.continentFbm.frequency = 1 / v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'lacunarity', min: 1.4, max: 3.2, step: 0.05, bake: true,
        get: () => params.continentFbm.lacunarity, set: (v) => { params.continentFbm.lacunarity = v; } },
      { kind: 'slider', label: 'gain', min: 0.25, max: 0.75, step: 0.01, bake: true,
        get: () => params.continentFbm.gain, set: (v) => { params.continentFbm.gain = v; } },
      { kind: 'slider', label: 'amplitude', min: 0, max: 0.8, step: 0.01, bake: true,
        get: () => params.detailAmplitude, set: (v) => { params.detailAmplitude = v; } },
      { kind: 'slider', label: 'warp amount', min: 0, max: 900, step: 10, bake: true,
        get: () => params.warpAmplitude, set: (v) => { params.warpAmplitude = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'warp scale', min: 500, max: 7000, step: 100, bake: true,
        get: () => 1 / params.warpFrequency,
        set: (v) => { params.warpFrequency = 1 / v; },
        format: (v) => `${v} m` },
    ],
  },
  {
    title: 'Elevation mapping',
    controls: [
      { kind: 'slider', label: 'shoreline', min: 0, max: 0.9, step: 0.005, bake: true,
        get: () => params.shoreline, set: (v) => { params.shoreline = v; } },
      { kind: 'slider', label: 'land gain', min: 40, max: 700, step: 5, bake: true,
        get: () => params.landGain, set: (v) => { params.landGain = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'ocean gain', min: 40, max: 900, step: 5, bake: true,
        get: () => params.oceanGain, set: (v) => { params.oceanGain = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'rim start', min: 0.3, max: 1, step: 0.01, bake: true,
        get: () => params.rimStart, set: (v) => { params.rimStart = v; },
        format: (v) => `${(v * 100).toFixed(0)} %` },
      { kind: 'slider', label: 'rim depth', min: 40, max: 400, step: 5, bake: true,
        get: () => params.rimDepth, set: (v) => { params.rimDepth = v; },
        format: (v) => `-${v} m` },
    ],
  },
  {
    title: 'Biome partition',
    controls: [
      { kind: 'slider', label: 'region size', min: 400, max: 3000, step: 25, bake: true,
        get: () => params.biomeCellSpacing, set: (v) => { params.biomeCellSpacing = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'site jitter', min: 0, max: 1, step: 0.01, bake: true,
        get: () => params.biomeJitter, set: (v) => { params.biomeJitter = v; } },
      { kind: 'slider', label: 'quota strength', min: 0, max: 1, step: 0.02, bake: true,
        get: () => params.biomeQuota, set: (v) => { params.biomeQuota = v; },
        format: (v) => (v === 0 ? 'off' : v.toFixed(2)) },
      { kind: 'slider', label: 'warp 1 amount', min: 0, max: 1200, step: 10, bake: true,
        get: () => params.warpA1, set: (v) => { params.warpA1 = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'warp 1 scale', min: 1000, max: 9000, step: 100, bake: true,
        get: () => 1 / params.warpF1, set: (v) => { params.warpF1 = 1 / v; },
        format: (v) => `${(v / 1000).toFixed(1)} km` },
      { kind: 'slider', label: 'warp 2 amount', min: 0, max: 500, step: 5, bake: true,
        get: () => params.warpA2, set: (v) => { params.warpA2 = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'warp 2 scale', min: 200, max: 2500, step: 25, bake: true,
        get: () => 1 / params.warpF2, set: (v) => { params.warpF2 = 1 / v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'warp 3 amount', min: 0, max: 150, step: 2, bake: true,
        get: () => params.warpA3, set: (v) => { params.warpA3 = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'warp 3 scale', min: 60, max: 700, step: 10, bake: true,
        get: () => 1 / params.warpF3, set: (v) => { params.warpF3 = 1 / v; },
        format: (v) => `${v} m` },
    ],
  },
  {
    title: 'Height envelope',
    controls: [
      { kind: 'slider', label: 'envelope strength', min: 0, max: 1, step: 0.02, bake: true,
        get: () => params.envelopeStrength, set: (v) => { params.envelopeStrength = v; },
        format: (v) => (v === 0 ? 'off' : v.toFixed(2)) },
      { kind: 'slider', label: 'coast fade', min: 1, max: 200, step: 1, bake: true,
        get: () => params.coastBand, set: (v) => { params.coastBand = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'blend scale', min: 0, max: 3, step: 0.05, bake: true,
        get: () => params.blendScale, set: (v) => { params.blendScale = v; } },
      { kind: 'slider', label: 'hard-edge blend', min: 0, max: 120, step: 2, bake: true,
        get: () => params.hardEdgeBlend, set: (v) => { params.hardEdgeBlend = v; },
        format: (v) => (v === 0 ? 'none' : `${v} m`) },
    ],
  },
  {
    title: 'Erosion',
    controls: [
      { kind: 'slider', label: 'iterations', min: 0, max: 400, step: 10, bake: true,
        get: () => params.eroIterations, set: (v) => { params.eroIterations = v; },
        format: (v) => (v === 0 ? 'off' : String(v)) },
      { kind: 'slider', label: 'rain', min: 0, max: 0.05, step: 0.001, bake: true,
        get: () => params.eroRain, set: (v) => { params.eroRain = v; } },
      { kind: 'slider', label: 'capacity', min: 1, max: 40, step: 0.5, bake: true,
        get: () => params.eroCapacity, set: (v) => { params.eroCapacity = v; } },
      { kind: 'slider', label: 'dissolve rate', min: 0, max: 2, step: 0.02, bake: true,
        get: () => params.eroDissolve, set: (v) => { params.eroDissolve = v; } },
      { kind: 'slider', label: 'deposit rate', min: 0, max: 2, step: 0.02, bake: true,
        get: () => params.eroDeposit, set: (v) => { params.eroDeposit = v; } },
      { kind: 'slider', label: 'thermal rate', min: 0, max: 1, step: 0.02, bake: true,
        get: () => params.eroThermalRate, set: (v) => { params.eroThermalRate = v; } },
      { kind: 'slider', label: 'thermal every', min: 0, max: 8, step: 1, bake: true,
        get: () => params.eroThermalEvery, set: (v) => { params.eroThermalEvery = v; },
        format: (v) => (v === 0 ? 'off' : `${v} it`) },
      { kind: 'slider', label: 'erodibility override', min: -1, max: 1, step: 0.05, bake: true,
        get: () => params.eroErodibilityOverride,
        set: (v) => { params.eroErodibilityOverride = v; },
        format: (v) => (v < 0 ? 'real field' : v.toFixed(2)) },
    ],
  },
  {
    title: 'Display',
    controls: [
      { kind: 'select', label: 'layer',
        options: [
          { value: 'biome', label: 'Biome' },
          { value: 'hypsometric', label: 'Hypsometric' },
          { value: 'boundary', label: 'Boundary distance' },
          { value: 'erodibility', label: 'Erodibility' },
          { value: 'flow', label: 'Drainage (flow)' },
          { value: 'diff', label: 'Diff vs previous stage' },
          { value: 'grayscale', label: 'Height (gray)' },
          { value: 'slope', label: 'Slope' },
          { value: 'landmask', label: 'Land mask' },
        ],
        get: () => render.layer, set: (v) => { render.layer = v as LayerName; } },
      { kind: 'toggle', label: 'hillshade',
        get: () => render.hillshade, set: (v) => { render.hillshade = v; } },
      { kind: 'toggle', label: 'biome borders',
        get: () => render.biomeBorders, set: (v) => { render.biomeBorders = v; } },
      { kind: 'toggle', label: 'mask ocean in biome layer',
        get: () => render.maskOcean, set: (v) => { render.maskOcean = v; } },
      { kind: 'slider', label: 'diff scale', min: 0.5, max: 60, step: 0.5,
        get: () => render.diffScale, set: (v) => { render.diffScale = v; },
        format: (v) => `±${v} m` },
      { kind: 'slider', label: 'boundary scale', min: 50, max: 1200, step: 10,
        get: () => render.boundaryScale, set: (v) => { render.boundaryScale = v; },
        format: (v) => `${v} m` },
      { kind: 'toggle', label: 'shoreline',
        get: () => render.shoreLine, set: (v) => { render.shoreLine = v; } },
      { kind: 'toggle', label: 'contours',
        get: () => render.contours, set: (v) => { render.contours = v; } },
      { kind: 'slider', label: 'contour interval', min: 10, max: 200, step: 10,
        get: () => render.contourInterval, set: (v) => { render.contourInterval = v; },
        format: (v) => `${v} m` },
      { kind: 'slider', label: 'sun azimuth', min: 0, max: 360, step: 1,
        get: () => render.sunAzimuth, set: (v) => { render.sunAzimuth = v; },
        format: (v) => `${v}°` },
      { kind: 'slider', label: 'sun altitude', min: 5, max: 85, step: 1,
        get: () => render.sunAltitude, set: (v) => { render.sunAltitude = v; },
        format: (v) => `${v}°` },
      { kind: 'slider', label: 'relief exaggeration', min: 0.5, max: 6, step: 0.1,
        get: () => render.exaggeration, set: (v) => { render.exaggeration = v; } },
    ],
  },
];

const panel = buildPanel(controlsEl, sections, onChange);

// Stats and the stage table live below the generated controls.
appendSection('Biomes', legendHost, 'rows');
appendSection('Geomorphology', geoHost, 'rows');
appendSection('Bake', statsHost, 'kv');
appendSection('Pipeline', stageHost, 'rows');

const hint = document.createElement('div');
hint.className = 'hint';
hint.textContent =
  'Drag to pan, wheel to zoom. Click an implemented pipeline stage to view the atlas as of that stage. ' +
  'Display controls redraw instantly; anything else needs a bake.';
controlsEl.appendChild(hint);

function appendSection(title: string, host: HTMLElement, cls: string): void {
  const el = document.createElement('div');
  el.className = 'section';
  const head = document.createElement('h2');
  head.innerHTML = `<span>${title}</span><span>&#9662;</span>`;
  head.addEventListener('click', () => el.classList.toggle('collapsed'));
  const body = document.createElement('div');
  body.className = 'body';
  host.className = cls;
  body.appendChild(host);
  el.appendChild(head);
  el.appendChild(body);
  controlsEl.appendChild(el);
}

bakeBtn.addEventListener('click', () => { if (dirty) runBake(); });
let rerollCounter = 0;
rerollBtn.addEventListener('click', () => {
  // Still no Math.random: the clock picks the seed, the hash chain does the rest.
  seedText = (hashU32(Date.now() ^ (rerollCounter++ * 0x9e3779b1)) >>> 8).toString(36);
  params.seed = seedFromString(seedText);
  panel.sync();
  runBake();
});

panel.sync();
runBake();

/**
 * Audit runner — DESIGN.md §6 verification.
 *
 * Bakes with parameter overrides and returns numbers. This exists because
 * "does erosion make biomes look different" is not answerable by looking at
 * a hillshade, and because the bracket tests (erodibility forced to 0 and to
 * 1) are the only way to confirm the gate is actually wired to the thing it
 * claims to gate.
 */
export interface AuditRun {
  label: string;
  bakeMs: number;
  gpuMs: number;
  erosionRan: boolean;
  erosionReason: string;
  meanAbsDelta: number;
  netDelta: number;
  slopeInterior: number;
  slopeSoftBorder: number;
  slopeHardBorder: number;
  rho: Record<string, number>;
  deltaSpread: number;
  biomes: Array<Record<string, number | string>>;
}

async function auditRun(label: string, overrides: Partial<WorldParams>): Promise<AuditRun> {
  const p = cloneParams({ ...params, ...overrides } as WorldParams);
  const r = await bake(p);
  return {
    label,
    bakeMs: +r.totalMs.toFixed(0),
    gpuMs: +erosionStats.gpuMs.toFixed(0),
    erosionRan: erosionStats.ran,
    erosionReason: erosionStats.reason,
    meanAbsDelta: +erosionStats.meanAbsDelta.toFixed(3),
    netDelta: +erosionStats.netDelta.toFixed(3),
    slopeInterior: r.stats.slopeP99Interior,
    slopeSoftBorder: r.stats.slopeP99SoftBorder,
    slopeHardBorder: r.stats.slopeP99HardBorder,
    rho: {
      delta: +r.geomorph.rhoDelta.toFixed(3),
      slope: +r.geomorph.rhoSlope.toFixed(3),
      roughness: +r.geomorph.rhoRoughness.toFixed(3),
      drainage: +r.geomorph.rhoDrainage.toFixed(3),
      hypsometric: +r.geomorph.rhoHypsometric.toFixed(3),
    },
    deltaSpread: +r.geomorph.deltaSpread.toFixed(2),
    biomes: r.geomorph.biomes.map((b) => ({
      name: b.name,
      erod: b.erodibility,
      delta: +b.meanAbsDelta.toFixed(2),
      slope: +b.meanSlopeDeg.toFixed(1),
      rough: +b.roughness.toFixed(3),
      drain: +b.drainageDensity.toFixed(3),
      hypso: +b.hypsometricIntegral.toFixed(3),
    })),
  };
}

(window as unknown as Record<string, unknown>).field = {
  /** §3 contract probe — see core/field.ts measureColumnHonesty. */
  honesty: (samples?: number) => {
    if (!result) return { error: 'no bake yet' };
    const f = createField(result.atlas, params);
    return measureColumnHonesty(params, f, samples);
  },
  sample: (x: number, y: number) => {
    if (!result) return { error: 'no bake yet' };
    return createField(result.atlas, params).sampleColumn(x, y);
  },
};

(window as unknown as Record<string, unknown>).sweep = {
  regionSize: (sizes?: number[]) => sweepRegionSize(params, sizes),
  talus: (values?: number[]) => sweepTalus(params, values),
  envelope: () => envelopeDrift(params),
  driftByRegion: (sizes?: number[], seeds?: number) =>
    sweepDriftByRegion(params, sizes, seeds),
  envelopeBySeeds: (regionM: number, seeds?: number) =>
    envelopeBySeeds(params, regionM, seeds),
  sensitivity: (regionM: number, key: string, name: string,
                spans: number[], profiles: number[], seeds?: number) =>
    sensitivity(params, regionM, key, name, spans, profiles, seeds),
  radial: (regionM: number, key: string, name: string,
           variants: Array<{ label: string; radialMean?: number; radialWidth?: number }>,
           seeds?: number) =>
    radialSensitivity(params, regionM, key, name, variants, seeds),
  variants: (specs: VariantSpec[]) => compareVariants(params, specs),
};

(window as unknown as Record<string, unknown>).audit = {
  run: auditRun,
  /** The §6 bracket: 0 must leave terrain untouched, 1 must erode uniformly. */
  brackets: async (): Promise<AuditRun[]> => [
    await auditRun('no erosion', { eroIterations: 0 }),
    await auditRun('erodibility = 0', { eroErodibilityOverride: 0 }),
    await auditRun('erodibility = 1', { eroErodibilityOverride: 1 }),
    await auditRun('real erodibility', {}),
  ],
};
