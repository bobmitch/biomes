# World Generation & Biome Auditioner — Technical Design

Status: **draft v1**, derived from DESIGN-QA.md answers.
Scope: tech sandbox for terrain/biome math. No physics, vegetation, or gameplay.

---

## 0. Decisions locked

| # | Decision | Source |
|---|---|---|
| Sampling contract | 3D density evaluator public API, 2.5D authoring internally | **defaulted** (1a unanswered) |
| Caves | Both carved (SDF) and grown (3D noise), dispatched per biome | 1b |
| Locality | Global atlas allowed; bounded world exploited | **defaulted** (2a) + 2c |
| Rivers | Fake hydrology (flow hints, not simulation) | 2b |
| Generation technique | **Varies per biome** — see §6, this is the big one | 2b |
| Height continuity | Blended by default; hard steps only where a biome opts in | 3a |
| Material cut | 1-sample sharp, always | 3b |
| Ocean | Derived from depth below sea level, not a partition cell | 3c |
| Boundary warping | Yes, multi-octave | 3d |
| Carving rewrites biome | Yes, via explicit per-pass flag | 4a |
| Pass introspection | Full — retained intermediates, toggleable layers | 4d |
| Overlap resolution | SDF min/max + priority tiebreak | **decided** (4c unsure) |
| Feature placement | Seeded jittered grid now; curated placement deferred | 4b |
| Units | 1 unit = 1 m, sea level 0, range −200 to +600 | 6a |
| Responsiveness | Two-tier: instant coarse preview, explicit bake | 6b |
| Views | Top-down map primary, 3D inspector secondary | 6c |
| Stack | **TypeScript + WebGPU** — see §1 | 5a/5b, decided |

Two answers were blank (1a, 2a). I've taken my defaults. Both are the conservative
direction — they buy capability rather than spend it — but flag if you disagree.

---

## 1. Stack: TypeScript + WebGPU

> **M4 update.** The WGSL compute move landed. Erosion runs 140 iterations over 1024²
> in ~1.9 s of GPU time across 7 kernels; the equivalent CPU loop was never attempted
> because M1 measured 3.3 s for a *single* pass at 2048². Two bugs in this stage were
> invisible without instrumentation and are worth carrying forward as habits:
>
> - **`layout: 'auto'` is a trap for multi-kernel pipelines.** Each pipeline's generated
>   layout contains only the bindings that shader references, so binding the full set
>   against a kernel that uses three of eight is a validation error. WebGPU reports it
>   asynchronously and discards the command buffer, so the readback returned a
>   zero-filled staging buffer and the stage silently produced flat terrain. Use explicit
>   `createBindGroupLayout`, and wrap setup in `pushErrorScope('validation')` — the
>   second bug (a WGSL reserved keyword, `move`) only became visible once that scope
>   existed.
> - **Silent GPU failure looks like a plausible number.** The zero readback reported
>   69.546 m of mean erosion, which is not obviously wrong until you notice it equals
>   mean land elevation exactly, and is identical for 1 iteration and 140. The bracket
>   test caught it; nothing else would have.

You leaned C++ and left the call to me. I'm saying **browser/TypeScript with WGSL compute
shaders**, and here's the honest reasoning rather than a preference:

**Why it wins for this specific project**
- You said 100% disposable, and that the goal is "biome and visual viability, not engine
  implementation." Visual viability is an *iteration count* problem. C++ costs roughly a
  week of scaffolding (window, GL context, imgui, build system, hot-reload) before the
  first biome appears on screen.
- The heavy math lives in **WGSL compute shaders**. WGSL to HLSL is a near-mechanical port —
  same execution model, same threadgroup semantics, same numeric behaviour. The part that
  transfers is the part that's portable anyway.
- The auditioner is fundamentally a **slider-and-map UI**. The browser is simply better at
  that than imgui, and you'll build ten times more introspection because it's cheap.
- WebGPU timestamp queries give real GPU timings. For a field evaluator, those numbers are
  meaningful across stacks.

**The honest caveat**
TypeScript's CPU-side performance is roughly 3–10x off C++. That matters for the global
bake (erosion iterations), and not much else — the bake is explicitly allowed to take
seconds. If the global passes end up too slow in TS, they move to WGSL compute too, which
is where they'd want to be in a real engine regardless.

**When I'd be wrong:** if you decide you want to evaluate chunk meshing throughput, memory
layout, or streaming budgets. Those are engine questions, you've put them out of scope,
and they're the only things C++ would genuinely answer better.

**Shape:** `core/` (pure, dependency-free, deterministic — the part an AI agent or future
port actually reads) + `gpu/` (WGSL) + `ui/` (thin shell, Three.js for the 3D inspector,
canvas2d for the map). Vite. No framework beyond that.

---

## 2. Core architecture — two-tier field model

Everything follows from exploiting the bounded world.

### Tier A — the Atlas (global, baked, coarse)

A single flat array covering the 10 km disc. **2048² cells at ~4.9 m/cell.** Holds
everything that requires global knowledge or expensive iteration.

```
AtlasCell  (26 bytes, SoA not AoS)
  f32  baseHeight      // continental base, post-erosion
  f32  flowAccum       // drainage hint for fake rivers
  f32  boundaryDist    // metres to nearest foreign biome
  f32  erodibility     // per-biome material resistance (see §6)
  u16  biomeId         // partition result (pre-carve)
  u16  biomeId2        // nearest foreign biome — what this cell blends toward (§5.2)
  u16  biomeIdFinal    // post-carve, post-ocean override
  u16  featureId       // nearest carve feature, 0 = none
  u16  flags           // hardEdge, isOcean, isShore, ...
```

104 MB at 2048² (26 MB at 1024²), measured. The first draft of this doc said 134 MB from
a miscounted 32 bytes/cell; M1 measured 24, and M3 added `biomeId2` for 26.
Rebuilt on bake, cached per seed.

### Tier B — the Analytic field (local, on-demand, unbounded resolution)

Pure functions. No storage. Reads the Atlas via bilinear sample, adds high-frequency
detail, applies SDF carving. Evaluable at **any** resolution — this is what makes
tessellation (§11) possible later.

**The split rule:** if it needs to know about distant terrain, it's Atlas. If it's local
detail or a placed feature, it's Analytic. Erosion, drainage, island layout, biome
partition go in the Atlas. Surface roughness, caves, arches, overhangs are Analytic.

---

## 3. The sampling contract

Three entry points. Everything downstream uses only these.

```ts
// Primary — 3D, this is the one that survives into a voxel engine
sampleDensity(x: number, y: number, z: number): number
  // < 0 = solid, > 0 = air. Approximately signed distance near the surface.
  // Initially  z - columnHeight(x,y)  then perturbed by density-domain ops.

// Convenience — 2.5D fast path for the map view and anything surface-only
sampleColumn(x: number, y: number): {
  height: number          // metres, surface z where density crosses 0 (topmost)
  biomeId: number
  materialId: number
  normal: Vec3            // analytic where possible, not mesh-derived
}

// Batch — what the GPU actually calls, one invocation per cell
sampleRegion(originX, originY, size, resolution, outBuffers): void
```

`sampleDensity` is authoritative. `sampleColumn` is an optimisation that is *allowed to be
wrong* in density-domain biomes (floating islands, deep karst) and must declare so via a
per-biome `columnValid` flag. That honesty is better than a lie that looks fine until the
alien biome ships.

---

## 4. Resolution order

Fixed pipeline. Every stage retains its output for introspection (§10).

**Bake phase — Atlas, runs on seed change or global param change**

