// ---------------------------------------------------------------------------
// src/battle/units.js — battle staging + the single source of battle state.
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function createUnits({ arena, sheets, enemyArt, renderer }): Units
//   Units = { object3D, roster: UnitState[4], enemy: UnitState, get(id),
//             playAnim(id, name, opts?), spawnAt(id, worldPos),
//             update(dt, camera) }
//   UnitState = { id, name, isEnemy, anchor: THREE.Vector3,
//                 hp, hpMax, mp, mpMax, limit, statuses, queueEta,
//                 screen(target?): {x, y, h} }
//
// This module owns (BATTLE_BIBLE §1/§5/§6):
//   * the party zigzag at the §1 feet anchors — two ranks 5 m apart in depth,
//     the 1.37× rank size difference arising purely from perspective under the
//     solved (0,7,14)/12°/26° camera. Verified by reprojection: every anchor
//     lands within ±0.006 fw/fh of the bible's measured screen fractions.
//   * per-scene LIT sprite material (never MeshBasicMaterial): a bespoke
//     ShaderMaterial that evaluates the arena's live hemisphere + directional
//     fill/key + the two flickering torch point lights per fragment against
//     the §5 faux normal mix(up, toCamera, 0.35), takes scene exp2 fog at a
//     readability-floored strength, and re-emits a hue-bearing shade floor
//     (shadows keep hue, never grey/black).
//   * the runtime scene-keyed RIM pass (§5.1): 1-texel offset-mask silhouette
//     rim, direction refined per unit from arena.rim.sources (nearest/strongest
//     of torch L / torch R / active spell light), colour+strength from
//     arena.rim. Covers the facing edge only — never a full halo.
//   * CONTACT SHADOWS under every unit (§5.2 — the overworld's recurring
//     failure): 0.9×0.32 m feathered elliptical blobs per party member
//     (α .55 hall / .38 highland), a broad mass pool + forefeet blob under the
//     dragon, and the levitating sorcerer's pale fog-pool disc r 2.5 m α .25.
//   * GROUND OCCLUSION (§5.4): bottom 15 % of every grounded sprite darkened
//     12 %, plus feet sunk 2 texels into the floor so soles sit IN the
//     floor's ambient (battlerSheet reserves rows 92–95 for exactly this).
//   * SPELL-LIGHT RESPONSE capped at +35 % (§5.3): live point lights inside
//     arena's 'arenaSpellLights' group within 4 m add their colour additively
//     (the enemy, which bakes its key, caps at ±15 % — §6).
//   * anim clocks over the battlerSheet cell orders (idle ready attack cast
//     hit ko victory) with §9 hit-flash/recoil, KO desaturate+fade, and the
//     enemy quad's procedural life: 0.25 Hz breathing, ±2 px wing/beard
//     drift, hit flash + 0.15 m recoil, bottom-up death dissolve.
//   * screen(target?) — the load-bearing UI anchor. Projected feet px + sprite
//     screen height, cached once per frame, allocation-free in the hot path.
//
// State fields (hp/mp/limit/statuses/queueEta) are plain writable properties;
// choreo is the only writer. Boot values are the frame04 readout so the very
// first frame reads as a mid-battle moment even before choreo's first tick.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Constants — every number here is typed in from BATTLE_BIBLE
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

// §1 camera (used only to prime screen() before main's first update call).
const CAM_POS = [0, 7.0, 14.0]
const CAM_PITCH_DEG = 12.0
const CAM_FOV = 26

// §1 party staging — feet anchors, slot order. Screen fractions in comments
// are the bible's measured truth these world coords reproject onto (±0.006).
const PARTY_STAGING = [
  { id: 'rain',     slot: 1, rank: 'back',  x: +0.9, z: -9.2  }, // (0.543, 0.682)
  { id: 'lasswell', slot: 2, rank: 'front', x: +2.0, z: -4.4  }, // (0.626, 0.836)
  { id: 'fina',     slot: 3, rank: 'back',  x: +4.9, z: -10.5 }, // (0.736, 0.649)
  { id: 'lid',      slot: 4, rank: 'front', x: +5.0, z: -5.0  }, // (0.804, 0.812)
]

// §1 enemy staging.
const ENEMY_STAGING = {
  hall:     { x: -3.0, z: -6.5, sink: 0.35, mode: 'feet'   }, // forefeet (0.330, 0.760)
  highland: { x: -2.5, z: -7.5, massY: 3.4, mode: 'center' }, // mass centre, levitating
}

// §2: the hero IS the scale unit.
const BODY_METERS = 1.6

// §5.2 contact shadow: 0.9 × 0.32 m ellipse, #10131c, 45 % feather.
const BLOB_COLOR = 0x10131c
const BLOB_RX = 0.45
const BLOB_RZ = 0.16
const BLOB_ALPHA = { hall: 0.55, highland: 0.38 }
// Fog-pool disc under the levitating boss (§5.2): r 2.5 m, α 0.25, pale.
const FOGPOOL_R = 2.5
const FOGPOOL_ALPHA = 0.25
const FOGPOOL_COLOR = 0xa7b2a4

// §5.3 spell-light participation cap (+35 % party, ±15 % enemy per §6).
const SPELL_CAP_PARTY = 0.35
const SPELL_CAP_ENEMY = 0.15
const SPELL_RANGE = 4.0

// §5.4 ground occlusion: bottom 15 % of the body darkened 12 %.
const OCCLUDE_FRAC = 0.15
const OCCLUDE_DARKEN = 0.88

// Feet sink into the floor's ambient (battlerSheet reserves rows 92–95).
const FOOT_SINK_TEXELS = 2

// Hue-bearing shade floors (house law: deep shade keeps hue, rotates cool —
// nearest analogous regime to the overworld's EMISSIVE_FLOOR idiom, keyed to
// each arena's dark: hall #0a1420-class blue, highland #022123-class teal).
const EMISSIVE_FLOOR = { hall: 0x121a28, highland: 0x24302a }
// Sprites take scene fog at a floored strength so the party stays
// silhouette-dark against the highland fog band (§4 readability contract);
// the painterly enemy fogs near-fully — at 21 m detail drowns, darks survive.
const SPRITE_FOG_SCALE = 0.55
const ENEMY_FOG_SCALE = { hall: 0.95, highland: 0.88 }

// §9 hit react: 2 × 60 ms white flash, −0.35 m recoil over 90 ms, settle 180.
const HIT_FLASH_MS = 0.060
const HIT_RECOIL_M = 0.35
const HIT_RECOIL_IN = 0.09
const HIT_RECOIL_OUT = 0.18
// Enemy hit (§6): 60 ms flash + 0.15 m recoil.
const ENEMY_RECOIL_M = 0.15
// §9 KO: fall (ko cells) → desaturate to 20 % → fade α0 over 700 ms.
const KO_FADE_S = 0.70
const KO_DESAT = 0.80
// §6 enemy death: bottom-up dissolve 1.2 s.
const DEATH_DISSOLVE_S = 1.2
// §6 enemy idle: 0.25 Hz breathing ±1.5 %, wing/beard drift ±2 px.
const BREATH_HZ = 0.25
const BREATH_AMP = 0.015

