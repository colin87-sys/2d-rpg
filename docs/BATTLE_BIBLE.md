# BATTLE BIBLE — Aetherbound Battle Screen POC

**Status: BINDING.** Every number here was read off `docs/reference/frame04.png` (the primary
target) and `frame05.png` (the generalisation proof), pixel-sampled by script — colours are
5×5 patch means and mask-cluster means, geometry is edge-detected, and the camera was solved
numerically against the measured anchors (fit rms 0.009). Where this file disagrees with any
prose description, **this file wins.** Where a value is missing, use the nearest analogous
number in this file or in `ART_BIBLE.md` — do not invent a new regime.

Both plates are 1630×921. All screen measurements are given in px at that size **and** as
fractions of frame width/height (`fw`/`fh`) — the fractions are the binding form. Ignore the
capture watermarks listed in `docs/reference/README.md`.

The battle screen must read as the **same game** as the overworld: same palette discipline
(4-shade ramps, no gradients, no dithering on chibi sprites), same colour-matched outlines,
same "shadows keep hue, rotate cool, never grey/black" law, same designed-not-debug UI
grammar (dark glass, thin light hairlines, cyan/gold accents), same post stack family.

---

## 1. STAGING GEOMETRY & CAMERA

Side-on theatrical staging: enemy stage-left, party of four stage-right, on a flat ground
plane, shot with the house long lens from an elevated position. One battle world convention:
**1 unit = 1 m, ground y = 0, +X = party side (screen right), −Z = upstage (away from
camera), +Y up.** The camera does not orbit; the shot is a fixed proscenium.

### Camera (solved against frame04, binding)

| Parameter | Value | Why |
| --- | --- | --- |
| Projection | Perspective, **vFOV 26°** | Same long lens as the overworld — the diorama DNA. Verified: with this lens the solved layout reprojects every anchor below to ±0.008. |
| Position | **(0, 7.0, +14.0)** | Elevated proscenium seat. |
| Pitch / yaw | **12.0° downward / 0°** | Shallower than the overworld's 28° — battle is a stage, not a map. Sprites read in near-profile. |
| Near / far | 1 / 80 | Hall back wall at z −12; highland fog has won by 60 m. |
| Motion | Static during idle. On big casts: **dolly push-in ≤ 0.8 m over 350 ms, return 500 ms**. Never FOV-zoom. | Matches house camera law. |

### Party staging — the zigzag (feet anchors, frame04-measured)

The four are **staggered in two ranks, never a line**. Back rank and front rank are ~5 m
apart in depth; files alternate. Screen fractions are the binding truth; world coords are the
solved layout that reproduces them under the camera above.

| Unit | Rank | Feet world (X, 0, Z) | Feet screen (fw, fh) | Sprite height on screen |
| --- | --- | --- | --- | --- |
| Rain (slot 1) | back | (+0.9, 0, −9.2) | **(0.543, 0.682)** | 0.125 fh (≈115 px) |
| Lasswell (slot 2) | front | (+2.0, 0, −4.4) | **(0.626, 0.836)** | 0.174 fh (≈160 px) |
| Fina (slot 3) | back | (+4.9, 0, −10.5) | **(0.736, 0.649)** | 0.125 fh |
| Lid (slot 4) | front | (+5.0, 0, −5.0) | **(0.804, 0.812)** | 0.174 fh |

- Rank separation on screen ≈ **0.16–0.19 fh** of feet-y; the size difference between ranks
  (1.37×) is pure perspective under this camera — do not hand-scale sprites.
- All party feet stay inside x ∈ [0.53, 0.82] fw, y ∈ [0.63, 0.85] fh. Facing: west (toward
  the enemy), profile view.
- Frame05 proves the staging stretches: 8 units in three loose files across 0.55–0.96 fw,
  feet 0.59–0.82 fh. The POC ships 4 units at the exact anchors above.

### Enemy staging

