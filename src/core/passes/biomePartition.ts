/**
 * Stage 2 — Biome partition. DESIGN.md §5.
 *
 * Writes: biomeId, boundaryDist.
 *
 * Warped Worley. The warp is three single-octave simplex offsets at separate
 * scales rather than one fBm, because the three scales do three different jobs
 * and you want to tune them independently while auditioning:
 *
 *   coarse (~4 km)  breaks the Voronoi silhouette, so regions stop reading as
 *                   polygons with a wobble applied
 *   mid    (~900 m) gives each region organic lobes and inlets
 *   fine   (~200 m) removes the last trace of a straight edge at close zoom
 *
 * Biome assignment is per Worley site, not per sample, so a region is uniform
 * by construction. Sites are drawn weighted by radial position (Meadows inward,
 * Ashlands and Alien outward), then repaired against the forbidden-adjacency
 * table until no illegal border survives.
 *
 * KNOWN IMPRECISION, deliberate: boundaryDist is measured in warped space,
 * so it is off by the local warp Jacobian — roughly +/-30% at the default
 * amplitudes. For §5.3 blending that is tolerable (a 60 m blend band is really
 * 40-80 m), but it does mean blend width is not exactly metres. Correcting it
 * costs 4 extra samples per cell to estimate the Jacobian; deferred until M3
 * shows whether the error is actually visible.
 */

import { Atlas } from '../atlas';
import { BIOME_UNASSIGNED, PARTITIONED, isForbiddenPair } from '../biomes';
import { deriveSeed, hash2, rand01 } from '../hash';
import { simplex2 } from '../noise';
import type { WorldParams } from '../params';
import { buildSiteGrid, queryLabelled, siteNeighbours } from '../worley';
import type { BoundaryHit, SiteGrid } from '../worley';

export const PASS_PARTITION = 2;

/** Strength of the quota pressure at p.biomeQuota = 1. See pass D. */
const QUOTA_GAMMA = 3.2;

/** Site biome assignment, kept beside the grid for the repair sweep. */
export interface BiomeSites {
  grid: SiteGrid;
  biome: Uint16Array;
  /** Stable per-site tiebreak, so repairs are deterministic. */
  priority: Float64Array;
  /** Selection weight per (site, biome), row-major over PARTITIONED. The
   *  repair sweep reuses it so a repaired site obeys the same preferences
   *  the original draw did. */
  weights: Float64Array;
}

function gaussian(v: number, mean: number, width: number): number {
  const d = (v - mean) / width;
  return Math.exp(-d * d);
}

/**
 * What the terrain under a site actually looks like. Nine samples on a small
 * rosette rather than one at the centre, because a single sample sitting in a
 * bay would call an entire mountainous region "coastal".
 */
function siteTerrain(
  atlas: Atlas, p: WorldParams, x: number, y: number, radius: number,
): { meanLandH: number; landFrac: number } {
  let sum = 0;
  let landN = 0;
  const n = 9;
  for (let k = 0; k < n; k++) {
    let sx = x;
    let sy = y;
    if (k > 0) {
      const a = ((k - 1) * Math.PI * 2) / 8;
      sx += Math.cos(a) * radius;
      sy += Math.sin(a) * radius;
    }
    const h = atlas.sampleHeight(sx, sy);
    if (h > p.seaLevel) { sum += h; landN++; }
  }
  return { meanLandH: landN > 0 ? sum / landN : 0, landFrac: landN / n };
}

