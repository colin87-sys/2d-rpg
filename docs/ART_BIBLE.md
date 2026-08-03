# ART BIBLE — Aetherbound Overworld POC

**Status: BINDING.** Every number in this document was read off `docs/reference/frame01.png`
(pixel-sampled and depth-corrected), cross-checked against `frame02–05.png`. Where this file
disagrees with `REFERENCE.md` or `REFERENCE_MEASURED.md`, **this file wins** — §10 lists the
corrections and the measurements behind them. If your module needs a number that is not here,
use the nearest analogous number here; do not invent a new regime.

World convention (from CONTRACT.md): 1 unit = 1 m, `WORLD = 512`, terrain spans
X/Z ∈ [−256, +256], **+X = east, −Z = north, +Y = up**, sea level y = 0.
Reference framing is 16:9 (verify at 1600×900). "fh/fw" = fraction of frame height/width.

---

## 1. SCENE CONCEPT — the hero frame

One frame, recreated exactly: **late-morning coastal grasslands.** A green shelf above a
western ocean; an ochre road S-curving from the south foreground past fenced golden wheat
paddocks; the mounted hero on the road at dead centre; a pale limestone massif with a white
waterfall centre-right; the white-and-cobalt royal castle on its own plateau at the right
third; a timber trestle bridge over a hazed coastal inlet upper-left; everything dissolving
into pale sage haze at the top. **No sky is visible — the frame is 100 % terrain,** edge to
edge, like a tabletop model photographed with a long lens.

### Binding world layout (the terrain seed must be shaped to deliver these)

| Element | World position (X, Z) | Elevation (Y) | Notes |
| --- | --- | --- | --- |
| **Hero / shot anchor** | (−38, +18) | ground ≈ +10.4 | Standing on the road, facing north, wheat paddock at his east shoulder |
| Hero grass shelf | x −80…−10, z −15…+60 | +9…+12 | Rolling ≤1.5 m undulation, cliff-edged on the west |
| **Coastline** (cliffs into sea) | mean x = −82, meander ±10, from z +256 to z −60; veers west to x −130 north of z −60 | cliff lip +7…+11 → sea 0 | Near-vertical pale cliffs, thin foam line at contact |
| Pier (small, wooden) | (−76, −8), pointing WSW | deck +0.4 | 5 m long |
| **Farm POI** (wheat paddocks) | centres (−34, +14), (−42, +26), (−30, +30) | +10 | Rounded-organic patches 10×6 to 16×9 m, two-rail fences, hero stands beside the first |
| Road fork + signpost | (−44, +2) | +10 | Branches: south entry (−24, +120) → hero; west to trestle bridge; east to castle gate; north switchback |
| **Castle POI** | centre (−20, +4), gate faces SW | plateau top +14 | Footprint 15×12 m; tallest spire tip +20.5 (6.5 m tall) |
| **Central massif** | footprint x −34…−2, z −52…−18 | plateau band +20…+24 | Banded pale limestone, flat top with grass and pines |
| **Waterfall** | lip (−26, −40) on the massif's SW face | lip +20 → pool +11 | 9 m single drop, mist at base |
| River | pool (−31, −33) → (−8, −26) → (+14, −20) → exits SE at (+60, +10) | +11 falling to +6 | 3–6 m wide, reads brighter/more saturated than the ocean |
| **Trestle bridge POI (west)** | (−84, −66) spanning a 12 m inlet gorge | deck +18 | Timber post-and-rail (see F1 upper-left), heavily hazed |
| **North gorge bridge POI** | (−30, −118) | deck +26 | Small log bridge, top-of-frame, almost dissolved in fog |
| **Village POI** | (−70, −128) | +24 | Slate-roofed hamlet, only hazy silhouettes in the hero shot |
| Shrine POI | (+38, −64) | +18 | East of river headwater |
| Camp POI | (+8, +88) | +8 | On the south road |
| North stepped plateaus | z < −60 | +26…+34 | The frame's top band **must climb** in 2–3 cliff-banded steps so terrain fills the frame |
| Far NE ridge | x > +120, z < −80 | +36…+42 | Forested, snow-dusted crests (uses `pine_snow`), fully fog-washed |
| Ocean | x < −92 (west of coast) | 0 | Deep band by x −110 |