// Boot stats — the frame04 readout (choreo owns these fields afterwards).
const BOOT_STATS = {
  rain:     { hp: 2938, hpMax: 3150, mp: 204, mpMax: 238, limit: 0.34, eta: 0.0 },
  lasswell: { hp: 2508, hpMax: 2680, mp: 327, mpMax: 402, limit: 1.00, eta: 6.6 }, // full limit
  fina:     { hp: 1507, hpMax: 2440, mp: 324, mpMax: 458, limit: 0.18, eta: 7.4 },
  lid:      { hp: 1982, hpMax: 2560, mp: 313, mpMax: 396, limit: 0.52, eta: 8.1 },
  enemy:    { hp: 61240, hpMax: 74000, mp: 999, mpMax: 999, limit: 0.55, eta: 5.9 },
}

const NAMES = { rain: 'Rain', lasswell: 'Lasswell', fina: 'Fina', lid: 'Lid' }

// ---------------------------------------------------------------------------
// Small helpers (allocation-free where hot)
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** '#rrggbb' → THREE.Color (working colour space). */
function colorOf(hexOrNum) {
  return new THREE.Color(hexOrNum)
}

// ---------------------------------------------------------------------------
// The lit-sprite shader — one program for party chibi AND the painterly enemy.
//
// Lighting model (per fragment): hemisphere(up-axis) + one directional +
// up to two point lights with three.js r169 physical attenuation
// (intensity/d², windowed by pow2(1−(d/cutoff)⁴)), all against the §5 faux
// normal published per frame as a uniform. On top: hue-bearing emissive floor,
// per-unit capped spell-light addition, offset-mask rim, ground occlusion,
// hit flash, KO desat/fade, enemy death dissolve, manual exp2 scene fog.
// Party cells sample through a per-frame uv window (96 px cells on a 1024×512
// sheet: UVs from pixel ratios, never 1/cols — battlerSheet's own warning).
// ---------------------------------------------------------------------------

const UNIT_VERT = /* glsl */ `
  uniform vec2 uCellOff;
  uniform vec2 uCellRep;
  varying vec2 vUv;      // 0..1 across the quad (cell-local)
  varying vec2 vTexUv;   // sheet uv
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vTexUv = uCellOff + uv * uCellRep;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const UNIT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec2  uClampMin;    // rim sampling stays inside the live cell
  uniform vec2  uClampMax;
  uniform float uAlphaCut;
  uniform vec3  uNormalW;     // §5 faux normal: mix(up, toCamera, 0.35)
  uniform vec3  uHemiSky;     // premultiplied by intensity
  uniform vec3  uHemiGround;
  uniform vec3  uDirDir;      // world dir TOWARD the directional light
  uniform vec3  uDirColor;    // premultiplied
  uniform vec3  uPtPos[2];    // torch anchors (live flicker/jitter)
  uniform vec3  uPtColor[2];  // premultiplied by live intensity
  uniform vec2  uPtParam[2];  // (cutoffDistance, decayExponent)
  uniform vec3  uEmissive;    // hue-bearing shade floor (multiplies albedo)
  uniform float uLightBase;   // party 0 / enemy 0.85 (bakes its key, §6)
  uniform float uLightResp;   // party 1 / enemy 0.45 → then hard ±15 % clamp
  uniform vec2  uLightClamp;  // (min, max) on the light multiplier
  uniform vec3  uSpellAdd;    // CPU-capped additive spell colour (§5.3)
  uniform vec3  uRimColor;    // premultiplied by strength; black = off
  uniform vec2  uRimOff;      // 1-texel uv offset toward the rim light
  uniform float uFlash;       // white hit flash 0..1
  uniform float uDesat;       // KO desaturation 0..1
  uniform float uFade;        // KO fade 1..0
  uniform vec2  uOccl;        // (soleV, topV) in cell-local v; x<0 disables
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uFogScale;
  uniform float uDissolve;    // enemy death 0..1 (bottom-up)
  uniform vec2  uDrift;       // (px amplitude in uv, region start v)
  uniform float uTime;
  varying vec2 vUv;
  varying vec2 vTexUv;
  varying vec3 vWorld;

  float hash12(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void main() {
    vec2 uv = vTexUv;
    // §6 idle: wing/beard drift ±2 px on the upper region of the enemy quad.
    if (uDrift.x > 0.0) {
      float band = smoothstep(uDrift.y, 1.0, vUv.y);
      uv.x += sin(uTime * 2.2 + vUv.y * 5.1) * uDrift.x * band;
    }
    vec4 tex = texture2D(uMap, uv);
    if (tex.a < uAlphaCut) discard;

    // §6 death: bottom-up dissolve with a ragged noise edge + ember rim.
    if (uDissolve > 0.0001) {
      float n = hash12(floor(uv * 220.0));
      float h = vUv.y * 0.82 + n * 0.18;
      float th = uDissolve * 1.15;
      if (h < th - 0.035) discard;
      if (h < th + 0.045) tex.rgb = mix(tex.rgb, vec3(1.0, 0.55, 0.22), 0.8);
    }

    // ---- scene lighting against the faux normal --------------------------
    vec3 N = uNormalW;
    vec3 light = mix(uHemiGround, uHemiSky, N.y * 0.5 + 0.5);
    light += uDirColor * max(dot(N, uDirDir), 0.0);
    for (int i = 0; i < 2; i++) {
      vec3 toL = uPtPos[i] - vWorld;
      float d = length(toL);
      float cutoff = uPtParam[i].x;
      float win = 1.0;
      if (cutoff > 0.0) {
        float q = d / cutoff;
        q = q * q; q = q * q;              // (d/cutoff)^4
        win = clamp(1.0 - q, 0.0, 1.0);
        win *= win;
      }
      float att = win / max(pow(d, uPtParam[i].y), 0.01);
      light += uPtColor[i] * (max(dot(N, toL / max(d, 1e-4)), 0.0) * att);
    }
    vec3 mul = clamp(vec3(uLightBase) + light * uLightResp, vec3(uLightClamp.x), vec3(uLightClamp.y));
    vec3 col = tex.rgb * mul;

    // Hue-bearing shade floor — the sprite re-emits its own colours dimly so
    // full shade never crushes to grey/black (house law).
    col += tex.rgb * uEmissive;

    // §5.3 spell light: overexpose TOWARD the spell colour (CPU-capped).
    col += uSpellAdd * (0.45 + 0.55 * dot(tex.rgb, vec3(0.299, 0.587, 0.114)));

    // §5.4 ground occlusion: feet sit IN the floor's ambient.
    if (uOccl.x >= 0.0) {
      col *= mix(${OCCLUDE_DARKEN.toFixed(2)}, 1.0, smoothstep(uOccl.x, uOccl.y, vUv.y));
    }

    // §5.1 scene-keyed rim: 1-texel offset mask — lit where the neighbour
    // toward the light is empty. Facing edge only, never a full halo.
    if (uRimColor.r + uRimColor.g + uRimColor.b > 0.001) {
      float aN = texture2D(uMap, clamp(uv + uRimOff, uClampMin, uClampMax)).a;
      float edge = step(aN, 0.45);
      // second tap 2 texels out softens the rim onto round silhouettes
      float aN2 = texture2D(uMap, clamp(uv + uRimOff * 2.0, uClampMin, uClampMax)).a;
      edge = max(edge, step(aN2, 0.45) * 0.45);
      col += uRimColor * edge;
    }

    // §9 hit flash / KO desat.
    col = mix(col, vec3(1.0), uFlash);
    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uDesat);

    // Manual exp2 scene fog at the sprite fog scale.
    float fd = uFogDensity * length(vWorld - cameraPosition);
    float fogF = clamp((1.0 - exp(-fd * fd)) * uFogScale, 0.0, 1.0);
    col = mix(col, uFogColor, fogF);

    gl_FragColor = vec4(col, tex.a * uFade);
    #include <colorspace_fragment>
  }
`

