/**
 * Stage 3 — Height envelope, and Stage 4 — Erodibility map. DESIGN.md §4, §5.3.
 *
 * Writes: baseHeight (stage 3), erodibility (stage 4).
 *
 * Both stages consume the same blend weights, so the weight function lives
 * here once and stage 4 recomputes rather than caching. It is four arithmetic
 * ops and no noise; caching it would cost an atlas field to save nothing.
 *
 * THE ENVELOPE
 *
 * Each biome re-profiles the continental base onto its own vertical scale:
 *
 *     u      = normalised base elevation over all land, 0 at sea level
 *     h_b    = elevSpan_b * u ^ elevProfile_b
 *     target = w1 * h_1 + w2 * h_2
 *
 * The curve is anchored at zero, which is the whole trick. The first version
 * used an elevMin..elevMax band, and elevMin behaved as a floor — Mountains
 * starting at 200 m could not reach the sea without a 200 m wall. Fading the
 * envelope in over the first metres of elevation did not fix that; it just
 * relocated the wall inland and made it steeper, since the same 200 m now had
 * less horizontal distance to happen in. Land slope p99 measured 77 degrees.
 *
 * Anchoring at zero means every biome meets the water at the water's height
 * and expresses itself in how fast it rises instead of where it starts. The
 * coast fade below survives only to soften the first few metres; it is no
 * longer load-bearing, and `coastBand` can go to 1 without cliffs returning.
 *
 * Normalising u against the *global* land range rather than per-region makes
 * big landmasses get big mountains and small islands get hills. That falls
 * out for free and is worth keeping.
 */

import { Atlas } from '../atlas';
import { biomeById } from '../biomes';
import { clamp01, lerp, smoothstep } from '../math';
import type { WorldParams } from '../params';

export const PASS_ENVELOPE = 3;
export const PASS_ERODIBILITY = 4;

/**
 * Weight toward biomeId (the nearer biome). The remainder goes to biomeId2.
 * At a border boundaryDist is 0 and this returns 0.5, so the two sides meet
 * at the average of their targets — continuous by construction.
 */
function weightToNearest(
  b1: number, b2: number, boundaryDist: number, p: WorldParams,
): number {
  if (b1 === b2) return 1;
  const d1 = biomeById(b1);
  const d2 = biomeById(b2);
  if (!d1 || !d2) return 1;

  // §5.3: a hard edge on EITHER side makes the pair hard.
  const hard = d1.hardEdge || d2.hardEdge;
  const width = hard
    ? p.hardEdgeBlend
    : Math.min(d1.blendWidth, d2.blendWidth) * p.blendScale;

  if (width <= 0) return 1; // 1-sample cut: the nearer site simply wins
  return 0.5 + 0.5 * smoothstep(0, width, boundaryDist);
}

/** Highest land in the disc — the normaliser for `u`. */
function maxLandHeight(atlas: Atlas, p: WorldParams): number {
  const { res, baseHeight } = atlas;
  const r2 = p.worldRadius * p.worldRadius;
  let max = p.seaLevel;
  for (let iy = 0; iy < res; iy++) {
    const wy = atlas.worldY(iy);
    for (let ix = 0; ix < res; ix++) {
      const wx = atlas.worldX(ix);
      if (wx * wx + wy * wy > r2) continue;
      const h = baseHeight[iy * res + ix];
      if (h > max) max = h;
    }
  }
  return max;
}

export function heightEnvelope(atlas: Atlas, p: WorldParams): void {
  const { res, baseHeight, biomeId, biomeId2, boundaryDist } = atlas;
  const sea = p.seaLevel;
  const maxLand = maxLandHeight(atlas, p);
  const span = Math.max(1, maxLand - sea);
  const strength = clamp01(p.envelopeStrength);
  const coastBand = Math.max(1, p.coastBand);

  // Each cell's new height depends only on its own old height, so rewriting
  // baseHeight in place is safe — no neighbourhood reads anywhere below.
  for (let i = 0; i < res * res; i++) {
    const base = baseHeight[i];
    if (base <= sea) continue; // ocean keeps the continental base untouched

    const b1 = biomeId[i];
    const b2 = biomeId2[i];
    const d1 = biomeById(b1);
    if (!d1) continue;
    const d2 = biomeById(b2) ?? d1;

    const u = clamp01((base - sea) / span);
    const s1 = p.spanOverride[d1.key] ?? d1.elevSpan;
    const s2 = p.spanOverride[d2.key] ?? d2.elevSpan;
    const g1 = p.profileOverride[d1.key] ?? d1.elevProfile;
    const g2 = p.profileOverride[d2.key] ?? d2.elevProfile;
    const h1 = s1 * Math.pow(u, g1);
    const h2 = s2 * Math.pow(u, g2);

    const w1 = weightToNearest(b1, b2, boundaryDist[i], p);
    const target = h1 * w1 + h2 * (1 - w1);

    const coast = smoothstep(0, coastBand, base - sea);
    baseHeight[i] = lerp(base, target, coast * strength);
  }
}

export function erodibilityMap(atlas: Atlas, p: WorldParams): void {
  const { res, biomeId, biomeId2, boundaryDist, erodibility, talus } = atlas;

  for (let i = 0; i < res * res; i++) {
    const b1 = biomeId[i];
    const d1 = biomeById(b1);
    if (!d1) { erodibility[i] = 1; talus[i] = 0.6; continue; }
    const b2 = biomeId2[i];
    const d2 = biomeById(b2) ?? d1;
    const w1 = weightToNearest(b1, b2, boundaryDist[i], p);
    erodibility[i] = d1.erodibility * w1 + d2.erodibility * (1 - w1);
    const t1 = d1.hardEdge && p.hardTalusOverride >= 0 ? p.hardTalusOverride : d1.talusTan;
    const t2 = d2.hardEdge && p.hardTalusOverride >= 0 ? p.hardTalusOverride : d2.talusTan;
    // Blended by the same weights, so a hardEdge pair (blend width 0) keeps a
    // near-vertical talus on the resistant side and a shallow one on the
    // other — which is exactly what a mesa rim is.
    talus[i] = t1 * w1 + t2 * (1 - w1);
  }
}
