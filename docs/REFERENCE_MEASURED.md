# Measured Reference Data

`REFERENCE.md` describes the target look in prose. This file is the same five frames read
**quantitatively** — colours sampled by eye off the actual pixels, proportions measured as
fractions of frame dimensions, scale ratios counted against the character sprite.

Nobody on the implementation team can see the reference images. These numbers are the closest
thing to seeing them. **Prefer a number in this file over your own intuition.** Where the art
bible and this file disagree on a colour or a proportion, this file wins and the art bible
should be corrected.

All screen-space measurements are fractions of frame height (`fh`) or frame width (`fw`),
normalised from a 16:9 frame.

---

## Frame 1 — grasslands + royal castle

### Camera and composition
- Downward pitch reads as **50–55°**. Not a top-down map view and not a third-person chase cam.
- Very little perspective convergence across the frame → a **long lens**, roughly 24–28° vertical FOV.
- Horizon is **above the top edge** — no sky is visible at all. The frame is 100% terrain.
  This is important and easy to get wrong: the diorama fills the frame edge to edge.
- The eye enters at the road in the lower-right foreground, follows it left and up through the
  midground fields, and terminates on the castle at the right third. Classic S-curve read.

### Depth of field (the single most identifying feature)
- Top **~0.00–0.13 fh**: strongly defocused. Individual trees are soft coloured masses.
- **~0.13–0.22 fh**: transition ramp.
- **~0.22–0.72 fh**: the sharp band. Sprites here are crisp to the pixel.
- **~0.72–0.88 fh**: transition ramp.
- Bottom **~0.88–1.00 fh**: strongly defocused again.
- So: focus band centred at roughly **0.47 fh**, sharp core about **0.50 fh** tall, with ramps
  of about **0.10 fh** on each side. Max blur radius at the extreme edges is large — perhaps
  6–8 px at 1080p — enough that foreground tree crowns become unreadable blobs.

### Sampled palette
| Role | Hex (approx) |
| --- | --- |
| Grass, sunlit | `#8fae52` |
| Grass, mid | `#6f9243` |
| Grass, shadow (cool) | `#4e6d3e` |
| Dirt road, lit | `#d3b585` |
| Dirt road, shadow | `#a88a5f` |
| Cliff rock, lit | `#bcc2b4` |
| Cliff rock, mid | `#8d948a` |
| Cliff rock, shadow (cool) | `#697470` |
| Ocean, deep | `#1d4f7a` |
| Ocean, mid | `#2a6ea8` |
| Ocean, shallow turquoise | `#4fb3c9` |
| Surf / foam | `#eef6f7` |
| River water | `#3f92c4` |
| Conifer, lit tier | `#4e7c3c` |
| Conifer, mid | `#375e2d` |
| Conifer, shadow | `#24401f` |
| Deciduous, yellow-green | `#93b04c` |
| Deciduous, mid green | `#5f8a3e` |
| Wheat field, lit | `#e2c85e` |
| Wheat field, mid | `#c6a83f` |
| Castle stone | `#e9e4d6` |
| Castle stone shadow | `#bfbaa9` |
| Castle roof, cobalt | `#33529f` |
| Castle roof, highlight | `#4a6fc6` |
| Gold finial / trim | `#e0b34a` |
| Shadow tint on terrain | cool, blue-violet shifted — shadows are **not** just darker grass, they rotate toward `#4a6a6b` |

### Scale, counted against the hero sprite
The hero is roughly **0.055 fh** tall on screen (≈60 px at 1080p). Measuring everything against
that gives the scale chart the whole look depends on:

- **Conifers: 2.5–3.5× hero height.** The tallest ones approach 4×.
- **Deciduous crowns: 2–3× hero height**, and noticeably *wider* than tall.
- **Bushes: 0.5–0.8× hero.**
- **Fence posts: ~0.6× hero.**
- **Castle keep: ~12–15× hero.** The castle is genuinely monumental against the figure.
- **Road width: ~2.5–3× hero height.**
- **Wheat field patch: ~15–20× hero across.**

