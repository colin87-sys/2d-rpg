# ASSET REQUESTS — what to generate, and to what spec

> ## STATUS — 9 assets received, 1 blocker outstanding
>
> Everything in `assets/raw/`. Batch 1 is complete **except the dragon**; Batch 2 is complete.
>
> | Received | File | Replaces |
> | --- | --- | --- |
> | Rain battler | `battler_rain.webp` 1920×1600 | `makeBattlerSheet('rain')` |
> | Lasswell battler | `battler_lasswell.webp` 1920×1600 | `makeBattlerSheet('lasswell')` |
> | Fina battler | `battler_fina.webp` 1920×1600 | `makeBattlerSheet('fina')` |
> | Lid battler | `battler_lid.webp` 1920×1600 | `makeBattlerSheet('lid')` |
> | Highland boss | `boss_sorcerer_sheet.webp` 1500×1500 | `makeSorcererArt()` |
> | Stone hall backdrop | `bg_stone_hall.webp` 1920×1080 | the whole procedural `hall` set in `arena.js` |
> | Highland backdrop | `bg_misty_highland.webp` 1920×1080 | the whole procedural `highland` set in `arena.js` |
> | Overworld Rain | `overworld_rain.webp` 1536×1152 | `makeHeroSheet()` |
> | Overworld chocobo | `overworld_chocobo.webp` 1536×1152 | `makeMountSheet()` |
>
> **STILL BLOCKING: the dragon (§1.2-equivalent, hall enemy).** It is the focal point of the
> hall frame and the only fully procedural element left in it. The critic's verdict on the
> code-drawn version was *"a cute vector bird-blob, not a painterly dragon — the
> enemy-as-spectacle hierarchy collapses."* Painterly treatment, facing **right** toward the
> party, ~6 m world height, frames `idle(4) attack(4) hit(2) death(3)`.
>
> Note: §1.2 below describes the sorcerer as a pairing for "your dragon" and the universal
> rules reference existing sheets. That text was written before any assets existed and those
> references were speculative — the dragon has never been supplied.
>
> After the dragon, the highest-value requests are the overworld **vegetation** and **cliff/rock**
> sets (see Batch 3 below). The procedural cliffs have failed three critique rounds running.


Generated sprite sheets replace hand-coded Canvas2D art for **characters, creatures and
backdrops only**. Terrain, cliffs, water, roads and camera stay procedural — geometry cannot
come from a PNG, and that is where the overworld's remaining defects live.

Every item below says what it is for, the frames it needs, and the technical constraints the
loader will enforce. Anything marked **BINDING** breaks the build if it is wrong; everything
else I can fix on import.

---

## 0. Universal technical rules (apply to every sheet)

| Rule | Value | Why |
| --- | --- | --- |
| Format | **PNG with real alpha** | BINDING. Your existing two sheets already pass — 76.5 % and 72.6 % fully transparent. Keep whatever step produced that. |
| Background | Fully transparent, or solid pure black if the model will not do alpha | I can key pure black out, but real alpha is cleaner — black keying eats the dark outline pixels. |
| One subject per sheet | Yes | BINDING. Never two characters in one image; they drift apart in style. |
| Grid | Even rows/columns, uniform cell size, generous even spacing | Frames may sit slightly off-centre — my importer auto-trims and re-anchors. What it cannot fix is frames at *different scales*. |
| Scale consistency | **Identical character size in every frame** | BINDING. This is the one thing that ruins animation and cannot be repaired automatically. |
| Resolution | As large as the model will give (2K+) | I downsample. Generating small loses detail permanently. |
| Light direction | **Key from upper-left, cool rim down the right edge** | Keeps every asset consistent with the world lighting rig (sun WSW, elevation 58°). |
| Shadows | Keep their hue, rotated toward teal, never grey / violet / pure black | House law. Pure-black shadows are an instant fail in both bibles. |
| No extras | No text, watermarks, logos, labels, frame numbers, grid lines, borders, ground planes, drop shadows, scenery | The loader has no way to strip these. |

**Two distinct art treatments — do not mix them:**

- **Party characters → pixel art.** Hard-edged pixel clusters, 4 shades per material plus a
  highlight speckle, a 1 px colour-matched outline in warm near-black `#1d1410`, no
  dithering, no gradients. Your hero sheet is already exactly this.
- **Monsters and bosses → painterly.** 8–12 tone ramps, soft blends, a dark edge glaze and a
  scene-keyed rim light, **no pixel outline**. Your dragon is already exactly this.

That split is deliberate — it is how the reference frames read, and it is why your two
existing sheets already look like they belong to the same game.