Screen-position audit with the §2 camera (all within a few % of frame01): waterfall 0.64 fw,
castle 0.72–0.95 fw right third, ocean strip enters frame-left for z < −42, trestle bridge
0.07 fw upper-left, hero 0.50 fw at 0.52 fh.

---

## 2. CAMERA

| Parameter | Value | Why |
| --- | --- | --- |
| Projection | Perspective, **vFOV 26°** (hFOV ≈ 44.6° at 16:9) | Frame01 shows almost no perspective convergence; parallel road edges stay parallel. A long lens compresses depth — the #1 ingredient of the diorama read. Under 24° feels orthographic-dead; over 30° starts converging. |
| **Pitch** | **28° downward** | Measured, not guessed: ground ellipses foreshorten by sin(pitch). The mount's contact shadow (29×10 px → plan-corrected 0.48) and the main wheat patch (255×90 px → 0.35) both give 21–29°; the castle wall face-to-walkway ratio gives ≈ 27°. The spire cones show their *sides*, not their tops. (Prose docs said 45–55° — that is wrong, see §10.) |
| Yaw | **0° — due north** (looking along −Z) | Puts ocean west on frame-left, castle east on frame-right, massif upstage. |
| Distance to hero | **53 m** (camera → hero chest) | Makes the 1.6 m hero 0.065 fh ≈ 60 px at 921 px height (70 px at 1080p), matching the measured sprite. |
| Camera transform | position **(−38.0, 36.3, 64.8)**, look-at **(−38.0, 11.4, 18.0)** | = hero + (0, +24.9, +46.8). |
| Near / far | **4 / 700** | Far covers the map corner (~450 m max visible); fog has fully won by 250 m. |
| Horizon check | Top ray is 15° below horizontal → horizon sits 0.58 fh **above** the top edge | Sky can never appear, at any terrain height. Do not "fix" this. |
| Rig (player.js) | Follow-distance 53 (zoom dolly 38–70, **never FOV zoom**), pitch 28° (clamp 24–34°), free orbit allowed but boots at yaw 0; critically-damped smoothing, ≈ 0.25 s settle | The shot must be reproducible on load: boot exactly at the transform above. |

---

## 3. MASTER PALETTE

Authoring albedo values (sRGB). The grade (§7) and fog (§4) will finish them; do not pre-haze
distant assets. **Shadow rule: shadows keep their material's hue rotated +10–15° toward teal,
saturation −10 %, value ×0.45–0.55 — never grey, never violet, never just "darker."**
Deep-shade floor for the whole frame is `#1d3a1e`-class dark greens, not black.

### Terrain
| Name | Hex | | Name | Hex |
| --- | --- | --- | --- | --- |
| GRASS_HI (tips, bloom-kissed) | `#7fa63b` | | ROAD_LIT | `#c39a5c` |
| GRASS_LIT | `#62902e` | | ROAD_MID | `#a57a45` |
| GRASS_MID | `#4a7429` | | ROAD_SHADOW | `#6f5638` |
| GRASS_SHADOW | `#2f5426` | | WHEAT_TIPS | `#eed794` |
| GRASS_DEEP (under clumps) | `#1d3a1e` | | WHEAT_LIT | `#e0c26e` |
| CLIFF_LIT | `#b7c2a8` | | WHEAT_SHADOW | `#b3913f` |
| CLIFF_MID | `#8a9880` | | SNOW_LIT (far NE only) | `#eef2f0` |
| CLIFF_SHADOW | `#5d7161` | | SNOW_SHADOW | `#c2ced2` |
| CLIFF_CREVICE | `#37473f` | | | |