| Anchor | World | Screen |
| --- | --- | --- |
| Dragon forefeet (ground contact) | **(−3.0, 0, −6.5)** | (0.330, 0.760) |
| Dragon wing crest (top of silhouette) | (−3.4, **6.0**, −7.5) | (0.310, 0.140) |
| Dragon head centre (held LOW, at hero eye-line) | (−1.6, 1.4, −6.2) | ≈ (0.375, 0.59) |
| Full dragon screen bbox | — | x 0.03–0.475 fw, y 0.09–0.77 fh |
| Sorcerer boss (frame05) mass centre — **levitating**, no ground contact | (−2.5, 3.4, −7.5) | bbox ≈ x 0.10–0.43 fw, y 0.03–0.72 fh; robe hem dissolves into fog by 0.72 fh |

The enemy's tail/wings may exit frame-left — the monster is bigger than the frame. Its mass
never crosses **x 0.50 fw**; the duel line between enemy nose and front-rank hero is the
horizontal centre of the frame and stays clear for VFX.

### The set floor

Hall floor is flat y = 0, back wall plane z = **−12**, stepped platform (5 steps × 0.36 m
rise = 1.8 m) from z −10.5 to −11.5 centred on x +0.5, door (3.2 m tall) on the platform at
screen (0.534, 0.20). Highland floor: same anchors on a shelf rising 2° upstage, dressed with
rock knuckles. Arena exposes `groundY(x, z)`; every foot and every contact shadow plants on
it.

---

## 2. SCALE — the monster contract

| Asset | Height (m) | ×Hero | Screen check @ frame04 camera |
| --- | --- | --- | --- |
| **Battle hero (chibi)** | **1.60** | 1.0 | 0.174 fh front rank, 0.125 fh back rank |
| **Dragon, wing crest** | **6.0** | **3.75** | silhouette 0.09→0.77 fh (0.68 fh tall) |
| Dragon shoulder hump | 3.4 | 2.1 | head held DOWN at 1.4 m — menace at hero eye-line |
| Dragon nose-to-tail | ≈ 9.5 (tail coils off-frame) | — | 0.44 fw visible |
| **Sorcerer boss (frame05)** | **6.5 incl. wings, floats 0.6 m off the ground** | 4.1 | 0.69 fh |
| Torch flame | 1.15 | 0.7 | 0.10 fh at the wall |
| Door | 3.2 | 2.0 | — |

The enemy is a **wall of painting** — roughly 4× hero and 12–20× his screen area. Frame05's
boss differs from the dragon in axis (vertical, floating, humanoid) but holds the same 4×
ratio. An enemy under 3× hero is an instant fail; over 5× it crowds the timeline.

---

## 3. ENVIRONMENT A — THE TORCHLIT STONE HALL (frame04)

A near-black hall where **two torch pools and the door glow are the only warmth**. Walls
fall to blue-black; the floor is cool slate that only warms inside torch radius. Deep shadow
is blue `#060d18`-class, never pure black in authored albedo, never grey.

### Palette (sampled)

| Role | Hex | | Role | Hex |
| --- | --- | --- | --- | --- |
| WALL_HOT (inside torch pool) | `#ac6f40` | | FLOOR_COOL (slate, mid) | `#3c4049` |
| WALL_LIT | `#895c3c` | | FLOOR_WARM (torch pool) | `#5c4c46` |
| WALL_MID | `#532f23` | | FLOOR_GROUT | `#23262e` |
| WALL_DARK | `#28242c` | | FLOOR_FG_VIGNETTE | `#142f41` |
| WALL_BLACK (post floor) | `#0a1420` | | STEPS_LIT | `#997962` |
| DOOR_RECESS | `#4e3c28` | | STEPS_SHADE | `#6a5952` |
| FLAME_CORE | `#f9f3e3` | | BRAZIER_BOWL | `#401c0f` |
| FLAME_MID | `#e99648` | | FLAME_BASE | `#af5d21` |
| EMBER | `#b2512e` | | | |

