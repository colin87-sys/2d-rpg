# FRAMING SOLVE — the frame01 camera/layout reconciliation

**Status: BINDING for the hero shot.** This document supersedes the ART_BIBLE §1 world
layout and amends §2 (see §7 below for the exact rows that change). Authority chain:
`docs/reference/frame01.png` (1630×921) → this file → ART_BIBLE → everything else.
Every number here was measured off frame01 and pushed through the projection arithmetic
in §3; the verification table in §6 was generated numerically, not by eye.

Conventions: 1 unit = 1 m, +X east, −Z north, +Y up, sea level y = 0.
`fw`/`fh` = fraction of frame width/height, measured from **left/top**.

---

## 1. Why the old numbers could not produce frame01 (the defect, worked)

ART_BIBLE §2 camera: pos (−38, 36.3, 64.8), look-at (−38, 11.4, 18), pitch 28°, vFOV 26°.
ART_BIBLE §1 massif: footprint x −34…−2, z −52…−18, plateau top y 20–24.

Push §1 through §2 (projection math in §3):

| §1 landmark | projects to | verdict |
| --- | --- | --- |
| Massif S lip (−18, 22, −18) | fw 0.81, **fh −0.21** | off the top edge |
| Waterfall lip (−26, 20, −40) | fw 0.65, **fh −0.25** | off the top edge |
| Castle spire tip (−20, 20.5, +4) | fw 0.86, **fh −0.02** | off the top edge |
| Coast cliff lip (−82, 9, −10) | **fw −0.18**, fh 0.20 | off the left edge |