---

## BATCH 1 — the battle cast (highest priority)

The battle screen has **zero implementation** and is the natural home for generated art: a
fixed proscenium camera, a painted backdrop, and sprites on a stage. It is greenfield, so
nothing has to be un-built first.

### 1.1 — Four party battlers · **pixel art**

Four separate sheets, one per character. Same treatment, same light, same outline colour, so
they read as one party.

**Frames — 29 total, laid out 6 columns × 5 rows (30 cells, last cell empty):**

| Anim | Frames | Notes |
| --- | --- | --- |
| `idle` | 4 | Standing ready, ±1 px breathing motion |
| `ready` | 4 | Steps forward and leans in — the "my turn" pose |
| `attack` | 6 | Full weapon swing with wind-up, contact and recovery |
| `cast` | 6 | Raises weapon/hand, magic gathers |
| `hit` | 2 | Recoiling from damage |
| `ko` | 3 | Falling to one knee, then down |
| `victory` | 4 | Celebration loop |

**BINDING: all frames face WEST — left profile, three-quarter-back at most — except the 4
`victory` frames, which face the camera.** The party stands stage-right and fights an enemy
on the left. Your current hero sheet is front/right-facing, so it cannot be used for battle
as-is; this is the one thing I genuinely need re-generated rather than adapted.

The four characters (design them however you like, these are just roles that give the party
silhouette variety — the critical thing is that four battlers are *distinguishable in
silhouette at 115 px tall*):

| Slot | Role | Suggested read |
| --- | --- | --- |
| 1 | Sword hero | Your existing blue-haired hero, re-posed to west profile — keep the design, it is good |
| 2 | Katana duellist | Taller, leaner, calm stance, long blade |
| 3 | Mage / healer | Robed, staff or tome, floaty silhouette, lightest colour mass |
| 4 | Gunner / engineer | Stocky, goggles, mechanical gear, widest silhouette |

### 1.2 — Highland boss · **painterly**

A second boss to pair with your dragon, for the frame05 environment.

- **Levitating humanoid sorcerer**, no ground contact, robe hem dissolving into fog at the bottom.
- Vertical silhouette (the dragon is horizontal — the contrast is the point).
- Frames: `idle(4) cast(4) hit(2) death(3)` — 13 frames, 4 cols × 4 rows.
- Portrait-ish aspect, roughly 3:4.

### 1.3 — Two battle backdrops · **painted, single image each, no alpha needed**

These replace modelling the arena in 3D. For a fixed camera this is how 2D JRPGs actually do
it, and it will look far better than procedural stone walls.

**A. Torchlit stone hall (frame04)** — 16:9.
Near-black hall, two torch pools and a door glow as the *only* warmth, walls falling to
blue-black, cool slate floor warming only inside torch radius. Stepped platform and a tall
door upstage centre. Deep shadow is blue `#060d18`-class — never pure black, never grey.
Palette: walls `#ac6f40` hot / `#895c3c` lit / `#532f23` mid / `#28242c` dark; floor
`#3c4049` cool / `#5c4c46` warm; steps `#997962`; flame `#f9f3e3` core / `#e99648` mid.
**Empty stage — no characters, no creatures.**

**B. Misty highland (frame05)** — 16:9.
Rock shelf rising gently upstage, tree and rock silhouettes flattened by fog, layered
atmospheric depth, a soft backlight glow disc behind the ridge, ground mist.
**Empty stage — no characters, no creatures.**

---

## BATCH 2 — overworld hero and mount (do after batch 1)

Replaces `src/art/characterSprite.js` (1,342 lines of drawing code). Lower priority than the
battle cast because the overworld's problems are geometry, not sprites — but this is where
the visible quality jump on the existing frame comes from.

### 2.1 — Hero, four-direction · **pixel art**
Your existing hero design, but as a walking set. 12 frames, 4 cols × 3 rows:
- Row 1 — `walk_south` (facing camera) × 4
- Row 2 — `walk_west` (left profile) × 4
- Row 3 — `walk_north` (facing away) × 4

East is mirrored from west on import — do not generate it.

### 2.2 — Mount, four-direction · **pixel art**
A large rideable bird (chocobo-class), same three directions × 4 frames, same treatment.
**Generate it riderless** — I composite the hero on top, so one mount sheet works for any
character.

---

## NOT needed — do not spend generations on these

- **Terrain, cliffs, rock faces, roads, water, the ocean** — all 3D geometry and shaders. A
  PNG cannot fix the massif or the waterfall.