### Water
| Name | Hex | | Name | Hex |
| --- | --- | --- | --- | --- |
| OCEAN_DEEP | `#22516f` | | RIVER | `#2f9ec9` |
| OCEAN_MID | `#2e6f95` | | RIVER_SHALLOW | `#6cc3de` |
| OCEAN_SHALLOW / streaks | `#49a8bf` | | RAPIDS / falls sheet | `#dceef5` |
| FOAM | `#eaf4f2` | | | |

### Vegetation (4-step ramps: HI speckle / LIT / MID / SHADOW; outline = §6)
| Ramp | HI | LIT | MID | SHADOW |
| --- | --- | --- | --- | --- |
| Conifer | `#7fae6a` | `#4c7c3e` | `#33592b` | `#1e3c1c` |
| Deciduous green | `#a8c47c` | `#6f9a44` | `#4e7a33` | `#2b4d24` |
| Deciduous olive-gold | `#c6c05e` | `#9aa032` | `#767d20` | `#4d5416` |
| Blossom A (pale pink) | `#f0c9e2` | `#dfa6cf` | `#b478ae` | `#7e5279` |
| Blossom B (orchid) | `#e3aed6` | `#d092bb` | `#b76fa6` | `#8d4f86` |
| Blossom C (violet) | `#c19bd8` | `#a273b8` | `#7a5292` | `#5d3a58` |
| Bamboo | `#b5d96e` | `#8fbf4e` | `#55842f` | `#2f5522` |

### Architecture & props
| Name | Hex | | Name | Hex |
| --- | --- | --- | --- | --- |
| CASTLE_STONE_LIT | `#e8e3d3` | | VILLAGE_ROOF (slate) | `#3f4450` |
| CASTLE_STONE_MID | `#c2bdac` | | VILLAGE_ROOF_RIDGE | `#9aa0a8` |
| CASTLE_STONE_SHADOW | `#8e8b7d` | | VILLAGE_WALL | `#d9c9a8` |
| ROOF_COBALT_LIT | `#5477c8` | | VILLAGE_WOOD | `#6b4a2e` |
| ROOF_COBALT | `#35549c` | | VILLAGE_RED accent | `#b0453c` |
| ROOF_COBALT_SHADOW | `#232f56` | | FENCE / TRESTLE WOOD | `#5d4226` |
| ROOF_SPEC streak | `#b9c6e4` | | FLOWER_WHITE | `#efeadb` |
| GOLD_TRIM / finial | `#d9b542` | | FLOWER_GOLD | `#e5c95c` |

### Light & atmosphere
| Name | Hex | | Name | Hex |
| --- | --- | --- | --- | --- |
| SUN | `#fff1d0` | | FOG | `#bcc8b2` |
| SKY_ZENITH | `#7ba7d6` | | AMBIENT_SKY (hemi top) | `#b9cbd8` |
| SKY_HORIZON | `#d9e4da` | | AMBIENT_GROUND (hemi bottom) | `#66744f` |
| CLOUD_LIT | `#f6f8f1` | | SHADOW_TINT (shadowed-area target) | `#2c4a44` |
| CLOUD_SHADOW | `#b9c6cf` | | CONTACT_SHADOW | `#241611` at 55 % α |

### Hero & mount (sampled off frame01 sprite)
| Part | Lit | Shade |
| --- | --- | --- |
| Skin | `#e8c9a8` | `#b08c6c` |
| Hair (blond, spiky) | `#e8cf6f` | `#b3873a` |
| Coat red | `#a03028` | `#5c1c14` |
| Coat black | `#37302e` | `#1d1815` |
| Trim gold | `#d9b542` | `#8a6d24` |
| Cape (blue-white) | `#dce4ea` | `#8fa3b8` |
| Mount (golden bird) | `#e0a844` | `#976d2c` — beak/legs `#d97f2e` |
| Sprite outline | `#1d1410` (warm near-black) | |

---

## 4. LIGHT RIG (numbers to type in)