| # | Pass | Writes | Notes |
|---|---|---|---|
| 1 | **Continental base** | `baseHeight` | Island-cluster layout. Low-octave fBm times radial disc mask times cluster Worley. |
| 2 | **Biome partition** | `biomeId`, `boundaryDist` | Warped Worley (§5). `boundaryDist` from F2 minus F1. |
| 3 | **Height envelope** | `baseHeight` | Per-biome target mean + variance, blended by `boundaryDist` (§5.3). |
| 4 | **Erodibility map** | `erodibility` | From biome table, blended same as height. |
| 5 | **Global erosion** | `baseHeight`, `flowAccum` | Hydraulic + thermal, **modulated by `erodibility`** (§6). The expensive one. |
| 6 | **Fake hydrology** | `baseHeight` | River troughs along high-`flowAccum` paths. Carve, don't simulate. |
| 7 | **Feature placement** | `featureId` | Seeded jittered grid, per-biome density. Canyons, anomalies, sinkholes. |
| 8 | **Carve stamp (coarse)** | `baseHeight`, `biomeIdFinal` | Large features that affect the macro silhouette. May rewrite biome. |
| 9 | **Ocean resolve** | `biomeIdFinal`, `flags` | Depth-derived: `height < seaLevel - 10` becomes Ocean. Shore band flagged. |

**Sample phase — Analytic, runs per query**

| # | Pass | Domain | Notes |
|---|---|---|---|
| 10 | Atlas fetch | — | Bilinear `baseHeight`, nearest `biomeId`. |
| 11 | Per-biome detail | height | Biome-dispatched technique (§6). Blended across boundaries. |
| 12 | Density lift | to density | `d = z - height`. Everything after is 3D. |
| 13 | Density-domain ops | density | Overhangs, arches, land bridges, floating islands (§8). |
| 14 | Cave/tunnel pass | density | Grown (3D worm noise) and/or carved (SDF), per biome. |
| 15 | Material resolve | — | `materialId` from biome + slope + altitude + carve-exposure. |

**Biome has three write points** — partition (2), carve (8), ocean (9). After stage 9,
`biomeIdFinal` is immutable. Anything reading biome downstream reads `biomeIdFinal`.

---

## 5. Biome system

### 5.1 Partition

Worley F1 cell ID over a jittered grid, **domain-warped at three scales** before lookup:

```
warp(p) = p + A1*fbm(p*f1) + A2*fbm(p*f2) + A3*fbm(p*f3)

  A1 ~ 300m,  f1 ~ 1/4000     coarse — breaks the Voronoi silhouette
  A2 ~  80m,  f2 ~ 1/900      mid    — organic lobes
  A3 ~  20m,  f3 ~ 1/200      fine   — removes the last trace of a straight edge
```

This directly addresses your Valheim complaint — their borders are unwarped and read as a
texture atlas rather than a world.

Cell to biome assignment is a weighted draw from the biome table, conditioned on distance
from world centre (so Ashlands and Alien skew outward, Meadows skew inward) and on
neighbour cells (adjacency rules prevent Meadows directly bordering Ashlands).

### 5.2 Boundary distance *(revised in M3)*

Originally `(F2 - F1) * 0.5` from the same Worley evaluation — free, and a good
approximation of metres-to-border.

**That is the distance to the nearest *site* edge, which is not the same thing as the
distance to the nearest *biome* edge.** They coincide only when adjacent sites happen to
disagree, and the quota draw (§5.4) makes neighbouring sites share a biome often. A cell
deep inside a merged region reported a boundary distance near zero and blended against
itself.

The query is now *labelled*: nearest site, plus nearest site carrying a different biome.
`boundaryDist = (fOther - f1) * 0.5`, and the atlas also stores `biomeId2`, the biome
being blended toward. Without that second id there is nothing to blend *with* — knowing
you are 30 m from a border does not tell you what is on the other side of it. Cost is one
extra `u16` per cell and a second scan over 25 cached distances.

### 5.3 Blending

Per **biome pair**, not per biome. Table of blend widths:

```
blendWidth(a, b) = hardEdge(a) || hardEdge(b)  ?  0  :  pairWidth[a][b]   // 20-200 m
t = smoothstep(0, blendWidth, boundaryDist)
```

- **Height, erodibility, detail-technique weights** are blended over `blendWidth`.
- **materialId** is 1-sample sharp at `boundaryDist = 0`, always. Never blended.

Your 3a answer in practice: blending is the default everywhere, and `hardEdge` is an
opt-in per-biome flag for the cases where a cliff *is* the trait (mesa rim, volcanic
caldera wall, alien anomaly perimeter).

### 5.4 Quotas — amends §5.1 (added after M2)

§5.1 said cell-to-biome assignment is "a weighted draw from the biome table". Built that
way, it does not work, and the reason generalises.

**The measurement.** Only land-bearing Worley sites contribute to the mix a player
actually experiences, and land is ~19% of the disc. At 1150 m regions that was **22 land
sites for 8 biomes** — under 3 regions each. Two seeds, identical parameters:

| | seed A | seed B | intended |
|---|---|---|---|
| Alien | 4.1% | **19.8%** | 4.9% |
| Badlands | 17.2% | 2.0% | 11.5% |
| Meadows | 4.0% | 14.2% | 21.7% |

A world that is one fifth Alien is not a rare interesting seed, it is a broken one.

**The fix.** Each biome gets a target share of total *land* area; sites are drawn in a
seeded order with weights scaled by `exp(gamma * deficit)`. Preference still chooses
*which* sites a biome gets; the quota only decides *how many*. After: Alien 3.7–5.9%
across seeds, every biome present, nothing starved.

Three things had to be right, and each was wrong first:

- **Quota pressure must be exponential, not bounded.** Preference weights are gaussian,
  so their ratios span orders of magnitude. A factor capped at 1 cannot lift a biome
  whose preference is in the tail, and the quota is silently ignored.
- **Only land-bearing sites may participate.** Pressure boosts a starved biome
  *everywhere*, including on all-ocean sites — which consume no quota, so the deficit
  never closes and the biome just accumulates worthless open water. Meadows did exactly
  this: pinned at the cap, covering sea, still 6% of land against a 22% target.
- **Elevation preference must be rank-based and weak.** Expressed in absolute metres it
  silently breaks whenever stage 1 is retuned — islands are domes, so almost no land sits
  near 0 m, and a Fen asking for "8 m" asks for terrain that does not exist. Worse, it is
  the wrong stage to ask: **stage 3 is what gives a biome its elevation**, so gating
  stage 2 on elevation makes stage 2 demand a condition stage 3 exists to create. It
  should only be a nudge, so Mountains prefer ground that is already high.

**The tension this exposes, which is yours to resolve.** Mix control and biome size pull
against each other, and the knob between them is land-site count:

| region size | land sites | mix | looks like |
|---|---|---|---|
| 1150 m | 22 (2.8/biome) | a lottery | big, characterful regions |
| 820 m *(current default)* | 37 (4.6/biome) | close to target | 2–4 biomes per island |
| 620 m | 70 (8.8/biome) | tracks target well | a quilt |

The underlying cause is that 19% land in a 10 km disc is ~15 km², which is not much room
for 8 biomes at Valheim scale. Three ways out: **raise the land fraction** (stage 1
sliders, available now), **cut the roster** to 5–6 biomes per world, or **accept smaller
biomes**. The auditioner exists to answer exactly this, so it is left as a slider rather
than decided here. Watch "land sites" in the Bake panel, not region size.

### 5.5 The height envelope must be anchored at zero (added after M3)

§4 stage 3 says "per-biome target mean + variance", and §7 lists an elevation band per
biome. Implemented literally — `h = elevMin + (elevMax - elevMin) * u` — it puts a cliff
at every shoreline. Mountains has `elevMin: 200`, so where its terrain meets the sea the
coast is a 200 m wall.

Fading the envelope in over the first metres of elevation does **not** fix this, which is
the part worth remembering. It relocates the wall inland and makes it *steeper*, because
the same 200 m now has less horizontal distance to happen in. Measured land slope p99 was
77 degrees with the fade already in place.

The envelope is now anchored at zero:

```
h_b = elevSpan_b * u ^ elevProfile_b          u = normalised base elevation, 0 at sea
```

A biome's character lives in **how fast it rises**, not in where it starts. Every biome
meets the water at the water's height. `elevProfile > 1` keeps a biome low and lifts it
late (Fen at 1.8 is nearly flat); near 1 is linear. The §7 bands now describe the
resulting *mean*, which the legend reports per biome so the two can be compared directly.

