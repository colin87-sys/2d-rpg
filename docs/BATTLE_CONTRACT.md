# Module Contract — Aetherbound Battle Screen POC

> **Before anything else: open `docs/reference/frame04.png` with the `Read` tool and look at
> it.** That image is the frame this battle POC is recreating; `frame05.png` is the same
> system in a second environment and both must be producible. `docs/BATTLE_BIBLE.md` carries
> every measured number — build to it. Do not build from prose alone.

**Hard rule for every implementer: do not change any exported signature below, and do not
edit files you do not own.** `battle.html`, `src/battle/main.js` and `tools/shot.mjs` are
owned by the integrator. The overworld files (`src/main.js`, `src/core/engine.js`,
`src/art/*`, `src/world/*`, `src/gfx/*`, `src/game/*`, `src/ui/*`, `index.html`) are frozen:
battle modules may **import** from them read-only where noted, never modify them. If you
need something added to the contract, note it in your return summary instead of editing
another module.

Stack: Three.js `^0.169` (native ESM + import map, no bundler), no external assets.
**Every texture, sprite and UI graphic must be generated procedurally in code** (Canvas2D /
data textures / DOM+CSS). No network fetches, no binary asset files, no webfonts.

Units: 1 world unit = 1 metre. Battle stage: ground plane `y = 0`, **+X = party side
(screen right), −Z = upstage**, camera fixed at `(0, 7, 14)`, pitch 12° down, vFOV 26°
(BATTLE_BIBLE §1). The battle scene is its own world — it shares no scene graph with the
overworld.

---

## `src/battle/arena.js`

```js
export function createArena({ renderer, scene, variant }): Arena   // variant: 'hall' | 'highland'
```

```
Arena = {
  object3D: THREE.Object3D,        // the full set, added to scene by main
  groundY(x, z): number,           // stage surface height (0 for hall; shelf for highland)
  camera: { position, pitchDeg, fovDeg },   // BIBLE §1 values for main to apply
  rim: { dir: [x, y], color: '#rrggbb', strength: number },  // sprite rim law, BIBLE §5
  addSpellLight(light: THREE.PointLight): void,  // parents VFX lights into the set
  update(t: number, camera): void, // torch flicker / fog-card drift / ember spawn
  meta: { variant, torches: Array<{x,y,z}>, safeStage: {x0,x1,z0,z1} }
}
```

Owns the environment: hall (near-black stone walls, door + stepped platform at z −12, two
brazier columns with 3-layer flame billboards and flickering point lights at (∓5.3, 5.4,
−10.8)) or highland (rock shelf, tree/rock silhouettes, 3 drifting fog cards, backlight glow
disc, ground mist). Owns the scene fog, all environment lights, and the light/palette values
of BIBLE §3–§4. Both variants must ship behind the one flag.

## `src/battle/art/enemySprite.js`

```js
export function makeDragonArt(): EnemyArt      // hall enemy   (BIBLE §6 dragon)
export function makeSorcererArt(): EnemyArt    // highland boss (BIBLE §6 sorcerer)
```

`EnemyArt = { texture: THREE.Texture, px, py, anchor: 'feet'|'center', worldHeight: number,
floatOffset: number, meta: { name, palette } }`

Hand-painted Canvas2D sprites at the BIBLE-specified canvases (dragon 1024×896 anchored at
feet, worldHeight 6.0; sorcerer 768×1024 anchored at centre, floatOffset 0.6, worldHeight
6.5). Painterly: 8–12 tone ramps, soft blends, dark edge glaze + scene-keyed rim — **no
pixel outlines, no NearestFilter** (`LinearFilter` + mipmaps, sRGB). This module owns enemy
textures only; it places nothing.

## `src/battle/art/battlerSheet.js`

```js
export function makeBattlerSheet(id): Sheet    // id: 'rain' | 'lasswell' | 'fina' | 'lid'
```

