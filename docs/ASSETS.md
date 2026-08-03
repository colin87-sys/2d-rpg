# Real Assets — inventory and what changes

**This supersedes the "everything procedural" rule** in `CONTRACT.md` and `BATTLE_CONTRACT.md`
for anything listed here. That rule existed only because there were no assets to work from;
procedural generation was a substitute, not a goal. Where a real asset exists, use it.

Assets live in `assets/raw/`. They are committed to the repo.

## Received

| File | Size | What it is | Replaces |
| --- | --- | --- | --- |
| `bg_stone_hall.webp` | 1920×1080 | Torchlit stone hall battle background — columns, two braziers, stepped platform, door | the entire procedural `hall` variant in `src/battle/arena.js` |
| `bg_misty_highland.webp` | 1920×1080 | Misty highland battle background — rock shelf, conifers, fog banks, moonlit cloud | the entire procedural `highland` variant in `src/battle/arena.js` |
| `boss_sorcerer_sheet.webp` | 1500×1500 | Winged sorcerer boss, 13 frames: idle ×4, cast wind-up ×4, hit ×2, dissolve ×3 | `makeSorcererArt()` in `src/battle/art/enemySprite.js` |
| `battler_lasswell.webp` | 1920×1600 | Lasswell battler sheet, ~30 frames: idle, walk, attack, cast, hit, ko, victory | `makeBattlerSheet('lasswell')` |
| `battler_fina.webp` | 1920×1600 | Fina battler sheet, ~30 frames, same anim set | `makeBattlerSheet('fina')` |

## Still needed for the battle screen

- **Dragon** (hall enemy) — currently the weakest element in the frame; the critic called the
  procedural one "a cute vector bird-blob".
- **Rain** and **Lid** battler sheets — without them the party mixes real and procedural art at
  different quality levels, which reads worse than either alone.

## Still needed for the overworld

Nothing has been supplied yet. The overworld's procedural vegetation atlas and hero/mount
sheets were the one part of that screen the critic consistently praised, so they are not
urgent — but real tree/terrain art would move it more than another repair round.

## Implications for the code

1. **Sprite sheets need a frame grid.** Each battler sheet is a fixed-cell grid; the loader must
   derive `frameW`/`frameH`/`cols`/`rows` and map the contract's anim keys
   (`idle ready attack cast hit ko victory`) onto row/column ranges. The existing `Sheet` shape
   in `BATTLE_CONTRACT.md` stays — only its source changes.
2. **The boss sheet is not a uniform grid** — 13 frames laid out 4/4/4/1. It needs an explicit
   frame table, not a naive grid split.
3. **Backgrounds are pre-lit.** The hall art already contains its torch pools, falloff and
   colour grade. `arena.js` must stop generating a set and instead composite this plate, adding
   only what has to be dynamic: flame flicker, the spell's light response, and fog/mist drift.
   The scene's light rig still has to key **sprite** shading to match the plate.
4. **Post-processing must not fight the plate.** The hall grade fixes we specified were
   compensating for a bad procedural set. Against real art, most of that should be dialled back
   to near-neutral — bloom on the flames and spell only.
5. **Asset loading changes the boot path.** These are files fetched over HTTP, so `main.js` must
   await them before signalling `window.__POC.ready`, or captures will race a half-loaded scene.
6. **`.gitignore` must not exclude `assets/`.** Only generated captures under `shots/` are ignored.

## What stays procedural

The UI — timeline, panels, callouts — and all VFX. Those were the strongest parts of the battle
screen (the critic rated the panels closest to parity and the UI "palette-stable", which was the
whole point of the frame05 test) and no art has been supplied for them.