Interior slope p99 dropped 77 deg to 66 deg. The coast fade survives but is no longer
load-bearing — `coastBand` can go to 1 without cliffs returning.

### 5.6 Measuring seams (added after M3)

M3's job was "proves no seams", and a hillshade cannot prove it: a seam and a steep
mountainside look identical. The bake therefore reports 99th-percentile land slope split
**three** ways, not two.

The two-way split — border vs interior — lies. Badlands, Ashlands and Alien are
`hardEdge` by design (§7), so their borders are *supposed* to be cliffs. Counting them
reported an 86 deg "seam" that was the feature working correctly. Only borders where both
sides expect to blend are evidence about blending.

| measure | value | meaning |
|---|---|---|
| interior p99 | 66 deg | ordinary terrain |
| **soft border p99** | **55 deg** | **the seam test — below interior, so no seams** |
| hard border p99 | 87 deg | intended cliffs, isolated rather than hidden |

Soft borders coming out *less* steep than interiors is the expected result: blending
averages two envelopes, which smooths. Setting `hardEdgeBlend` to 100 m drops the hard
figure to 74 deg, confirming the same code path drives both.

**Known imprecision:** quota accounting uses a 9-sample rosette as a per-site land-area
proxy. Biomes that land on coastal sites (less true area than the proxy suggests) still
under-deliver slightly — visible as Meadows running ~4 points under target and
Blackforest over. Stage 3 changes the elevation ranks this depends on, so retune after
M3 rather than now.

**Also known:** `boundaryDist` is measured in warped space and is therefore off by the
local warp Jacobian, roughly ±30% at default amplitudes. A 60 m blend band is really
40–80 m. Correcting it costs 4 samples per cell; deferred until M3 shows whether it is
visible.

---

## 6. Per-biome generation technique — the erodibility insight

This is your Q2b idea, and it's the sharpest thing in your answers. It also doesn't work
the obvious way, so here's the resolution.

**The problem.** You can't region-restrict hydraulic erosion. It's a global iterative
process over a connected grid — water entering a "non-eroded" biome from an eroded one has
to go somewhere, and masking the pass produces visible seams and broken drainage. Likewise
midpoint displacement has its own grid alignment and won't tile against an eroded surface.

**The resolution.** Erosion stays **global and unconditional**. What varies per biome is
**material resistance**, fed in as the `erodibility` field:

```
erosionDelta *= erodibility(biome)
```

- Meadows / Blackforest — `erodibility ~ 1.0` — fully rounded, mature drainage, soft valleys
- Mountains — `~ 0.6` — eroded but retains ridgelines and arêtes
- Badlands — `~ 0.25` — resists rounding, keeps sharp mesa rims and stratification
- Ashlands — `~ 0.1` — reads as geologically fresh, barely weathered
- Alien — `~ 0.0` — completely untouched by natural process, which is exactly the point

This gives you everything the "blend the techniques" idea wanted — meadows that look
genuinely water-carved next to badlands that look like nothing ever rained there — with a
field that blends smoothly at boundaries and never produces a seam. It's also how World
Machine and Gaea do it, which is reassuring.

**Technique dispatch still exists, just later.** Stage 11 (per-biome detail, Analytic) *is*
genuinely biome-dispatched and blends by weight:

```
height = atlasBase + sum over b of  w_b * detailOp_b(x, y)     // w from §5.3, sum w = 1
```

- Meadows — low-amplitude fBm, gentle
- Mountains — ridged multifractal
- Badlands — **height quantisation** (stratification), hard terracing
- Karst — low fBm + sinkhole SDF field
- Ashlands — cone primitives + lava channel troughs
- Alien — non-fBm: Chebyshev/Manhattan Worley, crystalline, deliberately wrong

Blending *detail* operators is safe — they're local, amplitude-bounded, and share a base.
Blending *base-generation* algorithms is not. The split falls exactly on that line.

**Arches are generation, not post-process** — as you suspected. They live in stage 13,
density domain, placed from the atlas. See §8.

### 6.1 The bet, tested (M4)

**Confirmed.** But the obvious test is invalid, and that is worth recording.

**The naive test does not work.** Comparing per-biome erosion across the roster gives
Spearman rho of **-0.73** — the *wrong sign*, suggesting resistant biomes erode more.
They do, but not because of erodibility: §7 gives the low-erodibility biomes high
`elevSpan` (Mountains 600, Alien 520, Ashlands 450) and the high-erodibility ones low
(Meadows 40, Fen 15). Erodibility and relief are anti-correlated **by design**, and steep
terrain erodes more regardless. The measurement reads the envelope, not the gate.

**The controlled test.** Bake twice from the same seed. Stages 1-4 are untouched by the
erodibility override, so relief, biome layout and envelopes are *identical*; only the
erodibility field differs. The ratio of per-biome erosion between the two runs isolates
what erodibility alone contributes:

| biome | erodibility | real / uniform |
|---|---|---|
| Fen | 1.0 | 1.43 |
| Meadows | 1.0 | 1.36 |
| Blackforest | 0.85 | 1.33 |
| Karst | 0.5 | 1.03 |
| Mountains | 0.6 | 1.01 |
| Badlands | 0.25 | 0.88 |
| Ashlands | 0.1 | 0.69 |
| Alien | 0.0 | 0.39 |

**Spearman rho = 0.97**, monotonic, 3.7x spread end to end. Karst and Mountains sit at
~1.0 because the uniform field was 0.5, which is where they already are — the test
predicts that, and it holds.

**Bracket validation.** Erodibility forced to 0 gives net height change of exactly
**0.000 m**: dissolution is fully gated. It still shows 0.93 m of movement, which is
thermal relaxation at the resistant talus angle and is correct — hard rock still has a
maximum stable slope. Forced to 1 gives 4.78 m. Interior slope p99 runs 70 deg at
erodibility 0 against 61 deg at 1.

### 6.2 Erodibility cannot carry two properties (M4)

Your hardEdge prediction — that the three `hardEdge` biomes, being also the three least
erodible, would keep their rims — **failed as originally built**, and the failure was
structural rather than a tuning miss.

Hard-border slope p99 fell from 87 deg to 74 deg, and a uniform-erodibility run scored 71
— so the real field bought almost nothing. Cause: thermal relaxation caps slope at
`atan(talus)`, and talus was derived as `mix(talusHard, talusSoft, erodibility)`. At
Badlands' 0.25 that is 64 deg, so an 87 deg mesa rim was relaxed away however resistant
the rock was. Sweeping the global `talusHard` recovered the contrast (+7 deg to +20 deg
as the angle went 69 deg to 88 deg) but cut total erosion from 1.99 m to 0.56 m, because
the same constant also governs how much resistant biomes erode at all.

**One scalar was being asked to encode two independent rock properties.** Resistance to
dissolution and angle of repose are not the same thing — sandstone dissolves readily and
still stands in vertical cliffs. `talusTan` is now its own `BiomeDef` field, blended per
cell by stage 4 exactly as erodibility is, and the thermal kernel reads it directly.

After the split, with Badlands and Ashlands at tan 8.0 and Alien at 14.0:

| | interior | soft border | hard border | contrast |
|---|---|---|---|---|
| before erosion | 66 deg | 55 deg | 87 deg | +21 |
| after erosion | 64 deg | 59 deg | **85 deg** | **+21** |

Rims survive intact and the controlled rho stays at 0.97. Note that erodibility no longer
affects thermal at all, which is the intended separation.

**Yours to set, not mine:** the `talusTan` values themselves. 8.0 and 14.0 preserve rims,
but how vertical a mesa should be is a look decision. The non-hardEdge biomes were given
values reproducing their previous behaviour exactly, so nothing else moved.

---

## 7. Biome roster (proposed)

You asked for suggestions. Eight partitioned plus one derived.