function assignSites(
  atlas: Atlas, p: WorldParams, grid: SiteGrid, seed: number,
): BiomeSites {
  const n = grid.nx * grid.ny;
  const nb = PARTITIONED.length;
  const biome = new Uint16Array(n);
  const priority = new Float64Array(n);
  const weights = new Float64Array(n * nb);
  const invR = 1 / p.worldRadius;
  const rosette = grid.spacing * 0.45;

  // Pass A: measure the terrain under every site.
  const meanH = new Float64Array(n);
  const landFrac = new Float64Array(n);
  const hasLand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = siteTerrain(atlas, p, grid.px[i], grid.py[i], rosette);
    meanH[i] = t.meanLandH;
    landFrac[i] = t.landFrac;
    // A site that is nearly all water gets no elevation opinion — whatever
    // lands there is masked by stage 9 anyway, and forcing a choice would
    // just waste the land-loving biomes on open sea.
    hasLand[i] = t.landFrac > 0.12 ? 1 : 0;
  }

  // Pass B: turn absolute heights into ranks over the land sites that exist.
  const landHeights: number[] = [];
  for (let i = 0; i < n; i++) if (hasLand[i]) landHeights.push(meanH[i]);
  landHeights.sort((a, b) => a - b);
  const rankOf = (h: number): number => {
    if (landHeights.length < 2) return 0.5;
    let lo = 0;
    let hi = landHeights.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (landHeights[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    return lo / (landHeights.length - 1);
  };

  // Pass C: preference weight per (site, biome).
  for (let i = 0; i < n; i++) {
    const px = grid.px[i];
    const py = grid.py[i];
    const r = Math.sqrt(px * px + py * py) * invR;
    priority[i] = rand01(hash2(seed, i, 0x1d7b));
    const rank = hasLand[i] ? rankOf(meanH[i]) : -1;

    const row = i * nb;
    for (let b = 0; b < nb; b++) {
      const def = PARTITIONED[b];
      const rMean = p.radialMeanOverride[def.key] ?? def.radialMean;
      const rWidth = p.radialWidthOverride[def.key] ?? def.radialWidth;
      let w = def.weight * gaussian(Math.min(r, 1.4), rMean, rWidth);
      if (rank >= 0) {
        w *= gaussian(
          rank,
          p.elevRankMeanOverride[def.key] ?? def.elevRankMean,
          p.elevRankWidthOverride[def.key] ?? def.elevRankWidth,
        );
      }
      weights[row + b] = w;
    }
  }

  /*
   * Pass D: draw against land-area quotas.
   *
   * Independent per-site draws do not work here, and the reason is worth
   * stating. Only ~15% of the 360-odd sites contain meaningful land, so the
   * effective sample size for the mix a player actually walks on is ~50.
   * Multinomial variance at n=50 is brutal: measured across two seeds with
   * identical parameters, Alien went from 4% to 20% of all land and Badlands
   * from 17% to 2%. A world that is one fifth Alien is not a rare interesting
   * seed, it is a broken one.
   *
   * So each biome gets a target share of total *land* area, and sites are
   * drawn in a seeded order with their weights scaled by how far each biome
   * still is from its target. Preference still decides which sites a biome
   * gets — the quota only decides how many. Water-only sites consume no quota,
   * which is what makes the guarantee land-relative rather than map-relative.
   *
   * p.biomeQuota blends between the two regimes so the difference is
   * auditionable: 0 reproduces the old independent draw exactly.
   */
  const targetShare = new Float64Array(nb);
  let weightSum = 0;
  for (let b = 0; b < nb; b++) weightSum += PARTITIONED[b].weight;
  for (let b = 0; b < nb; b++) targetShare[b] = PARTITIONED[b].weight / weightSum;

  let totalLand = 0;
  for (let i = 0; i < n; i++) totalLand += landFrac[i];
  const target = new Float64Array(nb);
  for (let b = 0; b < nb; b++) target[b] = Math.max(1e-6, targetShare[b] * totalLand);

  // Deterministic visit order — without a shuffle, quotas fill in raster order
  // and the last biomes to be satisfied all end up on one edge of the map.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) key[i] = rand01(hash2(seed, i, 0x2c9f));
  const orderArr = Array.from(order).sort((a, b) => key[a] - key[b]);

  const acc = new Float64Array(nb);
  const quota = Math.max(0, Math.min(1, p.biomeQuota));
  const scored = new Float64Array(nb);

  // Land sites first, water sites afterwards with no quota pressure at all.
  // This split is load-bearing, not tidiness. Quota pressure boosts a starved
  // biome's weight everywhere, including on sites that are nearly all ocean —
  // and those consume no quota, so the deficit never closes. The biome just
  // wins more and more worthless open water while its land share stays flat.
  // Meadows is centre-biased, so on a seed whose centre is sea it did exactly
  // this: boosted to the cap, covering ocean, still 6% of land against a 22%
  // target. Only land-bearing sites get to argue about quota.
  const landFirst = orderArr.filter((i) => hasLand[i]).concat(orderArr.filter((i) => !hasLand[i]));

  for (const i of landFirst) {
    const row = i * nb;
    const participates = hasLand[i] === 1;
    let total = 0;
    for (let b = 0; b < nb; b++) {
      // Exponential pressure, not linear. Preference weights are gaussian, so
      // their ratios span orders of magnitude; a factor bounded at 1 simply
      // cannot lift a biome whose preference is in the tail, and the quota
      // gets ignored. exp(gamma*d) gives a starved biome a ~20x boost and an
      // overfilled one a ~0.05x cut, which is the same scale as the thing it
      // is arguing with.
      let s = weights[row + b];
      if (participates) {
        const d = Math.max(-1, Math.min(1, 1 - acc[b] / target[b]));
        s *= Math.exp(QUOTA_GAMMA * quota * d);
      }
      scored[b] = s;
      total += s;
    }

    let chosen = PARTITIONED[0].id;
    let chosenIdx = 0;
    if (total > 0) {
      let pick = rand01(hash2(seed, i, 0x5f3a)) * total;
      for (let b = 0; b < nb; b++) {
        pick -= scored[b];
        if (pick <= 0) { chosen = PARTITIONED[b].id; chosenIdx = b; break; }
      }
    }
    biome[i] = chosen;
    acc[chosenIdx] += landFrac[i];
  }

  // Won-rank distribution, land sites only (rank is undefined without land).
  {
    const byBiome = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (!hasLand[i]) continue;
      const list = byBiome.get(biome[i]) ?? [];
      list.push(rankOf(meanH[i]));
      byBiome.set(biome[i], list);
    }
    const stats: Record<string, { mean: number; sd: number; n: number }> = {};
    for (const def of PARTITIONED) {
      const v = byBiome.get(def.id) ?? [];
      if (v.length === 0) { stats[def.key] = { mean: 0, sd: 0, n: 0 }; continue; }
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = v.length > 1
        ? Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1))
        : 0;
      stats[def.key] = { mean: m, sd, n: v.length };
    }
    partitionStats.wonRank = stats;
  }

  partitionStats.targetShare = Array.from(targetShare);
  partitionStats.achievedShare = Array.from(acc, (v) => (totalLand > 0 ? v / totalLand : 0));
  partitionStats.landSites = landFirst.filter((i) => hasLand[i]).length;
  return { grid, biome, priority, weights };
}