### Light rig (numbers to type in)

| Parameter | Value |
| --- | --- |
| Torch point lights ×2 | at **(∓5.3, 5.4, −10.8)** — screen (0.235, 0.136) and (0.753, 0.136). Colour `#ffa64f`, intensity 40, distance 14, decay 2 |
| Torch flicker | intensity ±12 %, two-octave noise at 7–9 Hz, independent phase per torch; light position jitters ±0.06 m |
| Hemisphere ambient | sky `#2a3448` / ground `#1c1410`, intensity 0.35 |
| Cool front fill | directional from camera-high (+0.2, 0.8, 0.6 toward stage), colour `#4a6a8a`, intensity 0.22 — keeps the foreground slate readable |
| Fog | `#0a1018`, exp2 density 0.012 — the hall drowns, it doesn't haze |
| Flames | 3-layer additive billboards per torch: core `#f9f3e3` 0.45 m, body `#e99648` 0.8 m, tongues `#af5d21` 1.15 m; scroll + flutter 6–9 Hz; 6 embers/s rise 0.7 m/s, life 1.2 s |
| Shadow | torch lights cast none (cost); one shadow map on the cool fill, 1024², PCF, opacity ≤ 0.35 — sprite grounding comes from contact blobs |

Composition: door glow centred (0.534, 0.20), torch pools at the flame anchors with radius
≈ 0.11 fw of strong influence; everything outside pools falls toward `#0a1420` within ~3 m.

---

## 4. ENVIRONMENT B — THE MISTY HIGHLAND (frame05)

Near-monochrome sage fog; readability is **silhouette-first**. The fog is brightest in a
band behind the units and darkens toward the top corners — the boss floats backlit against
the glow.

### Palette (sampled)

| Role | Hex | | Role | Hex |
| --- | --- | --- | --- | --- |
| FOG_BRIGHT (band 0.38–0.51 fh) | `#9fa194` | | GROUND_MID (party line) | `#626e57` |
| FOG_MID | `#969d95` | | GROUND_FG | `#4e5a42` |
| FOG_FAR | `#7b8b83` | | GRASS_PALE tips | `#77775b` |
| SKY_GLOW (top centre) | `#617c7b` | | TREE_SILHOUETTE | `#0a2620` |
| TOP_CORNER (vignette target) | `#022123` | | ROCK_THRU_FOG near→far | `#435e57` → `#143b3a` |

### Fog & light rig

| Parameter | Value |
| --- | --- |
| Scene fog | colour `#8e978d`, **exp2 density 0.028** — at 21 m (boss) darks survive (`#0d110d` robe still reads), detail does not |
| Fog cards | 3 drifting alpha layers at z −4 / −9 / −14, α 0.22 / 0.35 / 0.50, drift 0.15–0.4 m/s, scale 14–24 m |
| Backlight glow | additive disc behind the boss at (−2.5, 3.5, −9.5), radius 6 m, `#b1c0b4`, α 0.35 |
| Key | directional from behind-left-high (−0.4, 0.75, −0.55), `#c9d2c4`, intensity 0.9 — a backlight, not a key on faces |
| Hemisphere | sky `#8a958c` / ground `#3a4434`, intensity 0.55 |
| Ground mist | 8–12 low fog blobs hugging y < 0.6 m among the party, α 0.15, slow churn |

**Readability contract:** after fog and grade, a unit's body mean luma ≤ 0.35 against a fog
band ≥ 0.55 behind it — every sprite must survive a 2-value posterize by outline alone.

---

## 5. SPRITE LIGHTING IN BATTLE — why sprites belong to the set

Billboards use the lit-material law from ART_BIBLE §4 (normal = blend(up, −viewDir, 0.35),
receive scene lights + hemisphere + fog, never `MeshBasicMaterial`). Battle adds four
numeric obligations:

