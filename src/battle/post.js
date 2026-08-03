/**
 * src/battle/post.js — the battle screen's final draw (BATTLE_BIBLE §10).
 *
 * CONTRACT (frozen):
 *   createBattlePost({ renderer, scene, camera, variant }) -> BattlePost
 *   BattlePost = { render(dt, impulses): void, setSize(w, h): void,
 *                  params: object, dispose(): void }
 *
 * Same pipeline family as the overworld (src/gfx/post.js — read, not imported:
 * its params must never be mutated from here), battle-tuned per §10:
 *
 *   scene → HDR target
 *     → threshold bloom (bright gate on POST-TONEMAP display luma — the
 *       overworld's round-3 lesson; 13-tap Jimenez downsample pyramid + tent
 *       ADDITIVE upsample, UnrealBloom semantics)
 *   → ACES filmic (Hill fit, exposure 1.0) + bloom composite (display space)
 *   → per-variant GRADE — the §10 table, both columns in one shader:
 *       hall:     lifted blue-blacks +(.010,.018,.038), warm mids ×(1.06,1.00,.92),
 *                 sat 1.05, gentle contrast push — firelight against near-black
 *       highland: desat to 0.82 FIRST, sage mids ×(.99,1.02,.97), shadow lift
 *                 +(.008,.020,.018), gentle contrast pull — foggy and flat
 *   → MILD tilt-shift: sharp band 0.30–0.86 fh, ramps 0.10, max 4/3 px hall,
 *     3/2.4 px highland @1080p. This is a proscenium, not a miniature — the
 *     overworld's 9.5/7 px would smear the dragon's wings and the torch band.
 *     The band always contains the full stage; inside it the frame is the
 *     bit-exact full-res grade target (blend = 0), so chibi texels survive.
 *   → band-masked LUMA-ONLY unsharp (0.25 hall / 0.20 highland)
 *   → chromatic aberration (quadratic ease from r 0.55, chroma-clamped so a
 *     sub-pixel shift can never flip a 1-px chibi texel to magenta)
 *   → per-variant vignette — hall 0.34 near-symmetric with corners landing on
 *     #000513; highland 0.42 TOP-WEIGHTED landing on #022123. Implemented as
 *     darken + hue-bearing colour floor: corners keep their blue/teal identity,
 *     never #000 (instant-fail §11.6).
 *   → animated luma grain (0.028 / 0.035) → dither → the ONE linear→sRGB encode.
 *
 * IMPULSES (§8): render(dt, impulses) consumes { shake, flash } as 0..1
 * decaying envelopes written by vfx.js. The contract split (stated in vfx.js):
 * vfx owns the envelope, post owns the oscillation and the px/percent mapping.
 *   flash: display-space white mix, CEILING 15 % — firaga's 0.80 peak lands at
 *          the measured 12 %. Applied before the vignette so corners hold and
 *          the frame pops without ever blowing out (the reference's Firaga is
 *          bright, the frame is not white).
 *   shake: screen-space content shake, CEILING 7 px @1080p / the envelope dies
 *          within 220 ms upstream — firaga's 0.86 peak ≈ 6 px over 180 ms with
 *          ~2 oscillations at 11 Hz. The lens layer (CA / vignette / grain)
 *          stays fixed while the image kicks; a proportional inward pad keeps
 *          every sample on-buffer so no clamp streaks appear at the edges.
 * Both ceilings are clamped in sync() — params can tune below the §8 budget,
 * never above it.
 *
 * COLOUR: linear working space throughout — every RT is LinearSRGBColorSpace
 * and float where available; exactly one lin2srgb at the end of the final (or
 * debug/bypass copy) pass. Half-float is probed and the stack degrades to
 * 8-bit targets when unavailable (thresholds are display-space < 1.0, so the
 * bloom gate still functions; HDR sparkle is what degrades).
 *
 * INTEGRATOR NOTES:
 *   - params is live: plain numbers/arrays/hex strings re-synced every frame.
 *   - params.debug: 'off' | 'scene' | 'bloom' | 'dof' | 'band'; params.bypass
 *     renders the raw scene preview-tonemapped for A/B.
 *   - setVariant('hall'|'highland') re-tunes params in place (extra, additive
 *     to the contract shape — nothing depends on it).
 *   - px-denominated params are authored @1080p (as the bible writes them) and
 *     scale with the actual drawing-buffer height.
 *   - setSize resizes every target from the renderer's drawing-buffer size
 *     (call it after renderer.setSize; args are a fallback only).
 *   - UI is DOM above the canvas; this stack never touches it.
 */

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Per-variant recipes — BATTLE_BIBLE §10, both columns, plus the frame-checked
// vignette floors (§3 WALL_BLACK / §4 TOP_CORNER families).
// ---------------------------------------------------------------------------

const VARIANTS = {
  // frame04 — warm firelight against near-black, deep contrast
  hall: {
    exposure: 1.0,
    bloom: { threshold: 0.62, knee: 0.16, strength: 0.55, radius: 0.90 },
    grade: {
      preSat: 1.0,                          // no pre-desat in the hall
      shadowLift: [0.010, 0.018, 0.038],    // lifted blue-blacks (§10 verbatim)
      shadowLiftEnd: 0.30,
      midTint: [1.06, 1.00, 0.92],          // warm firelit mids
      midAmount: 1.0,
      midLo: 0.22,
      midHi: 0.70,
      postSat: 1.05,                        // sat 1.05 after the warm
      contrast: 1.045,                      // deep-contrast push, gentle
      contrastPivot: 0.38,
    },
    dof: { maxTopPx: 4.0, maxBotPx: 3.0 },  // §10: 4 px top / 3 px bottom
    sharpen: { amount: 0.25 },
    ca: { amountPx: 1.2 },
    vignette: {
      start: 0.55, end: 1.16, strength: 0.34,
      topWeight: 1.0, bottomWeight: 0.85,   // near-symmetric; ceiling darkest
      floor: '#000513',                     // corners land here — blue, not #000
    },
    grain: { amount: 0.028 },
  },

  // frame05 — cool sage fog, low contrast, silhouette-first
  highland: {
    exposure: 1.0,
    bloom: { threshold: 0.80, knee: 0.12, strength: 0.18, radius: 0.90 },
    grade: {
      preSat: 0.82,                         // desat to 0.82 FIRST (§10 order)
      shadowLift: [0.008, 0.020, 0.018],    // teal-green shadow lift
      shadowLiftEnd: 0.30,
      midTint: [0.99, 1.02, 0.97],          // sage mids
      midAmount: 1.0,
      midLo: 0.20,
      midHi: 0.62,
      postSat: 1.0,
      contrast: 0.945,                      // low-contrast pull toward the fog
      contrastPivot: 0.50,                  // pivot ≈ the fog-band plateau
    },
    dof: { maxTopPx: 3.0, maxBotPx: 2.4 },  // §10: max 3 px
    sharpen: { amount: 0.20 },
    ca: { amountPx: 1.0 },
    vignette: {
      start: 0.52, end: 1.12, strength: 0.42,
      topWeight: 1.0, bottomWeight: 0.55,   // §10: top-weighted
      floor: '#022123',                     // §4 TOP_CORNER — teal, hue-bearing
    },
    grain: { amount: 0.035 },
  },
}