| Parameter | Value |
| --- | --- |
| Sun azimuth / elevation | **250° / 58°** (azimuth from north, clockwise; sun in the WSW, high). Unit direction *toward* the sun: **(−0.498, 0.848, +0.181)** in (E, up, S) axes — e.g. `sun.position.copy(dir).multiplyScalar(180)` |
| Why | Castle and cliff lit faces are their W/SW sides; spire highlight streaks sit left-of-axis; contact shadows are near-centred blobs (short — high sun). Screen-space: **key from upper-LEFT** with camera at yaw 0. |
| Sun colour / intensity | `#fff1d0`, **2.6** (with ACES tonemap + exposure 1.05) |
| Hemisphere | sky `#b9cbd8` / ground `#66744f`, intensity **0.55**. No other ambient. |
| Shadow map | 2048², PCF-soft, radius 4 (penumbra ≈ 0.3 m at 3 m occluder height), `bias −0.0006`, `normalBias 0.02`, ortho frustum 140×140 m centred ahead of camera, far 200 |
| Shadow floor | Shadowed ground must land near SHADOW_TINT `#2c4a44` × material — never below ~45 % of lit value, never colourless |
| **Fog** | colour `#bcc8b2`, **exp2, density k = 0.0072** (40 % fogged at 100 m, 69 % at 150 m, 87 % at 200 m — top-of-frame silhouettes survive, detail does not) |
| Fog height falloff | density × `exp(−max(0, y − 8) / 38)` |
| Waterfall mist | +15 % local fog/mist sprites within 30 m of the falls base, below y 12 |
| Sky dome (unseen in-shot but feeds hemi/water) | zenith `#7ba7d6` → horizon `#d9e4da`, soft cumulus `#f6f8f1` / `#b9c6cf`, sun disc tint `#fff1d0` |
| Sprite lighting | Billboards are **lit** (frames 3–5 prove per-scene lighting): normal = blend(up, −viewDir, 0.35), receive sun + hemisphere + fog. Never `MeshBasicMaterial`. |

---

## 5. SCALE CHART — the miniature contract

**Depth-corrected measurements** (screen size × distance-ratio vs the hero) — this is where
the illusion lives, and where REFERENCE_MEASURED.md was most wrong (§10). The trick is not
"big trees": it is that **the whole world is a toy and the hero is a giant in it.** A real
conifer is 8–12× a person — here it is **1.75×**. A real castle is 25–40 m — here the entire
castle is **6.5 m, about 4× the hero.** Landforms depict 100 m mesas with 10 m steps. Build
the metres below literally; do not "correct" them toward realism, and do not inflate trees
toward the old 3× figure.

| Asset | Height (m) | ×Hero | Notes |
| --- | --- | --- | --- |
| **Hero, standing** | **1.60** | 1.0 | 60 px on the 921-px frame at §2 camera |
| Hero mounted (unit) | 2.40 | 1.5 | |
| Conifer, common | **2.2–3.4, mode 2.8** | 1.4–2.1 | Rare "landmark" pines to 4.5, never > 5. Width ≈ 0.55× height |
| Deciduous crown | 1.5–2.4 tall | 0.9–1.5 | **Crown width 1.3× its height** — wider than tall, always |
| Blossom tree (F2 biome) | 1.6–2.4 | 1.0–1.5 | |
| Bamboo cane clump | 2.0–3.0 | 1.3–1.9 | |
| Bush | 0.5–0.9 | 0.3–0.55 | |
| Rock / boulder | 0.4–1.2 / 1.5–2.5 | — | |
| Grass tuft / fern | 0.25–0.4 | — | |
| Wheat stalk | **0.75–0.95** | 0.5 | Reaches the mount's belly — wheat stays near-real scale |
| Fence post | **0.5** (rails at 0.22 / 0.42, span 1.3) | 0.31 | Toy fence; do not enlarge |
| Signpost | 1.3 | 0.8 | |
| **Castle, tallest spire tip** | **6.5** (keep roofline 4.2, curtain wall 2.6, gatehouse 3.4, gate arch 1.9) | **4.1** | Footprint 15×12 m. Monumentality comes from spire *count* and silhouette, not size |
| Village house ridge | 2.2–2.8 | 1.4–1.75 | |
| Trestle bridge | span 12, deck width 1.1 | — | Log bridge north: span 9 |
| Road width | **2.6 core + 1.2 feather each side** | 1.6 | |
| River width | 3–6 | — | Waterfall drop 9 |
| Cliff bands (terraces) | 4–11 per step | — | |
| Pier | 5 long, deck +0.4 above sea | — | |