1. **Scene-keyed rim.** A 1-px silhouette rim applied at runtime (offset-mask second pass),
   direction and colour published by the arena: hall → `#ffb47a` at strength 0.55, from the
   nearest of {torch L, torch R, active spell light}; highland → `#cfd6cb` at strength 0.70,
   from above-behind (0, −1 screen). Rim covers 40–60 % of the facing edge, never a full
   halo.
2. **Contact shadow.** Elliptical blob per unit, **0.9 × 0.32 m**, `#10131c`, α 0.55 (hall)
   / 0.38 (highland), 45 % feather. The levitating boss gets a fog-pool disc r 2.5 m α 0.25
   instead. Missing blobs = pasted-on = instant fail.
3. **Spell light participation.** Any VFX point light within 4 m adds its colour to sprites
   up to +35 % (additive). In frame04 Rain inside the burst reads blown warm (`#ffc2a3`
   measured on his robe) — sprites must overexpose toward the spell, not stay flat.
4. **Ground occlusion.** Bottom 15 % of each sprite darkened 12 % — feet sit IN the floor's
   ambient, not on top of it.

Chibi ramps stay 4-shade + HI + colour-matched near-black outline `#1d1410` (hero-class
outline for all four battlers). The fog scene desaturates via fog/grade — never author
desaturated sprites.

### Battle chibi cells

