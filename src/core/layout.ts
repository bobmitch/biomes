/**
 * Biome layout metrics — the instrument for the §5.4 size-vs-mix tension.
 *
 * "Reads as a quilt" is the thing being decided, so it needs a number. Three
 * independent ones, because they fail in different directions:
 *
 *   meanPatchAreaKm2   how big a contiguous region of one biome actually is
 *   meanCrossingRunM   how far you walk in a straight line before the biome
 *                      changes — the pedestrian's view, and the one that
 *                      corresponds to "quilt"
 *   channelsPerPatch   how many drainage channels a typical patch contains
 *
 * The third exists to test the M4-follow-up prediction. Erosion cannot change
 * biome boundaries, so patch size and crossing length are identical before and
 * after it runs. What erosion changes is whether a patch has internal
 * structure — a patch crossed by several channels reads as terrain, a patch
 * crossed by none reads as a coloured tile. If small regions only became
 * acceptable because of erosion, this is the metric that will say so.
 */

import { Atlas } from './atlas';
import { BIOMES } from './biomes';
import type { WorldParams } from './params';

export interface LayoutMetrics {
  /**
   * Sites carrying enough land to take part in the quota draw.
   *
   * NOT COMPARABLE ACROSS REGION SIZES. The land test samples a rosette of
   * radius 0.45 x spacing, so each variant asks "is there land here" at a
   * different physical scale, and the count moves non-monotonically with
   * spacing as a result. It is the right number for judging quota
   * granularity at one size (§5.4) and the wrong one for a size sweep —
   * use `patches`, which counts contiguous biome regions on the finished
   * map and does fall monotonically.
   */
  landSites: number;
  /** Contiguous same-biome land regions. */
  patches: number;
  meanPatchAreaKm2: number;
  medianPatchAreaKm2: number;
  /** Mean straight-line distance between biome changes, metres. */
  meanCrossingRunM: number;
  /**
   * Mean number of DISTINCT drainage channels crossed per biome run.
   *
   * Counts transitions into a channel, not channel cells. Counting cells is
   * tautological: the channel threshold is the 80th percentile, so ~20% of
   * land cells qualify and the per-run count is just 0.2x the run length
   * whatever the terrain looks like. The first version of this metric
   * reported 6.46 channels for a 32-cell run and would have "confirmed" the
   * prediction from arithmetic alone.
   */
  channelsPerPatch: number;
  /** Mean |achieved land share - target share| across partitioned biomes, in points. */
  mixErrorPoints: number;
  /** Worst single biome's deviation, in points. */
  maxMixErrorPoints: number;
  landKm2: number;
}