The elevation column is the target **mean**, not a clamp and not a floor — see §5.5. In
code each biome carries `elevSpan` (height reached where the continental base peaks) and
`elevProfile` (the exponent). Measured means from the current build are in brackets;
**`elevSpan` is the authored peak, not the observed one.** Mountains at `elevSpan` 600
measures a **p99 peak of 490 m (sd 45)**, because the span is only reached where the global
continental base peaks *and* a Mountains region happens to sit there. Read the right-hand
band number as an authored ceiling, never as what a player will stand on.

The bracketed figures are measured MEANS, and §16.1 establishes that comparing a mean
against these ranges was a definition error — the ranges are the biome's elevation extent,
not a target for its mean.

| Biome | Elev (m) | Erod. | Base character | Signature 3D flavour |
|---|---|---|---|---|
| **Meadows** | 5–40 *(16)* | 1.0 | Mature eroded rolling | — (restraint is the point) |
| **Blackforest** | 40–140 *(36)* | 0.85 | Eroded hills, dense drainage | Mossy boulder overhangs, root hollows |
| **Mountains** | 200–600 *(192)* | 0.6 | Ridged multifractal + glacial cirques | Arêtes, cliff overhangs, **natural arches** |
| **Karst** | 10–60 *(16)* | 0.5 surf. | Low, flat, deceptive | **Sinkholes, tunnel networks, collapse bridges** |
| **Badlands** | 80–250 *(96)* | 0.25 | Stratified terracing | **Slot canyons, hoodoos, mesa arches** |
| **Fen** | −5–15 *(9)* | 1.0 | Near-flat, high water table | Peat hollows, sunken channels |
| **Ashlands** | 150–450 *(136)* | 0.1 | Volcanic cones, fresh | Lava tubes, collapsed roofs, spatter spires |
| **Alien** | any *(145)* | 0.0 | Non-fBm, crystalline, wrong | **Floating islands, inverted spires, lattices** |
| *Ocean* | < −10 | — | *derived, not partitioned* | Shelf, trench, sea stacks |

**Karst is your limestone cave biome** — low and flat on the surface exactly as you
described, with the entire design living underground. It's the best proving ground for the
3D density contract, because `sampleColumn` is *meaningfully wrong* there. If Karst works,
the architecture works.

**Alien** is the other extreme: `erodibility 0`, `hardEdge true`, floating geometry with no
column representation at all. It stresses the opposite axis. I'd build Meadows, then
Mountains, then Karst, then Alien — each one breaks an assumption the previous made.

---

## 8. Density-domain flavour ops

All stage 13–14. All composed via SDF min/max with priority tiebreak (your 4c, decided).

| Op | Technique | Placement signal |
|---|---|---|
| **Arch** | Subtract horizontal capsule through a ridge | High ridge value + steep slope + ridge direction from gradient |
| **Land bridge** | *Union* a thin beam across a gap | Two high atlas regions separated by low gap under 80 m |
| **Overhang** | Warp density's `z` by horizontal noise | Slope over 55°, amplitude scaled by slope |
| **Sinkhole** | Subtract vertical cone, connect to tunnel below | Karst, jittered grid, Poisson-ish spacing |
| **Tunnel (grown)** | 3D worm noise — `abs(fbm3) < threshold` | Karst, Ashlands; density-domain, no placement |
| **Tunnel (carved)** | SDF capsule chain along a seeded path | Where you want *authored* topology |
| **Floating island** | Isolated density blob, detached from surface | Alien only |
| **Sea stack** | Union vertical column, resist ocean mask | Shore flag + erodibility under 0.5 |

Your 1b answer — both carved and grown, per biome — is why stage 14 has two
implementations. Grown gives organic unpredictable networks (Karst). Carved gives
intentional authored topology (anywhere you need a specific thing). Both write the same
density field and compose the same way.

---

## 9. Determinism

- One `u64` world seed. Everything derives via a documented hash chain:
  `seed(pass, feature, x, y) = splitmix64(worldSeed ^ passId*P1 ^ featureIdx*P2 ^ hash2(x,y))`
- **No language RNG anywhere.** No `Math.random`, no `std::mt19937`. Every random value is
  a pure hash of position and pass. This is the one piece of discipline worth keeping even
  though the code is disposable — it's what makes a result reproducible when you port it.
- Noise variant pinned and documented: **OpenSimplex2S** for fBm, Worley with Euclidean
  F1/F2 (Chebyshev variant for Alien). Stated explicitly because "Perlin" across two
  implementations is two different terrains.
- Atlas bake is a pure function of `(worldSeed, params)`. Cache key is their hash.

---

## 10. Auditioner UI

**Primary: top-down map.** 2048² canvas, pan/zoom, with a layer stack:

```
[x] Hillshade          [ ] Slope
[x] Biome colour       [ ] Erodibility
[ ] Height (gradient)  [ ] Flow accumulation
[ ] Boundary distance  [ ] Feature placement
[ ] Blend weights      [ ] Pass diff (A vs B)
```

**Pass introspection (your 4d).** A scrubber over the nine bake stages — view the atlas
*as of* any stage, and diff consecutive stages. You named the reason precisely: it's how
you find where behaviour diverges from expectation, and how you tell an agent where to
look. Worth the cost of retaining intermediates (9 x 2048² x f32 is about 150 MB,
acceptable).

**Secondary: 3D inspector.** Click the map to fly to that point. Quadtree LOD, analytic
normals. Density-domain biomes get marching cubes; heightfield biomes get a grid mesh.
Toggle between them to see where `sampleColumn` lies.

**Two-tier responsiveness (your 6b).** Detail params re-sample the visible region instantly
on drag (GPU, under 16 ms). Params that invalidate the atlas grey out a **Bake** button
with an estimate. Dirty-tracking is per-pass, so changing a carve param re-runs stages
7–9 only.

---

## 11. Near-field detail — your tessellation note

The architecture already answers this, which is why I'm flagging it rather than designing
it.

Because the Analytic tier is a **pure function at unbounded resolution**, a tessellation
stage can ask for detail at 10 cm without the generator knowing or caring. The thing that
would have blocked it — baking everything to a fixed 1 m grid — is exactly what the
two-tier split avoids.

Two consequences worth building in now, cheaply:

- **Analytic normals.** Derive from the field via central differences in the *field*, not
  from mesh triangles. Mesh-derived normals quantise to the polygon and are the main reason
  1 m terrain reads as polygonal. This costs 4 extra field samples and is the single
  highest return on "doesn't look like triangles."
- **Keep a `detailFrequency` budget per biome.** If a biome's highest-frequency octave is
  below the tessellation target, tessellation adds vertices with nothing to displace them.
  Documenting the frequency ceiling per biome now tells you later where parallax or detail
  textures must take over from geometry.

Parallax occlusion mapping is a rendering concern and out of scope for the auditioner —
but the frequency budget is the data it would need, so it's worth recording as we go.

---

## 12. Open / deferred

- **Q1a, Q2a** — defaulted, not answered. Flag if wrong.
- **Q4b curated placement** — deferred per your answer. The Atlas `featureId` field is
  already there, so hand-placement is additive later, not a rewrite.
- **Biome adjacency rules** — sketched (§5.1), needs a real table once the roster is fixed.
- **Material system** — stage 15 is stubbed. Materials are a texturing concern; I've left
  it at `materialId` until the geometry is convincing.
- **Sea level as a parameter** — currently fixed at 0. Trivial to expose, but moving it
  invalidates the ocean resolve and shore flags, so it belongs in the bake tier.

---

## 13. Build order

Each milestone breaks an assumption the previous one made. That's deliberate.

1. ~~**Atlas + disc + continental base.** Top-down map, hillshade, pan/zoom. Proves the tier split.~~
   **Done.** Measured: 0.78 s bake at 1024² (24 MB), 3.3 s at 2048² (96 MB), ~19% land.
   Identical terrain at both resolutions, which is the resolution-independence the
   Analytic tier depends on. Two findings worth carrying forward:
   - The warp *spectrum* matters more than its amplitude. At gain 0.5 the high octaves
     only translate the field and islands stay visibly circular; carrying energy down to
     the ~500 m octave is what actually ripples a coastline.
   - 3.3 s for one CPU pass means stage 5 (erosion) will not fit in a CPU bake at 2048².
     Plan on moving the bake to WGSL compute at M4, not later.