Battle sprites are re-authored at battle resolution, same identity as the overworld sheet:
**96×96 px cells, body ≈ 84 px tall, 52.5 texels/m** (1.5× the overworld's 35) so the front
rank lands at ≈ 2.2 screen px/texel at 1080p and the back rank ≈ 1.6 — inside the house
crispness band. Anims (all facing west toward the enemy, victory faces south):
`idle(4) ready(4) attack(6) cast(6) hit(2) ko(3) victory(4)`.

---

## 6. ENEMY ART — the painterly wall

Enemies are **large hand-drawn painterly sprites** — not chibi, not 3D. This is the FFBE
sandwich: crunchy 4-tone pixel heroes in front of a soft 3D set, facing a painting with 8–12
tones and soft edge glazes. Each rendering language is one step more refined than the layer
behind it; the enemy is the spectacle and the heroes are the toys who fight it. Do not let
the languages bleed: no soft gradients on chibi, no 4-step posterize on the enemy.

| Property | Dragon (hall) | Sorcerer (highland) |
| --- | --- | --- |
| Canvas | **1024×896**, drawn region ≈ 980×840, anchor bottom-centre at the feet anchor, sunk 0.35 m | **768×1024**, anchor at mass centre, floats 0.6 m |
| On-screen | ≈ 722×625 px @1630 → painted at ~1.35× display size, `LinearFilter` + mips (painterly, NOT NearestFilter) | ≈ 530×640 px |
| Ramp depth | 8–12 tones per material, soft airbrush blends allowed | same, but compressed value range (fog eats contrast) |
| Outline | none. A **2–4 px dark edge glaze** `#2c1d20`-class melting into shadow, plus a warm rim `#e7a06a` on the party-facing side | cool rim `#c8cfc4` top-left; silhouette does all the work |
| Shape language | S-curve neck, low wedge head at hero eye-line with open maw, sail wings raised to 6 m, tail coil framing the top-left corner | vertical robe mass, huge beard as the brightest shape, staff diagonal, ragged wing fingers |

### Dragon palette (mask-cluster means off frame04)

| Material | Shadow → Lit |
| --- | --- |
| Bone/cream hide | `#b89a82` → `#c6a792` → `#e6d0b9` → `#e7dbc5` |
| Wing membrane | `#492a66` → `#57316e` → `#88558f` → `#9b6597` |
| Mane / crest | `#3d6d54` → `#88b394` → `#8dd0a5` |
| Talon / spike amber | `#ca5f2b` → `#b76d39` → `#d48c47`, olive-gold tips `#c1a631` |
| Maw | `#a42f28` → `#f0836f` |
| Belly plates (shadow) | `#3f2320` → `#744c40` |

### Sorcerer palette (frame05)

| Material | Values |
| --- | --- |
| Beard / hair (brightest mass) | `#adaf99` → `#b3b4a1` → `#c8c9b8` → `#ccd0c2` |
| Robe core | `#0d110d` near-black |
| Robe teal lining | `#0e3a4d` → `#3d606a` |
| Robe wine lining | `#2d0216`-class deep magenta |
| Old-gold trim | `#726739` → `#84805a` (reads olive through fog) |
| Staff | oxblood `#390708` → `#481a1c` with crimson edge |

Enemy sprites bake their scene key (torch-warm rims for the hall dragon, fog-flat backlight
for the boss); the scene's lights then modulate them only ±15 %. Idle motion: 0.25 Hz
breathing scale-y ±1.5 %, wing/beard drift ±2 px; hit reaction: 60 ms white flash + 0.15 m
recoil; death: bottom-up dissolve 1.2 s with 40 embers.

---

## 7. UI SYSTEM — the shipped-game chrome

The UI is identical across both frames (bar positions match within 2 px) — it is a fixed
grammar, palette-stable in every scene: **dark teal glass, 1-px steel hairlines, diamonds
everywhere, cyan HP / steel-blue MP / magenta limit.** Everything anti-aliased DOM/canvas,
no default browser styling. Font: the house UI face (Georgia/'Times New Roman' small-caps is
the overworld nameplate; battle numerals and names use a **bold humanist sans** — system-ui
stack — because they must read at 13 px).

### 7.1 Turn-order timeline (top)

| Element | Geometry | Styling |
| --- | --- | --- |
| Track | horizontal rail at **y 0.089 fh**, 3 px thick, from x 0.092 → **0.665 fw**, last 0.05 fw fades to 0 | `#aebfc6` at 80 % α, 1 px darker under-edge |
| Slot diamonds (empty ticks) | 18 px point-to-point, **pitch 0.0336 fw** (54.7 px), first at x 0.120 fw | glass diamonds: top half `#10485f`→`#1f4a5a`, bottom half `#a8bdc2` sheen |
| **Active diamond** | **130 px point-to-point** (0.080 fw), centre **(0.051 fw, 0.090 fh)** | 4 px near-white frame `#e1e2e6`/`#b2b5bc`, inner 1 px cyan-glass line, painted chibi bust portrait, soft drop shadow |
| Next-up diamonds | 56 px, centres ≈ (0.100, 0.072) and (0.091, 0.115) — right of and below the active | 2 px white frame, portrait |
| Queue portraits | 40 px diamonds ON the track, **pitch 0.0237 fw** (38.7 px), cluster begins ≈ x 0.451 fw | 2 px white frame; shrink/dim toward the right end |
| Enemy markers | crimson diamonds **26×22 px hanging BELOW the track**, centres y 0.112 fh (frame04: x 738 & 767 px) | fill `#9c2233`, darker border, no portrait |

Behaviour: the rail is a time ruler. Portraits drift left toward the active seat
(position ∝ time-to-act; typical traversal 0.45 → 0.10 fw over ~6 s). On turn start the
arriving portrait morphs into the active diamond with a **90 ms white flash**; on
re-sort/haste, entries slide to new x over **240 ms cubic ease-out**. Never teleport.

### 7.2 Party HP/MP panels (bottom right)

Four panels, right-aligned block, resting on the frame bottom edge:

| Property | Value |
| --- | --- |
| Panel rect | **204×138 px = 0.1252 fw × 0.150 fh**; tops at y **0.836 fh**; lefts at x 0.4730 / 0.6049 / 0.7368 / 0.8687 fw (**pitch 0.1319 fw**, gap 11 px); right inset 0.006 fw |
| Fill | vertical gradient `#474753` (top) → `#243e4f` (bottom) at α 0.86; corner radius 4 px |
| Hairlines | 1 px: top `#736e75`, sides `#676f7a`, bottom `#5b6879`; soft drop shadow below |
| Name | white `#e7e8ea`, bold, **cap height 13 px**, baseline y +26 px from panel top, left inset 11 px |
| HP row | label "HP" in teal-green gradient `#084536`→`#37a484`, 11 px, at x +14; numerals white `#f3f6fb`, **digit height 17 px**, tabular, right-aligned to x +185 |
| **HP bar** | x +18, **width 167 px (0.1025 fw), height 9 px**, y +60…+68. Beveled pill: 1 px pale edges `#577573`/`#5d7074`; fill vertical gradient `#14785c` → `#51c9a6` (core) → `#286a5c`; leading-tip highlight `#65cdac`; track `#05070a` |
| MP row | label `#0d4661`→`#5aa6bd`; numerals 16 px; **MP bar** same pill at y +93…+101: fill horizontal gradient `#287496` (left) → `#4595b8` (right), core `#3d89ad`, bevel `#587587`/`#527088` |
| **Limit gauge** | x +18, width 167, **8 px**, y +116…+124, hairlines `#5c6674`/`#616e7c`; track `#171823`; fill ramp `#7a3d82` → `#b453d4` → `#e97af5` |
| Limit FULL state | the strip ignites: `#eb7cfe` full-width with animated shimmer (bright ends `#e371fd`, travelling dark wave `#a13daf`), glow blooming **±10 px** beyond the strip |

State reads: damage → numerals count down over 350 ms, bar drops instantly leaving a
**ghost segment `#e8637a` that fades 400 ms**, panel hairline flashes `#ff8896` for 300 ms.
Heal ghost `#7dffa8`. HP ≤ 30 % → fill ramp swaps to amber `#b07a28`→`#d9a53f`; ≤ 15 % →
crimson `#c23a4e` + 1.2 Hz hairline pulse. MP/limit deplete without ghosts.

### 7.3 Enemy gauges (bottom left, under the enemy)

Two stacked bars anchored under the enemy's mass (block left edge ≈ enemy screen x − 0.065
fw, clamped to [0.10, 0.30] fw; frame04 x 0.152, frame05 x 0.194 — **y is fixed**):

