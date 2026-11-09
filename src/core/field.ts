/**
 * The sampling contract — DESIGN.md §3. Milestone 6, part one.
 *
 * Three entry points, and everything downstream uses only these. This is the
 * interface §3 said to commit to on day one so that caves become a new op
 * rather than a new architecture; M6 is where it starts doing real work.
 *
 * WHAT IS AND IS NOT IMPLEMENTED
 *
 * Stage 12 (density lift) is here: `d = z - height(x, y)`. Stages 13 and 14 —
 * the density-domain ops and cave passes that make `sampleDensity` diverge
 * from `sampleColumn` — are not. So right now the two agree exactly, by
 * construction, everywhere.
 *
 * That matters for how the contract is tested. A test that only checks
 * "column agrees with density" passes trivially today and will keep passing
 * until the moment it stops meaning anything. `columnValid` is therefore
 * declared per biome in the roster (§7) rather than derived from measurement:
 * Karst and Alien are marked false because their *design* puts geometry the
 * column cannot describe, not because the current build does. The inspector's
 * job is to show that divergence when it arrives, and `measureColumnHonesty`
 * below reports it rather than asserting it away.
 */

import { Atlas } from './atlas';
import { biomeById } from './biomes';
import type { WorldParams } from './params';

export interface ColumnSample {
  /** Metres. Surface z where density crosses zero (topmost). */
  height: number;
  biomeId: number;
  materialId: number;
  /** Unit normal, from field central differences — not from mesh triangles. */
  normal: [number, number, number];
  /**
   * False where this biome's design puts geometry a single height cannot
   * describe (§7 columnValid). A caller that ignores this will render Karst
   * as a flat plain and never know it was lied to.
   */
  columnValid: boolean;
}

export interface Field {
  /** Authoritative. < 0 solid, > 0 air; approximately signed distance. */
  sampleDensity(x: number, y: number, z: number): number;
  /** 2.5D fast path. Allowed to be wrong where columnValid is false. */
  sampleColumn(x: number, y: number): ColumnSample;
  /** Batch form — what a mesher or the GPU calls. */
  sampleRegion(
    originX: number, originY: number, size: number, resolution: number,
    out: Float32Array,
  ): void;
}

export const MATERIAL_ROCK = 1;
export const MATERIAL_SOIL = 2;
export const MATERIAL_SAND = 3;
export const MATERIAL_SNOW = 4;

export function createField(atlas: Atlas, p: WorldParams): Field {
  /** Surface height in world metres. Tier B reads the atlas bilinearly. */
  const heightAt = (x: number, y: number): number => atlas.sampleHeight(x, y);

  const sampleDensity = (x: number, y: number, z: number): number => {
    // Stage 12. Stages 13-14 will perturb this; until then it is exact.
    return z - heightAt(x, y);
  };

  const biomeAt = (x: number, y: number): number => {
    const ix = Math.round(atlas.cellX(x));
    const iy = Math.round(atlas.cellY(y));
    const cx = ix < 0 ? 0 : ix >= atlas.res ? atlas.res - 1 : ix;
    const cy = iy < 0 ? 0 : iy >= atlas.res ? atlas.res - 1 : iy;
    return atlas.biomeId[cy * atlas.res + cx];
  };

  const sampleColumn = (x: number, y: number): ColumnSample => {
    const h = heightAt(x, y);
    // Analytic normal: central differences in the FIELD, at a fixed epsilon
    // rather than the atlas cell size, so the normal does not quantise to the
    // mesh. §11 called this the highest-return fix for "looks like triangles".
    const e = Math.max(0.5, atlas.cellSize * 0.5);
    const dzdx = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
    const dzdy = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
    const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
    const b = biomeAt(x, y);
    const def = biomeById(b);
    const slope = Math.hypot(dzdx, dzdy);

    let material = MATERIAL_SOIL;
    if (h < p.seaLevel + 3) material = MATERIAL_SAND;
    else if (slope > 1.2) material = MATERIAL_ROCK;
    else if (def && h > def.elevSpan * 0.8) material = MATERIAL_SNOW;

    return {
      height: h,
      biomeId: b,
      materialId: material,
      normal: [-dzdx * inv, -dzdy * inv, inv],
      columnValid: def?.columnValid ?? true,
    };
  };

  const sampleRegion = (
    originX: number, originY: number, size: number, resolution: number,
    out: Float32Array,
  ): void => {
    const step = size / resolution;
    for (let j = 0; j < resolution; j++) {
      for (let i = 0; i < resolution; i++) {
        out[j * resolution + i] = heightAt(originX + i * step, originY + j * step);
      }
    }
  };

  return { sampleDensity, sampleColumn, sampleRegion };
}

export interface ColumnHonesty {
  samples: number;
  /** Cells where the topmost density crossing differs from sampleColumn. */
  disagreements: number;
  maxDisagreementM: number;
  /** Cells sitting in a biome whose roster entry declares columnValid false. */
  inInvalidBiome: number;
  note: string;
}

/**
 * Measures how often `sampleColumn` disagrees with a ray-march of
 * `sampleDensity`, which is the only honest way to state what the 2.5D fast
 * path currently costs.
 *
 * Expected to report ZERO disagreements until stages 13-14 land — the two are
 * the same function today. Reporting zero is the point: it confirms the ray
 * march and the column agree where they must, so a non-zero result later is
 * real divergence rather than a broken probe.
 */
export function measureColumnHonesty(
  p: WorldParams, field: Field, samples = 4000,
): ColumnHonesty {
  const R = p.worldRadius;
  let disagreements = 0;
  let maxDiff = 0;
  let invalid = 0;
  let taken = 0;

  // Deterministic lattice rather than random sampling, so repeated runs are
  // comparable without threading a seed through.
  const side = Math.ceil(Math.sqrt(samples));
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = -R + ((i + 0.5) / side) * 2 * R;
      const y = -R + ((j + 0.5) / side) * 2 * R;
      if (x * x + y * y > R * R) continue;
      const col = field.sampleColumn(x, y);
      if (col.height <= p.seaLevel) continue;
      taken++;
      if (!col.columnValid) invalid++;

      // March down from above the world to the first solid crossing.
      const top = 700;
      const step = 2;
      let prev = field.sampleDensity(x, y, top);
      let hit = Number.NaN;
      for (let z = top - step; z > p.seaLevel - 300; z -= step) {
        const d = field.sampleDensity(x, y, z);
        if (prev > 0 && d <= 0) {
          // Linear interpolation to the crossing.
          hit = z + step * (d / (d - prev));
          break;
        }
        prev = d;
      }
      if (!Number.isFinite(hit)) continue;
      const diff = Math.abs(hit - col.height);
      if (diff > step) {
        disagreements++;
        if (diff > maxDiff) maxDiff = diff;
      }
    }
  }

  return {
    samples: taken,
    disagreements,
    maxDisagreementM: maxDiff,
    inInvalidBiome: invalid,
    note:
      'Zero disagreements is expected until stages 13-14 add density-domain ' +
      'geometry; it validates the probe, not the contract. inInvalidBiome ' +
      'counts land where the roster already declares the column unreliable.',
  };
}
