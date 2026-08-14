# Generated game assets

These PNGs implement every item in `docs/ASSET_REQUESTS.md`.

## Loader contract

- Atlas indices are zero-based, row-major, with cell 0 at the top-left.
- All sprite atlases use straight (not premultiplied) RGBA and real transparency.
- Battle battlers use 320 x 320 cells; the last cell is intentionally transparent.
- The boss uses 512 x 512 cells; cells 13-15 are intentionally transparent.
- Overworld actors use 384 x 384 cells. Mirror the west row for east-facing movement.
- Anchor occupied frames at bottom-centre after optional alpha trim.
- Use sRGB colour space. For crisp pixel art in Three.js, use `NearestFilter`, disable
  mipmaps, and avoid fractional screen-space scaling where possible. The painterly boss and
  backdrops may use linear filtering.

Exact paths, dimensions, grid sizes, and animation ranges are in `manifest.json`.

## Character continuity

- `rain-stormblade.png` and `rain-stormblade-walk.png` preserve the established Stormblade:
  navy spikes, silver forelock, orange scarf, blue-and-gold coat, gold pauldron, and icy inset
  sword.
- `fina-radiant-support.png` preserves the established adult blonde support heroine: long high
  ponytail with navy bow, navy-and-gold outfit, white bodice, and crescent crystal staff.
- The katana duellist and engineer were designed as original party complements using the same
  chibi proportions, warm outline, hard pixel clusters, material ramps, and shared light rig.
- `highland-sovereign.png` uses the painterly monster treatment established by the earlier
  Bahamut sheet rather than the party pixel treatment.

## Suggested Three.js texture setup

```js
texture.colorSpace = THREE.SRGBColorSpace;
texture.flipY = false;
texture.premultiplyAlpha = false;

// Party and overworld pixel art only:
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;
```

Keep the procedural terrain and camera. These images are intended for billboarded character
planes and fixed battle-backdrop planes, as described by the repo's art and battle bibles.

---

## Encoding — use the PNGs, not `raw/*.webp`

Two copies of this batch reached the repo by different routes. The `.webp` set in
`assets/raw/` is **lossy** and must not be wired up. Measured by decoding both and
comparing pixel-for-pixel:

| Sheet | Pixels differing | Max channel delta | Other loss |
| --- | --- | --- | --- |
| `battler_rain` | 15.28 % | 101 / 255 | — |
| `overworld_rain` | 21.56 % | 104 / 255 | — |
| `boss_sorcerer_sheet` | — | — | downscaled 2048² → 1500² |

Alpha survives (0 % of pixels differ by more than 2 in the alpha channel), so the damage
is purely colour — which is exactly the wrong thing to lose here. This art is authored to a
4-shade-per-material ramp with a 1 px `#1d1410` outline; a ±100 channel excursion smears
those hard edges and the ramp steps into mush, and `NearestFilter` then magnifies the
artefacts instead of hiding them. Lossy encoding is fine for the two backdrop plates and
wrong for every sprite atlas.

The PNGs under `battlers/`, `enemies/`, `backdrops/` and `overworld/` are the originals as
generated, verified by `node tools/import-assets.mjs`. Treat them as canonical and delete
`assets/raw/` once nothing references it.