| Bar | Geometry | Colours |
| --- | --- | --- |
| Enemy HP | **220×7 px (0.135 fw)**, centre-y **0.747 fh** | fill `#632740` → `#822046` → tip `#9d224e` (brighter toward the leading edge); track `#050508`; 1 px dark border |
| Break gauge | 220×9 px + 2 px bevel, centre-y **0.769 fh** | gold `#7c653b` → `#cfb286` → `#e8d19b` with hot specular top row; track `#241c05`→black |

No name, no numbers, no frame — the monster's size is its nameplate.

### 7.4 Skill-name banner

| Property | Value |
| --- | --- |
| Rect | **410×42 px = 0.2515 fw × 0.0456 fh**, centred x 0.494 fw, y 0.203–0.249 fh (centre 0.226 fh) |
| Fill | steel-teal glass `rgba(9, 49, 69, 0.82)` (`#093145`); the outer 50 px each side fade to α 0 |
| Hairlines | 1 px `#7e98a6` at 55 % α top and bottom (bottom slightly brighter), fading with the fill |
| Text | skill name centred at 0.5 fw, white `#dff5ff`, ~19 px (cap 13 px), +0.04 em tracking, faint 1 px glow |
| Animation | in: fade + 12 px slide-down, **120 ms**; hold ≥ 900 ms; out: fade + 8 px slide-up, 180 ms |

### 7.5 Status icons, damage numerals, target reticle

- **Status icon**: diamond **40×34 px** planted at the unit's feet projection (+8 px y):
  fill `#982f3d`, top rim `#d694a0`, bottom shade `#6d2530`, white glyph `#ffeae9` 18 px.
  Multiple statuses stack horizontally, 4 px apart, gentle 1 Hz bob.