`Sheet = { texture, frameW, frameH, cols, rows, anims: Record<string, number[]>, fps,
meta: { texelsPerMeter: 52.5, bodyPx, groundRow } }` — the exact Sheet shape of
`src/art/characterSprite.js` (which may be imported read-only for palette/idiom reference;
Rain's ramps must byte-match ART_BIBLE §3 hero colours). 96×96 cells, body ≈ 84 px,
4-shade ramps + `#1d1410` outline, NearestFilter, power-of-two sheet. Required anim keys:
`idle ready attack cast hit ko victory` (west-facing profile; `victory` faces south).
Frame counts per BIBLE §5/§9.

## `src/battle/units.js`

```js
export function createUnits({ arena, sheets, enemyArt, renderer }): Units
```

```
Units = {
  object3D,                         // all unit billboards + contact shadows
  roster: Array<UnitState>,         // party, in slot order
  enemy: UnitState,
  get(id): UnitState,
  playAnim(id, name, opts?): void,  // opts: { onDone }
  spawnAt(id, worldPos): void,
  update(dt, camera): void,
}
UnitState = {
  id, name, isEnemy: boolean,
  anchor: THREE.Vector3,            // feet (world); BIBLE §1 staging is the boot layout
  hp, hpMax, mp, mpMax, limit,      // limit: 0..1
  statuses: string[],               // e.g. ['stone']
  queueEta: number,                 // seconds until this unit acts (drives the timeline)
  screen(target?): {x, y, h}        // projected feet px + sprite screen height (UI anchor)
}
```

The staging layer and the single source of battle state that every UI module reads. Owns:
billboard placement at the BIBLE §1 anchors, per-scene lit sprite material + runtime rim
pass (from `arena.rim`), contact shadows, ground occlusion, spell-light response (≤ +35 %),
anim clocks, and the enemy quad. Mutation happens only through `choreo` calling its methods
/ writing its stat fields.

## `src/battle/vfx.js`

```js
export function createVFX({ scene, arena, units, renderer }): VFX
```

`VFX = { object3D, cast(name, casterId, targetId, opts?): Promise<void>, update(dt, camera):
void, impulses: { shake: number, flash: number } }`

Owns spell effects (`'firaga'` column burst per BIBLE §8 is mandatory; add at will), their
additive geometry, particle pools (≤ 180 alive), and the travelling **point light** it
registers via `arena.addSpellLight` so spill hits the set and sprites. Writes `impulses`
(0..1, decaying) each frame; `main` hands them to `post.render`. `cast` resolves when the
effect completes (choreo awaits it).

## `src/battle/ui/timeline.js`

```js
export function createTimeline({ units }): TimelineUI
```

`TimelineUI = { dom: HTMLElement, update(dt): void }` — the top turn-order rail of BIBLE
§7.1: track + slot ticks, active diamond with painted bust portraits, next-up diamonds,
queue portraits positioned by `queueEta`, crimson enemy markers below the rail, 240 ms
re-sort slides, 90 ms arrival flash. Mounted into `#ui`. Owns nothing below y 0.16 fh.

## `src/battle/ui/panels.js`

```js
export function createPanels({ units }): PanelsUI
```

`PanelsUI = { dom, update(dt): void }` — the four party panels (BIBLE §7.2: geometry,
gradients, beveled HP/MP pills, limit gauge with full-state shimmer, damage ghosts,
low-HP states) **and** the enemy HP + break gauges (§7.3, anchored under the enemy via
`units.enemy.screen()`). Owns the bottom band y > 0.83 fh plus the enemy gauge block.

## `src/battle/ui/callouts.js`

```js
export function createCallouts({ units, camera }): CalloutsUI
```

`CalloutsUI = { dom, update(dt): void, announce(text): void, number(unitId, value, kind):
void, reticle(unitId | null): void, status(unitId): void }` — the skill-name banner (BIBLE
§7.4), damage/heal numerals, status-icon diamonds and the target reticle (§7.5), all
world-anchored via `units.get(id).screen()`. Owns the floating chrome; never touches panels
or timeline DOM.

## `src/battle/choreo.js`

```js
export function createChoreography({ units, vfx, timeline, panels, callouts }): Choreo
```

`Choreo = { update(dt): void, state: 'idle'|'acting'|'frozen' }` — the scripted demo loop
that makes the screenshot a mid-battle moment: turn beats per BIBLE §9 (ready → banner →
cast `firaga` on a party target → hit reacts → damage numerals → queue re-sort), cycling
~9 s, stats drifting believably (hall boot values: Rain 2938/204, Lasswell 2508/327 with
**full limit**, Fina 1507/324, Lid 1982/313 — the frame04 readout). Must honour
`?freeze=firaga`: advance to the burst peak then hold state (torches/fog keep animating) for
deterministic capture. Owns the turn logic; renders nothing.

## `src/battle/post.js`

```js
export function createBattlePost({ renderer, scene, camera, variant }): BattlePost
```

`BattlePost = { render(dt, impulses): void, setSize(w, h): void, params: object,
dispose(): void }` — the battle post stack per BIBLE §10: threshold bloom, ACES + per-variant
grade, mild tilt-shift (sharp 0.30–0.86 fh), sharpen, CA, per-variant vignette, grain, and
the flash/shake impulse consumer (budgets §8). Owns the final draw to screen. May crib from
`src/gfx/post.js` read-only but must not import-and-mutate its params.

---

## Entry point (integrator-owned)

`battle.html` — a sibling of `index.html` with the same import map and `#app` / `#ui`
divs, loading `/src/battle/main.js`. Query params: `?variant=hall|highland` (default
`hall`), `?freeze=firaga`. `src/battle/main.js` constructs, in order: engine/renderer →
`createArena` → sheets (`makeBattlerSheet` ×4) + enemy art → `createUnits` → `createVFX` →
`createTimeline` → `createPanels` → `createCallouts` → `createChoreography` →
`createBattlePost`, applies `arena.camera`, and exposes `window.__POC = { ready, engine }`,
setting `ready = true` once the first fully-populated frame has drawn.

## Integration notes

`src/battle/main.js` calls, per frame, in this order:
`arena.update(t, camera)` → `choreo.update(dt)` → `units.update(dt, camera)` →
`vfx.update(dt, camera)` → `timeline.update(dt)` → `panels.update(dt)` →
`callouts.update(dt)` → `post.render(dt, vfx.impulses)`.

UI modules are DOM inside `#ui` (above the canvas; post never touches them). All world→
screen anchoring goes through `units.*.screen()` — no UI module owns a projection of its
own. The overworld page and modules must keep working untouched.

---

## Build & verification (no bundler)

Native ES modules + import map, exactly like the overworld — no build step, no new
dependencies. The integrator extends `tools/shot.mjs` with a backward-compatible
`--page <file>` flag (default `index.html`) that changes only the URL it opens.

Verify your work with:

```
node tools/shot.mjs shots/battle_hall.png     --page "battle.html?freeze=firaga" --w 1600 --h 900
node tools/shot.mjs shots/battle_highland.png --page "battle.html?variant=highland" --w 1600 --h 900
```

It boots the static server, renders in headless Chromium (SwiftShader — software GL, keep an
eye on cost), waits for `window.__POC.ready`, screenshots, and prints all console output plus
page errors. **A clean console is part of "done".** Then `Read` the PNG, put it next to
`docs/reference/frame04.png` (or `frame05.png`), and look at both.