function makeUnitMaterial({ map, alphaCut, emissive, fogScale, lightBase, lightResp, lightClamp }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uCellOff: { value: new THREE.Vector2(0, 0) },
      uCellRep: { value: new THREE.Vector2(1, 1) },
      uClampMin: { value: new THREE.Vector2(0, 0) },
      uClampMax: { value: new THREE.Vector2(1, 1) },
      uAlphaCut: { value: alphaCut },
      uNormalW: { value: new THREE.Vector3(0, 1, 0) },
      uHemiSky: { value: new THREE.Vector3(0.1, 0.12, 0.16) },
      uHemiGround: { value: new THREE.Vector3(0.05, 0.04, 0.03) },
      uDirDir: { value: new THREE.Vector3(0, 1, 0) },
      uDirColor: { value: new THREE.Vector3(0, 0, 0) },
      uPtPos: { value: [new THREE.Vector3(0, -99, 0), new THREE.Vector3(0, -99, 0)] },
      uPtColor: { value: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)] },
      uPtParam: { value: [new THREE.Vector2(14, 2), new THREE.Vector2(14, 2)] },
      uEmissive: { value: new THREE.Vector3(emissive.r, emissive.g, emissive.b) },
      uLightBase: { value: lightBase },
      uLightResp: { value: lightResp },
      uLightClamp: { value: new THREE.Vector2(lightClamp[0], lightClamp[1]) },
      uSpellAdd: { value: new THREE.Vector3(0, 0, 0) },
      uRimColor: { value: new THREE.Vector3(0, 0, 0) },
      uRimOff: { value: new THREE.Vector2(0, 0) },
      uFlash: { value: 0 },
      uDesat: { value: 0 },
      uFade: { value: 1 },
      uOccl: { value: new THREE.Vector2(-1, -1) },
      uFogColor: { value: new THREE.Vector3(0.04, 0.06, 0.09) },
      uFogDensity: { value: 0.012 },
      uFogScale: { value: fogScale },
      uDissolve: { value: 0 },
      uDrift: { value: new THREE.Vector2(0, 0.5) },
      uTime: { value: 0 },
    },
    vertexShader: UNIT_VERT,
    fragmentShader: UNIT_FRAG,
    transparent: true,   // KO fade + the enemy's soft painterly edges
    depthWrite: true,    // units occlude additive layers behind them (torch halo law)
    depthTest: true,
    side: THREE.DoubleSide,
  })
}

// ---------------------------------------------------------------------------
// Contact-shadow decals (§5.2). Feathered ellipse in the XZ plane; the alpha
// core is denser so the blob reads as occlusion pooling, not an airbrush dot.
// 45 % feather = solid to r 0.55 then smooth to the edge.
// ---------------------------------------------------------------------------

const BLOB_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`
const BLOB_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uFogDensity;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    float a = 1.0 - smoothstep(0.55, 1.0, r);          // 45 % feather
    a *= 0.80 + 0.20 * (1.0 - smoothstep(0.0, 0.5, r)); // denser core
    float fd = uFogDensity * length(vWorld - cameraPosition);
    float fogT = exp(-fd * fd);
    float outA = a * uAlpha * mix(0.25, 1.0, fogT);
    if (outA < 0.004) discard;
    gl_FragColor = vec4(uColor, outA);
    #include <colorspace_fragment>
  }
`

let _blobGeo = null
function blobGeometry() {
  if (_blobGeo) return _blobGeo
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  _blobGeo = g
  return g
}

function makeBlob({ color, alpha, rx, rz, fogDensity }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: colorOf(color) },
      uAlpha: { value: alpha },
      uFogDensity: { value: fogDensity },
    },
    vertexShader: BLOB_VERT,
    fragmentShader: BLOB_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  })
  const mesh = new THREE.Mesh(blobGeometry(), mat)
  mesh.scale.set(rx, 1, rz)
  mesh.renderOrder = -1     // among transparents: always under the sprites
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.userData.bootAlpha = alpha
  return mesh
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/**
 * Party billboard quad: planeW × planeH metres, origin at the FEET-CENTRE,
 * soles (sheet groundRow) sunk FOOT_SINK_TEXELS below y=0 so boots seat into
 * the floor's ambient. UVs 0..1; the cell window is applied in the shader.
 */
function partyGeometry(planeW, planeH, footBase, sink) {
  const y0 = -(footBase + sink)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -planeW / 2, y0, 0, planeW / 2, y0, 0,
    planeW / 2, y0 + planeH, 0, -planeW / 2, y0 + planeH, 0,
  ], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/**
 * Enemy quad: full canvas as one plane, sized by meta.pxPerMeter, with the
 * ANCHOR PIXEL (art.px, art.py) at the local origin — so planting the origin
 * at the world anchor composes exactly like the plates (dragon forefeet at
 * 0.330 fw with the tail coil hanging far frame-left of them).
 */
function enemyGeometry(art) {
  const meta = art.meta || {}
  const cw = (meta.canvas && meta.canvas.w) || (art.texture.image ? art.texture.image.width : 1024)
  const chh = (meta.canvas && meta.canvas.h) || (art.texture.image ? art.texture.image.height : 896)
  const ppm = meta.pxPerMeter || (chh * 0.9) / (art.worldHeight || 6)
  const W = cw / ppm
  const H = chh / ppm
  const u = (art.px != null ? art.px : cw / 2) / cw          // anchor u from left
  const v = (chh - (art.py != null ? art.py : chh)) / chh    // anchor v from bottom
  const x0 = -u * W
  const y0 = -v * H
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, y0, 0, x0 + W, y0, 0, x0 + W, y0 + H, 0, x0, y0 + H, 0,
  ], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return { geo: g, W, H, ppm, anchorV: v, anchorU: u }
}