2. ~~**Warped Worley partition + boundary distance.** Biome colours. Proves the warp quality.~~
   **Done.** 0.4 s for the pass, 1.2 s total bake at 1024². The three-scale warp works:
   no straight edge survives at any zoom. But the milestone was decided by something
   else entirely — see §5.4, which amends §5.1. Short version: the partition needed
   **quotas**, because the biome mix a player walks on is a ~40-sample problem and
   independent draws gave worlds that were 20% Alien.
3. ~~**Height envelope + blending.** Proves no seams.~~
   **Done.** Stages 3 and 4 both landed (erodibility shares the blend weights, so it
   came along for ~10 lines). Bake 1.3 s at 1024². **No seams: soft-border slope p99
   55 deg against 66 deg interior.** Two amendments came out of it — §5.5 (the envelope
   had to be re-anchored at zero) and §5.6 (the seam metric needed a three-way split).
   §5.2 was also revised, since blending needs the nearest *foreign biome*, not the
   nearest site edge.
4. ~~**Global erosion + erodibility modulation.** The §6 bet.~~
   **Done, and the bet holds — see §6.1.** Virtual-pipe hydraulic erosion plus thermal
   relaxation, in WGSL compute. 1.9 s for 140 iterations at 1024². The §6 resolution is
   confirmed by controlled experiment at **Spearman rho 0.97**. One structural change was
   needed: talus angle had to be split out of erodibility (§6.2).
5. **Pass introspection UI.** Build it here, not later — everything after is easier to debug with it.
6. **3D inspector + density lift.** First time `sampleDensity` does real work.
7. **Karst.** First biome where `sampleColumn` is wrong. Proves the 3D contract.
8. **Carving passes + biome rewrite.** Badlands canyons.
9. **Alien.** Floating geometry, zero erosion, hard edges. Proves the extremes.

Milestone 4 is the one that decides whether this design is right. If erodibility-modulated
global erosion doesn't produce visually distinct biomes, the §6 resolution is wrong and we
reconsider before building on it.


---

## 14. Variant sweeps (M5)

One seed, one axis at a time — the method that settled §6.1. Run them with
`window.sweep.regionSize()`, `.talus()`, `.envelope()`.

### 14.1 Region size — the §5.4 tension

Averaged over 3 seeds, because at 1400 m there are ~20 land sites and a single-seed
curve showed mix error *falling* from 1250 m to 1400 m, which was noise reading as signal.

| region | patches | mean patch km² | crossing run | channels/run | mix err (pts) | worst seed (pts) |
|---|---|---|---|---|---|---|
| 500 m | 177 | 0.13 | 307 m | 1.72 | 4.44 | 10.8 |
| 620 m | 126 | 0.18 | 352 m | 1.96 | 4.22 | 9.4 |
| 760 m | 108 | 0.21 | 403 m | 2.20 | 4.08 | 11.6 |
| 900 m | 93 | 0.24 | 428 m | 2.34 | 4.95 | 10.1 |
| 1050 m | 88 | 0.26 | 458 m | 2.56 | 4.62 | 10.3 |
| 1250 m | 68 | 0.33 | 509 m | 2.82 | 4.87 | 16.2 |
| 1400 m | 60 | 0.39 | 540 m | 2.99 | 6.99 | 14.1 |

**Mean mix error is flat (4.1-5.0) from 500 m to 1050 m** and only degrades past 1250 m.
The §5.4 claim that the mix is "a lottery" at large regions holds in the *worst-seed*
column, not the mean: 16.2 points at 1250 m against ~10 below it. Whatever is chosen, the
cost of large regions is variance across seeds rather than average error.

**Two measurement traps found here, both worth keeping in mind:**

- **`channels/run` was tautological at first.** Counting channel *cells* per run just
  returns 0.2x run length, because the channel threshold is the 80th percentile — the
  first version reported 6.46 for a 32-cell run and would have "confirmed" the structure
  prediction by arithmetic. It now counts distinct channel *crossings*.
- **`landSites` is not comparable across region sizes.** The land test samples a rosette
  of radius 0.45 x spacing, so each variant asks "is there land here" at a different
  physical scale; the count moves non-monotonically with spacing even though it is
  strictly monotonic at a fixed seed (108 → 13 from 500 m to 1400 m). `patches` is the
  comparable count. Flagged in `layout.ts`.

### 14.2 Erosion did change the picture — but it is scale-free

The prediction was that drainage networks would give each patch internal structure, so
620 m might read better post-erosion than it did as a "quilt".

**Channel spacing is ~180 m and independent of region size** (1.96 crossings per 352 m
run at 620 m; 2.99 per 540 m at 1400 m — both one channel per ~180 m). Drainage spacing
is set by the terrain, not by the biome layout, so internal features per patch scale
linearly with patch size. A 620 m region contains ~2 channels, a 1400 m region ~3.

So erosion does add internal structure, and it helps small regions proportionally most —
a 620 m patch goes from no internal features to two. **Whether two channels is enough to
stop a patch reading as a tile is a look judgement, and it is yours.** The measurement
says the structure is there; it cannot say it is sufficient.

### 14.3 talusTan — what a hard rim costs (§6.2)

| talusTan | angle | hard-border contrast | erosion in hardEdge biomes | total erosion |
|---|---|---|---|---|
| 1.5 | 56° | +5 | 3.82 m | 2.36 m |
| 2.5 | 68° | +7 | 2.65 m | 1.97 m |
| 4 | 76° | +13 | 1.97 m | 1.69 m |
| 6 | 80° | +18 | 1.47 m | 1.48 m |
| **8** *(current)* | 83° | +19 | 1.19 m | 1.36 m |
| 11 | 85° | +21 | 0.96 m | 1.26 m |
| **14** *(Alien)* | 86° | +21 | 0.81 m | 1.19 m |
| 20 | 87° | +22 | 0.64 m | 1.12 m |

Contrast saturates around tan 11 (+21 of a +22 maximum) while erosion in those biomes
keeps falling, so everything above ~11 buys stillness for nothing. The steep part of the
curve is 2.5 → 6, where contrast nearly triples for a third of the erosion. Not
recommending a point.

### 14.4 Envelope drift — erosion does NOT close it

> **CORRECTION (M5b).** The table below is a single seed at 820 m region size, and the
> drift figures in it are **optimistic and not a property of the envelope**. 820 m was
> the region size in place when the spans were authored, so the spans were implicitly
> fitted to it. At 6 seeds the same configuration gives mean drift **8.39 m, not 4.80 m**.
> The conclusion that erosion does not close the drift still holds — that part was
> measured pre/post on identical terrain. What does not hold is treating these absolute
> drift values as the envelope's. See §14.5.

M3's drift was deferred on the grounds that erosion would redistribute it. It does not.

| biome | §7 band | pre-erosion | post-erosion | changed by | outside band |
|---|---|---|---|---|---|
| Meadows | 5-40 | 16.4 | 15.8 | −0.6 | — |
| Blackforest | 40-140 | 36.8 | 36.1 | −0.7 | 3.9 m |
| **Mountains** | 200-600 | 181.2 | 179.4 | **−1.8** | **20.6 m** |
| Karst | 10-60 | 15.8 | 15.8 | −0.0 | — |
| Badlands | 80-250 | 96.0 | 97.0 | +1.0 | — |
| Fen | −5-15 | 8.7 | 8.1 | −0.6 | — |
| **Ashlands** | 150-450 | 136.5 | 136.1 | **−0.4** | **13.9 m** |
| Alien | 0-520 | 145.0 | 144.6 | −0.4 | — |

Mean drift went **4.44 m → 4.80 m**: slightly worse, not better. Erosion moves biome-mean
elevation by at most 1.8 m against gaps of 14-21 m, which is expected — it is close to
mass-conserving and redistributes locally rather than shifting a region's mean.