This is the miniature trick: a real conifer is 8–15× a human. Here it is **~3×**. Vegetation is
deliberately scaled up by roughly **3–4×** relative to reality, which is what makes the terrain
read as a tabletop model rather than a landscape. **If trees are realistically scaled the whole
illusion collapses**, and this is the most common failure mode.

### Density
- Tree cover on the forested slopes is genuinely **dense — crowns overlap and occlude each other**,
  with essentially no visible ground between them in the clumps.
- Open pasture is genuinely **empty** — large clean areas of grass with only grass tufts.
- The contrast between dense clumps and empty pasture is what makes it read as organic. Uniform
  medium density everywhere is the amateur tell.
- Clump edges are **ragged and irregular**, and trees crowd along the road edges and ridge lines.

### Other observations
- Every tree has a small, soft, dark **elliptical contact shadow** at its base. Without these,
  billboards float.
- Cliff faces show **horizontal strata banding** — the rock is layered, not a noise texture.
- The road has **soft feathered edges** blending into grass over roughly a third of its width.
- Bloom is present but restrained: it sits on the brightest grass highlights and the white castle
  stone. It does not wash out the frame.
- Minimap panel occupies roughly **0.16 fw × 0.28 fh**, inset about `0.02 fw` from the top-right.
  Corner radius is small, maybe 8–10 px. Dark translucent fill, thin light-grey border, and a
  visible drop shadow separating it from the world.

---

## Frame 2 — cherry-blossom valley

### Palette additions
| Role | Hex (approx) |
| --- | --- |
| Blossom, light pink | `#eeb2ce` |
| Blossom, mid pink | `#dc8fb6` |
| Blossom, deep magenta-pink | `#c26a9c` |
| Blossom, lavender variant | `#b892d0` |
| Bamboo, bright green | `#7ec24a` |
| River, bright cyan | `#4fc4e6` |
| Rapids / white water | `#f2fbfd` |
| Headland grass, golden-tan | `#b9a961` |
| Village roof, dark slate | `#3b404b` |
| Village accent red (bridge) | `#b8443a` |
| Sunlit ocean specular | `#a4dbe9` |

### Observations
- The blossom trees use **three distinct pink ramps intermixed within a single stand**, not one
  pink recoloured. That variation is what stops a mass of pink reading as a flat blob.
- Blossoms are **interleaved with dark conifers**. The dark green is what makes the pink sing —
  a pure pink hillside would read as noise. Do not build a monoculture stand.
- The river is much **more saturated and brighter** than the ocean — it reads as an accent
  colour, almost a light source, cutting a Z through the frame.
- Terrain here is **more vertical**: steeper cut banks, a gorge, two waterfall drops.
- Same DOF band and same camera language as Frame 1 — confirming these are systemic, not per-shot.
- The ocean on the right has a broad **specular sheet** where the sun hits it, blowing to near
  white. The ocean is not a flat blue plane.

---

## Frames 3–5 — story and battle staging

Out of scope for this overworld POC, but they establish two things that constrain it:

- **Sprite lighting is per-scene, not baked.** The same characters are cool-rim-lit at night on
  the airship deck, warm in torchlight in the stone hall, and desaturated through fog on the
  highland. Sprites must take the scene's light, ambient and fog — a flat unlit sprite material
  would be wrong.
- **Silhouette carries readability.** In the fog frame, the characters are nearly value-flattened
  and still perfectly readable purely by outline. Every sprite must survive that test.

---

## The five things most likely to sink this

Ranked by how immediately they give the game away:

1. **Realistically-scaled vegetation.** Kills the miniature illusion outright. See the scale chart.
2. **A uniformly sharp frame.** No tilt-shift = no HD-2D, no matter how good the world is.
3. **Uniform scatter density.** Real reference has dense overlapping clumps *and* genuinely empty
   pasture. An even carpet of trees reads as procedural immediately.
4. **Sprites without contact shadows.** They float and look pasted on.
5. **Warm or neutral shadows.** Reference shadows rotate cool/blue-violet. Shadows that are just
   a darker version of the lit colour make the whole frame look muddy and cheap.