/**
 * Repair forbidden adjacencies. Each sweep finds illegal borders and re-rolls
 * the lower-priority side to the heaviest biome that is legal against all of
 * its current neighbours.
 *
 * Replacing a site can create a new illegal pair elsewhere, so this is not
 * provably monotonic — the sweep cap is what guarantees termination, and
 * `partitionStats.unresolved` reports any pairs still illegal when it stops.
 * In practice the forbid table is sparse enough that it converges in two or
 * three sweeps; if that number is ever non-zero, the table is too strict.
 */
function repairAdjacency(sites: BiomeSites, maxSweeps = 8): void {
  const { grid, biome, priority, weights } = sites;
  const nb = PARTITIONED.length;
  const n = grid.nx * grid.ny;
  // Two buffers: the outer loop is mid-iteration over its own neighbour list
  // while the inner lookup needs the loser's, and sharing one corrupts both.
  const nbrI: number[] = [0, 0, 0, 0];
  const nbrL: number[] = [0, 0, 0, 0];
  let repairs = 0;
  let sweeps = 0;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    sweeps = sweep + 1;
    let changed = false;

    for (let i = 0; i < n; i++) {
      const count = siteNeighbours(grid, i, nbrI);
      for (let k = 0; k < count; k++) {
        const j = nbrI[k];
        if (!isForbiddenPair(biome[i], biome[j])) continue;

        const loser = priority[i] <= priority[j] ? i : j;
        const lcount = siteNeighbours(grid, loser, nbrL);
        const lrow = loser * nb;

        // Pick the replacement by the same preference weights the original
        // draw used, so a repaired site still respects terrain and radius
        // rather than defaulting to whatever is merely legal.
        let best = 0;
        let bestWeight = -1;
        for (let b = 0; b < nb; b++) {
          const def = PARTITIONED[b];
          if (def.id === biome[loser]) continue;
          let legal = true;
          for (let m = 0; m < lcount; m++) {
            if (isForbiddenPair(def.id, biome[nbrL[m]])) { legal = false; break; }
          }
          if (!legal) continue;
          const w = weights[lrow + b];
          if (w > bestWeight) { bestWeight = w; best = def.id; }
        }

        if (best !== 0) {
          biome[loser] = best;
          changed = true;
          repairs++;
        }
      }
    }

    if (!changed) break;
  }

  // Audit the result rather than assuming the loop did its job.
  let unresolved = 0;
  for (let i = 0; i < n; i++) {
    const count = siteNeighbours(grid, i, nbrI);
    for (let k = 0; k < count; k++) {
      if (nbrI[k] > i && isForbiddenPair(biome[i], biome[nbrI[k]])) unresolved++;
    }
  }

  partitionStats.repairs = repairs;
  partitionStats.sweeps = sweeps;
  partitionStats.unresolved = unresolved;
}