- **Damage numerals**: spawned at unit chest +24 px, ±14 px x-jitter. White `#f4f7ff` with
  2 px `#1d1410` outline, 34 px; crit gold `#ffe9a6` at 1.4×; heal `#7dffa8`; MP `#5aa6bd`.
  Pop to 1.4× in 90 ms → settle 1.0× → rise 28 px fading over 650 ms.
- **Target reticle**: four cyan corner brackets forming a 64 px diamond around the target's
  centre, `#3fc9f2` 2 px hairlines, rotating 4°/s, scale pulsing ±6 % at 1.1 Hz.

UI safe areas: timeline band y < 0.16 fh; bottom band y > 0.83 fh; the stage duel line
(0.30–0.62 fh centre) stays free of chrome. World may pass **behind** UI; UI is always on top.

---

## 8. VFX — the column burst (Firaga-class)

Measured off frame04: column x 0.513–0.607 fw (**154 px ≈ 2.0 m wide**), y 0.471–0.684 fh
(**≈ 3.0 m tall**), sparks reaching y 0.358 fh (1.4 m above the column). Two-tone anatomy:
**dusty-magenta sheath around a warm white-cream core** — never a single flat colour.

| Layer | Spec |
| --- | --- |
| Ground ring | additive disc r 1.3 m at target feet, `#c190b0` → transparent, 45 % feather |
| Sheath | 3 nested additive cylinder shells r 0.55/0.75/0.95 m, heights 2.2/2.6/3.0 m, scrolling noise upward 4 m/s; colours outer `#a56f87`, mid `#c190b0`, deep edge `#664071`; rippled rim, λ ≈ 0.5 m |
| Core | 12 vertical streak quads 0.15–0.4 m wide, 2.4–3.2 m tall, `#f3c9d8` → **`#fff0cf`** hot centre (measured core `#fdeff3`/`#fff0cf`) |
| Sparks | **90 sparks over 0.45 s** (~70 alive peak), 2–6 px @1080p, v₀ (±0.8, 3.5–6.5, ±0.8) m/s, gravity −1.5 m/s², life 0.7–1.2 s, additive, ramp white → `#dca9c8` → fade |
| Blending | everything additive; only core + sparks may cross the bloom threshold |

**Light spill is mandatory — the spell illuminates the scene.** A point light rides the
column: position (target.x, 1.3, target.z), colour `#ee86d2`, intensity 0→60→0 across the
effect, distance 11, decay 2. Acceptance numbers (all measured in frame04): floor within
1.5 m lifts from `#4b4240` to `#ae988b`-class (+0.25 luma); the steps 2.5 m away tint to
`#c495c1`; the victim sprite overexposes toward `#ffc2a3` (the +35 % sprite rule, §5). A
burst that does not repaint its surroundings is an instant fail.

Timing (total 1.35 s): windup glow 250 ms → burst 400 ms (peak at +100 ms) → decay 700 ms.
At burst: **screen flash 12 % white for 60 ms; camera shake 6 px @1080p, 180 ms, 2
oscillations.** Budget: ≤ 180 particles alive, ≤ 1 shake + 1 flash per cast, flash ≤ 15 %,
shake ≤ 7 px / 220 ms. Hall variant of the light warms the whole room; highland variant
also brightens the fog cards within 6 m (+0.08 α) — fog receives light too.

---

## 9. ANIMATION TIMING — the pacing of a turn

60 fps timings. A full turn beat ≈ 2.6–3.4 s; the game must never feel paused between turns
(idle anims + timeline drift + torch flicker are always running).