function makeParams(variant) {
  const v = VARIANTS[variant] || VARIANTS.hall
  return {
    enabled: true,
    bypass: false,
    debug: 'off',            // 'off' | 'scene' | 'bloom' | 'dof' | 'band'
    msaa: 0,                 // scene-target MSAA; 0 for SwiftShader safety
    variant: VARIANTS[variant] ? variant : 'hall',
    exposure: v.exposure,    // ACES exposure (§10: 1.0 both variants)

    bloom: {
      enabled: true,
      threshold: v.bloom.threshold,  // post-tonemap display luma
      knee: v.bloom.knee,
      strength: v.bloom.strength,
      radius: v.bloom.radius,        // per-level scatter decay on upsample
      levels: 5,
      spread: 1.0,
    },

    grade: {
      preSat: v.grade.preSat,
      shadowLift: v.grade.shadowLift.slice(),
      shadowLiftEnd: v.grade.shadowLiftEnd,
      midTint: v.grade.midTint.slice(),
      midAmount: v.grade.midAmount,
      midLo: v.grade.midLo,
      midHi: v.grade.midHi,
      postSat: v.grade.postSat,
      contrast: v.grade.contrast,
      contrastPivot: v.grade.contrastPivot,
    },

    dof: {
      enabled: true,
      // §10 band, shared by both variants: sharp 0.30–0.86 fh, ramps 0.10.
      // fh is measured from the frame TOP (as the bible measures); the uv
      // conversion happens in sync(). The whole stage lives inside the band.
      bandTopFh: 0.30,
      bandBotFh: 0.86,
      rampTopFh: 0.10,
      rampBotFh: 0.10,
      maxTopPx: v.dof.maxTopPx,      // px @1080p
      maxBotPx: v.dof.maxBotPx,
      taps: 18,                      // small radii need few taps (SwiftShader)
      lumaThreshold: 0.62,           // bokeh boost: torch flames in the blur
      lumaBoost: 1.8,                // gentler than the overworld — restraint
      jitter: 1.0,
      fill: true,
      fillScale: 0.5,
      fillMaxPx: 1.6,
      blendLoPx: 0.30,
      blendHiPx: 1.40,
    },

    sharpen: {
      amount: v.sharpen.amount,      // luma-only unsharp, band-masked
      radiusPx: 1.0,
    },

    ca: {
      amountPx: v.ca.amountPx,       // corner shift @1080p
      inner: 0.55,                   // dead zone radius (quadratic ease out)
      chromaClamp: 0.12,             // fringe deviation cap per px of shift
    },

    vignette: {
      start: v.vignette.start,
      end: v.vignette.end,
      strength: v.vignette.strength,
      topWeight: v.vignette.topWeight,
      bottomWeight: v.vignette.bottomWeight,
      floor: v.vignette.floor,       // hex — the hue the corners land on
    },

    grain: {
      amount: v.grain.amount,
      sizePx: 1.0,
      fps: 24,                       // filmic re-roll, not per-frame sizzle
      shadowFloor: 0.35,
    },

    // §8 impulse mapping — ceilings are BINDING and re-clamped in sync():
    // flash ≤ 15 %, shake ≤ 7 px @1080p. vfx envelopes already die ≤ 220 ms.
    impulse: {
      flashMax: 0.15,
      shakeMaxPx: 7.0,
      shakeHz: 11.1,                 // ≈ 2 oscillations over firaga's 180 ms
      shakeYRatio: 0.45,             // mostly horizontal — a stage kick
    },

    dither: 0.6,                     // LSBs — the near-black hall must not band
  }
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const PRELUDE = /* glsl */ `
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`

// ACES filmic — the same three-equivalent Hill fit the overworld grades with
// (incl. the /0.6 exposure bake), shared by the grade pass and the bloom
// bright gate so "display luma 0.62/0.80" means what the viewer sees.
const ACES_GLSL = /* glsl */ `
  vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 acesFilmic(vec3 color) {
    const mat3 ACESInputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777)
    );
    const mat3 ACESOutputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327),
      vec3(-0.53108,  1.10813, -0.07276),
      vec3(-0.07367, -0.00605,  1.07602)
    );
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return clamp(color, 0.0, 1.0);
  }
`

const SRGB_GLSL = /* glsl */ `
  vec3 lin2srgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }
`

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// -- bloom bright pass (half res) --------------------------------------------
// Karis-weighted 4-tap average (tames the 2–6 px spark fireflies of §8 into
// steady glow instead of flicker), then a soft-knee gate on the TONEMAPPED
// display luma. In display space the hall's torch-pool walls (~0.47) and the
// highland's fog plateau (~0.60) sit under their gates (0.62 / 0.80) while
// flame cores, the firaga core streaks and sparks sail over — exactly the
// §10 allowed list. Emits full gated colour (LuminosityHighPass semantics),
// composited post-tonemap, so 0.55/0.18 strength reads as authored.
const BRIGHT_FRAG = PRELUDE + ACES_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uExposure;

  void main() {
    float ex = uExposure * (1.0 / 0.6);
    vec3 s0 = texture2D(tSrc, vUv + uTexel * vec2(-0.75, -0.75)).rgb;
    vec3 s1 = texture2D(tSrc, vUv + uTexel * vec2( 0.75, -0.75)).rgb;
    vec3 s2 = texture2D(tSrc, vUv + uTexel * vec2(-0.75,  0.75)).rgb;
    vec3 s3 = texture2D(tSrc, vUv + uTexel * vec2( 0.75,  0.75)).rgb;
    float w0 = 1.0 / (1.0 + luma(s0) * ex);
    float w1 = 1.0 / (1.0 + luma(s1) * ex);
    float w2 = 1.0 / (1.0 + luma(s2) * ex);
    float w3 = 1.0 / (1.0 + luma(s3) * ex);
    vec3 c = (s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3) / (w0 + w1 + w2 + w3);

    vec3 mapped = acesFilmic(max(c, 0.0) * ex);
    float l = luma(mapped);
    float contrib = smoothstep(uThreshold - uKnee, uThreshold + uKnee, l);
    gl_FragColor = vec4(mapped * contrib, 1.0);
  }
`

// -- bloom 13-tap Jimenez downsample -----------------------------------------
const DOWN_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;

  void main() {
    vec2 t = uTexel;
    vec3 a = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb;
    vec3 b = texture2D(tSrc, vUv + t * vec2( 0.0, -2.0)).rgb;
    vec3 c = texture2D(tSrc, vUv + t * vec2( 2.0, -2.0)).rgb;
    vec3 d = texture2D(tSrc, vUv + t * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture2D(tSrc, vUv).rgb;
    vec3 f = texture2D(tSrc, vUv + t * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture2D(tSrc, vUv + t * vec2(-2.0,  2.0)).rgb;
    vec3 h = texture2D(tSrc, vUv + t * vec2( 0.0,  2.0)).rgb;
    vec3 i = texture2D(tSrc, vUv + t * vec2( 2.0,  2.0)).rgb;
    vec3 j = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb;
    vec3 k = texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb;
    vec3 l = texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb;
    vec3 m = texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb;

    vec3 col = e * 0.125;
    col += (a + c + g + i) * 0.03125;
    col += (b + d + f + h) * 0.0625;
    col += (j + k + l + m) * 0.125;
    gl_FragColor = vec4(col, 1.0);
  }
`

// -- bloom tent upsample + ADDITIVE accumulate -------------------------------
// out = base + tent(wider) * scatter — UnrealBloom accumulation semantics,
// the family §10's threshold/strength/radius triplets were written for.
const UP_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform sampler2D tBase;
  uniform vec2 uTexel;
  uniform float uScatter;
  uniform float uSpread;

  void main() {
    vec2 t = uTexel * uSpread;
    vec3 s =
        texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb * 1.0
      + texture2D(tSrc, vUv + t * vec2( 0.0, -1.0)).rgb * 2.0
      + texture2D(tSrc, vUv + t * vec2( 1.0, -1.0)).rgb * 1.0
      + texture2D(tSrc, vUv + t * vec2(-1.0,  0.0)).rgb * 2.0
      + texture2D(tSrc, vUv).rgb                        * 4.0
      + texture2D(tSrc, vUv + t * vec2( 1.0,  0.0)).rgb * 2.0
      + texture2D(tSrc, vUv + t * vec2(-1.0,  1.0)).rgb * 1.0
      + texture2D(tSrc, vUv + t * vec2( 0.0,  1.0)).rgb * 2.0
      + texture2D(tSrc, vUv + t * vec2( 1.0,  1.0)).rgb * 1.0;
    s *= (1.0 / 16.0);
    vec3 base = texture2D(tBase, vUv).rgb;
    gl_FragColor = vec4(base + s * uScatter, 1.0);
  }
`

// -- tonemap + battle grade ---------------------------------------------------
// HDR in, display-linear LDR out. One shader, two personalities: the §10 table
// is entirely uniform-driven so hall/highland (and live re-tunes) share code.
// Order matters and follows the bible's phrasing:
//   hall:     lift blue-blacks → warm mids → sat 1.05 → contrast push
//   highland: desat 0.82 FIRST → lift teal shadows → sage mids → contrast pull
// (preSat=1 makes step one a no-op for the hall; postSat=1 for the highland.)
const GRADE_FRAG = PRELUDE + ACES_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform float uPreSat;
  uniform vec3  uShadowLift;
  uniform float uShadowLiftEnd;
  uniform vec3  uMidTint;
  uniform float uMidAmount;
  uniform float uMidLo;
  uniform float uMidHi;
  uniform float uPostSat;
  uniform float uContrast;
  uniform float uContrastPivot;

  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;

    // ACES filmic, exposure baked as exposure/0.6 (three-equivalent)
    c = max(c, 0.0) * (uExposure / 0.6);
    c = acesFilmic(c);

    // bloom composites in display space — the bright pass emits tonemapped
    // values, so the 0.55 hall strength is a real glow and the 0.18 highland
    // strength is a real whisper (not eaten by the ACES shoulder).
    if (uBloomStrength > 0.0) {
      c = clamp(c + texture2D(tBloom, vUv).rgb * uBloomStrength, 0.0, 1.0);
    }

    // 1 — pre-desaturation (highland: the fog world is drained first)
    float l = luma(c);
    c = mix(vec3(l), c, uPreSat);

    // 2 — shadow lift: hue-bearing darks (§11.6 — never grey, never #000)
    l = luma(c);
    c += (1.0 - smoothstep(0.0, uShadowLiftEnd, l)) * uShadowLift;

    // 3 — mid tint (hall: firelight warm; highland: sage)
    c *= mix(vec3(1.0), uMidTint, uMidAmount * smoothstep(uMidLo, uMidHi, luma(c)));

    // 4 — post saturation (hall 1.05)
    l = luma(c);
    c = mix(vec3(l), c, uPostSat);

    // 5 — gentle contrast about a pivot: the hall bites, the highland breathes
    c = uContrastPivot + (c - uContrastPivot) * uContrast;

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`

// -- DOF prefilter to half res ------------------------------------------------
const DOF_DOWN_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;

  void main() {
    vec3 c =
        texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2(-0.5,  0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`

// Analytic screen-band CoC — blur radius is a pure function of screen y.
// Band edges/ramps in GL uv space (y up); radii in the caller's px space.
const COC_GLSL = /* glsl */ `
  uniform float uBandLo;
  uniform float uBandHi;
  uniform float uRampLo;
  uniform float uRampHi;
  uniform float uMaxTop;
  uniform float uMaxBot;

  float cocAt(float y) {
    float above = smoothstep(0.0, 1.0, (y - uBandHi) / max(uRampHi, 1e-4));
    float below = smoothstep(0.0, 1.0, (uBandLo - y) / max(uRampLo, 1e-4));
    return above * uMaxTop + below * uMaxBot;
  }
`

// -- DOF Vogel-disc gather at half res ---------------------------------------
// Golden-angle disc, per-tap analytic-CoC coverage (scatter-as-gather), and a
// luma boost so torch flames above the band blur into round warm blobs.
const DOF_GATHER_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uTaps;
  uniform float uLumaTh;
  uniform float uLumaBoost;
  uniform float uJitter;

  const int MAXT = 32;
  const float GOLDEN = 2.399963229728653;

  void main() {
    float myCoc = cocAt(vUv.y);
    vec3 centre = texture2D(tSrc, vUv).rgb;
    if (myCoc < 0.20) {
      gl_FragColor = vec4(centre, 1.0);
      return;
    }

    float rot = hash12(gl_FragCoord.xy) * 6.2831853 * uJitter;
    float cw = 1.0 + uLumaBoost * pow(smoothstep(uLumaTh, 1.0, luma(centre)), 2.0);
    vec3 acc = centre * cw;
    float wsum = cw;

    for (int i = 0; i < MAXT; i++) {
      if (float(i) >= uTaps) break;
      float fi = float(i);
      float r = sqrt((fi + 0.5) / uTaps);
      float a = fi * GOLDEN + rot;
      vec2 offPx = vec2(cos(a), sin(a)) * (r * myCoc);
      vec2 uv = vUv + offPx * uTexel;
      float d = length(offPx);

      float tapCoc = cocAt(uv.y);
      float cover = clamp(1.0 + (tapCoc - d), 0.0, 1.0);

      vec3 s = texture2D(tSrc, uv).rgb;
      float w = cover * (1.0 + uLumaBoost * pow(smoothstep(uLumaTh, 1.0, luma(s)), 2.0));
      acc += s * w;
      wsum += w;
    }
    gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
  }
`

// -- DOF hex fill pass --------------------------------------------------------
const DOF_FILL_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uFillScale;
  uniform float uFillMax;

  void main() {
    float coc = cocAt(vUv.y);
    vec3 centre = texture2D(tSrc, vUv).rgb;
    if (coc < 0.20) {
      gl_FragColor = vec4(centre, 1.0);
      return;
    }
    float rad = min(coc * uFillScale, uFillMax);
    vec3 acc = centre * 2.0;
    for (int i = 0; i < 6; i++) {
      float a = 0.2617994 + float(i) * 1.0471976;
      acc += texture2D(tSrc, vUv + vec2(cos(a), sin(a)) * rad * uTexel).rgb;
    }
    gl_FragColor = vec4(acc / 8.0, 1.0);
  }
`

// -- DOF composite + band-masked luma-only unsharp ---------------------------
// blend == 0 inside the band: the stage (dragon body, all four chibi, the
// firaga column) reaches the screen as untouched full-res grade pixels.
// The unsharp term (0.25/0.20 @1 px) lives only where the band mask ≈ 1 and
// boosts LUMA with chroma ratios preserved — per-channel unsharp rings hot
// edges on 1-px NearestFilter chibi texels; this cannot.
const COMPOSITE_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSharp;
  uniform sampler2D tDof;
  uniform vec2 uTexelFull;
  uniform float uDofOn;
  uniform float uBlendLo;
  uniform float uBlendHi;
  uniform float uSharpAmt;
  uniform float uSharpRad;

  void main() {
    vec3 sharp = texture2D(tSharp, vUv).rgb;
    float coc = cocAt(vUv.y) * uDofOn;

    vec3 c = sharp;
    if (coc > uBlendLo) {
      vec3 blur = texture2D(tDof, vUv).rgb;
      c = mix(sharp, blur, smoothstep(uBlendLo, uBlendHi, coc));
    }

    float bandMask = 1.0 - smoothstep(0.0, 0.8, coc);
    if (uSharpAmt > 0.0 && bandMask > 0.001) {
      vec2 o = uTexelFull * uSharpRad;
      vec3 nb = 0.25 * (
          texture2D(tSharp, vUv + vec2(o.x, 0.0)).rgb
        + texture2D(tSharp, vUv - vec2(o.x, 0.0)).rgb
        + texture2D(tSharp, vUv + vec2(0.0, o.y)).rgb
        + texture2D(tSharp, vUv - vec2(0.0, o.y)).rgb);
      float dl = clamp(luma(sharp - nb), -0.5, 0.5);
      float mx = max(sharp.r, max(sharp.g, sharp.b));
      float sat = (mx - min(sharp.r, min(sharp.g, sharp.b))) / max(mx, 1e-4);
      float gain = uSharpAmt * bandMask * (1.0 - 0.35 * sat);
      float ratio = 1.0 + clamp(dl * gain / max(luma(sharp), 0.05), -0.6, 0.6);
      c *= ratio;
    }
    gl_FragColor = vec4(max(c, 0.0), 1.0);
  }
`

// -- final: shake + CA + flash + vignette + grain + dither + sRGB ------------
// The lens layer. Shake displaces WHAT the lens sees (content samples move,
// CA direction / vignette / grain stay screen-fixed — a kicked camera, not a
// wobbling texture). The inward pad guarantees every displaced sample stays
// on-buffer, so no clamp streaks at frame edges mid-shake.
const FINAL_FRAG = PRELUDE + SRGB_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uResolution;
  uniform float uAspect;
  uniform vec2 uShakeUv;      // oscillating content offset (uv)
  uniform vec2 uShakePad;     // amplitude-proportional inward pad (uv)
  uniform float uFlash;       // pre-mapped 0..0.15 white mix
  uniform float uCaPx;
  uniform float uCaInner;
  uniform float uCaClamp;
  uniform float uVigStart;
  uniform float uVigEnd;
  uniform float uVigStrength;
  uniform float uVigTopW;     // top-corner weight (highland: 1.0 vs bottom 0.55)
  uniform float uVigBotW;
  uniform vec3  uVigFloor;    // linear-space corner colour target
  uniform float uGrainAmt;
  uniform float uGrainSize;
  uniform float uGrainFloor;
  uniform float uFrame;
  uniform float uDither;

  void main() {
    vec2 nc = vUv * 2.0 - 1.0;
    float r = length(nc) * 0.70710678;   // 0 centre → 1 corners

    // §8 camera kick — content shakes inside a fixed lens
    vec2 suv = 0.5 + (vUv - 0.5) * (1.0 - 2.0 * uShakePad) + uShakeUv;

    // chromatic aberration: quadratic ease from uCaInner so the stage band
    // gets nearly nothing and the full shift lives at true corners; the
    // chroma clamp stops sub-pixel R/B decorrelation flipping 1-px chibi
    // texels hot while corner fringes on hard edges stay visible.
    vec3 c0 = texture2D(tSrc, suv).rgb;
    vec3 c = c0;
    float s = smoothstep(uCaInner, 1.0, r);
    float ca = uCaPx * s * s;
    if (ca > 0.01) {
      vec2 dirPx = normalize(vec2(nc.x * uAspect, nc.y) + 1e-6) * ca;
      vec2 duv = dirPx / uResolution;
      c.r = texture2D(tSrc, suv - duv).r;
      c.b = texture2D(tSrc, suv + duv).b;
      float lim = uCaClamp * min(ca, 1.5);
      c = c0 + clamp(c - c0, vec3(-lim), vec3(lim));
    }

    // §8 screen flash BEFORE the vignette: the burst pops to at most 15 %
    // white while the corners hold their darkness — the frame never blows out.
    c = mix(c, vec3(1.0), uFlash);

    // per-variant vignette with vertical weighting (§10: highland is
    // top-weighted) and a hue-bearing floor — corners land near #000513
    // (hall) / #022123 (highland), never pure black (§11.6).
    float w = mix(uVigBotW, uVigTopW, smoothstep(-0.6, 0.9, nc.y));
    float fall = smoothstep(uVigStart, uVigEnd, r) * w;
    c *= 1.0 - uVigStrength * fall;
    c = max(c, uVigFloor * fall);

    // animated luma-only grain, damped in the deepest blacks
    float l = luma(c);
    vec2 gp = floor(gl_FragCoord.xy / max(uGrainSize, 1.0));
    float n = hash12(gp + vec2(uFrame * 17.13, uFrame * 29.71));
    c += (n - 0.5) * 2.0 * uGrainAmt
       * mix(uGrainFloor, 1.0, smoothstep(0.02, 0.30, l));

    // sub-LSB dither — the hall's near-black falloffs must not band in 8-bit
    float d = hash12(gl_FragCoord.xy + vec2(uFrame * 3.7, uFrame * 7.9));
    c += (d - 0.5) * (uDither / 255.0);

    // the single linear → sRGB encode of the whole pipeline
    gl_FragColor = vec4(lin2srgb(clamp(c, 0.0, 1.0)), 1.0);
  }
`

// -- utility copy / debug -----------------------------------------------------
// mode 0: LDR-linear → sRGB. mode 1: HDR → preview tonemap. mode 2: band/CoC
// visualiser (cyan band edges + warm CoC tint) for tuning against frame04/05.
const COPY_FRAG = PRELUDE + SRGB_GLSL + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform float uMode;
  uniform float uExposure;
  uniform vec2 uResolution;

  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    if (uMode > 1.5) {
      float coc = cocAt(vUv.y);
      float m = max(uMaxTop, uMaxBot);
      c = mix(c, vec3(1.0, 0.45, 0.15), 0.45 * clamp(coc / max(m, 1e-3), 0.0, 1.0));
      float px = 1.5 / uResolution.y;
      if (abs(vUv.y - uBandHi) < px || abs(vUv.y - uBandLo) < px) {
        c = vec3(0.1, 0.9, 1.0);
      }
    } else if (uMode > 0.5) {
      c = max(c, 0.0) * uExposure;
      c = c / (1.0 + c);
    }
    gl_FragColor = vec4(lin2srgb(clamp(c, 0.0, 1.0)), 1.0);
  }
`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBattlePost({ renderer, scene, camera, variant = 'hall' }) {
  const params = makeParams(variant)

  // -- capability probe: half-float colour targets ---------------------------
  // WebGL2 + EXT_color_buffer_(half_)float → RGBA16F render targets, linear
  // filtering core. Otherwise 8-bit linear targets: both bloom gates are
  // display-space (< 1.0) so the stack keeps functioning; only HDR headroom
  // above the tonemap shoulder is lost.
  let hdrType = THREE.UnsignedByteType
  try {
    if (
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float')
    ) {
      hdrType = THREE.HalfFloatType
    }
  } catch (_) {
    hdrType = THREE.UnsignedByteType
  }

  const makeRT = (w, h, { depth = false, type = hdrType, samples = 0 } = {}) => {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: depth,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace, // linear throughout; encode once
      samples: samples | 0,
    })
    rt.texture.generateMipmaps = false
    return rt
  }

  // -- render targets ---------------------------------------------------------
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  let fullW = Math.max(1, size.x | 0)
  let fullH = Math.max(1, size.y | 0)

  let rtScene = null   // full res HDR + depth — the battle scene renders here
  let rtLDR = null     // full res — tonemapped + graded, display-linear
  let rtPost = null    // full res — DOF composite + sharpen
  let rtDofA = null    // half res ping
  let rtDofB = null    // half res pong
  let rtBright = null  // half res bloom bright
  let downs = []
  let ups = []
  let rtUpHalf = null  // final bloom accumulation at half res
  let builtLevels = 0

  function buildTargets() {
    const halfW = Math.max(1, fullW >> 1)
    const halfH = Math.max(1, fullH >> 1)

    rtScene = makeRT(fullW, fullH, { depth: true, samples: params.msaa })
    rtLDR = makeRT(fullW, fullH)
    rtPost = makeRT(fullW, fullH)
    rtDofA = makeRT(halfW, halfH)
    rtDofB = makeRT(halfW, halfH)
    rtBright = makeRT(halfW, halfH)

    builtLevels = Math.min(Math.max(params.bloom.levels | 0, 2), 7)
    downs = []
    ups = []
    let w = halfW
    let h = halfH
    for (let i = 0; i < builtLevels; i++) {
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
      downs.push(makeRT(w, h))
    }
    for (let i = 0; i < builtLevels - 1; i++) {
      ups.push(makeRT(downs[i].width, downs[i].height))
    }
    rtUpHalf = makeRT(halfW, halfH)
  }

  function disposeTargets() {
    const all = [rtScene, rtLDR, rtPost, rtDofA, rtDofB, rtBright, rtUpHalf, ...downs, ...ups]
    for (const rt of all) if (rt) rt.dispose()
    downs = []
    ups = []
  }

  buildTargets()

  // -- materials ---------------------------------------------------------------
  const mat = (fragmentShader, uniforms) =>
    new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      fog: false,
      lights: false,
    })

  const brightMat = mat(BRIGHT_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 0.62 },
    uKnee: { value: 0.16 },
    uExposure: { value: 1.0 },
  })

  const downMat = mat(DOWN_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  })

  const upMat = mat(UP_FRAG, {
    tSrc: { value: null },
    tBase: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uScatter: { value: 0.9 },
    uSpread: { value: 1.0 },
  })

  const gradeMat = mat(GRADE_FRAG, {
    tScene: { value: null },
    tBloom: { value: null },
    uBloomStrength: { value: 0.55 },
    uExposure: { value: 1.0 },
    uPreSat: { value: 1.0 },
    uShadowLift: { value: new THREE.Vector3(0.01, 0.018, 0.038) },
    uShadowLiftEnd: { value: 0.3 },
    uMidTint: { value: new THREE.Vector3(1.06, 1.0, 0.92) },
    uMidAmount: { value: 1.0 },
    uMidLo: { value: 0.22 },
    uMidHi: { value: 0.7 },
    uPostSat: { value: 1.05 },
    uContrast: { value: 1.0 },
    uContrastPivot: { value: 0.4 },
  })

  const cocUniforms = () => ({
    uBandLo: { value: 0.14 },
    uBandHi: { value: 0.70 },
    uRampLo: { value: 0.10 },
    uRampHi: { value: 0.10 },
    uMaxTop: { value: 4.0 },
    uMaxBot: { value: 3.0 },
  })

  const dofDownMat = mat(DOF_DOWN_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  })

  const dofGatherMat = mat(DOF_GATHER_FRAG, {
    ...cocUniforms(),
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTaps: { value: 18 },
    uLumaTh: { value: 0.62 },
    uLumaBoost: { value: 1.8 },
    uJitter: { value: 1.0 },
  })

  const dofFillMat = mat(DOF_FILL_FRAG, {
    ...cocUniforms(),
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFillScale: { value: 0.5 },
    uFillMax: { value: 0.8 },
  })

  const compositeMat = mat(COMPOSITE_FRAG, {
    ...cocUniforms(),
    tSharp: { value: null },
    tDof: { value: null },
    uTexelFull: { value: new THREE.Vector2() },
    uDofOn: { value: 1.0 },
    uBlendLo: { value: 0.3 },
    uBlendHi: { value: 1.4 },
    uSharpAmt: { value: 0.25 },
    uSharpRad: { value: 1.0 },
  })

  const finalMat = mat(FINAL_FRAG, {
    tSrc: { value: null },
    uResolution: { value: new THREE.Vector2() },
    uAspect: { value: 16 / 9 },
    uShakeUv: { value: new THREE.Vector2(0, 0) },
    uShakePad: { value: new THREE.Vector2(0, 0) },
    uFlash: { value: 0 },
    uCaPx: { value: 1.2 },
    uCaInner: { value: 0.55 },
    uCaClamp: { value: 0.12 },
    uVigStart: { value: 0.55 },
    uVigEnd: { value: 1.16 },
    uVigStrength: { value: 0.34 },
    uVigTopW: { value: 1.0 },
    uVigBotW: { value: 0.85 },
    uVigFloor: { value: new THREE.Vector3(0, 0, 0) },
    uGrainAmt: { value: 0.028 },
    uGrainSize: { value: 1.0 },
    uGrainFloor: { value: 0.35 },
    uFrame: { value: 0 },
    uDither: { value: 0.6 },
  })

  const copyMat = mat(COPY_FRAG, {
    ...cocUniforms(),
    tSrc: { value: null },
    uMode: { value: 0 },
    uExposure: { value: 1.0 },
    uResolution: { value: new THREE.Vector2() },
  })

  const materials = [
    brightMat, downMat, upMat, gradeMat, dofDownMat,
    dofGatherMat, dofFillMat, compositeMat, finalMat, copyMat,
  ]

  // -- full-screen triangle rig -----------------------------------------------
  const fsGeo = new THREE.BufferGeometry()
  fsGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  )
  fsGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  const fsMesh = new THREE.Mesh(fsGeo, copyMat)
  fsMesh.frustumCulled = false
  const fsScene = new THREE.Scene()
  fsScene.add(fsMesh)
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  function pass(material, target) {
    fsMesh.material = material
    renderer.setRenderTarget(target)
    renderer.render(fsScene, fsCam)
  }

  // -- per-frame uniform sync (params are live) --------------------------------
  const v3 = (u, a) => u.value.set(a[0], a[1], a[2])
  const vigFloorColor = new THREE.Color()

  function setCoc(u, bandLo, bandHi, rampLo, rampHi, maxTop, maxBot) {
    u.uBandLo.value = bandLo
    u.uBandHi.value = bandHi
    u.uRampLo.value = rampLo
    u.uRampHi.value = rampHi
    u.uMaxTop.value = maxTop
    u.uMaxBot.value = maxBot
  }

  function sync(time, impulses) {
    const p = params
    const pxScale = fullH / 1080 // "px @1080p" → this drawing buffer

    // fh (measured from frame top) → GL uv (measured from bottom)
    const bandHiUv = 1.0 - p.dof.bandTopFh
    const bandLoUv = 1.0 - p.dof.bandBotFh
    const maxTopFull = Math.max(0, p.dof.maxTopPx) * pxScale
    const maxBotFull = Math.max(0, p.dof.maxBotPx) * pxScale

    // bloom
    brightMat.uniforms.uThreshold.value = p.bloom.threshold
    brightMat.uniforms.uKnee.value = Math.max(p.bloom.knee, 1e-3)
    brightMat.uniforms.uExposure.value = p.exposure
    upMat.uniforms.uScatter.value = THREE.MathUtils.clamp(p.bloom.radius, 0, 1)
    upMat.uniforms.uSpread.value = p.bloom.spread

    // grade
    const g = gradeMat.uniforms
    g.uBloomStrength.value = p.bloom.enabled ? p.bloom.strength : 0.0
    g.uExposure.value = p.exposure
    g.uPreSat.value = p.grade.preSat
    v3(g.uShadowLift, p.grade.shadowLift)
    g.uShadowLiftEnd.value = p.grade.shadowLiftEnd
    v3(g.uMidTint, p.grade.midTint)
    g.uMidAmount.value = p.grade.midAmount
    g.uMidLo.value = p.grade.midLo
    g.uMidHi.value = p.grade.midHi
    g.uPostSat.value = p.grade.postSat
    g.uContrast.value = p.grade.contrast
    g.uContrastPivot.value = p.grade.contrastPivot

    // dof — gather + fill run in HALF-res px space
    setCoc(dofGatherMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull * 0.5, maxBotFull * 0.5)
    dofGatherMat.uniforms.uTaps.value = THREE.MathUtils.clamp(p.dof.taps | 0, 4, 32)
    dofGatherMat.uniforms.uLumaTh.value = p.dof.lumaThreshold
    dofGatherMat.uniforms.uLumaBoost.value = p.dof.lumaBoost
    dofGatherMat.uniforms.uJitter.value = p.dof.jitter

    setCoc(dofFillMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull * 0.5, maxBotFull * 0.5)
    dofFillMat.uniforms.uFillScale.value = p.dof.fillScale
    dofFillMat.uniforms.uFillMax.value = Math.max(0, p.dof.fillMaxPx) * pxScale * 0.5

    // composite — FULL-res px space
    setCoc(compositeMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull, maxBotFull)
    compositeMat.uniforms.uDofOn.value = p.dof.enabled ? 1.0 : 0.0
    const blendLo = Math.max(0.01, p.dof.blendLoPx * pxScale)
    compositeMat.uniforms.uBlendLo.value = blendLo
    compositeMat.uniforms.uBlendHi.value = Math.max(blendLo + 0.05, p.dof.blendHiPx * pxScale)
    compositeMat.uniforms.uSharpAmt.value = p.sharpen.amount
    compositeMat.uniforms.uSharpRad.value = Math.max(0.25, p.sharpen.radiusPx * pxScale)

    // -- §8 impulse consumer -------------------------------------------------
    // vfx hands 0..1 decaying envelopes; the ceilings live HERE and are
    // clamped so no param tune (or rogue impulse > 1) can exceed the budget:
    // flash ≤ 15 % white, shake ≤ 7 px @1080p. Firaga's authored peaks
    // (0.80 / 0.86) land on the measured 12 % / 6 px.
    const imFlash = THREE.MathUtils.clamp(impulses && +impulses.flash || 0, 0, 1)
    const imShake = THREE.MathUtils.clamp(impulses && +impulses.shake || 0, 0, 1)
    const flashMax = Math.min(Math.max(0, p.impulse.flashMax), 0.15)
    const shakeMaxPx = Math.min(Math.max(0, p.impulse.shakeMaxPx), 7.0)

    const ampPx = imShake * shakeMaxPx * pxScale
    const yRatio = THREE.MathUtils.clamp(p.impulse.shakeYRatio, 0, 1)
    const w = 2 * Math.PI * Math.max(0.1, p.impulse.shakeHz)
    // two incommensurate sines — reads as a kick, not a metronome
    const offX = Math.sin(w * time) * ampPx
    const offY = Math.sin(w * 1.83 * time + 1.7) * ampPx * yRatio

    const f = finalMat.uniforms
    f.uShakeUv.value.set(offX / Math.max(1, fullW), offY / Math.max(1, fullH))
    f.uShakePad.value.set(ampPx / Math.max(1, fullW), (ampPx * yRatio) / Math.max(1, fullH))
    f.uFlash.value = imFlash * flashMax

    // final lens layer
    f.uResolution.value.set(fullW, fullH)
    f.uAspect.value = fullW / Math.max(1, fullH)
    f.uCaPx.value = Math.max(0, p.ca.amountPx) * pxScale
    f.uCaInner.value = p.ca.inner
    f.uCaClamp.value = Math.max(0, p.ca.chromaClamp)
    f.uVigStart.value = p.vignette.start
    f.uVigEnd.value = Math.max(p.vignette.end, p.vignette.start + 1e-3)
    f.uVigStrength.value = p.vignette.strength
    f.uVigTopW.value = p.vignette.topWeight
    f.uVigBotW.value = p.vignette.bottomWeight
    vigFloorColor.set(p.vignette.floor)            // sRGB hex → linear floor
    f.uVigFloor.value.set(vigFloorColor.r, vigFloorColor.g, vigFloorColor.b)
    f.uGrainAmt.value = p.grain.amount
    f.uGrainSize.value = Math.max(1, p.grain.sizePx)
    f.uGrainFloor.value = p.grain.shadowFloor
    f.uFrame.value = Math.floor(time * Math.max(1, p.grain.fps))
    f.uDither.value = Math.max(0, p.dither)

    // debug copy shares the full-res CoC field so 'band' view is truthful
    setCoc(copyMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull, maxBotFull)
    copyMat.uniforms.uResolution.value.set(fullW, fullH)
  }

  // -- render ------------------------------------------------------------------
  let time = 0

  function render(dt, impulses) {
    time += Math.max(0, dt || 0)

    // live-rebuild on msaa / level changes (integrator tuning)
    const wantLevels = Math.min(Math.max(params.bloom.levels | 0, 2), 7)
    if (wantLevels !== builtLevels) {
      disposeTargets()
      buildTargets()
    } else if ((rtScene.samples | 0) !== (params.msaa | 0)) {
      rtScene.dispose()
      rtScene = makeRT(fullW, fullH, { depth: true, samples: params.msaa })
    }

    sync(time, impulses)

    const prevAutoClear = renderer.autoClear
    const prevTarget = renderer.getRenderTarget()

    // 1 — scene → HDR target (linear working space; RTs never sRGB-encode)
    renderer.autoClear = true
    renderer.setRenderTarget(rtScene)
    renderer.render(scene, camera)

    renderer.autoClear = false // every pass below overdraws its whole target

    // bypass / disabled: preview-tonemap the raw scene straight to screen
    if (params.bypass || !params.enabled) {
      copyMat.uniforms.tSrc.value = rtScene.texture
      copyMat.uniforms.uMode.value = 1
      copyMat.uniforms.uExposure.value = params.exposure
      pass(copyMat, null)
      renderer.autoClear = prevAutoClear
      renderer.setRenderTarget(prevTarget)
      return
    }

    // 2 — threshold bloom pyramid (half res down, additive tent up)
    if (params.bloom.enabled) {
      brightMat.uniforms.tSrc.value = rtScene.texture
      brightMat.uniforms.uTexel.value.set(1 / rtScene.width, 1 / rtScene.height)
      pass(brightMat, rtBright)

      let src = rtBright
      for (let i = 0; i < builtLevels; i++) {
        downMat.uniforms.tSrc.value = src.texture
        downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height)
        pass(downMat, downs[i])
        src = downs[i]
      }

      let acc = downs[builtLevels - 1]
      for (let i = builtLevels - 2; i >= 0; i--) {
        upMat.uniforms.tSrc.value = acc.texture
        upMat.uniforms.uTexel.value.set(1 / acc.width, 1 / acc.height)
        upMat.uniforms.tBase.value = downs[i].texture
        pass(upMat, ups[i])
        acc = ups[i]
      }
      upMat.uniforms.tSrc.value = acc.texture
      upMat.uniforms.uTexel.value.set(1 / acc.width, 1 / acc.height)
      upMat.uniforms.tBase.value = rtBright.texture
      pass(upMat, rtUpHalf)
    }

    // 3 — ACES + bloom composite + per-variant grade (HDR → display-linear)
    gradeMat.uniforms.tScene.value = rtScene.texture
    gradeMat.uniforms.tBloom.value = rtUpHalf.texture
    pass(gradeMat, rtLDR)

    // 4 — mild tilt-shift at half res
    let dofTex = rtDofA.texture
    if (params.dof.enabled) {
      dofDownMat.uniforms.tSrc.value = rtLDR.texture
      dofDownMat.uniforms.uTexel.value.set(1 / rtLDR.width, 1 / rtLDR.height)
      pass(dofDownMat, rtDofA)

      dofGatherMat.uniforms.tSrc.value = rtDofA.texture
      dofGatherMat.uniforms.uTexel.value.set(1 / rtDofA.width, 1 / rtDofA.height)
      pass(dofGatherMat, rtDofB)

      if (params.dof.fill) {
        dofFillMat.uniforms.tSrc.value = rtDofB.texture
        dofFillMat.uniforms.uTexel.value.set(1 / rtDofB.width, 1 / rtDofB.height)
        pass(dofFillMat, rtDofA)
        dofTex = rtDofA.texture
      } else {
        dofTex = rtDofB.texture
      }
    }

    // 5 — composite (stage band bit-exact) + band-masked unsharp
    compositeMat.uniforms.tSharp.value = rtLDR.texture
    compositeMat.uniforms.tDof.value = dofTex
    compositeMat.uniforms.uTexelFull.value.set(1 / rtLDR.width, 1 / rtLDR.height)
    pass(compositeMat, rtPost)

    // debug taps replace the final draw
    const dbg = params.debug
    if (dbg && dbg !== 'off') {
      const u = copyMat.uniforms
      if (dbg === 'scene') {
        u.tSrc.value = rtScene.texture
        u.uMode.value = 1
        u.uExposure.value = params.exposure
      } else if (dbg === 'bloom') {
        u.tSrc.value = rtUpHalf.texture
        u.uMode.value = 1
        u.uExposure.value = 2.0
      } else if (dbg === 'dof') {
        u.tSrc.value = dofTex
        u.uMode.value = 0
      } else {
        u.tSrc.value = rtPost.texture
        u.uMode.value = 2 // 'band'
      }
      pass(copyMat, null)
      renderer.autoClear = prevAutoClear
      renderer.setRenderTarget(prevTarget)
      return
    }

    // 6 — shake + CA + flash + vignette + grain + dither + sRGB → screen
    finalMat.uniforms.tSrc.value = rtPost.texture
    pass(finalMat, null)

    renderer.autoClear = prevAutoClear
    renderer.setRenderTarget(prevTarget)
  }

  // -- resize ------------------------------------------------------------------
  // Called after renderer.setSize, so the drawing buffer is authoritative
  // (CSS w/h args would miss devicePixelRatio); args are a fallback for a
  // not-yet-sized renderer. Rebuilds EVERY target.
  function setSize(w, h) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2())
    let nw = Math.max(1, s.x | 0)
    let nh = Math.max(1, s.y | 0)
    if (nw <= 1 && nh <= 1 && w > 0 && h > 0) {
      nw = Math.max(1, w | 0)
      nh = Math.max(1, h | 0)
    }
    if (
      nw === fullW && nh === fullH &&
      builtLevels === Math.min(Math.max(params.bloom.levels | 0, 2), 7)
    ) {
      return
    }
    fullW = nw
    fullH = nh
    disposeTargets()
    buildTargets()
  }

  // -- variant hot-swap (additive convenience; params stays the contract) -----
  function setVariant(next) {
    const v = VARIANTS[next]
    if (!v) return
    const fresh = makeParams(next)
    params.variant = next
    params.exposure = fresh.exposure
    Object.assign(params.bloom, fresh.bloom)
    Object.assign(params.grade, fresh.grade)
    Object.assign(params.dof, fresh.dof)
    Object.assign(params.sharpen, fresh.sharpen)
    Object.assign(params.ca, fresh.ca)
    Object.assign(params.vignette, fresh.vignette)
    Object.assign(params.grain, fresh.grain)
  }

  function dispose() {
    disposeTargets()
    for (const m of materials) m.dispose()
    fsGeo.dispose()
  }

  // Screen-space band needs no depth; keep the contract's camera referenced
  // for a future world-anchored focus plane.
  void camera

  return { render, setSize, params, dispose, setVariant }
}