/** Mutable, read by the stats panel after a bake. */
export const partitionStats = {
  sites: 0,
  repairs: 0,
  sweeps: 0,
  unresolved: 0,
  /** Intended land-area share per PARTITIONED index, for legend comparison. */
  targetShare: [] as number[],
  /** What the quota draw actually achieved, in its own site-area units. If
   *  this matches targetShare but the measured map area does not, the quota
   *  is working and its area proxy is wrong. */
  achievedShare: [] as number[],
  /** Sites carrying enough land to participate in quotas. */
  landSites: 0,
  /**
   * Elevation-rank distribution of the LAND sites each biome actually won,
   * keyed by biome key. Tests whether a narrow elevRank preference really
   * concentrates a biome on the ground it asked for, or whether the quota
   * ends up placing it anywhere: a concentrated biome shows a high mean rank
   * with a small sd, a quota-scattered one drifts toward the middle with a
   * large sd. Without this the non-monotonic §16.3 curve has only a guess
   * behind it.
   */
  wonRank: {} as Record<string, { mean: number; sd: number; n: number }>,
};

export function biomePartition(atlas: Atlas, p: WorldParams): void {
  const sSite = deriveSeed(p.seed, PASS_PARTITION, 1);
  const sPick = deriveSeed(p.seed, PASS_PARTITION, 2);
  const sW1x = deriveSeed(p.seed, PASS_PARTITION, 3);
  const sW1y = deriveSeed(p.seed, PASS_PARTITION, 4);
  const sW2x = deriveSeed(p.seed, PASS_PARTITION, 5);
  const sW2y = deriveSeed(p.seed, PASS_PARTITION, 6);
  const sW3x = deriveSeed(p.seed, PASS_PARTITION, 7);
  const sW3y = deriveSeed(p.seed, PASS_PARTITION, 8);

  const extent = p.worldRadius + p.warpA1 + p.warpA2 + p.warpA3 + p.biomeCellSpacing * 3;
  const grid = buildSiteGrid(sSite, p.biomeCellSpacing, p.biomeJitter, extent);
  const sites = assignSites(atlas, p, grid, sPick);
  repairAdjacency(sites);
  partitionStats.sites = grid.nx * grid.ny;

  const { res, biomeId, biomeId2, boundaryDist } = atlas;
  const hit: BoundaryHit = { f1: 0, cell: -1, fOther: Infinity, cellOther: -1 };
  // Cap the reported distance so "deep interior" is a finite number the
  // blend and the display layer can both handle without special-casing.
  const interiorCap = p.biomeCellSpacing * 1.5;

  const a1 = p.warpA1, f1 = p.warpF1;
  const a2 = p.warpA2, f2 = p.warpF2;
  const a3 = p.warpA3, f3 = p.warpF3;

  for (let iy = 0; iy < res; iy++) {
    const wy = atlas.worldY(iy);
    const row = iy * res;

    for (let ix = 0; ix < res; ix++) {
      const wx = atlas.worldX(ix);

      const x =
        wx +
        a1 * simplex2(sW1x, wx * f1, wy * f1) +
        a2 * simplex2(sW2x, wx * f2, wy * f2) +
        a3 * simplex2(sW3x, wx * f3, wy * f3);
      const y =
        wy +
        a1 * simplex2(sW1y, wx * f1, wy * f1) +
        a2 * simplex2(sW2y, wx * f2, wy * f2) +
        a3 * simplex2(sW3y, wx * f3, wy * f3);

      queryLabelled(grid, x, y, sites.biome, hit);

      const i = row + ix;
      const mine = hit.cell >= 0 ? sites.biome[hit.cell] : BIOME_UNASSIGNED;
      biomeId[i] = mine;
      biomeId2[i] = hit.cellOther >= 0 ? sites.biome[hit.cellOther] : mine;
      // (fOther - f1) / 2 approximates distance to the nearest edge with a
      // DIFFERENT biome across it. See the Jacobian caveat in this header.
      boundaryDist[i] =
        hit.cellOther >= 0 ? Math.min((hit.fOther - hit.f1) * 0.5, interiorCap) : interiorCap;
    }
  }
}
