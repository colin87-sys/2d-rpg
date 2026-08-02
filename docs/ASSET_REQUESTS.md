# ASSET REQUESTS — what to generate, and to what spec

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