The root cause is arithmetic, not tuning: with the camera 36.3 m up and pitched 28° down,
a ray leaving through screen height `fh` has depression `28° − atan(2(0.5−fh)·tan13°)`.
The ray through fh 0.11 (frame01's massif top) is 17.9° below horizontal, so any point on
it satisfies `y = cam_y − 0.322 · horizontal_distance`. At the old massif's distance
(hd 83–117 m) that ray is at y **9.6 … −1.4** — *below the hero's shelf*. A y 22 plateau
can only cross that ray at hd ≈ 44 m, i.e. z ≈ +21 — **south of the hero**. No dolly or
FOV change fixes this (they move the limit and the content together — round 2 proved it).

**Conclusion: frame01's massif is much closer and lower than §1 claimed.** The reference
is a *tabletop miniature*: the visible composition lives within ~40–90 m of the camera,
landforms are 4–8 m tall, and the long 26° lens + fog does the "mountain" reading. This is
the same trick §5 already codified for trees and the castle — §1 just never applied it to
the terrain. The fix below applies it.

## 2. Screen targets measured off frame01 (1630×921, ignore PiP/watermark)

| Feature | fw | fh |
| --- | --- | --- |
| Hero (mounted unit) | 0.505 centre | sprite spans 0.475–0.565 (feet/shadow 0.556) |
| Mounted unit height | — | 0.090 fh (standing body ⇒ 0.065 fh) |
| Massif face span | 0.47 … 0.74 at mid-height | base ~0.45 (behind wheat), summit lip 0.11 |
| Massif summit | 0.625 | 0.110 |
| Waterfall (white column) | 0.655 | lip 0.225 → base 0.345 |
| River (visible blue bend) | 0.700 | 0.400 |
| Castle | 0.755 … 0.925 | spire tips 0.335, S-wall base 0.585 |
| Ocean strip | 0.00 … 0.07 | full left edge; cove/beach upper-left |
| Coast cliff lip | 0.055 … 0.090 | runs the left edge, 0.25 → 0.75 |
| Inlet trestle bridge (small, far W) | 0.02 | 0.34 |
| North trestle bridge (large, timber) | 0.44 | 0.145 |
| Fork signpost | 0.245 | 0.36 |
| Wheat paddock 1 (hero's shoulder) | 0.455–0.60 | 0.46–0.56 |
| Wheat paddock 2 | 0.485–0.60 | 0.63–0.75 |
| Big SE wheat field | 0.60–0.95 | 0.82–1.00 |
| Village / autumn grove (hazed) | 0.28–0.34 | 0.05–0.10 |
| Forest knoll (dark, SW) | 0.05–0.35 | 0.55–0.95 |
| Top of frame | 100 % terrain | hazed low valley at hd 65–90 m; **no sky** |

## 3. The solved camera (BINDING — player.js boots exactly here)

| Parameter | Value | Arithmetic |
| --- | --- | --- |
| Projection | Perspective, **vFOV 26°**, aspect 16:9 (hFOV 44.6°) | unchanged from §2 — frame01's parallel road edges demand the long lens |
| **Pitch** | **28° down**, yaw 0 (due north) | unchanged — re-confirmed by the ellipse foreshortening in §10.1 |
| **Distance** | **46.0 m** (camera → aim point) | §2 said 53 m but forgot that a vertical object forshortens by cos(pitch) on screen: standing span = 1.6·cos28° / (2·d·tan13°). Solving for the measured 0.065 fh ⇒ d ≈ 46. At 46 m: standing **0.0654 fh** ✓, 2.4 m mounted envelope 0.099 fh, the actual composited sprite unit (2.16 m visual top) **0.089 fh** vs plate 0.090 ✓ |
| **Look-at (aim)** | **(−38.0, 12.0, 18.0)** = hero feet + 1.6 m | §2 aimed at chest (+1.0) which parks the hero's feet at 0.536 fh; aiming at the standing head-top puts feet at **0.565** / unit centre 0.515, matching the plate (0.556 / 0.515) |
| **Camera position** | **(−38.0, 33.60, 58.62)** | = look-at + 46·(0, sin28°, cos28°) = (−38, 12+21.60, 18+40.62) |
| Near / far | 4 / 700 | unchanged |
| Rig | dolly-only zoom **38–62 m** (never FOV), pitch clamp 24–34°, boots at the exact transform above, critically-damped ≈ 0.25 s | dolly max cut from 70: past 62 m the mounted unit drops under 0.07 fh, off-model |

**Projection convention used everywhere in this doc** (yaw 0, pitch θ = 28°):
`fwd = (0, −sin θ, −cos θ)`, `up = (0, cos θ, −sin θ)`, `right = (1, 0, 0)`;
for point P: `rel = P − cam`, `zc = rel·fwd`, `yc = rel·up`, `xc = rel.x`;
`fw = 0.5 + xc / (2·zc·tan 13°·16/9)`, `fh = 0.5 − yc / (2·zc·tan 13°)`.

Useful derived constants at the hero (zc ≈ 44): frame is **21.4 m tall × 38.1 m wide**;
1 m of height ≈ 0.041 fh; 1 m of northing moves a ground point up ≈ 0.019 fh.
Bottom-edge ray hits ground (y 10) at z ≈ +31 (13 m south of the hero). Top-edge ray is
15° below horizontal (horizon 0.56 fh above the frame — sky can never appear) and reaches
ground height y 11–14 at z −60…−65, so the top band is *distant low valley*, ~70–90 m out,
hazed — **the "north stepped plateaus must climb to +26…+34" rule is dead** (§7).

## 4. Revised world layout (BINDING; supersedes ART_BIBLE §1 table)

Each row: old §1 value → new value. Justification = the §6 verification row(s) that the
new value satisfies; the old values project off-frame per §1's failure table above.

| Element | OLD (§1) | **NEW (binding)** |
| --- | --- | --- |
| Hero / shot anchor | (−38, +18), ground +10.4 | **unchanged** — (−38, +18), ground exactly +10.4 |
| Hero grass shelf | x −80…−10, z −15…+60, y 9…12 | **x −62…−16, z −2…+45, y 9.5…11.5**, ≤1.5 m undulation |
| **Central massif** | x −34…−2, z −52…−18, top +20…+24 | **footprint x −44…−25, z −6…+14; S foot toe (−36.5, +13.5) y 11; two limestone bands (lips y ≈ 13 and ≈ 15); grassy summit knob (−32.5, +5.5) y 16.5** (~8×6 m crown with 3–5 pines); N side descends to y ≈ 13 by z −8; E shoulder terrace y 12.5 (falls lip); W edge (−39.5, +8) blends into the switchback slope |
| **Waterfall** | lip (−26, −40), +20 → +11, 9 m drop | **lip (−30.5, +3.0) y 12.5 → pool (−30, +2) y 8.5 — 4 m single drop**, sheet ~2.5 m wide, mist below y 10 |
| River | pool (−31,−33) → exits SE, +11→+6 | **headwater y 13.5→12.5 from (−48, −3) under the north bridge (−41, −1) to the lip (−30.5, +3); then gorge run y 8.5→7: (−30, +2) → (−28, +4.5) → (−22, +6.5) → exits E at (−15, +8) behind the castle plateau.** Gorge floor 4–6 m wide between the massif E face and the castle plateau W cliff; small cascade y 8→7.5 near (−27.5, +5) |
| **Castle POI** | centre (−20, +4), plateau +14, spire +20.5 | **plateau flat y 10.5, x −30…−17, z +12…+22; footprint x −28…−21.5, z +13…+19.3; S wall (gate, faces S-SW) at z +19, gate arch centre (−24.8, +19.3); tallest spire at SW corner (−28, +19.5), tip y 16.5.** Castle total height **6.0 m** (§5's 6.5 rescaled ×0.92: curtain wall 2.4, roofline 3.9, gatehouse 3.1, spire 6.0); frontage ~6.5 m |
| **Coastline** | mean x −82 ±10 | **cliff lip: (−53, +23) → (−57, +10.5) → (−63.5, −6.5) → (−72, −28) → (−79, −45); lip y 8–8.5, near-vertical to sea 0, foam at contact.** Ocean deep band by x −72. Beach cove (−78, −40) |
| Pier | (−76, −8) | **(−64, −16), pointing WSW, deck +0.4** (haze-veiled, barely reads) |
| Trestle bridge W | (−84, −66), deck +18 | **inlet bridge (−59, +9.5), deck y 12, span 10**, timber trestle, crossing a 10 m inlet gorge that cuts NE from the ocean at (−62, +13) to (−55, +6) |
| North gorge bridge | (−30, −118), deck +26 | **(−41, −1), deck y 13.5, span 9** — the big warm-timber trestle over the headwater gorge (frame01 0.44 fw / 0.145 fh) |
| Road fork + signpost | (−44, +2) | **(−49.5, +8.5), y 11** |
| **Farm paddocks** | (−34,+14), (−42,+26), (−30,+30), y +10 | **P1 (−37, +15.5) y 10.5, ~8×5.5, road clips its W edge (wheat reads on BOTH of the hero's shoulders), small W lobe (−40.5, +16) 3×4; P2 (−36.5, +22.5) y 10, ~12×7; big SE field (−29.5, +28.5) y 9.5, ~14×9 sprawling to z +38.** Two-rail fences on P1/P2, partial on SE |
| Roads | S entry (−24,+120) | **S entry at (−36, +31) heading in from the bottom edge → hero (−38, +18) → fork (−49.5, +8.5). W branch → inlet bridge (−59, +9.5). N branch switchback: (−47, +3) → (−44, −1), climbing y 11 → 13.5, over the north bridge → village. E branch: (−34, +16.5) → saddle (−31, +17) y 9.7 → castle gate (−24.8, +19.3).** Width 2.6 + 1.2 feather (unchanged) |
| Village POI | (−70, −128), +24 | **(−50.5, −16.5), y 11.5** — hazy slate rooftops at the top edge (0.30 fw, 0.055 fh) |
| North terrain | stepped plateaus +26…+34, z < −60 | **rolling low valley y 10–14, z −8…−45**, with 2 cliff-banded knolls to y 15–16 near (−45, −25) and (−28, −20); olive-gold autumn grove (−49.5, −12) y 12. Everything ≥ 70 m out — fog does the rest |
| Far NE ridge | x > +120, snow | **backdrop cliffs behind the castle: x −20…−2, z −2…+12, y 12–16, hazed**; the snow-dusted x > +120 ridge stays in the data but is invisible in-shot |
| Forest knoll SW | (not in §1) | **NEW: dark dense forest knoll (−47.5, +27.5), crown y 12, ~14×10 m** — the bottom-left mass of the frame |
| Shrine / Camp POI | (+38, −64) / (+8, +88) | **shrine (−12, −12) y 12 (fog-hidden), camp (−32, +46) y 9.5 (below frame)** — keep the POI kinds alive, out of shot |
| Ocean | x < −92 | **x < lip line above; deep by x −72** |

## 5. What this buys (composition audit)

Eye path (unchanged in intent, §8): road enters bottom-centre (0.57, 0.99) → hero (0.505,
0.515, sharp band) → fence lines W to the wheat → fork/signpost (0.245, 0.36) → switchback
→ north bridge (0.44, 0.145) → waterfall accent (0.655, 0.28) → castle cobalt (0.755–0.925,
0.33–0.585). Ocean strip holds frame-left 0–0.07 fw; massif fills the centre 0.11–0.45 fh;
**100 % terrain** — top-edge rays terminate on hazed valley floor at 70–90 m.

## 6. Verification table (generated numerically; tolerance ±0.025)

Camera (−38.00, 33.60, 58.62), look-at (−38, 12, 18), pitch 28°, vFOV 26°, 16:9.

| Landmark | world (x, y, z) | proj fw | proj fh | frame01 fw | frame01 fh | Δfw | Δfh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hero feet (road) | (−38.0, 10.4, +18.0) | 0.500 | 0.565 | 0.505 | 0.556 | −0.005 | +0.009 |
| Mounted unit head-top (2.4 m) | (−38.0, 12.8, +18.0) | 0.500 | 0.466 | 0.505 | 0.470 | −0.005 | −0.004 |
| Massif S foot | (−36.5, 11.0, +13.5) | 0.536 | 0.447 | 0.535 | 0.450 | +0.001 | −0.003 |
| Massif summit lip | (−32.5, 16.5, +5.5) | 0.622 | 0.112 | 0.625 | 0.110 | −0.003 | +0.002 |
| Massif W mid-face edge | (−39.5, 12.5, +8.0) | 0.467 | 0.296 | 0.470 | 0.300 | −0.003 | −0.004 |
| Massif E mid-face edge | (−27.5, 12.0, +8.5) | 0.735 | 0.322 | 0.740 | 0.320 | −0.005 | +0.002 |
| Waterfall lip | (−30.5, 12.5, +3.0) | 0.655 | 0.225 | 0.655 | 0.225 | −0.000 | +0.000 |
| Waterfall pool | (−30.0, 8.5, +2.0) | 0.658 | 0.345 | 0.658 | 0.345 | −0.000 | −0.000 |
| River visible bend | (−28.0, 8.0, +4.5) | 0.704 | 0.398 | 0.700 | 0.400 | +0.004 | −0.002 |
| Castle SW spire tip | (−28.0, 16.5, +19.5) | 0.786 | 0.334 | 0.785 | 0.335 | +0.001 | −0.001 |
| Castle S wall base, W | (−28.0, 10.5, +19.0) | 0.766 | 0.585 | 0.760 | 0.585 | +0.006 | −0.000 |
| Castle S wall base, E | (−22.0, 10.5, +19.0) | 0.925 | 0.585 | 0.925 | 0.580 | +0.000 | +0.005 |
| Coast cliff lip, south | (−53.0, 8.5, +22.0) | 0.086 | 0.744 | 0.090 | 0.750 | −0.004 | −0.006 |
| Coast cliff lip, mid | (−57.0, 8.0, +10.5) | 0.075 | 0.500 | 0.070 | 0.500 | +0.005 | +0.000 |
| Coast cliff lip, north | (−63.5, 8.0, −6.5) | 0.053 | 0.252 | 0.055 | 0.250 | −0.002 | +0.002 |
| Ocean surface, far NW | (−79.0, 0.0, −44.5) | 0.032 | 0.120 | 0.030 | 0.120 | +0.002 | −0.000 |
| Inlet trestle bridge deck | (−59.0, 12.0, +9.5) | 0.022 | 0.338 | 0.020 | 0.340 | +0.002 | −0.002 |
| North trestle bridge deck | (−41.0, 13.5, −1.0) | 0.441 | 0.143 | 0.440 | 0.145 | +0.001 | −0.002 |
| Fork signpost | (−49.5, 11.0, +8.5) | 0.245 | 0.359 | 0.245 | 0.360 | −0.000 | −0.001 |
| Wheat paddock 1 centre | (−37.0, 10.5, +15.5) | 0.525 | 0.507 | 0.530 | 0.510 | −0.005 | −0.003 |
| Wheat paddock 2 centre | (−36.5, 10.0, +22.5) | 0.543 | 0.696 | 0.540 | 0.690 | +0.003 | +0.006 |
| Big SE wheat field centre | (−29.5, 9.5, +28.5) | 0.773 | 0.908 | 0.770 | 0.910 | +0.003 | −0.002 |
| Village rooftops (hazed) | (−50.5, 11.5, −16.5) | 0.301 | 0.055 | 0.300 | 0.055 | +0.001 | +0.000 |
| Forest knoll SW, crown | (−47.5, 12.0, +27.5) | 0.192 | 0.757 | 0.200 | 0.750 | −0.008 | +0.007 |
| Road, south entry | (−36.0, 9.8, +31.0) | 0.569 | 0.990 | 0.570 | 0.990 | −0.001 | +0.000 |
| Road-to-castle saddle | (−31.0, 9.7, +17.0) | 0.678 | 0.571 | 0.680 | 0.570 | −0.002 | +0.001 |
| Autumn grove, N ridge | (−49.5, 12.0, −12.0) | 0.307 | 0.079 | 0.310 | 0.080 | −0.003 | −0.001 |

All 27 landmarks land within 1 % of the plate. Hero scale: standing 0.0654 fh (target
0.065); the composited unit (visual top 2.16 m) 0.089 fh vs plate 0.090; 2.4 m envelope
0.099. Hero sprite spans fh 0.47–0.565 — inside the tilt-shift sharp band 0.25–0.79.

## 7. What changed and why (superseded ART_BIBLE numbers)

- **§2 distance 53 m → 46 m; camera (−38, 36.3, 64.8) → (−38, 33.60, 58.62); look-at
  (−38, 11.4, 18) → (−38, 12.0, 18).** The 53 m derivation ignored cos(pitch)
  foreshortening of vertical objects; 46 m restores the measured 0.065 fh hero. Aim point
  raised 0.6 m to put the unit centre at the plate's 0.515 fh. Pitch 28°, vFOV 26°,
  yaw 0, near/far 4/700 all **unchanged**. Dolly band 38–70 → **38–62**.
- **§1 massif position/height**: x −34…−2, z −52…−18, top +20…+24 → footprint
  x −44…−25, z −6…+14, summit y 16.5. Proof in §1 above: the old massif projects to
  fh −0.21.
- **§1 waterfall**: 9 m drop at (−26, −40) → **4 m drop at (−30.5, +3)**.
- **§1 castle**: plateau +14 at (−20, +4) → **plateau +10.5, footprint x −28…−21.5,
  z +13…+19.3**; §5 castle height 6.5 → **6.0 m** (spire-tip row of §6: y 16.5 lands
  exactly on the plate's 0.335 fh; 6.5 m would put it at 0.31).
- **§1 coastline**: mean x −82 → lip line ~x −53…−63 at frame latitudes.
- **§1 bridges/village/roads/paddocks**: moved per §4 — all within ~90 m of the camera.
- **§1 "north stepped plateaus must climb +26…+34"**: deleted. The top band is *distant
  low valley* (y 10–14 at 70–90 m); the frame stays 100 % terrain because the horizon is
  0.56 fh above the top edge — that guarantee is geometric, not topographic.
- **§1 screen-position audit paragraph** (waterfall 0.64 fw etc.): superseded by §2/§6
  here.
- Everything else in the ART_BIBLE (palette, light rig, §5 scale chart except the castle
  height, §6 pixel rules, §7 post, §8 density, §9 UI) **stands unchanged**.

## 8. Module directives (implement literally; do not re-derive)

### terrain.js
1. Ground at (−38, +18) must be **exactly 10.4**; publish `meta.extras.heroSpawn =
   { x: -38, z: 18 }` as before.
2. Build the §4 landforms at the stated coordinates: hero shelf; stepped massif (two
   limestone bands y≈13/y≈15, summit knob y 16.5 at (−32.5, +5.5) — keep each cliff band
   1.5–2.5 m with banded strata, per §5 shape language at miniature scale); castle plateau
   flat y 10.5 (x −30…−17, z +12…+22) with S cliff to y 9.5 and W cliff into the river
   gorge; coast cliff lip along the §4 polyline (y 8–8.5, near-vertical, sea 0); inlet
   notch (−62, +13)→(−55, +6); river channels + 4 m falls face at (−30.5, +3); north
   valley y 10–14 with two knolls y 15–16; SE field flats y 9.5; SW knoll y 12.
3. Roads (onRoad mask) along the §4 polylines, width 2.6 + 1.2 feather. The S entry must
   cross the bottom edge near fw 0.57 — i.e. pass through (−36, +31) heading SSE.
4. `meta.poi`: castle (−24.5, +16), village (−50.5, −16.5), farm (−37, +15.5),
   bridge (−59, +9.5) and (−41, −1), shrine (−12, −12), camp (−32, +46).
5. Nothing taller than y 17 anywhere in x −50…−20, z −10…+15 (massif crown is the local
   maximum); nothing taller than y 16 in the north valley band z −8…−45.

### props.js
1. Castle per §4: 6.0 m total, frontage ~6.5 m, S wall at z +19, gate arch centre
   (−24.8, +19.3) facing S-SW, tallest spire at the SW corner (−28, +19.5) tip y 16.5.
   Keep §5's internal proportions ×0.92 (wall 2.4, roofline 3.9, gatehouse 3.1).
2. North trestle bridge: timber post-and-rail, deck y 13.5, span 9 m over the headwater
   gorge at (−41, −1), oriented ~N–S (the switchback road crosses it). This bridge is
   plainly visible (0.44 fw, 0.145 fh) — build it to read at ~40 px.
3. Inlet trestle bridge: deck y 12, span 10 m at (−59, +9.5), crossing the inlet NW–SE;
   heavily hazed, silhouette quality is enough.
4. Fences: P1 two-rail around (−37, +15.5) 8×5.5 with a gap where the road clips its W
   edge, plus the W lobe (−40.5, +16) 3×4; P2 (−36.5, +22.5) 12×7; partial rails on the
   SE field. Fence post 0.5 m (§5 unchanged). Signpost (−49.5, +8.5).
5. Village: hazy slate hamlet at (−50.5, −16.5) y 11.5 — rooftop silhouettes only.
   Pier (−64, −16), deck +0.4.

### water.js
1. Ocean plane y 0 west of the coast lip polyline; foam line hugging the cliff base
   x −53…−79; the visible strip is fw 0.00–0.07 — keep swell subtle, it is 45–110 m out.
2. Waterfall: **one sheet, lip (−30.5, +3.0) y 12.5 → pool (−30, +2) y 8.5** (4 m drop),
   ~2.5 m wide, RAPIDS/falls palette, mist sprites below y 10 within 8 m of the base.
3. River ribbons: headwater y 13.5→12.5 from (−48, −3) to the lip; gorge run y 8.5→7
   from the pool east to (−15, +8); 3–5 m wide; small cascade near (−27.5, +5). River
   reads brighter/more saturated (RIVER `#2f9ec9`) than the ocean — it is the blue accent
   at (0.70, 0.40).
4. Inlet water y 0 under the west bridge.

### scatter.js
1. Dense dark conifer+oak forest on the SW knoll (x −54…−42, z +22…+33) — this is the
   bottom-left mass of the frame; deepest shadow ramp, crowns overlapping 20–40 %.
2. Forest band west of the fork along the shelf (x −56…−48, z +5…+20), ragged edges.
3. Conifers on the massif terraces; **3–5 landmark pines on the summit knob (−32.5, +5.5,
   y 16.5)** — they cut the massif's silhouette at fh ≈ 0.09, do not omit them.
4. Olive-gold autumn grove at (−49.5, −12) y 12 (frame01's warm cluster at 0.31, 0.08).
5. Wheat fill inside all three paddocks (stalk 0.75–0.95 m); road-side trees per §8; keep
   the pasture between hero and the SW knoll (fw 0.15–0.45, fh 0.5–0.7) genuinely open —
   lone trees + tufts only.
6. Contact-shadow blobs under everything, per §8 (unchanged).

### sky.js (note — owner to apply)
The scene compressed from ~250 m to ~90 m of visible depth. At k = 0.0072 the top band
(85 m) is only 31 % fogged; the plate reads ~55–70 % veiled up there. Recommend
**k = 0.0095** (hero 47 m → 18 %, massif crown 62 m → 29 %, top band 85 m → 48 %, ocean
far NW 125 m → 76 %) with the §4 height falloff unchanged. Shadow frustum 140×140 still
covers the composition.

### post.js / hud.js
No changes required by this solve. Tilt-shift band 0.25–0.79 fh already contains the hero
(0.47–0.565). Minimap and nameplate per §9.
