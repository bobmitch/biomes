/**
 * Bake orchestrator — DESIGN.md §4 (bake phase) and §10 (introspection).
 *
 * Stages run in a fixed order and each retains a snapshot of baseHeight, so
 * the UI can scrub the pipeline and diff consecutive stages. That retention is
 * the whole point of the pass architecture; fusing stages would be faster and
 * would make the auditioner useless.
 *
 * M1 implements stage 1 only. The remaining eight are declared here as
 * placeholders so the scrubber, the timing table and the dirty-tracking are
 * built against the real shape of the pipeline from the start.
 */

import { Atlas } from './atlas';
import type { WorldParams } from './params';
import { continentalBase, PASS_CONTINENTAL } from './passes/continentalBase';
import { biomePartition, PASS_PARTITION } from './passes/biomePartition';
import { BIOMES, biomeById } from './biomes';
import {
  heightEnvelope, erodibilityMap, PASS_ENVELOPE, PASS_ERODIBILITY,
} from './passes/heightEnvelope';
import { globalErosion, PASS_EROSION } from './passes/erosion';
import { geomorphology } from './metrics';
import type { GeomorphReport } from './metrics';

export interface StageDef {
  id: number;
  name: string;
  /** False until the milestone that implements it lands. */
  implemented: boolean;
  /** Atlas fields this stage writes. Shown in the UI so the scrubber does not
   *  imply it is showing you more than it is — snapshots retain baseHeight
   *  only, so a stage that writes no height looks identical to its
   *  predecessor in the height layers. */
  writes?: readonly string[];
  run?: (atlas: Atlas, p: WorldParams) => void | Promise<void>;
}

export const STAGES: StageDef[] = [
  { id: PASS_CONTINENTAL, name: 'Continental base', implemented: true,
    writes: ['baseHeight'], run: continentalBase },
  { id: PASS_PARTITION, name: 'Biome partition', implemented: true,
    writes: ['biomeId', 'biomeId2', 'boundaryDist'], run: biomePartition },
  { id: PASS_ENVELOPE, name: 'Height envelope', implemented: true,
    writes: ['baseHeight'], run: heightEnvelope },
  { id: PASS_ERODIBILITY, name: 'Erodibility map', implemented: true,
    writes: ['erodibility', 'talus'], run: erodibilityMap },
  { id: PASS_EROSION, name: 'Global erosion', implemented: true,
    writes: ['baseHeight', 'flowAccum'], run: globalErosion },
  { id: 6, name: 'Fake hydrology', implemented: false, writes: ['baseHeight'] },
  { id: 7, name: 'Feature placement', implemented: false, writes: ['featureId'] },
  { id: 8, name: 'Carve stamp', implemented: false, writes: ['baseHeight', 'biomeIdFinal'] },
  { id: 9, name: 'Ocean resolve', implemented: false, writes: ['biomeIdFinal', 'flags'] },
];

/**
 * Every field a stage wrote, as of the end of that stage.
 *
 * Only the declared `writes` are captured — snapshotting all nine fields at
 * every stage would cost ~230 MB at 1024² to preserve copies that are
 * identical to their predecessor. Capturing what a stage touched is both
 * cheaper and more honest: a field absent from a snapshot was not changed by
 * that stage, which is exactly what the scrubber needs to know.
 */
export type StageSnapshot = Partial<{
  baseHeight: Float32Array;
  flowAccum: Float32Array;
  boundaryDist: Float32Array;
  erodibility: Float32Array;
  talus: Float32Array;
  biomeId: Uint16Array;
  biomeId2: Uint16Array;
}>;

export interface StageResult {
  id: number;
  name: string;
  implemented: boolean;
  writes: readonly string[];
  ms: number;
  /** The fields this stage wrote, or null for unimplemented stages. */
  snapshot: StageSnapshot | null;
  /** Convenience alias for snapshot.baseHeight — the height scrubber's field. */
  heightSnapshot: Float32Array | null;
}

