# Reference Frames — LOOK AT THESE

These are the actual target images. **Open them with the `Read` tool and study them before you
write code.** Prose descriptions are a lossy substitute; these are the real thing.

| File | Scene | What it establishes |
| --- | --- | --- |
| `frame01.png` | Overworld — grasslands, dirt road, royal castle, coastal cliffs | **The primary target.** This is the frame the overworld POC is recreating. |
| `frame02.png` | Overworld — cherry-blossom valley, cyan river, waterfalls, village | Biome variety, water quality, saturated colour under the same grade |
| `frame03.png` | Story scene — airship deck at night | Sprites in a dramatic 3D set; sprite lighting is per-scene, not flat |
| `frame04.png` | Battle — stone hall vs. a dragon | UI hierarchy, additive VFX with light spill, staging |
| `frame05.png` | Battle — misty highland vs. a boss | Atmospheric depth, silhouette readability under fog |

All plates are 1630×921, cropped from a 2000×921 phone capture to remove the letterbox bars.

## Overlays to ignore

These are capture artifacts from the source video, **not** part of the game:

- A streamer picture-in-picture box and an "AREKKZ GAMING" watermark in the **bottom-left**.
- A "CLICK HERE TO SUBSCRIBE" watermark in the **bottom-right** of some frames.
- A "SOURCE IGN" tag and a Japanese "ストーリー" caption on frames 3 and 5.
- Japanese subtitle text at the bottom of frame 3.

Do not reproduce any of these. Everything else in the frame is the target.

## How to use these

- **Art director**: derive the palette, scale chart, camera and post values by *looking*, then
  write them into `ART_BIBLE.md` as numbers.
- **Implementers**: before you write your module, open `frame01.png` and find the thing you are
  responsible for. Study its shape language, its colour ramps, how big it is relative to the
  hero sprite, and how it sits against the ground. Then build *that*.
- **Critic**: put your rendered frame next to `frame01.png` and compare them directly. That
  side-by-side is the score — not your impression of the render on its own.

See also `../REFERENCE.md` (prose breakdown) and `../REFERENCE_MEASURED.md` (sampled hex
values, depth-of-field band positions, and the vegetation scale chart). Where those files and
the images disagree, **the images win**.