**The Mountains and Ashlands gaps are a property of `elevSpan`/`elevProfile` and have to
be fixed there.** Five of eight biomes sit inside their bands; the two that miss are the
two with the highest `elevProfile`-weighted spans, so the lever is those two numbers. Both
are look decisions, so they stay yours — but they will not fix themselves downstream, and
the §13 note deferring them to after M4 was wrong on that point.


### 14.5 Drift vs region size — not resolvable above seed noise (M5b)

The hypothesis was that envelope drift is dominated by region size rather than by
`elevSpan`, since the §5.4 elevation-rank nudge means region size changes which ground
Mountains lands on. Tested at 3 and then 6 seeds per size.

**Both apparent sweet spots were artifacts of under-sampling.**

| region | mean drift @1 seed | @3 seeds | @6 seeds | seed spread @6 |
|---|---|---|---|---|
| 500 m | — | 2.13 | 4.25 | 9.85 |
| 820 m | **4.80** | 6.89 | **8.39** | 13.42 |
| 900 m | — | **1.12** | **6.49** | 19.48 |
| 1050 m | — | 7.98 | 7.53 | 3.41 |

820 m looked best at one seed; 900 m looked best at three; neither survives six. That is
the whole finding, and it generalises: **every "sweet spot" in this project so far has
been a sample-size illusion**, and §14.1 already warned the land-site regime is
high-variance.

**Signal is smaller than noise.** Across sizes at 6 seeds, mean drift ranges 4.25-8.39 —
a span of **4.1 points**. Within a single size, the seed-to-seed spread is **3.4 to 19.5
points**. The between-size effect is smaller than the within-size variation at three of
four sizes, so region size cannot be chosen on drift grounds at any sample size that is
affordable here.

**So the premise does not hold at 6 seeds.** Drift is dominated by *seed*, not by region
size. The single-seed observation of Mountains swinging 89-179 m was mostly lottery: at
6 seeds its mean moves 166.0-195.1 across region sizes (range 29 m) while moving 0-96 m
*within* a single region size.

**Practical consequence — the original ordering was right after all.** Region size should
be picked from the §14.1 trade-off table (patches, crossing run, mix error, worst-seed
mix), and the spans tuned afterwards at whatever size is chosen. Choosing region size to
minimise drift is choosing noise.

**A structural finding that is actionable.** Mountains and Ashlands drift are
seed-dominated because of *where the partition is allowed to put them*, not because of
their spans:

- Ashlands has `radialMean 0.84`, which places it in the outer ring — exactly where the
  rim taper makes the existence of land a lottery. Its mean elevation ranges 97-157 m
  across runs and its drift 0-107 m.
- Mountains needs high continental base to reach its band, and whether a seed provides
  high ground where Mountains is drawn is luck.

If stable per-biome elevation is wanted, the lever is the radial and elevation-rank bias
widths in §5.1/§5.4 — not `elevSpan`. Widening Ashlands' `radialWidth` or lowering its
`radialMean` would put it on more reliable ground. Both are look decisions and stay open.

**Re-run cost:** `window.sweep.driftByRegion(sizes, seeds)` — about 4.5 s per bake, so
24 bakes is ~110 s. Resolving the curve properly would want ~20 seeds per size.


---

## 15. Envelope spans (M6, partial — awaiting region size)

The M6 brief specified every deliverable "at `<REGION>` m" and the placeholder was never
substituted, so items 1, 2 and 4 are reported here at the **candidate sizes** rather than
at the chosen one. The instrument work is size-independent and complete.

**Instrument correction first (brief caveat 1).** Every seed summary in §14 that used
`worstSeedMixPts` or a min-max range was not comparable across runs with different seed
counts — more draws mechanically produce a worse maximum. Those are now sample standard
deviations. p90 was considered and rejected: at n = 6 the 90th percentile *is* the top
order statistic, so it is max under another name. Only sd means the same thing at every n.

### 15.1 Which biomes are reliably out of band (6 seeds)

> **SUPERSEDED by §16.1.** The measurements stand; the interpretation does not. "Out of
> band" was computed against a band the mean was never able to satisfy.

`seedsInBand` is the column that separates "out of band on one draw" from "reliably out".

| biome | band | 500 m | 620 m | 760 m | 900 m |
|---|---|---|---|---|---|
| Meadows | 5-40 | 6/6 | 6/6 | 6/6 | 6/6 |
| Blackforest | 40-140 | 6/6 | 5/6 | 5/6 | 6/6 |
| **Mountains** | 200-600 | **3/6** | **0/6** | **1/6** | **1/6** |
| Karst | 10-60 | 6/6 | 6/6 | 6/6 | 6/6 |
| *Badlands* | 80-250 | *5/6* | *3/6* | *2/6* | *4/6* |
| Fen | −5-15 | 6/6 | 5/6 | 4/6 | 6/6 |
| **Ashlands** | 150-450 | **2/6** | **3/6** | **1/6** | **2/6** |
| Alien | 0-520 | 6/6 | 6/6 | 6/6 | 6/6 |

Mountains and Ashlands confirmed reliably out of band at every candidate size. **Badlands
is a third marginal case** that was not on the brief's list — 2/6 to 5/6 depending on
size, because its mean (74-91 m) straddles its 80 m floor.

Mountains at 760 m: mean 179.4 ± 20.3 against a 200 m floor. Ashlands: 123.4 ± 35.6
against 150. Both sit **roughly 0.75-1.0 standard deviations below their band minimum** —
so this is not a large miss on the mean, it is a mean parked on the boundary with enough
seed variance to fall below it most of the time.

### 15.2 Span and profile sensitivity — and why they are one lever, not two

> **Required-span table VOID** — twice over: the σ-scaling error corrected in §15.5, and
> the band misreading established in §16.1. The shapeFactor factorisation itself stands.

Mean elevation factorises exactly:

```
mean  =  elevSpan  x  shapeFactor      where shapeFactor = E[u^elevProfile]
```

`elevSpan` is therefore **exactly linear** in the mean, and `shapeFactor` is the measured
quantity that `elevProfile` moves. Reporting the shape factor is what makes the
interaction visible rather than implied (brief caveat 2): with it, the mean for *any*
span at a given profile is `span x shapeFactor`, no further bakes required.

Measured at 760 m, 3 seeds, span held at its authored value:

| Mountains profile | mean | shapeFactor | | Ashlands profile | mean | shapeFactor |
|---|---|---|---|---|---|---|
| 1.45 *(current)* | 198.7 | 0.331 | | 1.25 *(current)* | 146.8 | 0.326 |
| 1.20 | 227.2 | 0.379 | | 1.05 | 166.6 | 0.370 |
| 1.00 | 254.0 | 0.423 | | 0.90 | 184.0 | 0.409 |
| 0.80 | 285.1 | 0.475 | | 0.70 | 211.5 | 0.470 |
| 0.60 | 320.9 | 0.535 | | 0.55 | 236.3 | 0.525 |

Shape factor is close to linear in profile over this range, gaining ~0.024 per 0.1 of
profile reduction for both biomes.

**What each target costs.** Using the 6-seed shape factors at 760 m (0.299 Mountains,
0.274 Ashlands):

| target | Mountains | Ashlands |
|---|---|---|
| just inside band (floor) | span 670 (+12%) | span 547 (+22%) |
| **reliably inside (floor + 2σ)** | **span ~800 (+34%)** | **span ~807 (+79%)** |
| mid-band | span ~1340 (+123%) | span ~1095 (+143%) |

Mid-band is not reachable by profile alone — it would need shapeFactor ~0.67, beyond the
0.535 measured at profile 0.6, so profile would have to go below ~0.35 and make the
terrain read as a plateau. **Floor + 2σ is the target that makes "reliably in band" true,
and it is a far smaller change than centring.** Which target is wanted is yours.

### 15.3 The §14.5 alternative does not work (Ashlands radial bias)

