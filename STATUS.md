# Status — World Generation & Biome Auditioner

Last updated: 2026-11-09, end of M8.

A standalone tech sandbox for terrain/biome math for a Valheim-scale game
(10 km circular sandbox, island clusters, hard biome zoning). **Not an engine.**
No physics, vegetation or gameplay. See `DESIGN.md` for the full design and every
measurement; this file is the resume point.

---

## Run it

```bash
npm install
npm run dev     # http://localhost:5273
npm run build   # tsc --noEmit && vite build
```

WebGPU is required for stage 5 (erosion). Without it the stage reports why and
leaves terrain untouched rather than silently producing flat ground.

---

## Stack

TypeScript + WebGPU + Vite, no framework. `src/core/` is pure, dependency-free
and deterministic — that is the part a port would read. `src/gpu/` is WGSL,
`src/ui/` a thin shell. Chosen over C++ in §1; the reasoning and the two
WebGPU traps that cost a debugging cycle are recorded there.

---

## Pipeline state (DESIGN.md §4)

| # | Stage | Status |
|---|---|---|
| 1 | Continental base | done |
| 2 | Biome partition | done (warped Worley + land-area quotas) |
| 3 | Height envelope | done |
| 4 | Erodibility + talus map | done |
| 5 | Global erosion | done — WGSL, ~2 s for 140 iterations at 1024² |
| 6 | Fake hydrology | **not started** |
| 7 | Feature placement | not started |
| 8 | Carve stamp | not started |
| 9 | Ocean resolve | not started |

Analytic tier (stages 10-15): `sampleDensity` / `sampleColumn` / `sampleRegion`
exist in `src/core/field.ts` with stage 12's density lift. Stages 13-14
(density-domain ops, caves) are **not** implemented, so density and column are
currently the same function.

---

## Decided — do not re-litigate

| thing | value | where |
|---|---|---|
| Stack | TS + WebGPU | §1 |
| World | 10 km disc, sea level 0, 1 unit = 1 m | §6a |
| Atlas | 1024² default (2048² option), 26 B/cell | §2 |
| Region size | **900 m** | §15.4 |
| Mountains elevSpan | **600** (authored peak; observed p99 ~490) | §7, §17.1 |
| Mountains elevProfile | **1.20** | §17.1 |
| Ashlands elevRankWidth | **0.42** (0.28 tested and rejected) | §17.2 |
| Erosion | global + unconditional, gated by erodibility | §6 |
| talusTan | separate from erodibility | §6.2 |

## Open — user's to set

- `elevSpan` / `elevProfile` for **Ashlands** and **Badlands**.
- Whether to widen the §7 bands.
- **Ashlands site count** — the only untried lever on its elevation variance
  (quota `weight`, or more land sites). See §17.3.
- The M2 size-vs-mix tension if 900 m proves wrong in use (§14.1 priced it).

---

## Load-bearing findings

- **§6.1 — the erosion bet holds.** Erodibility-modulated global erosion
  produces distinct biomes: Spearman rho **0.97** between erodibility and
  erosion response, controlled for relief. The naive per-biome comparison gives
  **−0.73**, the wrong sign, because the roster anti-correlates erodibility with
  relief by design.
- **§6.2 — one scalar cannot carry two rock properties.** Resistance to
  dissolution and angle of repose are independent; `talusTan` is its own field.
- **§16.1 — the "drift" metric was a definition error.** `elevSpan == bandMax`
  for all nine biomes, so comparing a *mean* to that band was unsatisfiable by
  construction. `bandMin/elevSpan > shapeFactor` predicted all eight biomes'
  results exactly. Several earlier conclusions are stamped VOID/WITHDRAWN in
  the doc — read those stamps before trusting any section before §16.
- **§17.3 — Ashlands' variance is a small-sample artifact.** It wins only 2-3
  land sites per world, so no *placement* parameter can fix its mean. Both
  levers tried (radial bias, elevation-rank width) failed for this reason.
- **mean = elevSpan × shapeFactor**, and σ scales with span, so **CV is the
  span-invariant quantity**. Any target written as "mean + kσ" moves when span
  moves.

## Methodology lessons (the expensive ones)

1. **Sweet-spot illusions.** Four so far: 820 m at n=1, 900 m at n=3, §15.6's
   impossibility result, and elevRankWidth 0.28 at n=12. **Use n ≥ 24 for
   anything turning on a variance**; sd estimates carry ~15% relative error even
   at n=24.
2. **Report sd, never max or range.** Max is not comparable across different
   seed counts. p90 at n ≤ 10 *is* max under another name.
3. **Check metrics for tautology.** `channels/run` initially returned 0.2 ×
   run length because the channel threshold was the 80th percentile.
   `landSites` is not comparable across region sizes (the land test samples a
   rosette scaled to the spacing).
4. **Silent GPU failure looks like a plausible number.** A zero readback
   reported 69.546 m of erosion — exactly mean land elevation. Use explicit
   `createBindGroupLayout` (never `layout: 'auto'` for multi-kernel pipelines)
   and wrap setup in `pushErrorScope`.
5. **Don't gate stage N on a condition stage N+1 creates.** Gating the
   partition on elevation starved the low biomes, because stage 3 is what gives
   a biome its elevation.

---

## Harness

All measurement runs from the browser console. ~4.5 s per bake at 1024².

```js
window.sweep.{regionSize, talus, envelope, envelopeBySeeds,
              driftByRegion, sensitivity, radial, variants}
window.audit.{run, brackets}      // §6 bracket tests
window.field.{honesty, sample}    // §3 contract probe
```

Long sweeps exceed a single console call — kick them off storing to a `window.__x`
global and poll, rather than awaiting inline.

Per-biome overrides for sweeps (no roster edits needed): `spanOverride`,
`profileOverride`, `radialMeanOverride`, `radialWidthOverride`,
`elevRankMeanOverride`, `elevRankWidthOverride`, plus `eroErodibilityOverride`
and `hardTalusOverride`.

---

## Next

**Milestone 6, remainder** (§13): the Three.js inspector — click-to-fly from the
map, quadtree LOD, marching cubes for density-domain biomes against grid meshes
for heightfield ones, and a toggle that shows where `sampleColumn` lies.

The contract it consumes is already in place. 31% of sampled land sits in a
biome declaring `columnValid: false` (Karst, Alien) — that is how much of the
world the 2.5D fast path is committed to describing wrongly once stages 13-14
land. The inspector should show that, not paper over it.
