# Visual Reference — what we are matching

Target: the look of **Final Fantasy Brave Exvius / "FF Resonance"**-class HD-2D — high-res
2D pixel-art sprites composited into a lit 3D miniature-diorama world, shot with a long lens
and heavy tilt-shift. This document is the ground truth for the art bible, every
implementation module, and the critic. It is written from five reference frames.

## Frame 1 — Overworld: grasslands and the royal castle

A steep high-angle camera (~45–55° down) looking across a green coastal shelf. Depth of field
is strong: the top and bottom eighths of the frame fall out of focus, the mid-band is razor
sharp — the world reads as a **physical tabletop model**, not a landscape.

- **Terrain**: rolling green grass with subtle value variation, cut by a winding pale-ochre
  dirt road that runs from the lower-right foreground up to the top-left horizon. The road has
  soft feathered edges into the grass, never a hard stencil.
- **Cliffs**: pale grey-green limestone escarpments with flat plateau tops, banded strata, and
  hard silhouettes. A waterfall pours off one plateau into a short blue river that snakes to
  the right. Cliff faces are noticeably desaturated and cool against the warm grass.
- **Coast**: on the left, cliffs drop into deep blue ocean with a bright turquoise shallow
  band and a thin white surf line hugging the rock. A small wooden pier juts out.
- **Vegetation**: dense **pixel-art tree billboards** — dark-green conifers with stacked
  triangular tiers, and rounder mid-green and yellow-green deciduous crowns. Trees clump
  organically along road edges and ridge lines, thinning on open pasture. Each tree has a
  small soft contact shadow. Their scale is deliberately large relative to the terrain — this
  is what makes the world feel like a model.
- **Props**: a white-stone castle with cobalt-blue conical spires, gold finials, arched gate
  and curtain wall sits on a plateau at the right. Wheat fields fenced with thin wooden posts
  sit mid-frame, golden-yellow against green. A rope bridge spans a gorge at the top. A small
  wooden signpost sits at a fork.
- **Character**: a single chibi sprite, maybe 60 px tall on a 1080p frame — blond spiky hair,
  red-and-black coat with gold trim, a light cape — standing on the road, mounted on a
  golden bird-mount in one frame. Crisp nearest-neighbour pixels; strong dark outline; reads
  clearly against the ground because of a soft drop shadow.
- **UI**: a rounded rectangular minimap in the top-right — dark translucent glass, thin
  light border, a stylised parchment landmass inside, and small blue `!` and gold `!` quest
  pins.
- **Light and grade**: midday sun from the upper-left. Greens are saturated but not neon;
  shadows are cool blue-grey and soft; a gentle warm bloom sits on the brightest grass and on
  the castle's white stone. Overall contrast is medium-high with lifted, slightly cool blacks.

## Frame 2 — Overworld: cherry-blossom valley

Same camera language, different biome. A bright cyan river with white rapids cuts a Z through
the frame and drops over two waterfalls. The left hillside is covered in **pink and lavender
blossom trees** — clustered puffball crowns in three distinct pinks — interleaved with dark
conifers and a stand of bright green bamboo. A Japanese-style village of dark tiled roofs with
a red bridge sits in a pocket of blossoms. The right side is a golden-tan grass headland
falling into a sunlit ocean with a bright specular sheet. The player rides a black armoured
mount with purple wings across a small wooden bridge. This frame proves: **biome variety,
water quality, and saturated colour without losing the painterly grade.**

## Frame 3 — Story scene: airship deck

Night, high altitude. A dark steel deck with railings and towering turbine housings against a
blue-grey cloud bank; god-rays and drifting dust motes. Five chibi sprites stand in a loose
line, rim-lit blue from the sky and warm from deck lights; one kneels in a purple robe. A
subtitle line sits at the bottom. Proves: **sprites hold up in a dramatic 3D set with
volumetric light, and sprite lighting is per-scene, not flat.**

## Frame 4 — Battle: stone hall vs. a dragon

Side-on battle staging in a torchlit stone hall with columns and braziers. A large hand-drawn
dragon (green-and-cream, purple wings, fire mane) on the left; four chibi heroes staggered on
the right. Above: a horizontal **turn-order timeline** with diamond-framed portraits sliding
along it. Bottom: four HP/MP panels with cyan HP bars and blue MP bars and a pink limit gauge.
A magenta column-burst spell VFX with rising sparks plays over one hero, plus a floating
skill-name banner ("Firaga"). Proves: **crisp UI hierarchy, additive VFX with real light
spill, and readable staging.**

## Frame 5 — Battle: misty highland vs. a boss

Same battle grammar in fog. A huge winged sorcerer boss with a white beard and gold-trimmed
robes hovers left, eight heroes right, all silhouetted through cool volumetric fog. Two green
status icons; a "Stonera" banner. Proves: **atmospheric depth, silhouette readability, and
the same UI system under a completely different palette.**

## Non-negotiable qualities the critic scores against

1. **Tilt-shift miniature illusion** — near/far defocus with a sharp band. Without it the
   frame reads flat and cheap immediately.
2. **Pixel sprites stay pixel-crisp** — nearest sampling, no bilinear mush, no post blur on
   the focal band that softens the hero.
3. **Sprite/3D integration** — sprites receive the scene's light and fog, sit in contact with
   the ground via shadows, and never look pasted on.
4. **Silhouette-first vegetation** — tree shapes read at thumbnail size; clumping is organic,
   never grid-like or uniformly scattered.
5. **Painterly colour grade** — cohesive palette, cool shadows, warm key, no muddy greys and
   no oversaturated video-game green.
6. **Density and craft** — no bare terrain, no repeated identical props in a line, no visible
   tiling, no z-fighting, no hard billboard intersections with the ground.
7. **Shipped-game UI** — the minimap and any HUD must look designed, not debug.