Tested whether stabilising *where* Ashlands lands beats raising its span. 760 m, 4 seeds.

| variant | mean elev | elev sd | land share | mix err |
|---|---|---|---|---|
| baseline (mean .84 / width .30) | 125.8 | **45.7** | 9.1% | 4.29 |
| width .45 | 113.6 | **36.7** | 8.0% | 5.04 |
| width .60 | 111.7 | 39.3 | 7.6% | 4.82 |
| mean .70 | 126.9 | 46.9 | 8.1% | 5.04 |
| mean .70 + width .45 | 124.4 | 45.0 | 8.3% | 5.13 |

**No.** The best case (width .45) cuts elevation sd by 20% — but *lowers the mean by
12 m*, which moves Ashlands further below the floor that is the actual problem, and costs
0.75 points of mix error. Lowering `radialMean` does nothing to sd at all (45.7 → 46.9).

Elevation sd stays 37-47 m across every variant, which says Ashlands' elevation variance
is **not** primarily driven by radial placement. It is driven by which specific high
ground a seed happens to provide where Ashlands is drawn. Radial bias cannot fix that;
raising the span (or lowering the band) can.

### 15.4 Region size settled: 900 m

`biomeCellSpacing` default is now 900. §14.4's single-seed 820 m table is superseded by
§15.6 below.

### 15.5 CORRECTION: sigma scales with elevSpan, so "floor + 2 sigma" moves

§15.2's "reliably inside (floor + 2σ)" row treated σ as fixed while span varied. **It is
not.** Mean elevation is `span x shapeFactor` computed per seed, so the across-seed σ is
also proportional to span: raising span raises the spread by the same factor. The
**coefficient of variation `c = σ/mean` is the span-invariant quantity**, and the target
has to be written in terms of it.

For a band `[lo, hi]` and a reliability of ±kσ:

```
need   mean(1 - k*c) >= lo    and   mean(1 + k*c) <= hi
=> feasible only if      c <= (hi - lo) / (k * (hi + lo))
```

So each band admits a **maximum tolerable CV**, independent of any span. The span figures
in §15.2 are withdrawn; §15.6 replaces them.

**Measured CV, 14 seeds at 900 m** (n=14 because at n=6 the two seed families disagreed —
Ashlands read 0.156 and 0.348 — and the whole feasibility question turns on this number):

| biome | mean | sd | **CV** | shapeFactor | observed range |
|---|---|---|---|---|---|
| Mountains | 171.9 | 38.9 | **0.226** | 0.2865 | 85-230 |
| Ashlands | 116.5 | 36.7 | **0.315** | 0.2588 | 41-183 |
| Badlands | 85.8 | 15.4 | **0.179** | 0.3431 | 55-108 |

Profile reduces CV, but only second-order: Mountains 0.154 → 0.132 and Ashlands
0.348 → 0.278 across a profile swing of 0.65. Span is exactly CV-neutral.

### 15.6 What each biome needs at 900 m

> **WITHDRAWN — see §16.1.** "Ashlands cannot be made reliably in band by any span or
> profile" was an artifact of reading bandMin/bandMax as a band for the mean. Ashlands'
> high CV is still a real problem; the impossibility claim is not.

Required `elevSpan` to put the mean at the lowest value satisfying the band, at the
authored profile. k=1 is ~68% of seeds in band (~4/6), k=2 is ~95% (~6/6).

| biome | band | max tolerable CV (k=2) | actual CV | span at k=1 | span at k=2 |
|---|---|---|---|---|---|
| Mountains | 200-600 | 0.250 | 0.226 | 902 (1.5x) | **1274 (2.1x)** |
| **Ashlands** | 150-450 | 0.250 | **0.315** | 846 (1.9x) | **INFEASIBLE** |
| Badlands | 80-250 | 0.258 | 0.179 | 284 (1.1x) | 363 (1.5x) |

**Ashlands cannot be made reliably in band by any span or profile.** Its CV of 0.315
exceeds the 0.250 its band width permits at k=2: satisfying the 150 m floor at ±2σ needs a
mean of 405, but staying under the 450 ceiling at ±2σ caps the mean at 276. No value
satisfies both. Lowering `elevProfile` to 0.7 brings CV to 0.278 — still above 0.250.

Three ways out, all yours:
- **Widen the §7 band.** 150-450 is narrow relative to Ashlands' seed variance. A band of
  roughly 120-500 would admit CV 0.3.
- **Accept k=1** (span ~846, about 4 seeds in 6 landing in band).
- **Reduce the variance at source** — but not via radial bias, which §15.3 measured and
  found counterproductive.

Mountains at k=2 needs span ~1274, which is a 2.1x change and well past "tuning". Its mean
window at k=2 is narrow — [365, 413] — because its own CV is close to its band's limit.

**Badlands was not on the brief's list** but is the easiest of the three: span 363 (1.5x)
gives k=2, or 284 (1.1x) for k=1.

None of these values are set. The spans, the profiles and whether to widen the bands are
yours.


---

## 16. The band was never a band (M7)

### 16.1 Settled: a definition error, not a terrain finding

`elevSpan == bandMax` for all nine biomes, **exactly** — verified in code, not assumed.
§7's top number always was the biome's peak; `bandMin`/`bandMax` were then implemented as
a band for the biome's **mean**. A mean cannot equal a maximum, so the top of every band
was unreachable by construction and "drift" was measuring

```
bandMin / elevSpan  >  shapeFactor
```

which is a property of how the roster was written. Checked against the measured
`seedsInBand` results of §15.1, using the *measured* shape factors rather than an assumed
0.29:

| biome | bandMin/elevSpan | measured shapeFactor | predicted | measured |
|---|---|---|---|---|
| Meadows | 0.125 | 0.491 | pass | 6/6 |
| Blackforest | 0.286 | 0.342 | pass | 5-6/6 |
| **Mountains** | 0.333 | 0.277 | **FAIL** | 0-3/6 |
| Karst | 0.167 | 0.347 | pass | 6/6 |
| Badlands | 0.320 | 0.362 | marginal | 2-5/6 |
| Fen | −0.333 | 0.666 | pass | 4-6/6 |
| **Ashlands** | 0.333 | 0.305 | **FAIL** | 1-3/6 |
| Alien | 0.000 | 0.283 | pass | 6/6 |

**Eight for eight.** The two "failures" are exactly the two biomes that failed, and the
nearest-to-boundary case is exactly the one that was marginal.

**What is withdrawn:**
- §15.6's "Ashlands cannot be made reliably in band by any span or profile" — **void**. It
  was derived from a band the mean was never meant to satisfy.
- §15.2's required-span table — void twice over: once for the σ-scaling error §15.5
  already corrected, and again for this.
- §15.1's *interpretation* — void. Its measurements stand; "out of band" just does not
  mean what it was read to mean.
- §14.4's drift framing — void. Its pre/post erosion comparison stands, because that was
  measured on identical terrain and did not reference the band.

**What survives:** erosion moves biome-mean elevation by <2 m (§14.4); radial bias cannot
fix Ashlands and costs mix error (§15.3); mean = `elevSpan x shapeFactor` and σ scales
with span, so CV is the span-invariant quantity (§15.5); and **Ashlands' CV of ~0.30 is a
real problem independently of any band** — its mean swings 41-183 m across seeds.

**Instrument fixed.** Nothing computes mean-vs-band drift any more. `bandMax` is now
compared against measured p99 elevation (peak against peak) and `bandMin` is documentation
only. Added: `shapeFactor`, `peakElev` (p99), `highFraction` (fraction of a biome's land
above half its own `elevSpan`), and interior-only variants of the elevation metrics.

**Second confound found while fixing the first.** Per-biome means are contaminated by
blending. Fen measures a mean of 0.67x its own span, which is impossible for a biome at
profile 1.8 — its cells near Blackforest are lifted by that neighbour's 140 m span. Hence
`highFractionInterior`, restricted to cells >160 m from any foreign biome (the widest
authored `blendWidth` is 145 m). Interior figures describe the envelope; all-cell figures
describe what a player walking through meets. Both are real; they answer different
questions.

