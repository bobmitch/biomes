# World Generation & Biome Auditioner — Architecture Q&A

> Fill in the `**A:**` lines. Write `default` to accept my recommendation, or overwrite freely.
> Partial answers are fine — `default` on anything you don't care about yet.

---

## Project premise (correct me if wrong)

- ~10 km diameter circular sandbox, island-cluster topology
- Worley-driven **hard** biome zoning (cellular partition, not gradient climate lookup)
- Per-biome height boosting over a shared continental base
- Post-seed carving passes: badlands canyons, alien anomalies
- Radial ocean taper at the rim
- Eventually: high near-field detail + arbitrary dynamic topology (tunnels, caves, overhangs)
- Standalone tech sandbox. No physics, no vegetation, no gameplay.

**Corrections / additions:**
**A:**

---

## Q1 — Representation: the authoritative sampling contract

The evaluator's *signature* is the most expensive decision to reverse. "Arbitrary topology" and
"heightmap" are mutually exclusive representations; the question is when we pay for that.

**1a.** Core signature: `f(x, y) -> {height, biomeId, ...}` (column field)
or `f(x, y, z) -> {density, biomeId, ...}` (scalar field, initially `z - height(x,y)`)?

*My default:* author as a 2.5D surface stack, but make the public API a **3D density evaluator**
from day one, with carving as SDF boolean ops. Caves become a new op, not a new architecture.
Cost ~15% more plumbing now.

**A:**

**1b.** Caves/tunnels **carved** (subtract SDF primitives from a 2.5D base) or **grown**
(3D noise in the density field, overhangs emerge anywhere)?

**A:**

---

## Q2 — Locality: chunk-independent, or global pre-pass allowed?

The sleeper constraint. Silently kills whole feature classes.

**2a.** Must any point be evaluable from `(seed, x, y)` alone with bounded neighborhood reads
(Valheim-style, infinite-streaming-friendly)? Or is a **global world atlas** acceptable?
At 10 km / 4 m cells that's 2500² ≈ 6.25 M cells ≈ ~100 MB for a rich per-cell struct.

**A:**

**2b.** Rivers: **true hydrology** (flow accumulation, lake filling, erosion — requires global)
or **fake rivers** (Worley edges / warped ridge-noise troughs — local and cheap, but never
route correctly downhill)?

**A:**

**2c.** The world is bounded. Do you want to *exploit* that — treat "finite" as licence for
global passes — or preserve infinite-world discipline you may never need?

*My default:* exploit the bound. Global coarse atlas (hydrology, island layout, feature placement)
+ local high-frequency detail on demand. Hybrid, not either/or.

**A:**

---

## Q3 — Biome authority and height continuity at hard cuts

"Hard boundaries" is clear for *materials*, ambiguous for *geometry*.

**3a.** Is `biomeId` purely `f(x, y)` from the Worley partition, or can **altitude override it**
(>400 m becomes Mountain regardless of cell; below sea level becomes Ocean)? Override is how
Valheim stays coherent, but biome then stops being a clean 2D partition.

**A:**

**3b.** At a hard cut (Meadows +10 m vs Mountains +300 m): literal **cliff/discontinuity**, or
shared continental base with per-biome boosts through a **narrow geometric falloff** (~20–60 m)
while the **material cut stays 1-sample sharp**?

*My default:* narrow geometric blend, perfectly sharp material cut. Hard biomes visually, no seams.

**A:**

**3c.** Is **Ocean a biome** in the partition, or a post-process mask the radial taper imposes
on top of whatever biome was there?

**A:**

**3d.** **Domain warping** on the Worley lookup so borders are organic rather than straight-edged
Voronoi? (Strongly recommend yes — two lines, and it's the difference between "procedural"
and "generated".)

**A:**

---

## Q4 — Carving pipeline: ordering, authority, conflict resolution

**4a.** Can a carving pass **rewrite `biomeId`**? (Canyon cut through Forest — do the exposed walls
become Badlands, or stay Forest?) Determines whether biome is input to carving, output, or both.

**A:**

**4b.** Feature **placement**: seeded Poisson / jittered grid off the global seed
(reproducible, chunk-resolvable), or curated placement you can drag around in the UI?

**A:**

**4c.** Overlapping features: **priority order**, **min/max SDF-style combination**, or
**last writer wins**? Fixed pipeline, or user-reorderable pass stack in the UI?

**A:**

**4d.** Should every pass be **introspectable** — view the field after each stage
(base -> biome boost -> hydrology -> canyons -> anomalies -> ocean taper) as toggleable layers?
Highest-value auditioner feature, but it forces us to retain intermediates rather than fuse passes.

*My default for 4a/4c/4d:* ordered, named, individually-toggleable passes with retained
intermediates; SDF-style min/max combination; features may stamp `biomeId` via an explicit
per-pass flag.

**A:**

---

## Q5 — Stack, and whether this code is throwaway

**5a.** Runtime preference:
- **Browser + Three.js/TS** — zero install, shareable, great slider UI, WebGPU compute available
- **Python + PyVista/Napari** — fastest to write, best numerical inspection, poor interactivity at scale
- **C++/OpenGL** — closest to final engine, slowest to iterate
- something else?

**A:**

**5b.** Is this generator the **reference implementation** that gets ported into the real engine,
or **disposable exploration**?

If reference: all math isolated into a dependency-free deterministic core with a documented numeric
contract (fixed-point seeds, specified noise variant, no language-specific RNG), visualisation as a
thin shell. If disposable: optimise purely for iteration speed.

*My default, strongly:* browser/TypeScript + Three.js, generator as a pure engine-agnostic
dependency-free module, viewer as a thin shell. Best iteration-to-fidelity ratio; the math ports
cleanly to C++/C#/HLSL later.

**A:**

---

## Q6 — Scale, units, responsiveness

**6a.** World unit = 1 m? Sea level at 0? Height range? Near-field detail/voxel size?

*My default:* 1 unit = 1 m, sea level 0, range −200 m to +600 m, near-field target 0.5–1 m.

**A:**

**6b.** Slider-drag responsiveness:
- **(i)** sub-16 ms full re-sample of a 256²–512² preview — forces GPU evaluation and a
  branch-light, table-free noise stack
- **(ii)** 200 ms–2 s CPU bake with progress — unlimited algorithmic freedom, including global erosion

*My default:* two-tier — instant coarse preview on drag, explicit "bake detail" for expensive
global passes.

**A:**

**6c.** Views needed: full-world 10 km top-down map (biome colour + hillshade)? 3D fly-in to
near-field? Both means an LOD/quadtree of meshes rather than a single grid — worth knowing now.

*My default:* top-down map as primary audit view, 3D inspector secondary.

**A:**

---

## Anything else

Constraints, references, art direction, biome list, things I didn't ask about:

**A:**

---

### The three that matter most

If you only answer three: **Q1a** (sampling contract), **Q2a/2c** (global vs local),
**Q5b** (reference vs throwaway). Those determine the shape of everything else.
