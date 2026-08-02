/**
 * src/gfx/post.js — the HD-2D signature post stack.
 *
 * Matched against docs/reference/frame01.png: the top ~quarter of that frame
 * dissolves into soft sage-hazed blur, the hero band (0.25–0.79 fh) is pixel
 * crisp, the bottom edge softens again — the tabletop-miniature tilt-shift that
 * IS the genre. Bloom is wide and gentle (waterfall sheet, wheat tips, castle
 * stone), the grade lifts blacks cool-green and warms the mids to cream, edges
 * carry a whisper of chromatic aberration, and the whole frame sits under fine
 * animated grain. This file owns all of that plus the final draw to screen.
 *
 * CONTRACT (frozen):
 *   createPostFX({ renderer, scene, camera }) -> PostFX
 *   PostFX = { render(dt): void, setSize(w, h): void, params: object, dispose(): void }
 *
 * WHY HAND-ROLLED (and not EffectComposer):
 *   1. The focus band must be *bit-exact* full-resolution scene pixels — the
 *      pixel-art hero may not be resampled even once. A composer chain of
 *      full-res quads bilinear-taps the frame at every hop; here the sharp band
 *      is composited straight from the full-res grade target with blend = 0.
 *   2. Per-stage control of target format and resolution: HDR half-float for
 *      the scene + bloom pyramid, half-res for the DOF gather, exactly one
 *      linear→sRGB conversion at the very end. Composer passes each make their
 *      own assumptions about colour space and it is easy to double-encode.
 *   3. Fewer full-res passes — this must survive SwiftShader (software GL).
 *
 * PIPELINE (ART_BIBLE.md §7, in its exact order):
 *   scene → HDR target
 *     → bright pass (threshold 0.72 measured against POST-TONEMAP luma — the
 *       ACES output the viewer actually sees. R3 fix: R2 gated on pre-fit
 *       luma × exposure/0.6, where the sage fog plateau (~0.96) sails over
 *       0.72 — the whole hazed upper frame bloomed into a milky veil while
 *       real highlights barely cleared the fog. In display space fog sits at
 *       ~0.60 and only foam/falls/wheat tips/castle stone reach 0.78+, which
 *       is exactly the bible's allowed list; soft knee, Karis-tamed)
 *     → 5-level downsample pyramid (13-tap Jimenez) + tent-filtered ADDITIVE
 *       upsample accumulation (radius 0.85 = per-level decay, UnrealBloom
 *       semantics — R3 fix: R2 used mix(base, wider, 0.85), which *replaces*
 *       85 % of each level instead of accumulating, measured bloom delta on
 *       the final frame was under 1/255: bloom was silently absent)
 *   → ACES filmic (three-equivalent Hill fit, exposure 1.05), bloom composited
 *     in display space right after the fit (strength 0.30 of a display-referred
 *     bloom buffer — UnrealBloom semantics), then the colour grade
 *     (bible GLSL verbatim: cool-green lifted blacks, warm cream mids,
 *      saturation 1.08, highlight desat toward #fff3dc, per-channel L/G/G)
 *   → tilt-shift DOF: analytic screen-band CoC, half-res Vogel-disc bokeh
 *     gather with luma-boosted highlights + hex fill pass, full-res composite
 *     that keeps the band genuinely untouched
 *   → unsharp mask, masked to the focus band only, LUMA-ONLY (hue-preserving,
 *     with saturation-aware gain rolloff — per-channel unsharp rang red/green
 *     on the 1-px wheat texels)
 *   → chromatic aberration (radial, R out / B in, zero inside r 0.55,
 *     quadratic ease + chroma-clamped so sub-pixel shifts can never flip a
 *     saturated 1-px texel to hot magenta — R3 fix, see FINAL_FRAG)
 *   → vignette → animated luma grain → dither → single linear→sRGB encode.
 *
 * INTEGRATOR NOTES:
 *   - Everything is live-tunable through .params (plain numbers/arrays/hex
 *     strings); uniforms re-sync every frame, no apply() needed.
 *   - params.debug: 'off' | 'scene' | 'bloom' | 'dof' | 'band' — 'band' draws
 *     the CoC field + band edge lines over the frame for tuning the tilt-shift
 *     against frame01. params.bypass = true renders the raw scene (preview
 *     tonemapped) for A/B.
 *   - params.msaa (0/2/4): MSAA on the scene target. Default 0 for SwiftShader
 *     safety; on real GPUs 4 is cheap and calms cliff/castle edge crawl.
 *     Takes effect on the next frame (target is rebuilt automatically).
 *   - px-denominated params (blur radii, CA, sharpen) are authored "at 1080p"
 *     exactly as the art bible writes them and scale linearly with the actual
 *     drawing-buffer height, so they hold at 900p captures and 4K alike.
 *   - Requires no half-float: falls back to 8-bit targets (bloom threshold
 *     0.72 < 1.0 still passes; HDR sparkle degrades gracefully).
 */

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Tunables — every constant of the stack, art-bible §7 values as defaults.
// fh = fraction of frame height measured from the TOP of the frame (as the
// reference docs measure it); conversion to GL uv space happens in sync().
// ---------------------------------------------------------------------------