export function layoutMetrics(
  atlas: Atlas,
  p: WorldParams,
  targetShare: number[],
  achievedLand: Map<number, number>,
  landSites: number,
): LayoutMetrics {
  const { res, baseHeight, biomeId, flowAccum } = atlas;
  const r2 = p.worldRadius * p.worldRadius;
  const cellKm2 = (atlas.cellSize * atlas.cellSize) / 1e6;

  const isLand = (i: number, wx: number, wy: number): boolean =>
    wx * wx + wy * wy <= r2 && baseHeight[i] > p.seaLevel;

  // --- channel threshold, same definition metrics.ts uses ------------------
  const flows: number[] = [];
  for (let i = 0; i < res * res; i++) {
    if (baseHeight[i] > p.seaLevel && flowAccum[i] > 0) flows.push(flowAccum[i]);
  }
  flows.sort((a, b) => a - b);
  const channelT = flows.length ? flows[Math.floor(flows.length * 0.8)] : Infinity;

  // --- connected components over same-biome land --------------------------
  const label = new Int32Array(res * res).fill(-1);
  const stack = new Int32Array(res * res);
  const areas: number[] = [];
  let landCells = 0;

  for (let iy = 0; iy < res; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 0; ix < res; ix++) {
      const i = iy * res + ix;
      const wx = atlas.worldX(ix);
      if (!isLand(i, wx, wy)) continue;
      landCells++;
      if (label[i] >= 0) continue;

      const id = areas.length;
      const biome = biomeId[i];
      let sp = 0;
      stack[sp++] = i;
      label[i] = id;
      let size = 0;

      while (sp > 0) {
        const c = stack[--sp];
        size++;
        const cx = c % res;
        const cy = (c - cx) / res;
        // 4-connected; 8 would bridge diagonal touches that a walker cannot.
        if (cx > 0) pushIf(c - 1, cx - 1, cy);
        if (cx + 1 < res) pushIf(c + 1, cx + 1, cy);
        if (cy > 0) pushIf(c - res, cx, cy - 1);
        if (cy + 1 < res) pushIf(c + res, cx, cy + 1);
      }
      areas.push(size);

      // eslint-disable-next-line no-inner-declarations
      function pushIf(j: number, jx: number, jy: number): void {
        if (label[j] >= 0) return;
        if (biomeId[j] !== biome) return;
        const wjx = atlas.worldX(jx);
        const wjy = atlas.worldY(jy);
        if (!isLand(j, wjx, wjy)) return;
        label[j] = id;
        stack[sp++] = j;
      }
    }
  }

  // --- straight-line crossing runs, both axes -----------------------------
  let runTotal = 0;
  let runCount = 0;
  let channelTotal = 0;

  const scan = (horizontal: boolean): void => {
    for (let a = 0; a < res; a++) {
      let runLen = 0;
      let runBiome = -1;
      let runChannels = 0;
      let prevChannel = false;
      for (let b = 0; b < res; b++) {
        const ix = horizontal ? b : a;
        const iy = horizontal ? a : b;
        const i = iy * res + ix;
        const wx = atlas.worldX(ix);
        const wy = atlas.worldY(iy);
        const land = isLand(i, wx, wy);
        const bid = land ? biomeId[i] : -1;
        if (bid !== runBiome) {
          if (runBiome >= 0 && runLen > 0) {
            runTotal += runLen * atlas.cellSize;
            channelTotal += runChannels;
            runCount++;
          }
          runBiome = bid;
          runLen = 0;
          runChannels = 0;
          prevChannel = false;
        }
        if (bid >= 0) {
          runLen++;
          const isChannel = flowAccum[i] >= channelT;
          if (isChannel && !prevChannel) runChannels++;
          prevChannel = isChannel;
        } else {
          prevChannel = false;
        }
      }
      if (runBiome >= 0 && runLen > 0) {
        runTotal += runLen * atlas.cellSize;
        channelTotal += runChannels;
        runCount++;
      }
    }
  };
  scan(true);
  scan(false);

  // --- mix error ----------------------------------------------------------
  const partitioned = BIOMES.filter((b) => b.weight > 0);
  let errSum = 0;
  let errMax = 0;
  for (let k = 0; k < partitioned.length; k++) {
    const got = (achievedLand.get(partitioned[k].id) ?? 0) * 100;
    const want = (targetShare[k] ?? 0) * 100;
    const e = Math.abs(got - want);
    errSum += e;
    if (e > errMax) errMax = e;
  }

  areas.sort((a, b) => a - b);
  const meanArea = areas.length
    ? areas.reduce((s, v) => s + v, 0) / areas.length
    : 0;
  const medianArea = areas.length ? areas[Math.floor(areas.length / 2)] : 0;

  return {
    landSites,
    patches: areas.length,
    meanPatchAreaKm2: meanArea * cellKm2,
    medianPatchAreaKm2: medianArea * cellKm2,
    meanCrossingRunM: runCount ? runTotal / runCount : 0,
    channelsPerPatch: runCount ? channelTotal / runCount : 0,
    mixErrorPoints: partitioned.length ? errSum / partitioned.length : 0,
    maxMixErrorPoints: errMax,
    landKm2: landCells * cellKm2,
  };
}