export interface BakeStats {
  cellSize: number;
  cellCount: number;
  atlasBytes: number;
  minHeight: number;
  maxHeight: number;
  /** Fraction of in-disc cells above sea level. */
  landFraction: number;
  /** Fraction of in-disc cells within +/- 8 m of sea level. */
  shoreFraction: number;
  /** In-disc area fraction per biome id. */
  biomeArea: Map<number, number>;
  /** Same, but counting land cells only — what the player would actually meet. */
  biomeAreaLand: Map<number, number>;
  /**
   * Seam test (the M3 proof). 99th-percentile land slope in degrees.
   *
   * Split three ways, because the obvious two-way split lies. Badlands,
   * Ashlands and Alien are hardEdge by design (§7), so their borders are
   * SUPPOSED to be cliffs; lumping them in with the rest reported an 86 deg
   * "seam" that was the feature working correctly. Only soft borders — where
   * both sides expect to blend — are evidence about the blend.
   *
   * The test: soft-border p99 close to interior p99 means no seams. Hard
   * borders are reported beside them so the intended cliffs stay visible
   * rather than hidden.
   */
  slopeP99SoftBorder: number;
  slopeP99HardBorder: number;
  slopeP99Interior: number;
  softBorderCells: number;
  hardBorderCells: number;
  /** Mean land elevation per biome id — check against the §7 bands. */
  biomeMeanElev: Map<number, number>;
}

export interface BakeResult {
  atlas: Atlas;
  stages: StageResult[];
  totalMs: number;
  stats: BakeStats;
  /** The §6 instrument. `before` is the stage-4 snapshot, i.e. pre-erosion. */
  geomorph: GeomorphReport;
}

export async function bake(p: WorldParams): Promise<BakeResult> {
  const t0 = performance.now();
  const atlas = new Atlas(p.atlasRes, p.worldRadius);
  const stages: StageResult[] = [];

  for (const stage of STAGES) {
    if (!stage.implemented || !stage.run) {
      stages.push({
        id: stage.id, name: stage.name, implemented: false,
        writes: stage.writes ?? [], ms: 0, snapshot: null, heightSnapshot: null,
      });
      continue;
    }
    const s0 = performance.now();
    await stage.run(atlas, p);
    const ms = performance.now() - s0;
    const snapshot = captureSnapshot(atlas, stage.writes ?? []);
    stages.push({
      id: stage.id,
      name: stage.name,
      implemented: true,
      writes: stage.writes ?? [],
      ms,
      snapshot,
      heightSnapshot: snapshot.baseHeight ?? null,
    });
  }

  // Stage 4 writes no height, so walk back to the most recent stage that did.
  const eroIdx = stages.findIndex((st) => st.id === PASS_EROSION);
  let preErosion: Float32Array | null = null;
  for (let k = eroIdx - 1; k >= 0; k--) {
    if (stages[k].heightSnapshot) { preErosion = stages[k].heightSnapshot; break; }
  }

  return {
    atlas,
    stages,
    totalMs: performance.now() - t0,
    stats: computeStats(atlas, p),
    geomorph: geomorphology(atlas, p, preErosion),
  };
}

function captureSnapshot(atlas: Atlas, writes: readonly string[]): StageSnapshot {
  const out: StageSnapshot = {};
  for (const field of writes) {
    switch (field) {
      case 'baseHeight': out.baseHeight = new Float32Array(atlas.baseHeight); break;
      case 'flowAccum': out.flowAccum = new Float32Array(atlas.flowAccum); break;
      case 'boundaryDist': out.boundaryDist = new Float32Array(atlas.boundaryDist); break;
      case 'erodibility': out.erodibility = new Float32Array(atlas.erodibility); break;
      case 'talus': out.talus = new Float32Array(atlas.talus); break;
      case 'biomeId': out.biomeId = new Uint16Array(atlas.biomeId); break;
      case 'biomeId2': out.biomeId2 = new Uint16Array(atlas.biomeId2); break;
      default: break;
    }
  }
  return out;
}

