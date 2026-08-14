# ASSET REQUESTS — round 2

Batch 1 and 2 are complete and verified (`node tools/import-assets.mjs` passes on all nine).

**There is exactly one asset I need: the hall dragon.** Everything else below is deliberately
*not* being requested yet, and section 3 says why — so you don't spend generations on things
that won't move the needle.

The universal rules in `ASSET_REQUESTS.md` §0 still apply: PNG with real alpha, one subject
per sheet, identical character scale across frames, generate as large as the model allows.

---

## 1. THE DRAGON — hall enemy · painterly · **the one blocker**

This is the focal point of the `frame04` battle and the last fully procedural element in it.
The critic's verdict on the code-drawn version was *"a cute vector bird-blob, not a painterly
dragon — the enemy-as-spectacle hierarchy collapses."* You've already proven this exact class
of art works: the Bahamut sheet you generated earlier is the standard to hit.

### Spec

| Property | Value |
| --- | --- |
| Treatment | **Painterly** — 8–12 tone ramps, soft blends, dark edge glaze, scene-keyed rim light, **no pixel outline** |
| Sheet | 2048 × 2048, **4 columns × 4 rows**, 512 px cells |
| Frames | **13**: `idle(4) attack(4) hit(2) death(3)`. Cells 13–15 empty |
| Facing | **RIGHT (east)** — the party stands stage-right; the dragon must look toward them |
| Proportions | Wing crest **6.0 m** ≈ 3.75× the 1.6 m hero · shoulder hump 3.4 m · nose-to-tail ≈ 9.5 m |
| Head height | **Held LOW, around 1.4 m — at the hero's eye line.** This is the menace: it is not rearing up, it is looking straight at them |
| Anchor | Bottom-centre, forefeet planted |

### The one thing that matters most

The bible calls the enemy *"a wall of painting"* — roughly 4× the hero and **12–20× his
screen area**. The party are small pixel figures; the dragon is the spectacle. Build it heavy
and wide, filling its cell. Tail and wingtips may run right to the cell edge.

### Prompt

```
Painterly monster sprite sheet for a 2D JRPG boss battle, 4 columns by 4 rows of evenly
spaced animation frames, the identical original dragon in every single frame with perfectly
consistent design, anatomy, colour and scale across all frames, pure transparent background,
professional game asset sheet presentation, full side profile facing RIGHT in every frame.

The creature is an original ancient armoured dragon: a heavy quadrupedal western dragon with
a broad armoured chest, a thick muscular neck held LOW so the head sits level and forward
rather than reared up, powerful haunches, vast leathery wings half-furled, and a long spined
tail curling behind it. Deep slate and iron scales over a chest of layered antique-gold
lamellar plating, a crown of swept-back bone horns, torn wing membranes veined with dull
amber, ivory claws and fangs, and molten orange light leaking between the chest plates and
from the throat. Heavy, ancient, scarred.

The thirteen frames in reading order: 1-4 idle, breathing slowly with the chest plates
lifting and the wings shifting; 5-8 attack, rearing back then lunging forward with jaws wide
and fire building in the throat; 9-10 hit, head snapping aside with the body recoiling;
11-13 death, collapsing forward onto the forelimbs then down, wings folding, light in the
chest going out.

Render style: richly painted digital illustration with soft blended shading, eight to twelve
tone steps per material, a dark glaze along the silhouette edge, and a cool rim light down
the right side. Absolutely no pixel-art outline, no cel shading, no flat colour fills.
Dramatic top-left key light, deep saturated shadows that keep their hue and never go grey or
black.

The dragon is massive and fills its frame — a wall of painting, heavy and wide, roughly four
times the height of a human figure. Each frame fully contained with even spacing, nothing
overlapping between frames, all thirteen at identical scale.

No text, no watermark, no logos, no labels, no numbers, no frame borders, no grid lines, no
drop shadows on the background, no ground plane, no scenery, no other creatures, no human
characters, no duplicate heads, no extra limbs, no distorted anatomy, no photorealism, no 3D
render, no smooth airbrushed shading.
```

Save as `assets/enemies/hall-dragon.png`.

---

## 2. If the dragon comes out well — one optional extra

Not blocking, and only worth doing if you're generating anyway:

**A third enemy for encounter variety** — something small and numerous to fight alongside the
boss, since a battle system with exactly two enemies in the whole game is thin. Painterly,
facing right, 4 × 3 grid of 512 px cells, frames `idle(4) attack(4) hit(2) death(2)`. Wolf,
armoured knight, or elemental — your call, but keep it **under 2 m** so the dragon still
reads as the spectacle.

---

## 3. What I am deliberately NOT asking for

Being explicit so you don't burn generations on these.

**Overworld vegetation.** The adversarial critic rated the hand-coded pines *"genuinely good
— varied sizes, proper shape language"* and was clear the failure was **placement, not art**.
Generated trees would replace the one part of the overworld that's working.

**Cliff and rock textures.** Tempting — the cliffs have now failed three critique rounds with
the same complaint ("wavy elevation-following bands, not sculpted bench strata"). But I don't
yet believe a better texture fixes it. The last round rebuilt the cliff bands as real stepped
geometry and gated the strata material to near-vertical faces, and the critic *still* saw
contour stripes plus "scratch glyph" artefacts on flat ground. That pattern says the gating
mask is inverted or applied pre-normalisation — a shader bug, not a texture problem. **A
hand-painted texture fed through a broken mask will still read as contour lines.** Let me
confirm or kill that bug first; if the mask turns out to be correct and the material is
genuinely the weak link, I'll ask for a strata set then.

**Terrain, water, roads, castle, bridges.** Geometry and shaders. A PNG cannot fix a missing
waterfall or a mis-placed massif.

**UI, minimap, HP bars, damage numbers, battle VFX.** All procedural, all currently rated the
strongest systems in the build. The battle UI in particular the critic scored well.

---

## 4. What happens when the dragon arrives

1. `node tools/import-assets.mjs` — verifies size, alpha, empty cells, edge bleed, foot
   anchors, and per-animation scale consistency.
2. Add it to `assets/manifest.json` alongside the other atlases.
3. Swap `src/battle/art/enemySprite.js` (1,131 lines of drawing code) for a loader, and point
   the hall encounter at the sheet.
4. Re-render both battle variants and put the critic on them.