- **Trees, bushes, rocks, grass tufts** — the adversarial critic rated the existing hand-coded
  pixel vegetation *"genuinely good — varied sizes, proper shape language."* The failure there
  was placement, not art. Revisit only if you want a different look.
- **UI, minimap, health bars, menus** — DOM and Canvas2D, pixel-positioned against measured
  reference values. Generated art would be harder to align, not easier.
- **The overworld castle and bridges** — 3D props that must sit on terrain at surveyed
  coordinates and catch scene lighting.

---

## Prompt scaffold

Adapt per asset. The structure matters more than the wording — composition first, identity
second, style third, exclusions last, because image models weight earlier tokens more.

```
[GRID CLAUSE: "Pixel art sprite sheet, N columns by M rows of evenly spaced animation
frames"], the identical original [character] in every single frame with perfectly consistent
design, anatomy, colour and scale across all frames, pure transparent background,
professional game asset sprite sheet presentation, [FACING CLAUSE].

[CHARACTER: build head to toe — hair, face, armour/clothing layer by layer, weapon,
accessories, colours named specifically].

[FRAME LIST: "frames in reading order: 1 ..., 2 ..., ..."].

[STYLE MODULE: pixel-art or painterly block from section 0 above, verbatim].

[LIGHT: dramatic top-left key light with a cool rim down the right edge, saturated shadows
that keep their hue and never go grey or black].

Each frame fully contained with generous even spacing, nothing touching or overlapping,
nothing cropped at the edges, all frames at identical scale.

No text, no watermark, no logos, no labels, no numbers, no frame borders, no grid lines, no
drop shadows on the background, no ground plane, no scenery, no other characters, no
duplicate figures, no extra limbs, no distorted anatomy, no photorealism, no 3D render, no
smooth airbrushed shading.
```

---

## What happens when you send them back

1. **Import pass** — auto-trim each frame, detect the foot anchor, re-pack to a uniform
   power-of-two grid, verify scale consistency across frames and report any that drift.
2. **Loader swap** — `characterSprite.js` and `battlerSheet.js` become loaders returning the
   same `Sheet` shape the contract already specifies, so no other module changes.
3. **Contract amendment** — the "everything procedural, no binary asset files" rule in
   `CONTRACT.md` and `BATTLE_CONTRACT.md` gets scoped down to terrain/world/UI, with
   characters and backdrops explicitly exempted.

Send them in whatever order you generate them; I can wire up batch 1 before batch 2 exists.

---

## BATCH 3 — overworld world art (highest value after the dragon)

The overworld has been through three critique rounds (53 → 68 → partial). Its remaining
failures are concentrated in exactly the places where generated art would help most.

### 3.1 — Vegetation set · **pixel art**, side-on, one sprite per image, transparent

Conifers ×4 with genuinely different silhouettes, deciduous crowns ×4, cherry-blossom ×3 in
distinct pink/lavender ramps, bamboo cluster ×2, bushes ×3, autumn/dead variants ×2.

Critical: the reference has strong **hue variation between neighbouring trees** — olive,
yellow-green and blue-green in one stand. Our procedural atlas is one green with value changes
only, and that flatness is visible at frame scale.

### 3.2 — Rock and cliff set · **pixel art** + one tiling texture

Boulders ×3, rock clusters ×3, scree patches ×2, plus a **tileable cliff-face texture with
horizontal strata**.

This is the overworld's most persistent defect. Three rounds of procedural work have produced
what the critic called *"wavy khaki contour-plywood"* and *"a topographic map, not layered
rock"* — the wrong hue family and no facet structure. Painted strata would end it outright.

### 3.3 — Ground textures · tileable, 1024², hand-painted feel

Grass (with large-scale mottling, not flat), dirt road, sand, bare rock, ploughed field.

### 3.4 — Castle and structures · **pixel art or painted**

The castle is the overworld's landmark and still reads as a toy fort. Either a painted castle
sprite, or a texture set: white stone with masonry coursing, cobalt roof tile, gold trim.
Also useful: village houses ×4 plans, rope bridge, timber trestle bridge, fences, signpost, pier.

### 3.5 — Water · tileable

Water surface, foam/surf edge strip, waterfall sheet, river flow texture.

---

## Explicitly NOT needed

- **VFX.** Spell effects stay procedural. The Firaga burst already casts real light into the
  scene and the critic credited it as "not an additive decal floating on top".
- **UI.** Panels, turn rail and callouts are code-drawn and are our strongest area — rated
  "closest to parity" and palette-stable across both battle environments.
- **Fonts.** System stacks by design; no webfonts.
- **Terrain geometry, camera, lighting rigs.** Geometry cannot come from a PNG. These stay code.