function computeStats(atlas: Atlas, p: WorldParams): BakeStats {
  const { res, baseHeight, biomeId } = atlas;
  const r2 = p.worldRadius * p.worldRadius;
  let min = Infinity;
  let max = -Infinity;
  let inDisc = 0;
  let land = 0;
  let shore = 0;

  const counts = new Float64Array(BIOMES.length + 16);
  const countsLand = new Float64Array(BIOMES.length + 16);
  const elevSum = new Float64Array(BIOMES.length + 16);

  for (let iy = 0; iy < res; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 0; ix < res; ix++) {
      const wx = atlas.worldX(ix);
      if (wx * wx + wy * wy > r2) continue;
      const i = iy * res + ix;
      const h = baseHeight[i];
      inDisc++;
      if (h < min) min = h;
      if (h > max) max = h;
      const b = biomeId[i];
      if (b < counts.length) counts[b]++;
      if (h > p.seaLevel) {
        land++;
        if (b < countsLand.length) { countsLand[b]++; elevSum[b] += h; }
      }
      if (h > p.seaLevel - 8 && h < p.seaLevel + 8) shore++;
    }
  }

  // Seam test: slope histograms, border cells vs interior cells, land only.
  const BUCKETS = 90;
  const histSoft = new Int32Array(BUCKETS + 1);
  const histHard = new Int32Array(BUCKETS + 1);
  const histInterior = new Int32Array(BUCKETS + 1);
  let softBorderCells = 0;
  let hardBorderCells = 0;
  const isHard = (a: number, b: number): boolean =>
    (biomeById(a)?.hardEdge ?? false) || (biomeById(b)?.hardEdge ?? false);
  const cs2 = atlas.cellSize * 2;

  for (let iy = 1; iy < res - 1; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 1; ix < res - 1; ix++) {
      const wx = atlas.worldX(ix);
      if (wx * wx + wy * wy > r2) continue;
      const i = iy * res + ix;
      if (baseHeight[i] <= p.seaLevel) continue;

      const dzdx = (baseHeight[i + 1] - baseHeight[i - 1]) / cs2;
      const dzdy = (baseHeight[i + res] - baseHeight[i - res]) / cs2;
      const deg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      const bucket = Math.min(BUCKETS, Math.max(0, Math.round(deg)));

      const b = biomeId[i];
      let onBorder = false;
      let hard = false;
      for (const nb of [biomeId[i + 1], biomeId[i - 1], biomeId[i + res], biomeId[i - res]]) {
        if (nb === b) continue;
        onBorder = true;
        if (isHard(b, nb)) hard = true;
      }
      if (!onBorder) histInterior[bucket]++;
      else if (hard) { histHard[bucket]++; hardBorderCells++; }
      else { histSoft[bucket]++; softBorderCells++; }
    }
  }

  const percentile = (hist: Int32Array, q: number): number => {
    let total = 0;
    for (let k = 0; k <= BUCKETS; k++) total += hist[k];
    if (total === 0) return 0;
    const want = total * q;
    let run = 0;
    for (let k = 0; k <= BUCKETS; k++) {
      run += hist[k];
      if (run >= want) return k;
    }
    return BUCKETS;
  };

  const biomeArea = new Map<number, number>();
  const biomeAreaLand = new Map<number, number>();
  const biomeMeanElev = new Map<number, number>();
  for (const def of BIOMES) {
    if (inDisc) biomeArea.set(def.id, counts[def.id] / inDisc);
    if (land) biomeAreaLand.set(def.id, countsLand[def.id] / land);
    biomeMeanElev.set(def.id, countsLand[def.id] > 0 ? elevSum[def.id] / countsLand[def.id] : 0);
  }

  return {
    cellSize: atlas.cellSize,
    cellCount: atlas.cellCount,
    atlasBytes: atlas.bytes,
    minHeight: inDisc ? min : 0,
    maxHeight: inDisc ? max : 0,
    landFraction: inDisc ? land / inDisc : 0,
    shoreFraction: inDisc ? shore / inDisc : 0,
    biomeArea,
    biomeAreaLand,
    biomeMeanElev,
    slopeP99SoftBorder: percentile(histSoft, 0.99),
    slopeP99HardBorder: percentile(histHard, 0.99),
    slopeP99Interior: percentile(histInterior, 0.99),
    softBorderCells,
    hardBorderCells,
  };
}
