/**
 * Geomorphology metrics — the instrument for DESIGN.md §6's bet.
 *
 * The bet is that erodibility-modulated global erosion produces visually
 * distinct biomes. "Visually distinct" is not measurable, but the things that
 * make eroded and resistant terrain *look* different are:
 *
 *   meanAbsDelta        how much material erosion actually moved
 *   meanSlopeDeg        eroded terrain is gentler
 *   roughness           erosion smooths; |Laplacian| in metres
 *   drainageDensity     mature landscapes develop dense channel networks
 *   hypsometricIntegral mature profiles are concave, so this falls
 *
 * The test is not whether any single number looks right — it is whether the
 * numbers SEPARATE and whether they separate IN THE ORDER erodibility
 * predicts. That is a rank correlation, and it is falsifiable: if Spearman
 * rho between erodibility and these metrics is near zero, the §6 resolution
 * does not work and the stage ordering needs rethinking.
 */

import { Atlas } from './atlas';
import { BIOMES, biomeById } from './biomes';
import type { WorldParams } from './params';

export interface BiomeGeomorph {
  id: number;
  name: string;
  erodibility: number;
  landCells: number;
  meanAbsDelta: number;
  meanSlopeDeg: number;
  roughness: number;
  drainageDensity: number;
  hypsometricIntegral: number;
  /** Mean land elevation before and after stage 5, and the §7 range. */
  meanElevBefore: number;
  meanElevAfter: number;
  bandMin: number;
  bandMax: number;
  /**
   * Metres the measured p99 elevation falls short of bandMax. A peak compared
   * against a peak — replaces the old mean-against-band "drift", which was a
   * definition error (see BiomeDef.bandMin).
   */
  bandDrift: number;
  /** mean / elevSpan — the measured E[u^elevProfile]. */
  shapeFactor: number;
  /** 99th-percentile elevation within the biome: what its peak actually is. */
  peakElev: number;
  /**
   * Fraction of this biome's land above half its own elevSpan — "how much of
   * the mountain is actually mountain". Scale-free, so it compares across
   * biomes with different spans, which mean elevation cannot.
   */
  highFraction: number;
  /**
   * Same, restricted to cells more than 160 m from a foreign biome, i.e.
   * outside every blend band (the widest authored blendWidth is 145 m).
   *
   * Needed because per-biome means are contaminated by blending: Fen measures
   * a mean of 0.67x its own span, which is impossible for a biome whose
   * profile is 1.8, because its cells near Blackforest are pulled up by that
   * neighbour's 140 m span. Interior figures describe the envelope; all-cell
   * figures describe what a player walking through actually meets. Both are
   * real, they answer different questions.
   */
  highFractionInterior: number;
  meanElevInterior: number;
  interiorCells: number;
}

export interface GeomorphReport {
  biomes: BiomeGeomorph[];
  /** Spearman rho between biome erodibility and each metric. */
  rhoDelta: number;
  rhoSlope: number;
  rhoRoughness: number;
  rhoDrainage: number;
  rhoHypsometric: number;
  /** Ratio of the most-eroded biome's delta to the least-eroded one's. */
  deltaSpread: number;
  /** Mean |delta| restricted to biomes flagged hardEdge — the §6.2 cost. */
  hardEdgeDelta: number;
  /** Mean |bandDrift| across biomes, before and after erosion. */
  driftBefore: number;
  driftAfter: number;
}

