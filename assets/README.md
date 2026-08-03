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