Per-instance scale jitter is mandatory: height ×U(0.82, 1.24), independent width jitter ±8 %
(see §8). **Uniform tree size is a hard fail.**

---

## 6. PIXEL-ART RULES

- **Texel density: 30–40 texels per world-metre for every billboard**, so all sprites land at
  1.6–2.2 screen px per texel in the focus band at the §2 camera. Sprites must never be
  minified below 1 : 1 in the sharp band (mips + anisotropy handle the hazed distance).
- **Atlas cells** (px, alpha-cut): pine 64×112 (incl. 8 px trunk), oak 96×80, blossom 88×72,
  bamboo 48×96, bush 48×32, rock 48×36, boulder 64×48, tuft 24×20, wheat 40×28, fern 32×24,
  flower 20×20, stump 40×28, log 48×24, cattail 24×40, lilypad 32×16.
- **Hero sheet**: 48×64 per frame (contract minimum), hero 56 px tall in-cell → world sprite
  plane 1.83 m so the body reads 1.60 m. Mount frames 64×64.
- **Ramp depth: 4 shades per material + HI speckle + outline = max 6 indices.** No gradients.
- **Outline rule**: 1 px full outer silhouette in an ultra-dark **colour-matched** shade
  (~15 % value, hue kept — pine outline `#12240f`, never black). Interior forms separate by
  shade steps only, no interior lines. **Hero/mount get the stronger warm near-black
  `#1d1410` outline** — the character must pop harder than vegetation.
- **Dithering: none.** No checkerboards anywhere on sprites. Speckle stipple is allowed only
  as single-pixel HI dots on lobe tops and in ground *textures* (wheat, grass macro).