| Beat | Spec |
| --- | --- |
| Idle | 4 frames @ 6 fps, ±1 px breath |
| Turn start | portrait flash 90 ms; active unit steps to `ready` (4 f @ 8 fps, +4 px lean); reticle on |
| Banner | in 120 ms → hold through the action ≥ 900 ms → out 180 ms |
| Attack | dash-in 180 ms at 8 m/s (motion-smeared 2 f) → strike 3 f / 100 ms → target hit-react → recoil hop 240 ms → walk back 320 ms ease-in-out |
| Cast | 6 f / 0.9 s with glyph circle r 0.9 m under caster; VFX fires at f4 |
| Hit react | 2×60 ms white flash on the victim, −0.35 m recoil over 90 ms, settle 180 ms; damage numeral spawns at first flash |
| KO | desaturate to 20 % + fall 300 ms → fade to α 0 over 700 ms; panel name dims to 40 % |
| Enemy death | 1.2 s bottom-up dissolve + 40 embers + 300 ms slow-fade of its gauges |
| Victory | party `victory` loop 4 f @ 5 fps, staggered starts 120 ms apart, front rank first |
| Timeline | continuous drift; re-sort slides 240 ms cubic |

---

## 10. POST-PROCESSING — per-arena recipes

Same pipeline order as the overworld (`bloom → ACES → grade → tilt-shift → sharpen → CA →
vignette → grain`), battle-tuned. Battle keeps a **mild** tilt-shift — enough to say
"diorama", never enough to smear the enemy.

| Stage | Hall (frame04) | Highland (frame05) |
| --- | --- | --- |
| Bloom | threshold 0.62, strength 0.55, radius 0.9 — flames, VFX core, limit-glow only | threshold 0.80, strength 0.18 |
| Exposure | ACES, 1.0 | ACES, 1.0 |
| Grade | lifted blue-blacks: `c += (1−smoothstep(0,.30,l))·vec3(.010,.018,.038)`; mids warm ×(1.06, 1.00, 0.92); sat 1.05 | desat to 0.82, then sage mids ×(0.99, 1.02, 0.97); shadows lift vec3(.008,.020,.018) |
| Tilt-shift | sharp band **0.30–0.86 fh**, ramps 0.10, max blur 4 px top / 3 px bottom @1080p | same band, max 3 px |
| Sharpen | 0.25, masked to sharp band | 0.20 |
| CA | 1.2 px at corners | 1.0 px |
| Vignette | strength 0.34 from r 0.55 — corners land near `#000513` | strength 0.42, **top-weighted** — top corners land near `#022123` |
| Grain | 0.028 | 0.035 |
| Impulses | flash/shake injected here (VFX budget §8) | same |

Battle sprites and UI stay pixel/vector crisp: UI is DOM above the canvas (post never
touches it); the sharp band always contains the full stage (0.30–0.86 fh).

---

## 11. WHAT MUST NEVER APPEAR — instant fails

1. **A 3D-modelled or chibi enemy.** The enemy is the painterly hand-drawn wall (§6), 4×
   hero, or the whole hierarchy collapses.
2. **The party in a line.** Feet must zigzag with ≥ 0.15 fh rank separation at the §1
   anchors. A flat rank reads as a menu screen, not a stage.
3. **Enemy health bars floating over heads, enemy nameplates, or any chrome in the stage
   band** (0.16–0.83 fh centre). Enemy gauges live only in the bottom-left block (§7.3).
4. **Flat unlit sprites or missing contact shadows.** Every unit takes the scene light, the
   rim, and the blob (§5) — pasted-on stickers sink the whole frame.
5. **VFX without light spill** (§8). A burst that doesn't repaint floor, steps and nearby
   sprites reads as a gif glued on top. Equally: screen-long shakes or flashes over budget.
6. **Pure `#000000` shadows, grey or violet shadow casts.** Hall darks are blue
   (`#0a1420`-class), highland darks are teal-green (`#022123`-class), always hue-bearing.
7. **Gradients, dithering, or anti-aliased outlines inside chibi cells** — the 4-shade +
   `#1d1410` outline law is unchanged from the overworld. (Enemies are exempt — §6.)
8. **Circles where diamonds belong, default browser styling, opaque panels, missing
   hairlines, or HP bars without the bevel-pill treatment.** The UI grammar of §7 is the
   product's signature; a generic health bar fails the whole screen.