### 16.2 Mountains: elevProfile at 900 m, 8 seeds, span fixed at 600

| profile | shapeFactor | mean | p99 peak | high frac | high frac (interior) | mean slope |
|---|---|---|---|---|---|---|
| **1.45** *(current)* | 0.278 | 166.7 | 471 | 0.190 | 0.262 | **40.5°** |
| 1.20 | 0.320 | 191.9 | 490 | 0.244 | 0.330 | 43.3° |
| 1.00 | 0.360 | 216.1 | 506 | 0.303 | 0.404 | 45.4° |
| 0.80 | 0.407 | 244.1 | 523 | 0.380 | 0.495 | 47.1° |
| 0.60 | 0.461 | 276.8 | 540 | 0.472 | 0.592 | 48.4° |

Profile 1.45 → 0.6 takes the mountain from **19% to 47% of its area above 300 m** (26% to
59% in biome interiors), for **8 degrees** of mean slope. Slope rises far more slowly than
high-ground fraction, so walkability is a weak constraint over this whole range — if 40°
is already acceptable, 48° is not a cliff edge.

Note the p99 peak is **471-540 m, not 600**: `elevSpan` is only reached where the global
continental base peaks *and* a Mountains region happens to sit there. "Peak 600" as
authored delivers observed peaks around 500.

No value picked — the profile is yours.

### 16.3 Ashlands: narrowing elevRankWidth (12 seeds, the untried lever)

| elevRankWidth | mean elev | sd | **CV** | land share | mix err |
|---|---|---|---|---|---|
| **0.42** *(current)* | 111.6 | 34.0 | **0.304** | 6.18% | 4.48 |
| **0.28** | 134.7 | 26.7 | **0.198** | 6.92% | 4.41 |
| 0.18 | 119.0 | 36.6 | 0.308 | 5.47% | 4.40 |
| 0.10 | 116.2 | 35.5 | 0.305 | 5.56% | 4.58 |

At 0.28 the CV drops 35% (0.304 → 0.198), the mean *rises* 23 m, and mix error does not
degrade — so the expected exchange rate (placement accuracy bought with mix accuracy)
**did not materialise**; there was no cost to pay.

**But treat this as unconfirmed.** Two reasons to distrust it:
1. **The curve is not monotonic.** 0.18 and 0.10 revert to CV ~0.305. If narrowing
   concentrated Ashlands on high ground, narrower should be better, not worse. A likely
   mechanism is competition: Ashlands sits at rank 0.80 and Mountains at 0.90 with width
   0.38, so a very narrow Ashlands demands a thin slice of rank that often is not
   available, and the quota then places it arbitrarily. That would produce exactly this
   shape — but it is a hypothesis, not a measurement.
2. **n=12 is not enough for a CV claim.** The relative standard error of an sd estimate at
   n=12 is ~21%, so 0.198 against 0.304 is about 1.6 standard errors. This project has
   produced three sweet-spot illusions already (820 m at n=1, 900 m at n=3, and §15.6's
   impossibility result); one more unconfirmed optimum should not be acted on.

Confirming it needs ~24 seeds at 0.42 and 0.28, about 3.5 minutes of baking. Flagged
rather than pursued, and no value changed.


---

## 17. Envelope closed, 3D contract opened (M8)

### 17.1 Mountains elevProfile set to 1.20

Set in the roster. Re-measured at 900 m over 8 seeds, reproducing the §16.2 sweep row
exactly (which is itself worth noting — the sweep and the authored value agree, so the
override path and the roster path compute the same thing):

| metric | value |
|---|---|
| shapeFactor | 0.320 |
| mean elevation | 191.9 m |
| **p99 peak** | **490 m (sd 45)** |
| high fraction (above 300 m) | 0.244 |
| high fraction, biome interiors | 0.330 |
| mean slope | 43.3° |

§7 now states the authored-versus-observed peak distinction.

### 17.2 Ashlands elevRankWidth: the lever FAILED

Confirmed at n=24, 0.42 against 0.28 only, as instructed. **Leaving 0.42.**

| width | mean elev | **sd** | CV | mix err |
|---|---|---|---|---|
| 0.42 *(kept)* | 123.7 | **35.2** | 0.285 | 4.61 |
| 0.28 | 135.3 | **34.1** | 0.252 | 4.63 |

The n=12 result (CV 0.304 → 0.198, a 35% cut) was **the fourth sweet-spot illusion**. At
n=24 it is 0.285 → 0.252, and the reason matters: **the standard deviation barely moved**
(35.2 → 34.1, a 3% change well inside the ~15% relative error of an sd estimate at n=24).
CV fell only because the *mean rose* (123.7 → 135.3). The lever does not reduce Ashlands'
elevation spread, which was the entire stated problem. It raises its mean by ~12 m, which
is a different and smaller thing.

### 17.3 The non-monotonicity hypothesis is WRONG — and the real cause is worse

The guess was that a narrow Ashlands competes with Mountains for a thin slice of high
ground and the quota then places it arbitrarily. Measured directly, via the elevation-rank
distribution of the land sites Ashlands actually wins:

| width | won-rank mean | won-rank sd (within seed) | sites won | elev CV |
|---|---|---|---|---|
| 0.42 | 0.663 | 0.219 | — | 0.285 |
| 0.28 | 0.755 | 0.175 | — | 0.252 |
| 0.18 | 0.804 | 0.095 | **3.0** | 0.307 |
| 0.10 | 0.804 | 0.054 | **2.3** | 0.305 |

**The opposite of the prediction.** Won-rank mean rises monotonically (0.663 → 0.804) and
within-seed scatter falls monotonically (0.219 → 0.054). Narrowing the window targets high
ground *better* at every step, exactly as designed. There is no quota-scattering.

**The real cause is sample size.** Ashlands wins **2-3 land sites per world**. Its mean
elevation is the average of two or three patches, so its seed-to-seed variance is a
small-sample artifact however well those patches are chosen. Narrowing improves targeting
but *reduces the site count* (3.0 → 2.3), and the two effects cancel — which is the whole
shape of the curve.

The arithmetic confirms it: Ashlands' quota weight is 0.72 of 7.38 total, so 9.8% of a
~33-site land budget at 900 m is ~3.2 sites. Measured 2.3-3.0.

**This also explains why §15.3's radial lever failed.** Both levers change *where*
Ashlands goes; neither changes *how many sites it gets*. No placement parameter can fix a
2-sample mean.

**The untried lever is therefore site count** — Ashlands' quota `weight`, or more land
sites (smaller regions, more land). Both are yours, and note that §14.1 already priced
smaller regions. Remove the hypothesis from the doc: it was a guess and it was wrong.

### 17.4 Milestone 6 started: the §3 sampling contract

`core/field.ts` implements the three §3 entry points — `sampleDensity`, `sampleColumn`,
`sampleRegion` — with stage 12's density lift (`d = z - height`). Analytic normals come
from central differences in the field at a fixed epsilon, not from the atlas cell size and
not from mesh triangles (§11).

**Honest about what it does not do.** Stages 13-14 (density-domain ops, caves) are not
implemented, so `sampleDensity` and `sampleColumn` are currently the same function and
agree exactly. `measureColumnHonesty` ray-marches the density field and compares:

```
samples 374 land points · disagreements 0 · maxDisagreement 0 m · inInvalidBiome 116
```

Zero disagreement is the expected and correct result — it validates the probe, not the
contract. The number that matters today is the last one: **31% of sampled land sits in a
biome whose roster entry already declares `columnValid: false`** (Karst, Alien). That is
how much of the world the 2.5D fast path is committed to describing wrongly once the 3D
ops land, and it is reported rather than hidden.

**Remaining for milestone 6:** the Three.js inspector itself — click-to-fly, quadtree LOD,
marching cubes for density-domain biomes against a grid mesh for heightfield ones, and the
toggle that shows where the column lies. The contract it will consume is in place.