/** Spearman rank correlation. Ties get averaged ranks. */
export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (v: number[]): number[] => {
    const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
    const r = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && v[idx[j + 1]] === v[idx[i]]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

export function geomorphology(
  atlas: Atlas, p: WorldParams, before: Float32Array | null,
): GeomorphReport {
  const { res, baseHeight, biomeId, flowAccum } = atlas;
  const r2 = p.worldRadius * p.worldRadius;
  const cs = atlas.cellSize;
  const maxId = 16;

  // Channel threshold: the 80th percentile of flow over all land. Using a
  // global threshold rather than a per-biome one is the point — it asks which
  // biomes concentrate flow more than the world average, not which ones have
  // internal variation.
  const flows: number[] = [];
  for (let i = 0; i < res * res; i++) {
    if (baseHeight[i] > p.seaLevel && flowAccum[i] > 0) flows.push(flowAccum[i]);
  }
  flows.sort((a, b) => a - b);
  const channelT = flows.length ? flows[Math.floor(flows.length * 0.8)] : Infinity;

  const cells = new Float64Array(maxId);
  const sumDelta = new Float64Array(maxId);
  const sumSlope = new Float64Array(maxId);
  const sumRough = new Float64Array(maxId);
  const sumChannel = new Float64Array(maxId);
  const sumH = new Float64Array(maxId);
  const sumHBefore = new Float64Array(maxId);
  const sumHInterior = new Float64Array(maxId);
  const cellsInterior = new Float64Array(maxId);
  const highAll = new Float64Array(maxId);
  const highInt = new Float64Array(maxId);
  // Coarse elevation histogram per biome for the p99 peak, 5 m buckets.
  const HB = 160;
  const hist = new Int32Array(maxId * HB);
  const INTERIOR_M = 160;
  const minH = new Float64Array(maxId).fill(Infinity);
  const maxH = new Float64Array(maxId).fill(-Infinity);

  for (let iy = 1; iy < res - 1; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 1; ix < res - 1; ix++) {
      const wx = atlas.worldX(ix);
      if (wx * wx + wy * wy > r2) continue;
      const i = iy * res + ix;
      const h = baseHeight[i];
      if (h <= p.seaLevel) continue;
      const b = biomeId[i];
      if (b >= maxId) continue;

      const hl = baseHeight[i - 1];
      const hr = baseHeight[i + 1];
      const hu = baseHeight[i - res];
      const hd = baseHeight[i + res];

      const dzdx = (hr - hl) / (2 * cs);
      const dzdy = (hd - hu) / (2 * cs);
      const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

      cells[b]++;
      sumSlope[b] += slopeDeg;
      sumRough[b] += Math.abs(4 * h - (hl + hr + hu + hd));
      sumH[b] += h;
      if (h < minH[b]) minH[b] = h;
      if (h > maxH[b]) maxH[b] = h;
      if (flowAccum[i] >= channelT) sumChannel[b]++;
      if (before) { sumDelta[b] += Math.abs(h - before[i]); sumHBefore[b] += before[i]; }

      const def0 = biomeById(b);
      const halfSpan = def0 ? def0.elevSpan * 0.5 : Infinity;
      if (h >= halfSpan) highAll[b]++;
      hist[b * HB + Math.min(HB - 1, Math.max(0, Math.round(h / 5)))]++;
      if (atlas.boundaryDist[i] >= INTERIOR_M) {
        cellsInterior[b]++;
        sumHInterior[b] += h;
        if (h >= halfSpan) highInt[b]++;
      }
    }
  }

  const out: BiomeGeomorph[] = [];
  for (const def of BIOMES) {
    if (def.weight <= 0) continue;
    const b = def.id;
    const c = cells[b];
    if (c < 200) continue; // too small to characterise
    const span = maxH[b] - minH[b];
    const after = sumH[b] / c;
    // p99 elevation from the histogram.
    let run = 0;
    let peak = 0;
    for (let k = 0; k < HB; k++) {
      run += hist[b * HB + k];
      if (run >= c * 0.99) { peak = k * 5; break; }
    }
    const ci = cellsInterior[b];
    const bef = before ? sumHBefore[b] / c : after;
    out.push({
      meanElevBefore: bef,
      meanElevAfter: after,
      bandMin: def.bandMin,
      bandMax: def.bandMax,
      bandDrift: Math.max(0, def.bandMax - peak),
      shapeFactor: def.elevSpan !== 0 ? after / def.elevSpan : 0,
      peakElev: peak,
      highFraction: highAll[b] / c,
      highFractionInterior: ci > 0 ? highInt[b] / ci : 0,
      meanElevInterior: ci > 0 ? sumHInterior[b] / ci : 0,
      interiorCells: ci,
      id: b,
      name: def.name,
      erodibility: def.erodibility,
      landCells: c,
      meanAbsDelta: sumDelta[b] / c,
      meanSlopeDeg: sumSlope[b] / c,
      roughness: sumRough[b] / c,
      drainageDensity: sumChannel[b] / c,
      hypsometricIntegral: span > 0 ? (sumH[b] / c - minH[b]) / span : 0,
    });
  }

  const e = out.map((o) => o.erodibility);
  const deltas = out.map((o) => o.meanAbsDelta).filter((v) => v > 0);
  const spread =
    deltas.length >= 2 ? Math.max(...deltas) / Math.max(1e-6, Math.min(...deltas)) : 0;

  const hardBiomes = out.filter((o) => biomeById(o.id)?.hardEdge);
  const driftB = 0; // old mean-vs-band measure withdrawn; see BiomeDef.bandMin
  const driftA = out.length
    ? out.reduce((acc, o) => acc + o.bandDrift, 0) / out.length
    : 0;

  return {
    biomes: out,
    hardEdgeDelta: hardBiomes.length
      ? hardBiomes.reduce((acc, o) => acc + o.meanAbsDelta, 0) / hardBiomes.length
      : 0,
    driftBefore: driftB,
    driftAfter: driftA,
    rhoDelta: spearman(e, out.map((o) => o.meanAbsDelta)),
    rhoSlope: spearman(e, out.map((o) => o.meanSlopeDeg)),
    rhoRoughness: spearman(e, out.map((o) => o.roughness)),
    rhoDrainage: spearman(e, out.map((o) => o.drainageDensity)),
    rhoHypsometric: spearman(e, out.map((o) => o.hypsometricIntegral)),
    deltaSpread: spread,
  };
}

/** Slope p99 restricted to cells on a border between the two given biomes. */
export function borderSlopeP99(
  atlas: Atlas, p: WorldParams, hardOnly: boolean,
): number {
  const { res, baseHeight, biomeId } = atlas;
  const r2 = p.worldRadius * p.worldRadius;
  const cs2 = atlas.cellSize * 2;
  const hist = new Int32Array(91);
  let total = 0;

  for (let iy = 1; iy < res - 1; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 1; ix < res - 1; ix++) {
      const wx = atlas.worldX(ix);
      if (wx * wx + wy * wy > r2) continue;
      const i = iy * res + ix;
      if (baseHeight[i] <= p.seaLevel) continue;
      const b = biomeId[i];
      let match = false;
      for (const nb of [biomeId[i + 1], biomeId[i - 1], biomeId[i + res], biomeId[i - res]]) {
        if (nb === b) continue;
        const hard = (biomeById(b)?.hardEdge ?? false) || (biomeById(nb)?.hardEdge ?? false);
        if (hard === hardOnly) match = true;
      }
      if (!match) continue;
      const dzdx = (baseHeight[i + 1] - baseHeight[i - 1]) / cs2;
      const dzdy = (baseHeight[i + res] - baseHeight[i - res]) / cs2;
      const deg = Math.round((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI);
      hist[Math.min(90, Math.max(0, deg))]++;
      total++;
    }
  }
  if (!total) return 0;
  let run = 0;
  for (let k = 0; k <= 90; k++) {
    run += hist[k];
    if (run >= total * 0.99) return k;
  }
  return 90;
}