function makeDefaultParams() {
  return {
    enabled: true,       // full stack on/off (off = bypass preview)
    bypass: false,       // true → raw scene, preview-tonemapped, for A/B
    debug: 'off',        // 'off' | 'scene' | 'bloom' | 'dof' | 'band'
    msaa: 0,             // scene-target MSAA samples; 0 for software GL
    exposure: 1.05,      // ACES exposure (bible §7)

    bloom: {
      enabled: true,
      threshold: 0.72,   // post-exposure luma threshold (bible §7)
      knee: 0.18,        // soft-knee width below threshold
      strength: 0.30,    // composite add strength (bible §7)
      radius: 0.85,      // scatter: weight of the wider mip at each upsample
      levels: 5,         // downsample levels below the half-res bright target
      spread: 1.0,       // tent-filter footprint multiplier on upsample
    },

    dof: {
      enabled: true,
      // The measured band (bible §7 / §10): sharp 0.25–0.79 fh, focus centre
      // 0.52 fh — the hero at 0.50–0.55 fh sits deep inside it.
      bandTopFh: 0.25,   // top edge of the sharp band (fh from frame top)
      bandBotFh: 0.79,   // bottom edge of the sharp band
      rampTopFh: 0.12,   // falloff width above the band
      rampBotFh: 0.10,   // falloff width below the band
      // Bible §7 authors 7/5 px against its §2 camera, whose top edge is only
      // ~85 m out. The shipped rig fits 50→190 m in frame, so the top band is
      // 2.2× further from the focal plane and 7 px left it visibly in focus
      // (measured band gradient energy 16 at the top vs 33 in the sharp band —
      // frame01's ratio is 3×, ours was 2×). Scaled by the depth ratio.
      maxTopPx: 9.5,     // max blur radius at the top edge, px @1080p
      maxBotPx: 7.0,     // max blur radius at the bottom edge, px @1080p
      taps: 26,          // Vogel-disc gather taps (4..48)
      lumaThreshold: 0.60, // bokeh weighting: highlights above this bloom out
      lumaBoost: 2.2,    // how hard bright samples dominate the disc
      jitter: 1.0,       // per-pixel disc rotation, hides ring artefacts
      fill: true,        // hex smoothing pass over the gather (kills noise)
      fillScale: 0.5,    // fill radius = coc * fillScale
      fillMaxPx: 2.2,    // fill radius clamp, px @1080p (half-res space aware)
      blendLoPx: 0.35,   // composite: below this CoC the frame is pure full-res
      blendHiPx: 1.7,    // above this CoC the frame is pure half-res blur
    },

    grade: {
      // Bible §7, GLSL-exact terms — these two ARE the split-tone:
      shadowLift: [0.020, 0.030, 0.026], // cool-green lifted blacks
      shadowLiftEnd: 0.35,               // luma where the lift has fully faded
      warmTint: [1.05, 1.01, 0.94],      // warm cream multiplier on mids/highs
      warmAmount: 0.8,
      warmLo: 0.25,
      warmHi: 0.75,
      saturation: 1.08,                  // bible §7 verbatim (R1 shipped 1.06)
      highlightDesat: 0.10,              // desat toward cream above start luma
      highlightDesatStart: 0.80,
      creamTint: '#fff3dc',
      // Per-channel lift / gamma / gain — NEUTRAL (bible §7 verbatim), for the
      // integrator to land the frame on the plate. R1 shipped a small stretch
      // (lift −1 %, gain +7 %) whose histogram targets were measured against
      // the fog-veiled frame — it was compensating for the veil, and with the
      // height fog installed it just re-brightens the wash. Retune, if at all,
      // only against the corrected atmosphere.
      lift: [0.0, 0.0, 0.0],
      gamma: [1.0, 1.0, 1.0],
      gain: [1.0, 1.0, 1.0],
    },

    sharpen: {
      amount: 0.30,      // unsharp amount, masked to the focus band (bible §7)
      radiusPx: 1.0,     // px @1080p
    },

    ca: {
      amountPx: 1.6,     // corner shift in px @1080p (bible §7)
      inner: 0.55,       // zero inside this normalised radius (corner = 1.0)
      chromaClamp: 0.12, // max fringe deviation (linear) per px of shift —
                         // stops sub-pixel CA flipping 1-px wheat texels to
                         // magenta while corners keep a real visible fringe
    },

    vignette: {
      start: 0.62,       // normalised radius where darkening begins
      end: 1.18,         // where it reaches full strength (corner = 1.0)
      strength: 0.24,
    },

    grain: {
      amount: 0.032,     // luma-only amplitude (bible §7)
      sizePx: 1.0,       // grain cell size in device px
      fps: 24,           // re-roll rate — filmic, not per-frame sizzle
      shadowFloor: 0.35, // grain fades toward this factor in deep blacks
    },

    dither: 0.6,         // final 8-bit dither amplitude in LSBs (banding guard)
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

// ACES filmic (three-equivalent Hill fit). Shared by the grade pass (the
// actual tonemap) and the bloom bright pass (which gates on the tonemapped
// luma so "post-exposure luma 0.72" means the display value the viewer sees).
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

const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// -- bloom: bright pass ------------------------------------------------------
// 4 bilinear taps with Karis luma weights (tames single-pixel fireflies from
// foam/glint speckle) then the quadratic soft-knee threshold. Runs at half res.
const BRIGHT_FRAG = PRELUDE + ACES_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;       // source (full-res) texel size
  uniform float uThreshold;  // post-exposure luma
  uniform float uKnee;
  uniform float uExposure;

  void main() {
    // "Post-exposure luma" (bible §7) = the DISPLAY luma after the full ACES
    // tonemap at exposure 1.05 — the value the viewer sees, where 0.72 is a
    // genuine highlight. ROUND-3 FIX: R2 gated on pre-fit luma × exposure/0.6.
    // In that space the sage-fog plateau that washes the whole upper frame
    // sits at ~0.96 > 0.72, so the FOG bloomed (a milky veil, cf. the debug
    // bloom buffer's big soft blobs over the massif) while true highlights
    // barely rose above it. Measured through the fit: fog ~0.60 stays under
    // the gate; foam ~0.79, falls sheet ~0.80+, sunlit wheat tips ~0.78,
    // castle stone ~0.78 clear it — exactly the bible's allowed list.
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

    // Gate AND emit in display space, UnrealBloom semantics — the family the
    // bible's 0.72/0.30/0.85 triplet belongs to. Two R3 fixes live here:
    //   1. R2 emitted linear-HDR excess and added it pre-fit, so the ACES
    //      shoulder compressed the whole composite to ~1/255 — invisible.
    //   2. LuminosityHighPass outputs the FULL texel colour gated by a
    //      smoothstep, not the (tiny) excess-over-threshold; the excess form
    //      left wheat tips at ~0.03 in the pyramid. Full-colour gating puts
    //      them at ~0.75 and the 0.30 strength finally reads as a kiss.
    // The knee doubles as the smoothstep width; fog (~0.60 display) sits
    // below threshold − knee, so the haze contributes nothing at all.
    vec3 mapped = acesFilmic(max(c, 0.0) * ex);
    float l = luma(mapped);
    float contrib = smoothstep(uThreshold - uKnee, uThreshold + uKnee, l);
    gl_FragColor = vec4(mapped * contrib, 1.0);
  }
`

// -- bloom: 13-tap Jimenez downsample (no pyramid blockiness) ----------------
const DOWN_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel; // source texel size

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

// -- bloom: 9-tap tent upsample + ADDITIVE accumulate ------------------------
// out = sameLevel + tent(widerLevel) * radius. Each wider mip decays by
// `radius` (0.85) per hop — UnrealBloom semantics, which is the family the
// bible's threshold/strength/radius triplet was written for. ROUND-3 FIX:
// R2 shipped out = mix(base, tent(wider), 0.85), which *replaces* 85 % of
// every level's energy instead of stacking it; the composited bloom measured
// under 1/255 on the final frame — visually absent.
const UP_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;   // smaller (blurrier) level being upsampled
  uniform sampler2D tBase;  // same-resolution down level to accumulate onto
  uniform vec2 uTexel;      // texel size of tSrc
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

// -- tonemap + grade ---------------------------------------------------------
// HDR in (scene + bloom), display-linear LDR out. ACES here is the same Hill
// fit three.js uses for ACESFilmicToneMapping (incl. the /0.6 exposure bake),
// so the bible's "ACESFilmic, exposure 1.05" means exactly this.
const GRADE_FRAG = PRELUDE + ACES_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform vec3  uShadowLift;
  uniform float uShadowLiftEnd;
  uniform vec3  uWarmTint;
  uniform float uWarmAmount;
  uniform float uWarmLo;
  uniform float uWarmHi;
  uniform float uSaturation;
  uniform vec3  uCream;        // linear-space cream target
  uniform float uHighDesat;
  uniform float uHighDesatLo;
  uniform vec3  uLift;
  uniform vec3  uGamma;
  uniform vec3  uGain;

  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;

    // ACES filmic (three-equivalent), exposure baked as exposure/0.6
    c = max(c, 0.0);
    c *= uExposure / 0.6;
    c = acesFilmic(c);

    // Bloom composite in display space (the bright pass emits tonemapped
    // values — see BRIGHT_FRAG). Adding pre-fit let the ACES shoulder eat
    // the entire 0.30-strength contribution.
    if (uBloomStrength > 0.0) {
      c = clamp(c + texture2D(tBloom, vUv).rgb * uBloomStrength, 0.0, 1.0);
    }

    // -- grade, ART_BIBLE §7 verbatim --------------------------------------
    float l = luma(c);
    c += (1.0 - smoothstep(0.0, uShadowLiftEnd, l)) * uShadowLift;
    c *= mix(vec3(1.0), uWarmTint, uWarmAmount * smoothstep(uWarmLo, uWarmHi, l));

    // saturation x1.08
    l = luma(c);
    c = mix(vec3(l), c, uSaturation);

    // desaturate highlights toward cream (#fff3dc) above l 0.8
    l = luma(c);
    vec3 cream = uCream * (l / max(luma(uCream), 1e-4));
    c = mix(c, cream, uHighDesat * smoothstep(uHighDesatLo, 1.0, l));

    // per-channel lift / gamma / gain (neutral unless the critic retunes)
    c = pow(max(c * uGain + uLift, 0.0), vec3(1.0) / max(uGamma, vec3(1e-3)));

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`

// -- DOF: prefilter downsample to half res -----------------------------------
const DOF_DOWN_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel; // source (full-res) texel size

  void main() {
    vec3 c =
        texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2(-0.5,  0.5)).rgb
      + texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`

// Shared analytic CoC — the whole trick of tilt-shift: blur radius is a pure
// function of screen y, so every tap knows its own CoC with zero extra fetches.
// Band edges/ramps are in GL uv space (y up); radii in the caller's px space.
const COC_GLSL = /* glsl */ `
  uniform float uBandLo;   // uv y of the band's bottom edge
  uniform float uBandHi;   // uv y of the band's top edge
  uniform float uRampLo;   // falloff width below (uv units)
  uniform float uRampHi;   // falloff width above (uv units)
  uniform float uMaxTop;   // px radius at/beyond the top ramp end
  uniform float uMaxBot;   // px radius at/beyond the bottom ramp end

  float cocAt(float y) {
    float above = smoothstep(0.0, 1.0, (y - uBandHi) / max(uRampHi, 1e-4));
    float below = smoothstep(0.0, 1.0, (uBandLo - y) / max(uRampLo, 1e-4));
    return above * uMaxTop + below * uMaxBot;
  }
`

// -- DOF: Vogel-disc bokeh gather at half res --------------------------------
// Golden-angle spiral disc; every tap is weighted by
//   (a) coverage — would the tap's own CoC disc scatter onto this pixel?
//       (analytic per-tap CoC makes scatter-as-gather nearly exact here), and
//   (b) a luminance boost, so tonemapped highlights (foam, wheat tips, castle
//       stone) spread into round bokeh blobs instead of averaging away.
// Per-pixel disc rotation trades ring banding for noise; the hex fill pass and
// the film grain both eat that noise.
const DOF_GATHER_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;      // half-res texel size
  uniform float uTaps;      // active tap count (<= MAXT)
  uniform float uLumaTh;
  uniform float uLumaBoost;
  uniform float uJitter;

  const int MAXT = 48;
  const float GOLDEN = 2.399963229728653;

  void main() {
    float myCoc = cocAt(vUv.y);
    vec3 centre = texture2D(tSrc, vUv).rgb;
    if (myCoc < 0.20) {           // deep inside the sharp band: passthrough
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
      float r = sqrt((fi + 0.5) / uTaps);          // uniform disc density
      float a = fi * GOLDEN + rot;
      vec2 offPx = vec2(cos(a), sin(a)) * (r * myCoc);
      vec2 uv = vUv + offPx * uTexel;
      float d = length(offPx);

      // coverage: the tap blurs onto us only if its own CoC reaches us
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

// -- DOF: hexagonal fill/smooth pass -----------------------------------------
// A small 6-tap hex ring (radius tracks local CoC) that irons the spiral noise
// out of the gather and nudges highlight blobs toward hex bokeh.
const DOF_FILL_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uFillScale;
  uniform float uFillMax;   // px, half-res space

  void main() {
    float coc = cocAt(vUv.y);
    vec3 centre = texture2D(tSrc, vUv).rgb;
    if (coc < 0.20) {
      gl_FragColor = vec4(centre, 1.0);
      return;
    }
    float rad = min(coc * uFillScale, uFillMax);
    vec3 acc = centre * 2.0;
    // hex ring, rotated 15 deg so no axis-aligned smear
    for (int i = 0; i < 6; i++) {
      float a = 0.2617994 + float(i) * 1.0471976;
      acc += texture2D(tSrc, vUv + vec2(cos(a), sin(a)) * rad * uTexel).rgb;
    }
    gl_FragColor = vec4(acc / 8.0, 1.0);
  }
`

// -- DOF composite + band-masked unsharp -------------------------------------
// blend == 0 inside the band → the output there is the *untouched* full-res
// grade target; the pixel sprites survive to the screen bit-exact. The unsharp
// term (bible: 0.30 @ 1px) only lives where the band mask is ~1.
const COMPOSITE_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSharp;   // full-res graded LDR
  uniform sampler2D tDof;     // half-res blurred
  uniform vec2 uTexelFull;
  uniform float uDofOn;
  uniform float uBlendLo;     // px CoC where blur starts mixing in
  uniform float uBlendHi;     // px CoC of full blur takeover
  uniform float uSharpAmt;
  uniform float uSharpRad;    // px

  void main() {
    vec3 sharp = texture2D(tSharp, vUv).rgb;
    float coc = cocAt(vUv.y) * uDofOn;

    vec3 c = sharp;
    if (coc > uBlendLo) {
      vec3 blur = texture2D(tDof, vUv).rgb;
      c = mix(sharp, blur, smoothstep(uBlendLo, uBlendHi, coc));
    }

    // unsharp mask, focus band only — keeps hero/wheat/fence pixels biting.
    // LUMA-ONLY (multiplicative): per-channel unsharp on the 1-px wheat
    // texels rang R and G independently and hue-shifted stalk edges toward
    // red; boosting luma while preserving chroma ratios cannot. The gain is
    // additionally rolled off on saturated pixels (wheat gold, deep greens)
    // so high-frequency saturated texture never rings at full strength.
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

// -- final: CA + vignette + grain + dither + the ONE sRGB encode -------------
const FINAL_FRAG = PRELUDE + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 uResolution;   // buffer px
  uniform float uAspect;
  uniform float uCaPx;
  uniform float uCaInner;
  uniform float uCaClamp;     // max per-channel fringe deviation per px of shift
  uniform float uVigStart;
  uniform float uVigEnd;
  uniform float uVigStrength;
  uniform float uGrainAmt;
  uniform float uGrainSize;
  uniform float uGrainFloor;
  uniform float uFrame;       // grain re-roll counter (floor(time*fps))
  uniform float uDither;      // LSBs

  vec3 lin2srgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }

  void main() {
    vec2 nc = vUv * 2.0 - 1.0;               // -1..1, corner length sqrt(2)
    float r = length(nc) * 0.70710678;       // 0 centre → 1.0 at corners

    // chromatic aberration: red fringes outward, blue inward, edges only.
    // ROUND-3 FIX (critic defect 12): the linear smoothstep ramp put 0.3–0.6px
    // of shift on the wheat paddocks at r 0.6–0.8, and on a NearestFilter
    // 1-px-period gold/outline texture even a sub-pixel R/B decorrelation
    // flips texels to hot magenta/red (measured 800+ hot pixels; 0 with CA
    // off). Two guards, keeping the bible's letter (1.6 px at corners, zero
    // inside r < 0.55):
    //   1. quadratic ease — the ramp leaves 0.55 with zero slope, so the
    //      mid-frame band r 0.55–0.8 gets almost nothing and the full 1.6 px
    //      lives only out at the true corners;
    //   2. chroma clamp — the fringe may deviate from the unshifted colour by
    //      at most uCaClamp per px of shift, so a small shift can only tint,
    //      never invert, a saturated texel. Big corner shifts keep visible
    //      fringes on high-contrast edges (the intended look).
    vec3 c0 = texture2D(tSrc, vUv).rgb;
    vec3 c = c0;
    float s = smoothstep(uCaInner, 1.0, r);
    float ca = uCaPx * s * s;
    if (ca > 0.01) {
      vec2 dirPx = normalize(vec2(nc.x * uAspect, nc.y) + 1e-6) * ca;
      vec2 duv = dirPx / uResolution;
      c.r = texture2D(tSrc, vUv - duv).r;
      c.b = texture2D(tSrc, vUv + duv).b;
      float lim = uCaClamp * min(ca, 1.5);
      c = c0 + clamp(c - c0, vec3(-lim), vec3(lim));
    }

    // vignette
    c *= 1.0 - uVigStrength * smoothstep(uVigStart, uVigEnd, r);

    // animated luma-only grain, protected in the deepest blacks
    float l = luma(c);
    vec2 gp = floor(gl_FragCoord.xy / max(uGrainSize, 1.0));
    float n = hash12(gp + vec2(uFrame * 17.13, uFrame * 29.71));
    c += (n - 0.5) * 2.0 * uGrainAmt
       * mix(uGrainFloor, 1.0, smoothstep(0.02, 0.30, l));

    // sub-LSB dither so the haze gradients never band after quantisation
    float d = hash12(gl_FragCoord.xy + vec2(uFrame * 3.7, uFrame * 7.9));
    c += (d - 0.5) * (uDither / 255.0);

    gl_FragColor = vec4(lin2srgb(clamp(c, 0.0, 1.0)), 1.0);
  }
`

// -- utility copy / debug ----------------------------------------------------
// mode 0: LDR-linear src → sRGB.  mode 1: HDR src → quick preview tonemap.
// mode 2: band/CoC visualiser over the composited frame (cyan band edge lines,
// warm tint scaling with blur radius) — put frame01 beside it and tune.
const COPY_FRAG = PRELUDE + COC_GLSL + /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform float uMode;
  uniform float uExposure;
  uniform vec2 uResolution;

  vec3 lin2srgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }

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

export function createPostFX({ renderer, scene, camera }) {
  const params = makeDefaultParams()

  // -- capability probe: HDR target type ------------------------------------
  // WebGL2: RGBA16F is colour-renderable with EXT_color_buffer_float (which
  // also covers half) or EXT_color_buffer_half_float, and 16F linear filtering
  // is core. Without either we degrade to 8-bit linear targets — the stack
  // still runs, bloom threshold (0.72) still passes, HDR sparkle is lost.
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
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: samples | 0,
    })
    rt.texture.generateMipmaps = false
    return rt
  }

  // -- render targets --------------------------------------------------------
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  let fullW = Math.max(1, size.x | 0)
  let fullH = Math.max(1, size.y | 0)

  let rtScene = null       // full res, HDR, depth — the scene renders here
  let rtLDR = null         // full res — tonemapped + graded, display-linear
  let rtPost = null        // full res — DOF composite + sharpen
  let rtDofA = null        // half res ping
  let rtDofB = null        // half res pong
  let rtBright = null      // half res bloom bright
  let downs = []           // bloom downsample chain
  let ups = []             // bloom upsample accumulators
  let rtUpHalf = null      // final bloom accumulation at half res
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

  // -- materials -------------------------------------------------------------
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

  const creamColor = new THREE.Color(params.grade.creamTint)

  const brightMat = mat(BRIGHT_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 0.72 },
    uKnee: { value: 0.18 },
    uExposure: { value: 1.05 },
  })

  const downMat = mat(DOWN_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  })

  const upMat = mat(UP_FRAG, {
    tSrc: { value: null },
    tBase: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uScatter: { value: 0.85 },
    uSpread: { value: 1.0 },
  })

  const gradeMat = mat(GRADE_FRAG, {
    tScene: { value: null },
    tBloom: { value: null },
    uBloomStrength: { value: 0.3 },
    uExposure: { value: 1.05 },
    uShadowLift: { value: new THREE.Vector3(0.02, 0.03, 0.026) },
    uShadowLiftEnd: { value: 0.35 },
    uWarmTint: { value: new THREE.Vector3(1.05, 1.01, 0.94) },
    uWarmAmount: { value: 0.8 },
    uWarmLo: { value: 0.25 },
    uWarmHi: { value: 0.75 },
    uSaturation: { value: 1.08 },
    uCream: { value: new THREE.Vector3(1, 1, 1) },
    uHighDesat: { value: 0.1 },
    uHighDesatLo: { value: 0.8 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
  })

  const cocUniforms = () => ({
    uBandLo: { value: 0.21 },
    uBandHi: { value: 0.75 },
    uRampLo: { value: 0.1 },
    uRampHi: { value: 0.12 },
    uMaxTop: { value: 3.5 },
    uMaxBot: { value: 2.5 },
  })

  const dofDownMat = mat(DOF_DOWN_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
  })

  const dofGatherMat = mat(DOF_GATHER_FRAG, {
    ...cocUniforms(),
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTaps: { value: 26 },
    uLumaTh: { value: 0.6 },
    uLumaBoost: { value: 2.2 },
    uJitter: { value: 1.0 },
  })

  const dofFillMat = mat(DOF_FILL_FRAG, {
    ...cocUniforms(),
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFillScale: { value: 0.5 },
    uFillMax: { value: 1.1 },
  })

  const compositeMat = mat(COMPOSITE_FRAG, {
    ...cocUniforms(),
    tSharp: { value: null },
    tDof: { value: null },
    uTexelFull: { value: new THREE.Vector2() },
    uDofOn: { value: 1.0 },
    uBlendLo: { value: 0.35 },
    uBlendHi: { value: 1.7 },
    uSharpAmt: { value: 0.3 },
    uSharpRad: { value: 1.0 },
  })

  const finalMat = mat(FINAL_FRAG, {
    tSrc: { value: null },
    uResolution: { value: new THREE.Vector2() },
    uAspect: { value: 16 / 9 },
    uCaPx: { value: 1.6 },
    uCaInner: { value: 0.55 },
    uCaClamp: { value: 0.12 },
    uVigStart: { value: 0.62 },
    uVigEnd: { value: 1.18 },
    uVigStrength: { value: 0.24 },
    uGrainAmt: { value: 0.032 },
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

  // -- full-screen triangle rig ---------------------------------------------
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

  // -- per-frame uniform sync (params are live; no apply() ceremony) --------
  const v3 = (u, a) => u.value.set(a[0], a[1], a[2])

  function setCoc(u, bandLo, bandHi, rampLo, rampHi, maxTop, maxBot) {
    u.uBandLo.value = bandLo
    u.uBandHi.value = bandHi
    u.uRampLo.value = rampLo
    u.uRampHi.value = rampHi
    u.uMaxTop.value = maxTop
    u.uMaxBot.value = maxBot
  }

  function sync(time) {
    const p = params
    const pxScale = fullH / 1080 // "px @1080p" params → this buffer

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
    v3(g.uShadowLift, p.grade.shadowLift)
    g.uShadowLiftEnd.value = p.grade.shadowLiftEnd
    v3(g.uWarmTint, p.grade.warmTint)
    g.uWarmAmount.value = p.grade.warmAmount
    g.uWarmLo.value = p.grade.warmLo
    g.uWarmHi.value = p.grade.warmHi
    g.uSaturation.value = p.grade.saturation
    creamColor.set(p.grade.creamTint)
    g.uCream.value.set(creamColor.r, creamColor.g, creamColor.b)
    g.uHighDesat.value = p.grade.highlightDesat
    g.uHighDesatLo.value = p.grade.highlightDesatStart
    v3(g.uLift, p.grade.lift)
    v3(g.uGamma, p.grade.gamma)
    v3(g.uGain, p.grade.gain)

    // dof — gather + fill run in HALF-res pixel space
    setCoc(dofGatherMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull * 0.5, maxBotFull * 0.5)
    dofGatherMat.uniforms.uTaps.value = THREE.MathUtils.clamp(p.dof.taps | 0, 4, 48)
    dofGatherMat.uniforms.uLumaTh.value = p.dof.lumaThreshold
    dofGatherMat.uniforms.uLumaBoost.value = p.dof.lumaBoost
    dofGatherMat.uniforms.uJitter.value = p.dof.jitter

    setCoc(dofFillMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull * 0.5, maxBotFull * 0.5)
    dofFillMat.uniforms.uFillScale.value = p.dof.fillScale
    dofFillMat.uniforms.uFillMax.value = Math.max(0, p.dof.fillMaxPx) * pxScale * 0.5

    // composite — FULL-res pixel space
    setCoc(compositeMat.uniforms, bandLoUv, bandHiUv, p.dof.rampBotFh, p.dof.rampTopFh,
      maxTopFull, maxBotFull)
    compositeMat.uniforms.uDofOn.value = p.dof.enabled ? 1.0 : 0.0
    const blendLo = Math.max(0.01, p.dof.blendLoPx * pxScale)
    compositeMat.uniforms.uBlendLo.value = blendLo
    compositeMat.uniforms.uBlendHi.value = Math.max(blendLo + 0.05, p.dof.blendHiPx * pxScale)
    compositeMat.uniforms.uSharpAmt.value = p.sharpen.amount
    compositeMat.uniforms.uSharpRad.value = Math.max(0.25, p.sharpen.radiusPx * pxScale)

    // final
    const f = finalMat.uniforms
    f.uResolution.value.set(fullW, fullH)
    f.uAspect.value = fullW / Math.max(1, fullH)
    f.uCaPx.value = Math.max(0, p.ca.amountPx) * pxScale
    f.uCaInner.value = p.ca.inner
    f.uCaClamp.value = Math.max(0, p.ca.chromaClamp)
    f.uVigStart.value = p.vignette.start
    f.uVigEnd.value = Math.max(p.vignette.end, p.vignette.start + 1e-3)
    f.uVigStrength.value = p.vignette.strength
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

  // -- render ----------------------------------------------------------------
  let time = 0

  function render(dt) {
    time += Math.max(0, dt || 0)

    // params.msaa and params.bloom.levels are live: rebuild targets on change
    const wantLevels = Math.min(Math.max(params.bloom.levels | 0, 2), 7)
    if (wantLevels !== builtLevels) {
      disposeTargets()
      buildTargets()
    } else if ((rtScene.samples | 0) !== (params.msaa | 0)) {
      rtScene.dispose()
      rtScene = makeRT(fullW, fullH, { depth: true, samples: params.msaa })
    }

    sync(time)

    const prevAutoClear = renderer.autoClear
    const prevTarget = renderer.getRenderTarget()

    // 1 — scene → HDR target (linear working space; RTs never sRGB-encode)
    renderer.autoClear = true
    renderer.setRenderTarget(rtScene)
    renderer.render(scene, camera)

    renderer.autoClear = false // every pass below overdraws the whole target

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

    // 2 — bloom pyramid
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

    // 3 — tonemap + grade (HDR → display-linear LDR, full res)
    gradeMat.uniforms.tScene.value = rtScene.texture
    gradeMat.uniforms.tBloom.value = rtUpHalf.texture
    pass(gradeMat, rtLDR)

    // 4 — tilt-shift DOF at half res
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

    // 5 — composite (sharp band bit-exact) + band-masked unsharp
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
        // 'band' — CoC field + band edge lines over the composited frame
        u.tSrc.value = rtPost.texture
        u.uMode.value = 2
      }
      pass(copyMat, null)
      renderer.autoClear = prevAutoClear
      renderer.setRenderTarget(prevTarget)
      return
    }

    // 6 — CA + vignette + grain + dither + the single sRGB encode → screen
    finalMat.uniforms.tSrc.value = rtPost.texture
    pass(finalMat, null)

    renderer.autoClear = prevAutoClear
    renderer.setRenderTarget(prevTarget)
  }

  // -- resize ----------------------------------------------------------------
  // Engine calls this AFTER renderer.setSize, so the drawing buffer is
  // authoritative (CSS args would miss devicePixelRatio).
  function setSize(/* w, h */) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(1, s.x | 0)
    const h = Math.max(1, s.y | 0)
    if (w === fullW && h === fullH && builtLevels === Math.min(Math.max(params.bloom.levels | 0, 2), 7)) {
      return
    }
    fullW = w
    fullH = h
    disposeTargets()
    buildTargets()
  }

  function dispose() {
    disposeTargets()
    for (const m of materials) m.dispose()
    fsGeo.dispose()
  }

  // Keep the (unused-for-now) camera referenced: screen-space tilt-shift needs
  // no depth, but a future world-anchored focus plane would read it.
  void camera

  return { render, setSize, params, dispose }
}