// ---------------------------------------------------------------------------
// createUnits
// ---------------------------------------------------------------------------

export function createUnits({ arena, sheets, enemyArt, renderer }) {
  const variant = (arena && arena.meta && arena.meta.variant) || 'hall'
  const groundY = arena && arena.groundY ? arena.groundY : () => 0
  const isHall = variant === 'hall'
  const emissiveFloor = colorOf(EMISSIVE_FLOOR[variant] || EMISSIVE_FLOOR.hall)
  const blobAlpha = BLOB_ALPHA[variant] != null ? BLOB_ALPHA[variant] : BLOB_ALPHA.hall
  const bootFogDensity = isHall ? 0.012 : 0.028 // §3/§4 (live value re-read per frame)

  const group = new THREE.Group()
  group.name = 'battleUnits'

  // ---- normalize the sheets input -----------------------------------------
  // The contract shows makeBattlerSheet ×4 but not the container; accept an
  // array in slot order, an id-keyed object, or a single sheet reused ×4.
  const sheetById = {}
  if (Array.isArray(sheets)) {
    for (let i = 0; i < PARTY_STAGING.length; i++) {
      const sh = sheets[i]
      if (!sh) continue
      const id = (sh.meta && sh.meta.id) || PARTY_STAGING[i].id
      sheetById[id] = sh
      if (!sheetById[PARTY_STAGING[i].id]) sheetById[PARTY_STAGING[i].id] = sh
    }
  } else if (sheets && sheets.texture) {
    for (const s of PARTY_STAGING) sheetById[s.id] = sheets
  } else if (sheets) {
    for (const k of Object.keys(sheets)) sheetById[k] = sheets[k]
  }

  // ---- internal solved camera (primes screen() before main's first frame) --
  let vw = 1600
  let vh = 900
  const _sizeV2 = new THREE.Vector2()
  function readViewport() {
    const el = renderer && renderer.domElement
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      vw = el.clientWidth
      vh = el.clientHeight
    } else if (renderer && renderer.getSize) {
      renderer.getSize(_sizeV2)
      if (_sizeV2.x > 0) { vw = _sizeV2.x; vh = _sizeV2.y }
    }
  }
  readViewport()
  const bootCam = new THREE.PerspectiveCamera(CAM_FOV, vw / vh, 1, 80)
  bootCam.position.set(CAM_POS[0], CAM_POS[1], CAM_POS[2])
  bootCam.rotation.x = -CAM_PITCH_DEG * DEG
  bootCam.updateMatrixWorld(true)
  bootCam.matrixWorldInverse.copy(bootCam.matrixWorld).invert()

  // ---- arena light discovery ----------------------------------------------
  // Read the LIVE rig (torch flicker + position jitter feed the sprites every
  // frame). Spell lights live in the arena's 'arenaSpellLights' group and are
  // handled separately under the §5.3 cap — excluded here.
  const rig = { hemi: null, dir: null, points: [] }
  ;(function discover() {
    const root = arena && arena.object3D
    if (!root) return
    const spellRoot = root.getObjectByName('arenaSpellLights')
    root.traverse((o) => {
      let inSpell = false
      for (let p = o; p; p = p.parent) if (p === spellRoot) { inSpell = true; break }
      if (inSpell) return
      if (o.isHemisphereLight && !rig.hemi) rig.hemi = o
      else if (o.isDirectionalLight && !rig.dir) rig.dir = o
      else if (o.isPointLight && rig.points.length < 2) rig.points.push(o)
    })
  })()
  const spellGroup = arena && arena.object3D
    ? arena.object3D.getObjectByName('arenaSpellLights')
    : null

  // ---- shared scratch (hot path stays allocation-free) --------------------
  const _v = new THREE.Vector3()
  const _v2 = new THREE.Vector3()
  const _v3 = new THREE.Vector3()
  const _c = new THREE.Color()
  const _spellCol = new THREE.Color()
  let liveCam = bootCam
  let tNow = 0

  // rim colour cache (arena publishes a '#rrggbb' string)
  let rimColorStr = ''
  const rimColor = new THREE.Color(0xffb47a)

  // ---- unit construction ---------------------------------------------------
  const units = []          // party UnitStates in slot order
  const byId = {}
  const internals = []      // per-unit private driving state (same order + enemy)

  function registerScreen(u) {
    // Per-unit cached screen anchor; screen(target?) copies it out. The cache
    // is refreshed once per update() — UI modules run after units per the
    // integration order, so they always read current-frame values.
    const scr = { x: 0, y: 0, h: 0 }
    u.screen = function screen(target) {
      if (target) {
        target.x = scr.x
        target.y = scr.y
        target.h = scr.h
        return target
      }
      return scr
    }
    return scr
  }

  // ......................................................................
  // Party
  // ......................................................................
  for (const st of PARTY_STAGING) {
    const sheet = sheetById[st.id]
    if (!sheet) throw new Error(`createUnits: missing sheet for '${st.id}'`)
    const meta = sheet.meta || {}
    const texW = (sheet.texture.image && sheet.texture.image.width) || sheet.cols * sheet.frameW
    const texH = (sheet.texture.image && sheet.texture.image.height) || sheet.rows * sheet.frameH
    const tpm = meta.texelsPerMeter || 52.5
    const planeH = sheet.frameH / tpm             // 96 / 52.5 = 1.829 m
    const planeW = sheet.frameW / tpm
    const texel = planeH / sheet.frameH           // metres per texel
    const groundRow = meta.groundRow != null ? meta.groundRow : 90
    const footBase = (sheet.frameH - (groundRow + 1)) * texel
    const sink = FOOT_SINK_TEXELS * texel
    const bodyPx = meta.bodyPx || 84
    const bodyH = bodyPx / tpm                    // 1.60 m — §2, the scale unit

    // Exposure calibration (measured against frame04/05): the raw §3/§4 rig
    // integrates to ≈0.11 at the party anchors (torch 40/d² + hemi 0.35 +
    // fill 0.22 against the faux normal) — but the plates present the party
    // at ≈2/3 of authored albedo with visible torch-side modulation. So the
    // sprites get a scene-presence base plus an amplified response: the
    // flicker, the torch pools, the highland key and every spell light still
    // paint them (×2.2), and the total is clamped so a burst can push toward
    // overexposure without ever nuking the cells.
    const mat = makeUnitMaterial({
      map: sheet.texture,
      alphaCut: 0.5,                              // hard chibi cutout
      emissive: emissiveFloor,
      fogScale: SPRITE_FOG_SCALE,
      lightBase: 0.42,
      lightResp: 2.2,
      lightClamp: [0.0, 1.6],
    })
    // §5.4 occlusion window in cell-local v: soles → +15 % of the body.
    const soleV = (sheet.frameH - (groundRow + 1)) / sheet.frameH
    mat.uniforms.uOccl.value.set(soleV, soleV + (bodyPx * OCCLUDE_FRAC) / sheet.frameH)
    mat.uniforms.uCellRep.value.set(sheet.frameW / texW, sheet.frameH / texH)

    const mesh = new THREE.Mesh(partyGeometry(planeW, planeH, footBase, sink), mat)
    mesh.name = 'battler_' + st.id
    mesh.frustumCulled = false
    mesh.castShadow = false      // §3: sprite grounding comes from contact blobs
    mesh.receiveShadow = false

    // unit root carries the feet anchor; the mesh carries transient recoil
    const root = new THREE.Group()
    root.name = 'unit_' + st.id
    root.add(mesh)

    // §5.2 contact blob — planted on the stage surface under the feet, biased
    // 0.06 m toward camera so a sliver always reads below the soles on screen.
    const blob = makeBlob({
      color: BLOB_COLOR, alpha: blobAlpha,
      rx: BLOB_RX, rz: BLOB_RZ, fogDensity: bootFogDensity,
    })
    blob.position.set(0, 0.02, 0.06)
    root.add(blob)
    group.add(root)

    const anchor = new THREE.Vector3(st.x, groundY(st.x, st.z), st.z)
    root.position.copy(anchor)

    const boot = BOOT_STATS[st.id]
    const u = {
      id: st.id,
      name: meta.name || NAMES[st.id] || st.id,
      isEnemy: false,
      anchor,                       // live vector — feet, world space
      hp: boot.hp, hpMax: boot.hpMax,
      mp: boot.mp, mpMax: boot.mpMax,
      limit: boot.limit,
      statuses: [],
      queueEta: boot.eta,
      // non-contract extras (additive; UI may ignore)
      slot: st.slot,
      rank: st.rank,
      bodyMeters: BODY_METERS,
      alive: true,
    }
    const scr = registerScreen(u)
    units.push(u)
    byId[u.id] = u

    internals.push({
      u, root, mesh, mat, blob, sheet, scr,
      bodyH,
      texelUV: [1 / texW, 1 / texH],
      // anim clock
      anim: 'idle',
      frames: sheet.anims.idle,
      fps: sheet.fps || 12,
      t: Math.random() * 1.7,       // desynced idle breathing
      loop: true,
      holdLast: false,
      onDone: null,
      lastCell: -1,
      // transient reactions
      flashT: -1,                   // §9 double flash timeline
      recoilT: -1,
      recoilDir: 1,                 // party recoils +X (away from the enemy)
      koT: -1,
      chestY: bodyH * 0.62,
    })
  }

  // ......................................................................
  // Enemy — the painterly wall (§6)
  // ......................................................................
  const eStage = ENEMY_STAGING[variant] || ENEMY_STAGING.hall
  const artMode = (enemyArt && enemyArt.anchor) || eStage.mode
  const { geo: eGeo, H: eH, ppm: ePpm, anchorV: eAnchorV } = enemyGeometry(enemyArt)
  const eMeta = enemyArt.meta || {}
  const eName = (eMeta.name || (isHall ? 'dragon' : 'sorcerer')).toLowerCase()

  const eMat = makeUnitMaterial({
    map: enemyArt.texture,
    alphaCut: 0.02,                 // painterly soft edges: blend, not cutout
    // the enemy bakes its own shade hues (§6) — only a whisper of floor so the
    // ±15 % modulation law stays honest
    emissive: colorOf(EMISSIVE_FLOOR[variant] || EMISSIVE_FLOOR.hall).multiplyScalar(0.35),
    fogScale: ENEMY_FOG_SCALE[variant] || 0.9,
    lightBase: 0.85,                // §6: bakes its key; scene modulates ±15 %
    lightResp: 0.45,
    lightClamp: [0.85, 1.15],
  })
  // §6 idle wing/beard drift: ±2 px of the source canvas, upper 45 % only.
  const eCanvasW = (eMeta.canvas && eMeta.canvas.w) || 1024
  eMat.uniforms.uDrift.value.set(2 / eCanvasW, 0.55)
  if (artMode === 'feet') {
    // grounded enemy: occlusion band over the bottom 15 % of its 6 m mass
    eMat.uniforms.uOccl.value.set(eAnchorV, eAnchorV + ((enemyArt.worldHeight || 6) * OCCLUDE_FRAC * ePpm) / ((eMeta.canvas && eMeta.canvas.h) || 896))
  }

  const eMesh = new THREE.Mesh(eGeo, eMat)
  eMesh.name = 'enemy_' + eName
  eMesh.frustumCulled = false
  eMesh.castShadow = false
  eMesh.receiveShadow = false

  const eRoot = new THREE.Group()
  eRoot.name = 'unit_enemy'
  eRoot.add(eMesh)
  group.add(eRoot)

  // Enemy ground anchor (the contract's "feet"): the stage point beneath the
  // mass. The dragon's anchor pixel IS its forefeet contact; the sorcerer
  // levitates, so its anchor is the ground point below the §1 mass centre.
  const eGround = groundY(eStage.x, eStage.z)
  const eAnchor = new THREE.Vector3(eStage.x, eGround, eStage.z)
  // vertical placement of the anchor PIXEL relative to the ground anchor:
  const eSink = eStage.sink || 0
  const eMassLift = artMode === 'center'
    ? (eStage.massY != null ? eStage.massY : 3.4) - eGround  // §1 world 3.4 m
    : -eSink                                                  // feet sunk 0.35
  // silhouette top above the ground anchor (for screen().h):
  const eSil = eMeta.silhouette || null
  const eTopWorld = eSil
    ? eMassLift + ((enemyArt.py != null ? enemyArt.py : 838) - eSil.y0) / ePpm
    : eMassLift + (artMode === 'center' ? eH * (1 - eAnchorV) : (enemyArt.worldHeight || 6))

  // §5.2 grounding: dragon = broad mass pool + forefeet blob;
  // sorcerer = pale fog-pool disc r 2.5 m α 0.25 (no dark blob — it floats).
  const eBlobs = []
  if (artMode === 'feet') {
    const pool = makeBlob({ color: BLOB_COLOR, alpha: 0.50, rx: 2.45, rz: 0.95, fogDensity: bootFogDensity })
    pool.position.set(-1.25, 0.02, -0.15) // mass sits left of the forefeet
    eRoot.add(pool)
    eBlobs.push(pool)
    const feet = makeBlob({ color: BLOB_COLOR, alpha: 0.55, rx: 0.85, rz: 0.32, fogDensity: bootFogDensity })
    feet.position.set(0, 0.025, 0.05)
    eRoot.add(feet)
    eBlobs.push(feet)
  } else {
    const pool = makeBlob({ color: FOGPOOL_COLOR, alpha: FOGPOOL_ALPHA, rx: FOGPOOL_R, rz: FOGPOOL_R * 0.55, fogDensity: bootFogDensity })
    pool.position.set(0, 0.03, 0)
    eRoot.add(pool)
    eBlobs.push(pool)
  }
  eRoot.position.copy(eAnchor)

  const eBoot = BOOT_STATS.enemy
  const enemy = {
    id: eName,
    name: eName === 'dragon' ? 'Fell Wyrm' : eName === 'sorcerer' ? 'Grim Sage' : eName,
    isEnemy: true,
    anchor: eAnchor,
    hp: eBoot.hp, hpMax: eBoot.hpMax,
    mp: eBoot.mp, mpMax: eBoot.mpMax,
    limit: eBoot.limit,               // panels read this as the break gauge
    statuses: [],
    queueEta: eBoot.eta,
    worldHeight: enemyArt.worldHeight || (isHall ? 6.0 : 6.5),
    alive: true,
  }
  const eScr = registerScreen(enemy)
  byId[enemy.id] = enemy
  byId.enemy = enemy

  const eInternal = {
    u: enemy, root: eRoot, mesh: eMesh, mat: eMat, blobs: eBlobs, scr: eScr,
    bodyH: eTopWorld,
    massLift: eMassLift,
    // procedural anim state
    anim: 'idle',
    animT: 0,
    animDur: 0,
    onDone: null,
    flashT: -1,
    recoilT: -1,
    dissolve: 0,
    dying: false,
    breathPhase: Math.random() * Math.PI * 2,
  }

  // ......................................................................
  // Cell presentation (party)
  // ......................................................................
  function presentCell(inn, cell) {
    if (inn.lastCell === cell) return
    inn.lastCell = cell
    const sheet = inn.sheet
    const texW = 1 / inn.texelUV[0]
    const texH = 1 / inn.texelUV[1]
    const col = cell % sheet.cols
    const row = (cell / sheet.cols) | 0
    // 96 px cells on a 1024×512 sheet: offsets from PIXEL ratios, never 1/cols
    const ou = (col * sheet.frameW) / texW
    const ov = 1 - ((row + 1) * sheet.frameH) / texH
    inn.mat.uniforms.uCellOff.value.set(ou, ov)
    // rim sampling clamp: half a texel inside the live cell
    inn.mat.uniforms.uClampMin.value.set(ou + 0.5 * inn.texelUV[0], ov + 0.5 * inn.texelUV[1])
    inn.mat.uniforms.uClampMax.value.set(
      ou + sheet.frameW / texW - 0.5 * inn.texelUV[0],
      ov + sheet.frameH / texH - 0.5 * inn.texelUV[1],
    )
  }
  for (const inn of internals) presentCell(inn, inn.frames[0])

  // ......................................................................
  // playAnim
  // ......................................................................
  const LOOPING = { idle: true, ready: true, victory: true }

  function playAnim(id, name, opts) {
    const u = byId[id]
    if (!u) return
    const onDone = opts && opts.onDone ? opts.onDone : null

    if (u.isEnemy) {
      // procedural enemy beats (§6/§9)
      const inn = eInternal
      inn.onDone = onDone
      inn.animT = 0
      switch (name) {
        case 'hit':
          inn.anim = 'hit'
          inn.animDur = 0.33
          inn.flashT = 0            // single 60 ms flash
          inn.recoilT = 0
          break
        case 'attack':
        case 'cast':
          inn.anim = name
          inn.animDur = 0.9         // lunge out + back
          break
        case 'ko':
        case 'death':
          inn.anim = 'death'
          inn.animDur = DEATH_DISSOLVE_S
          inn.dying = true
          u.alive = false
          break
        default:
          inn.anim = 'idle'
          inn.animDur = 0
          inn.dying = false
          inn.dissolve = 0
          inn.mat.uniforms.uDissolve.value = 0
          inn.mat.uniforms.uFlash.value = 0
          for (const b of inn.blobs) b.material.uniforms.uAlpha.value = b.userData.bootAlpha
          u.alive = true
      }
      return
    }

    const inn = internals[units.indexOf(u)]
    if (!inn) return
    const frames = inn.sheet.anims[name]
    if (!frames || !frames.length) {
      if (onDone) onDone()
      return
    }
    inn.anim = name
    inn.frames = frames
    inn.t = 0
    inn.loop = opts && opts.loop != null ? !!opts.loop : !!LOOPING[name]
    inn.holdLast = name === 'ko'
    inn.onDone = onDone
    if (name === 'hit') {
      inn.flashT = 0                // §9: 2 × 60 ms white flash
      inn.recoilT = 0               // −0.35 m recoil, 90 ms in / 180 ms settle
    }
    if (name === 'ko') {
      inn.koT = 0
      u.alive = false
    } else if (inn.koT >= 0 && name === 'idle') {
      // revival: clear KO visuals
      inn.koT = -1
      inn.mat.uniforms.uDesat.value = 0
      inn.mat.uniforms.uFade.value = 1
      u.alive = true
    }
  }

  // ......................................................................
  // spawnAt
  // ......................................................................
  function spawnAt(id, worldPos) {
    const u = byId[id]
    if (!u || !worldPos) return
    const x = worldPos.x != null ? worldPos.x : u.anchor.x
    const z = worldPos.z != null ? worldPos.z : u.anchor.z
    if (u.isEnemy) {
      const g = groundY(x, z)
      u.anchor.set(x, g, z)
      eInternal.root.position.copy(u.anchor)
      if (artMode === 'center') eInternal.massLift = (eStage.massY != null ? eStage.massY : 3.4) - g
    } else {
      // feet plant on the stage surface (bible: every foot plants on groundY)
      u.anchor.set(x, worldPos.y != null && worldPos.y !== 0 ? worldPos.y : groundY(x, z), z)
      const inn = internals[units.indexOf(u)]
      inn.root.position.copy(u.anchor)
    }
    refreshScreens(liveCam)
  }

  // ......................................................................
  // Per-frame — lighting, rim, spell response, clocks, screen cache
  // ......................................................................

  function writeRig(mat) {
    const U = mat.uniforms
    if (rig.hemi) {
      const i = rig.hemi.intensity
      _c.copy(rig.hemi.color)
      U.uHemiSky.value.set(_c.r * i, _c.g * i, _c.b * i)
      _c.copy(rig.hemi.groundColor)
      U.uHemiGround.value.set(_c.r * i, _c.g * i, _c.b * i)
    }
    if (rig.dir) {
      const i = rig.dir.intensity
      _c.copy(rig.dir.color)
      U.uDirColor.value.set(_c.r * i, _c.g * i, _c.b * i)
      _v.copy(rig.dir.position)
      if (rig.dir.target) _v.sub(rig.dir.target.position)
      _v.normalize()
      U.uDirDir.value.copy(_v)
    }
    for (let i = 0; i < 2; i++) {
      const L = rig.points[i]
      if (L) {
        U.uPtPos.value[i].copy(L.position)
        const s = L.intensity
        _c.copy(L.color)
        U.uPtColor.value[i].set(_c.r * s, _c.g * s, _c.b * s)
        U.uPtParam.value[i].set(L.distance || 0, L.decay != null ? L.decay : 2)
      } else {
        U.uPtColor.value[i].set(0, 0, 0)
        U.uPtPos.value[i].set(0, -99, 0)
      }
    }
  }

  // live spell lights (≤4 tracked without allocating)
  const _spells = [null, null, null, null]
  let _spellN = 0
  function collectSpells() {
    _spellN = 0
    if (!spellGroup) return
    const kids = spellGroup.children
    for (let i = 0; i < kids.length && _spellN < 4; i++) {
      const L = kids[i]
      if (L.isPointLight && L.visible && L.intensity > 4) _spells[_spellN++] = L
    }
  }

  /** Per-unit §5.3 spell response + §5.1 rim source refinement. */
  function unitLightResponse(inn, isEnemy) {
    const U = inn.mat.uniforms
    const a = inn.u.anchor
    const chestY = a.y + (isEnemy ? Math.max(1.2, inn.bodyH * 0.35) : inn.chestY)

    // ---- capped additive spell colour ------------------------------------
    let amt = 0
    let cr = 0
    let cg = 0
    let cb = 0
    for (let i = 0; i < _spellN; i++) {
      const L = _spells[i]
      const dx = L.position.x - a.x
      const dy = L.position.y - chestY
      const dz = L.position.z - a.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > SPELL_RANGE) continue
      const fall = 1 - clamp((d - 1.0) / (SPELL_RANGE - 1.0), 0, 1)
      const w = clamp(L.intensity / 60, 0, 1) * fall * fall
      if (w <= 0) continue
      _spellCol.copy(L.color)
      cr += _spellCol.r * w
      cg += _spellCol.g * w
      cb += _spellCol.b * w
      amt += w
    }
    const cap = isEnemy ? SPELL_CAP_ENEMY : SPELL_CAP_PARTY
    if (amt > 0.001) {
      // normalized spell colour × cap × saturate(total weight) — never > cap
      const s = (cap * Math.min(amt, 1)) / amt
      U.uSpellAdd.value.set(cr * s, cg * s, cb * s)
    } else {
      U.uSpellAdd.value.set(0, 0, 0)
    }

    // ---- rim (party only — the enemy bakes its rim, §6) ------------------
    if (isEnemy) return
    const rim = arena && arena.rim
    if (!rim || !(rim.strength > 0)) {
      U.uRimColor.value.set(0, 0, 0)
      return
    }
    if (rim.color !== rimColorStr) {
      rimColorStr = rim.color
      rimColor.set(rim.color)
    }
    const k = rim.strength * 0.85
    U.uRimColor.value.set(rimColor.r * k, rimColor.g * k, rimColor.b * k)

    // direction: strongest of rim.sources as seen from THIS unit (§5.1),
    // projected to screen space (y down), falling back to the published dir.
    let dirX = rim.dir ? rim.dir[0] : 0
    let dirY = rim.dir ? rim.dir[1] : -1
    const srcs = rim.sources
    if (srcs && srcs.length) {
      let best = null
      let bestW = -1
      for (let i = 0; i < srcs.length; i++) {
        const s = srcs[i]
        const dx = s.x - a.x
        const dy = s.y - chestY
        const dz = s.z - a.z
        const d2 = dx * dx + dy * dy + dz * dz + 1
        const w = (s.kind === 'spell' ? (s.intensity || 60) : 40) / d2
        if (w > bestW) { bestW = w; best = s }
      }
      if (best) {
        _v.set(a.x, chestY, a.z).project(liveCam)
        _v2.set(best.x, best.y, best.z).project(liveCam)
        const sx = _v2.x - _v.x
        const sy = -(_v2.y - _v.y) // NDC y-up → screen y-down
        const l = Math.hypot(sx, sy)
        if (l > 1e-5) { dirX = sx / l; dirY = sy / l }
      }
    }
    // screen dir → texture-uv offset of ONE texel (v axis is screen-up)
    U.uRimOff.value.set(dirX * inn.texelUV[0], -dirY * inn.texelUV[1])
  }

  // ---- screen cache --------------------------------------------------------
  function refreshScreens(camera) {
    readViewport()
    for (let i = 0; i < internals.length; i++) {
      const inn = internals[i]
      const a = inn.u.anchor
      _v.copy(a).project(camera)
      const fx = (_v.x * 0.5 + 0.5) * vw
      const fy = (-_v.y * 0.5 + 0.5) * vh
      _v2.set(a.x, a.y + inn.bodyH, a.z).project(camera)
      const hy = (-_v2.y * 0.5 + 0.5) * vh
      inn.scr.x = fx
      inn.scr.y = fy
      inn.scr.h = fy - hy
    }
    // enemy
    {
      const a = enemy.anchor
      _v.copy(a).project(camera)
      eInternal.scr.x = (_v.x * 0.5 + 0.5) * vw
      eInternal.scr.y = (-_v.y * 0.5 + 0.5) * vh
      _v2.set(a.x, a.y + eInternal.bodyH, a.z).project(camera)
      eInternal.scr.h = eInternal.scr.y - (-_v2.y * 0.5 + 0.5) * vh
    }
  }

  // ---- fog read (arena owns scene.fog; walk up to the scene once) ---------
  let sceneRef = null
  function liveFog(mat) {
    if (!sceneRef) {
      for (let p = group.parent; p; p = p.parent) if (p.isScene) { sceneRef = p; break }
    }
    const fog = sceneRef && sceneRef.fog
    if (fog && fog.isFogExp2) {
      mat.uniforms.uFogDensity.value = fog.density
      const c = fog.color
      mat.uniforms.uFogColor.value.set(c.r, c.g, c.b)
    } else {
      mat.uniforms.uFogDensity.value = bootFogDensity
    }
  }

  // ......................................................................
  // update(dt, camera)
  // ......................................................................
  function update(dt, camera) {
    if (!(dt >= 0)) dt = 1 / 60
    if (dt > 0.1) dt = 0.1
    tNow += dt
    if (camera && camera.isCamera) {
      liveCam = camera
      // screen()/rim projection need a current inverse even before the first
      // renderer.render() has refreshed it.
      camera.updateMatrixWorld()
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    }
    collectSpells()

    // ---- party ------------------------------------------------------------
    for (let i = 0; i < internals.length; i++) {
      const inn = internals[i]
      const u = inn.u
      const U = inn.mat.uniforms

      // anim clock (one fps clock; ORDERS encode pacing — battlerSheet §9)
      inn.t += dt * inn.fps
      let idx = inn.t | 0
      const len = inn.frames.length
      if (idx >= len) {
        if (inn.loop) {
          inn.t -= len * Math.floor(inn.t / len)
          idx = inn.t | 0
        } else {
          idx = len - 1
          if (inn.onDone) {
            const cb = inn.onDone
            inn.onDone = null
            cb()
          }
          if (!inn.holdLast && inn.anim !== 'ko') {
            // one-shot finished → settle back to idle
            inn.anim = 'idle'
            inn.frames = inn.sheet.anims.idle
            inn.t = 0
            inn.loop = true
            idx = 0
          }
        }
      }
      presentCell(inn, inn.frames[idx])

      // §9 double hit flash: on 0–60 ms and 120–180 ms
      if (inn.flashT >= 0) {
        inn.flashT += dt
        const ft = inn.flashT
        const on = (ft < HIT_FLASH_MS) || (ft >= HIT_FLASH_MS * 2 && ft < HIT_FLASH_MS * 3)
        U.uFlash.value = on ? 0.85 : 0
        if (ft > HIT_FLASH_MS * 3) { inn.flashT = -1; U.uFlash.value = 0 }
      }
      // §9 recoil: −0.35 m over 90 ms, settle 180 ms (mesh offset; feet — and
      // the contact blob — stay planted at the anchor)
      if (inn.recoilT >= 0) {
        inn.recoilT += dt
        const rt = inn.recoilT
        let off = 0
        if (rt < HIT_RECOIL_IN) off = (rt / HIT_RECOIL_IN) * HIT_RECOIL_M
        else if (rt < HIT_RECOIL_IN + HIT_RECOIL_OUT) {
          const q = (rt - HIT_RECOIL_IN) / HIT_RECOIL_OUT
          off = HIT_RECOIL_M * (1 - q * q * (3 - 2 * q))
        } else { inn.recoilT = -1 }
        inn.mesh.position.x = off * inn.recoilDir
      } else if (inn.mesh.position.x !== 0) {
        inn.mesh.position.x = 0
      }
      // §9 KO: desat through the fall, then fade 700 ms
      if (inn.koT >= 0) {
        inn.koT += dt
        const fall = 0.30
        U.uDesat.value = KO_DESAT * clamp(inn.koT / fall, 0, 1)
        if (inn.koT > fall) {
          U.uFade.value = clamp(1 - (inn.koT - fall) / KO_FADE_S, 0, 1)
        }
      }

      // root follows the (choreo-driven) anchor; feet plant on the stage
      inn.root.position.copy(u.anchor)

      // yaw-only billboard toward the camera (house sprite law)
      inn.root.rotation.y = Math.atan2(
        liveCam.position.x - u.anchor.x,
        liveCam.position.z - u.anchor.z,
      )

      // §5 faux normal: mix(up, toCamera, 0.35), normalized — per unit
      _v3.set(
        liveCam.position.x - u.anchor.x,
        liveCam.position.y - (u.anchor.y + inn.chestY),
        liveCam.position.z - u.anchor.z,
      ).normalize()
      U.uNormalW.value.set(_v3.x * 0.35, 1 - 0.35 + _v3.y * 0.35, _v3.z * 0.35).normalize()

      writeRig(inn.mat)
      liveFog(inn.mat)
      unitLightResponse(inn, false)
      U.uTime.value = tNow
    }

    // ---- enemy ------------------------------------------------------------
    {
      const inn = eInternal
      const U = eMat.uniforms
      const u = enemy

      // procedural beats
      let lunge = 0
      if (inn.anim !== 'idle' && inn.animDur > 0) {
        inn.animT += dt
        const q = inn.animT / inn.animDur
        if (inn.anim === 'hit') {
          // 60 ms flash + 0.15 m recoil away from the party (−X), settle
          U.uFlash.value = inn.animT < 0.06 ? 0.8 : 0
          const rq = clamp(inn.animT / 0.09, 0, 1)
          const sq = clamp((inn.animT - 0.09) / 0.24, 0, 1)
          lunge = -ENEMY_RECOIL_M * (rq - sq * rq)
        } else if (inn.anim === 'attack' || inn.anim === 'cast') {
          // menace lunge toward the duel line and back (sin arc)
          lunge = Math.sin(Math.min(q, 1) * Math.PI) * (inn.anim === 'attack' ? 0.45 : 0.2)
        } else if (inn.anim === 'death') {
          inn.dissolve = clamp(q, 0, 1)
          U.uDissolve.value = inn.dissolve
          // grounding fades WITH the body, never before it (absolute, not
          // compounded per frame)
          for (const b of inn.blobs) {
            b.material.uniforms.uAlpha.value = b.userData.bootAlpha * Math.max(0, 1 - inn.dissolve)
          }
        }
        if (q >= 1) {
          if (inn.onDone) {
            const cb = inn.onDone
            inn.onDone = null
            cb()
          }
          if (inn.anim !== 'death') { inn.anim = 'idle'; U.uFlash.value = 0 }
          inn.animDur = 0
        }
      }

      // §6 idle: 0.25 Hz breathing scale-y ±1.5 %; sorcerer adds a slow bob
      const breath = 1 + BREATH_AMP * Math.sin(tNow * Math.PI * 2 * BREATH_HZ + inn.breathPhase)
      eMesh.scale.y = breath
      eMesh.scale.x = 1 + (1 - breath) * 0.4 // faint counter-squash
      eMesh.position.x = lunge
      let lift = inn.massLift
      if (artMode === 'center') {
        lift += Math.sin(tNow * Math.PI * 2 * 0.22 + 1.3) * 0.07
        eMesh.position.x += Math.sin(tNow * 0.9) * 0.03
      }
      eMesh.position.y = lift
      eRoot.position.copy(u.anchor)
      eRoot.rotation.y = Math.atan2(
        liveCam.position.x - u.anchor.x,
        liveCam.position.z - u.anchor.z,
      )

      _v3.set(
        liveCam.position.x - u.anchor.x,
        liveCam.position.y - (u.anchor.y + inn.bodyH * 0.4),
        liveCam.position.z - u.anchor.z,
      ).normalize()
      U.uNormalW.value.set(_v3.x * 0.35, 1 - 0.35 + _v3.y * 0.35, _v3.z * 0.35).normalize()

      writeRig(eMat)
      liveFog(eMat)
      unitLightResponse(inn, true)
      U.uTime.value = tNow

      // fog-pool disc breathes with the mist (§4 grounding of the boss);
      // during the death dissolve the fade owns the alpha instead
      if (artMode === 'center' && inn.blobs.length && !inn.dying) {
        const b = inn.blobs[0]
        const s = 1 + 0.05 * Math.sin(tNow * 0.5)
        b.scale.set(FOGPOOL_R * s, 1, FOGPOOL_R * 0.55 * s)
        b.material.uniforms.uAlpha.value = FOGPOOL_ALPHA * (1 + 0.12 * Math.sin(tNow * 0.33 + 2))
      }
    }

    // ---- screen cache (UI modules read after this per integration order) --
    refreshScreens(liveCam)
  }

  // prime everything against the solved boot camera so UI construction can
  // anchor before main's first frame
  refreshScreens(bootCam)
  update(0, bootCam)

  // ......................................................................
  // Public surface
  // ......................................................................
  return {
    object3D: group,
    roster: units,
    enemy,
    get(id) { return byId[id] || null },
    playAnim,
    spawnAt,
    update,
  }
}