- **Light in sprite space** (sun WSW, §4): HI speckle and the lightest shade cluster on the
  **top-left of every lobe/tier**; SHADOW pools bottom-right and under each shelf; plus a
  **1 px pale rim on the RIGHT silhouette edge** (mint `#7fae6a`-class for greens), covering
  ~40 % of that edge — this is the bounce that lifts crowns off dark backdrops (visible all
  over frame01's road conifers).
- **Shape language (must read at 40 px):**
  - *Conifer*: stepped triangle of 3–5 lumpy shelf-tiers with ragged notched edges, frosted
    tops, visible 2 px trunk foot. Silhouette survives 2-value posterize.
  - *Deciduous*: broccoli — 5–9 puffball lobes in 2–3 stacked shelves, wider than tall,
    flat-ish frosted tops, deep V-notches between lobes, tiny trunk.
  - *Blossom*: grape-cluster of 6–12 round puffballs, 2–3 pink values speckled per crown,
    plum undersides (see F2 crops).
  - *Rock*: 3 hard facets — lit top plane, mid face, dark base; no rounding.
  - *Wheat*: vertical stalk cluster, pale seed-head tips (WHEAT_TIPS) over darker body.
- Billboards Y-axis-locked, anchored at the base pixel row; bases sink 2–3 texels into
  ground contact (§8 forbids floating).

---

## 7. POST-PROCESSING RECIPE (starting values, in order)

Pipeline order: **bloom → ACES tonemap → grade → tilt-shift → sharpen → chromatic aberration
→ vignette → grain.**

| Stage | Values |
| --- | --- |
| Bloom | threshold **0.72** (post-exposure luma), strength **0.30**, radius **0.85**, 5 mips. Only foam, falls, wheat tips, castle stone and sea glints may pass threshold. |
| Tonemap | ACESFilmic, exposure **1.05** |
| Grade (LDR, GLSL-exact) | `l = luma(c);` `c += (1.0 − smoothstep(0.0, 0.35, l)) * vec3(0.020, 0.030, 0.026);` *(cool-green lifted blacks — measured deep shadow is `#1e2e1a`, never 0)* then `c *= mix(vec3(1.0), vec3(1.05, 1.01, 0.94), 0.8 * smoothstep(0.25, 0.75, l));` *(warm cream mids/highs)* |
| Saturation | ×**1.08**, then desaturate highlights 10 % toward `#fff3dc` above l 0.8 |
| **Tilt-shift** (screen-space band — the signature) | Focus centre **0.52 fh**; full-sharp band **0.25–0.79 fh**; ramp widths **0.12 (top) / 0.10 (bottom)**; max blur **7 px top / 5 px bottom at 1080p** (scale linearly with viewport height). Gaussian. The hero at 0.50–0.55 fh must always be inside the sharp band, pixel-crisp. |
| Sharpen | Unsharp **0.30**, radius 1 px, **masked to the sharp band only** |
| Chromatic aberration | Radial, **1.6 px at 1080p corners**, zero inside r < 0.55, R out / B in |
| Vignette | Starts r 0.62, strength **0.24**, smooth falloff |
| Grain | Animated luma-only, amplitude **0.032**, 1 px |

DOF was verified by a 36-band gradient-energy profile of frame01: soft ≤ 0.10 fh, ramp to
~0.24, sharp through ~0.80, soft ≥ 0.90 — the old 0.72-fh sharp-band end in
REFERENCE_MEASURED is too early (§10).

---

## 8. DENSITY & COMPOSITION RULES

**Placement law: clumps + voids, never carpet.** Clump centres from low-frequency noise
threshold; blue-noise spacing inside clumps; genuinely empty pasture between.

| Zone | Density |
| --- | --- |
| Forest clumps | **260–420 trees/ha inside the clump**: crown spacing 1.2–2.2 m, crowns overlapping 20–40 %, no ground visible inside; clumps of 6–30 trees; gaps of 8–30 m between clumps |
| Ecotone | Outrider clusters of 2–5 trees off clump edges — edges ragged, never convex-smooth |
| Open pasture | 0–8 lone trees/ha (anchored to fences, rocks, forks); ~400 tufts/ha + flower accents |
| Roadsides / cliff lips / river banks | Trees crowd here: 1–3 m off the road shoulder along ~35 % of its length; lines of *varying* species and size, never picket rows |
| Global budget (512² map, ~19 k instances) | conifer 2600 · oak 1900 · bush 2300 · rock+boulder 950 · tuft 9000 · wheat 1300 · flower 700 · fern 500 |

Jitter (mandatory, per instance): height ×U(0.82, 1.24); width ±8 % independent; tint ±6 %
value, ±4° hue; adjacent neighbours must differ by ≥ 6 % scale or ≥ 3° hue.

**NEVER (hard fails):** bare terrain — any 40 m² of grass without a tuft/rock/flower; grid or
lattice alignment; 3+ same-species same-scale in a row; uniform tree size; visible texture
tiling (macro-noise ≥ 3 octaves on every ground material); billboards floating or clipping
slopes > 35° (use rocks there); crowns intersecting cliff faces; missing contact shadows —
**every billboard gets an elliptical `#241611` blob, radius 0.9× crown radius, α 0.5, 40 %
feather**; hero blob 1.1×0.5 m α 0.55.

Wind: crowns sway 0.8–1.2° at 0.4–0.7 Hz, per-instance phase; wheat 2× amplitude; tufts 1.5×.

**Eye path (composition contract):** enter at the road bottom-centre → hero (sharp band) →
west along fence lines to the golden wheat → up the road switchback → waterfall's white
accent → terminate on the castle's cobalt-and-gold. An S-curve with all high-contrast accents
(foam, wheat, castle stone) inside the sharp band; both blur bands stay low-contrast haze.

---

## 9. UI STYLE

**Minimap** (top-right; measured off frame01 — bigger than the old doc claimed):
- Panel **0.20 fw wide × 0.32 fh tall** (320×288 px at 1600×900), inset **0.010 fw from the
  right, 0.022 fh from the top**. Outer corner radius **12 px**.
- Fill: `rgba(13, 18, 14, 0.60)` glass + subtle vertical lighten at top; drop shadow
  `0 6px 18px rgba(0,0,0,0.45)`.
- **Inner hairline frame**: inset 14 px, radius 9 px, 1.5 px stroke `#d8dcd2` at 55 % α.
- Map art (parchment style, north-up, rendered from biome data): water `#1d2b26`, land
  parchment `#a3835f` lit / `#6f5a40` relief-shade, forest stipple `#55603a`, mountain hatch
  `#7d7464`, roads 1 px `#c9ac74`, river/lakes `#3e6472`.
- Pins: quest = **cyan shield-teardrop** `#3fc9f2`, 18×22 px, white `!`, 1.5 px white outline,
  2 px drop shadow; rare quest = **gold diamond** `#eac93f` 20×20 px (45°-rotated square)
  with `#3a2f10` `!`; towns = 5 px dots `#f5efdd` at 80 %; player = 14 px white chevron
  arrow with a soft cyan glow.
- **Nameplate** (top-left): "GRANDPINE FIELDS — Ferren Coast" — serif small-caps (Georgia /
  'Times New Roman'; no webfonts allowed), 20 px, `#f2ead8`, letter-spacing 0.12 em, on a
  pill `rgba(10, 14, 10, 0.45)` with a 1 px gold hairline `#c9a84c` underline, soft shadow.
  Fades in over 0.6 s.
- Everything anti-aliased and designed (frames 4–5 grammar: thin light borders, dark glass,
  cyan/gold accents). No default-browser styling, no debug text.

---

## 10. CORRECTIONS to REFERENCE_MEASURED.md (measured, binding)

1. **Camera pitch is ~28°, not 50–55°.** Three independent foreshortening measurements
   (mount shadow ellipse, wheat-patch ellipse, castle wall-to-walkway ratio) all give 21–29°;
   at 50° the spire cones would show their tops — they show their sides.
2. **The scale chart was not depth-corrected.** Hero is 0.065 fh (60 px/921), not 0.055.
   Conifers are **1.4–2.1× hero** (screen-measured 58–170 px *at nearer depths*), not
   2.5–3.5×. The castle is **~4× hero (6.5 m)**, not 12–15× — it stands 228 px vs the 60 px
   hero at equal depth. Deciduous crowns 0.9–1.5× hero, wider than tall.
3. **Sharp band runs ~0.25–0.80 fh** (gradient-energy profile), not 0.22–0.72; bottom blur is
   the milder side.
4. **Shadows rotate toward teal-green, not blue-violet**: sampled deep shade holds green
   (`#1e4821`, `#22481a`); the cool cast at distance comes from the sage fog `#bcc8b2`.
   Grass lit is `#62902e`-class, not `#8fae52`; road lit `#c39a5c`, not `#d3b585` (those were
   haze-polluted samples).
5. **Ocean reads desaturated slate-teal through the grade** (`#2e6f95` mid), never navy; the
   saturated cyan belongs to the **river** (`#2f9ec9`, sampled `#259dc8` in F2).
6. Minimap is **0.20 fw × 0.32 fh** with a nested hairline (not 0.16×0.28), inset ~0.01 fw.
7. The west crossing is a **timber trestle bridge** (posts + planked deck, F1 upper-left),
   not a rope bridge.
8. "Yellow-green deciduous" trees are **olive-gold** (`#767d20`-class), not golden-yellow.

## The five instant fails (unchanged, and enforced)
1. Realistic vegetation/architecture scale (see §5). 2. Uniformly sharp frame (see §7).
3. Uniform scatter density (see §8). 4. Sprites without contact shadows (see §8).
5. Grey/violet or crushed-black shadows (see §3/§4).
