# Module Contract — Aetherbound Overworld POC

**Hard rule for every implementer: do not change any exported signature below, and do not
edit files you do not own.** `src/main.js` and `src/core/engine.js` are owned by the
integrator. If you need something added to the contract, note it in your return summary
instead of editing another module.

Stack: Three.js `^0.169` (ESM, `import * as THREE from 'three'`), Vite, no external assets.
**Every texture and every sprite must be generated procedurally in code** (Canvas2D / data
textures). No network fetches, no binary asset files.

Units: 1 world unit = 1 metre. Terrain spans `[-WORLD/2, +WORLD/2]` on X/Z, `WORLD = 512`.
Y is up. Sea level is `y = 0`. Land rises above it.

---

## `src/art/atlas.js`

```js
export function makeVegetationAtlas(renderer): Atlas
```

`Atlas = { texture: THREE.Texture, frames: Record<string, Frame>, size: number }`
`Frame  = { u0, v0, u1, v1, px, py, aspect, anchor: 'bottom' }` — UVs normalised 0..1,
`px`/`py` the pixel dimensions of the sprite cell, `aspect = px/py`.

Required frame keys (all pixel-art, alpha-cut, lit from upper-left, warm rim on the right):

`pine_a pine_b pine_c pine_snow oak_a oak_b oak_c blossom_a blossom_b blossom_c
bamboo_a bamboo_b bush_a bush_b bush_c rock_a rock_b rock_c boulder_a grass_tuft_a
grass_tuft_b fern_a flower_a flower_b wheat_a wheat_b stump log cattail lilypad`

Texture must be `NearestFilter` mag, `LinearMipmapLinearFilter` min, `generateMipmaps: true`,
`colorSpace = THREE.SRGBColorSpace`, `anisotropy = renderer.capabilities.getMaxAnisotropy()`.

## `src/art/characterSprite.js`

```js
export function makeHeroSheet(): Sheet
export function makeMountSheet(): Sheet   // chocobo-like mount, optional use
```

`Sheet = { texture, frameW, frameH, cols, rows, anims: Record<string, number[]>, fps: number }`
Anim keys: `idle_s idle_n idle_e idle_w walk_s walk_n walk_e walk_w run_s run_n run_e run_w`.
Frame indices are `row * cols + col`. Character reads as a JRPG chibi hero: blond spiky hair,
red-and-black coat with gold trim, blue-white cape, ~48×64 px per frame at minimum.

## `src/world/terrain.js`

```js
export function createTerrain(opts): Terrain
```

`opts = { size: 512, seed: number, renderer }`

```
Terrain = {
  object3D: THREE.Object3D,       // terrain mesh(es), added to scene by main
  height(x, z): number,           // world-space surface height, cheap, no allocation
  normal(x, z, target?): THREE.Vector3,
  slope(x, z): number,            // 0 = flat, 1 = vertical
  biome(x, z): string,            // 'ocean'|'beach'|'grass'|'forest'|'road'|'rock'|'snow'|'field'
  isWater(x, z): boolean,         // below sea level or inside a river channel
  onRoad(x, z): number,           // 0..1 road mask
  waterHeight(x, z): number,      // surface height of the water body at x,z (sea level or river level)
  update(t: number, camera): void,
  meta: { size, seaLevel, maxHeight, poi: Array<{ name, x, z, kind }> }
}
```

POI kinds the props module will consume: `'castle' | 'village' | 'shrine' | 'bridge' | 'farm' | 'camp'`.
Terrain must produce: an ocean-facing coastline on the west, a river system with at least one
waterfall down a cliff face, rolling grass plateaus with sharp rocky cliff bands, dirt roads
that follow the contours, and one flat plateau for a castle.

## `src/world/water.js`

```js
export function createWater({ terrain, renderer, sky }): Water
```

`Water = { object3D, update(t, camera): void }` — ocean plane with animated swell + shoreline
foam, river ribbons following `terrain`'s channels, waterfall sheets with mist particles.

## `src/world/scatter.js`

```js
export function createScatter({ terrain, atlas, renderer }): Scatter
```

`Scatter = { object3D, update(t, camera): void, count: number }` — instanced camera-facing
billboards (Y-axis-locked) for all vegetation and rocks, placed by biome/slope rules, with
per-instance scale/tint/phase, vertex wind sway, and contact shadow blobs. Must be a single
draw call per atlas material. Target 12k–30k instances at 60fps.

## `src/world/props.js`

```js
export function createProps({ terrain, atlas, renderer }): Props
```

`Props = { object3D, update(t, camera): void }` — hand-built landmarks derived from
`terrain.meta.poi`: a white-and-blue spired castle, a village of tiled roofs, rope bridge,
wooden fences, wheat fields, signposts, torii/shrine. Built from procedural geometry +
procedurally generated textures. These are 3D (not billboards) but must read as painted
diorama models.

## `src/gfx/sky.js`

```js
export function createSkyAndLights({ scene, renderer, terrain }): SkyRig
```

`SkyRig = { object3D, sun: THREE.DirectionalLight, ambient, update(t): void, params }` —
sky dome with gradient + procedural clouds, sun with shadow map sized for the diorama,
hemisphere fill, exponential height fog tuned to the miniature-diorama look.

## `src/gfx/post.js`

```js
export function createPostFX({ renderer, scene, camera }): PostFX
```

`PostFX = { render(dt): void, setSize(w, h): void, params: object, dispose(): void }` —
the HD-2D signature stack: threshold bloom with wide soft falloff, **tilt-shift depth of
field** (that is what sells the miniature diorama), filmic tone map + color grade, subtle
chromatic aberration at the edges, vignette, fine grain, and a light sharpen. Must own the
final draw to screen.

## `src/game/player.js`

```js
export function createPlayer({ terrain, sheet, renderer }): Player
export function createCameraRig({ camera, player, terrain }): CameraRig
```

`Player = { object3D, position: THREE.Vector3, update(dt, input, camera): void, facing: string }`
`CameraRig = { update(dt, input): void, params }`
`input = { x: -1..1, y: -1..1, run: boolean, zoom: -1..1, rotate: -1..1 }`

The player is a billboard sprite that snaps to the ground, animates its walk cycle, kicks up
dust, and casts a soft blob shadow. The camera is a high-angle diorama camera that orbits and
follows with smoothing.

## `src/ui/hud.js`

```js
export function createHUD({ terrain, player }): HUD
```

`HUD = { update(dt): void, dom: HTMLElement }` — the corner minimap (rendered from terrain
biome data, with POI pins and a player arrow), plus a location nameplate. Mounted into
`#ui`. Must look like a shipped JRPG UI: soft glass panel, gold hairline, drop shadow.

---

## Integration notes

`main.js` calls, per frame, in this order:
`sky.update(t)` → `terrain.update(t, camera)` → `water.update(t, camera)` →
`scatter.update(t, camera)` → `props.update(t, camera)` → `player.update(dt, input, camera)` →
`rig.update(dt, input)` → `hud.update(dt)` → `post.render(dt)`.

`window.__POC` is exposed for the screenshot harness: `{ ready: boolean, engine }`. Set
`ready = true` once the first frame with full world content has drawn.
