/**
 * src/gfx/sky.js — sky dome, sun + shadow rig, hemisphere fill, scene fog.
 *
 * Matched against docs/reference/frame01.png / frame02.png and ART_BIBLE.md §4:
 * the hero frame itself shows NO sky (horizon sits 0.58 fh above the top edge),
 * so this dome exists to feed the hemisphere/water/glitter and to hold up if the
 * camera is ever pitched loose. It is still built for real: zenith→horizon
 * gradient, a warm sun disc with atmospheric glow, and two parallax fBm cloud
 * layers (domain-warped cumulus low, stretched cirrus high) that drift slowly.
 *
 * CONTRACT (frozen):
 *   createSkyAndLights({ scene, renderer, terrain }) -> SkyRig
 *   SkyRig = { object3D, sun: THREE.DirectionalLight, ambient, update(t), params }
 *
 * Extra surface exposed for sibling modules (water.js reads these — additive,
 * no contract change):
 *   rig.sunDir   : THREE.Vector3, unit, pointing TOWARD the sun (kept in sync)
 *   rig.hemi     : the HemisphereLight (also returned as `ambient` — the art
 *                  bible §4 mandates "no other ambient", so the hemisphere IS
 *                  the ambient term; no hidden AmbientLight is added)
 *   rig.fog      : the THREE.FogExp2 instance installed on the scene (LAND
 *                  density — see below)
 *   rig.params   : every number below, live; call params.apply() after edits.
 *
 * Art bible §4 numbers used verbatim:
 *   sun az/el 250°/58°  → dir (−0.498, +0.848, +0.181)   colour #fff1d0 @ 2.6
 *   hemisphere #b9cbd8 / #66744f @ 0.55
 *   shadows: 2048², PCF-soft, bias −0.0006, normalBias 0.02, radius 4, ~140 m
 *   ortho box centred ahead of the boot camera, far 200.
 *
 * FOG (ROUND 2 — the R1 critic's "uniform milky sage veil" fix):
 *   R1 shipped a distance-only FogExp2. Distance-only fog is y-independent, so
 *   the whole top 60 % of the frame — high massif, castle, far ridges, ocean —
 *   converged on the same flat sage milk. Frame01 instead stays saturated
 *   through the sharp band and only dissolves at the very top. That behaviour
 *   IS the bible §4 height falloff: density × exp(−max(0, y − 8) / 38) —
 *   distant HIGH terrain keeps its colour, distant LOW basins fill with haze.
 *
 *   Implementation, without touching any other module:
 *   - THREE.FogExp2 cannot express a height term, so this file patches the
 *     global THREE.ShaderChunk fog chunks (fog_vertex / fog_fragment + pars)
 *     with the exact formula water.js already uses in its applyFog(). Every
 *     built-in-fog material (terrain splat MeshStandard, props MeshStandard/
 *     Basic/Sprite, scatter's patched MeshLambert, the hero's MeshLambert)
 *     picks it up at first compile — they all keep their stock `#include`s.
 *     World-space fragment height is recovered from mvPosition with the
 *     camera's rigid view transform (cameraPosition + viewMatrix column 1),
 *     which is exact for meshes, instances, billboards and sprites alike.
 *     scene.fog stays installed as the vehicle for the fogColor/fogDensity
 *     uniforms and as a plain-FogExp2 fallback if the chunks are ever reset.
 *     NOTE: fogHeightRef/fogHeightFalloff (and the waterfall-mist constants)
 *     are baked into the chunk source at install (compile-time constants —
 *     live edits reach water.js only).
 *   - LAND density (ROUND 3): k = 0.0095 — bible §4's 0.0072 rescaled for the
 *     framing solve, which compressed the visible world from ~250 m of depth
 *     to ~90 m — and it is a WORLD-SPACE CONSTANT. Earlier rounds scaled k by a camera-dolly ratio
 *     (fogDollyRef / fogDolly) to "hold the authored profile" — that coupling
 *     was the round-3 defect: fog is an atmosphere property of the WORLD, and
 *     any term tying it to camera distance, dolly or viewport makes the haze
 *     thicken or thin whenever the framing solver moves the camera (at the
 *     round-2 dolly of 30.5 m the ratio 53/30.5 = 1.74 → 1.74² ≈ 3× the
 *     effective exp2 extinction — a milky curtain over the whole top band).
 *     The coupling is REMOVED, not retuned: k must be correct at ANY dolly.
 *     Curve check at y ≤ 8: 40 % fogged at 100 m, 69 % at 150 m, 87 % at
 *     200 m — silhouettes survive at the top of frame, detail does not.
 *   - WATERFALL MIST (bible §4): +15 % local fog density within 30 m of the
 *     falls base (pool ~(−31, −33), y +11 per §1), below y 12 — baked into
 *     the fog chunk as a smooth radial/height mask, feathered so there is no
 *     visible boundary. water.js additionally does its own mist sprites.
 *   - WATER density: pale fog over a dark saturated sea destroys saturation
 *     ~3× faster than over grass (linear-space mixing), which is what greyed
 *     R1's ocean to #70909a. Frame01's sea stays rich teal right up the frame
 *     (§10.5: the cool cast lives on the CLIFFS, not the water). water.js
 *     live-reads params.fogDensity every frame, so that published value is
 *     the attenuated water density (land k × fogWaterAtten) — the sea keeps
 *     ≥55 % HSV saturation at the mid-left band while the far inlet still
 *     hazes off through distance + the tilt-shift ramp.
 */

import * as THREE from 'three'

const DEG = Math.PI / 180

// sRGB hex → THREE.Color. With r152+ colour management (default on) the hex is
// interpreted as sRGB and stored in linear working space — correct for uniforms.
const col = (hex) => new THREE.Color(hex)

/** Compass azimuth from north (−Z), clockwise through east (+X); elevation up. */
function sunDirFromAngles(azDeg, elDeg, out = new THREE.Vector3()) {
  const az = azDeg * DEG
  const el = elDeg * DEG
  return out
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
    .normalize()
}

// ---------------------------------------------------------------------------
// Height-fog chunk patch (see header). Installed once, before first compile.
// The formula mirrors water.js applyFog() exactly:
//   k(y) = fogDensity * exp(-max(y - REF, 0) / FALL)
//   f    = 1 - exp(-k(y)^2 * d^2)
// so built-in-fog land materials and the custom water shaders share one
// atmosphere model and never pop against each other.
// ---------------------------------------------------------------------------

function installHeightFogChunks(heightRef, heightFalloff, mist) {
  const REF = Number(heightRef).toFixed(3)
  const FALL = Math.max(Number(heightFalloff), 1e-3).toFixed(3)
  const MX = Number(mist.x).toFixed(2)
  const MZ = Number(mist.z).toFixed(2)
  const MR = Math.max(Number(mist.radius), 1).toFixed(2)
  const MY = Number(mist.yTop).toFixed(2)
  const MB = Math.max(Number(mist.boost), 0).toFixed(3)

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif`

  // mvPosition is in scope wherever the stock fog_vertex compiles (that chunk
  // already reads it). World pos = cameraPosition + Rᵀ·(view pos): the rows of
  // the view rotation's transpose are viewMatrix columns 0/1/2. Exact for
  // every transform path (instancing, billboards, sprites) because it runs
  // AFTER mvPosition is final.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = cameraPosition + vec3(
		dot( viewMatrix[0].xyz, mvPosition.xyz ),
		dot( viewMatrix[1].xyz, mvPosition.xyz ),
		dot( viewMatrix[2].xyz, mvPosition.xyz ) );
#endif`

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`

  // fogDensity is the WORLD-SPACE constant k (bible §4: 0.0072). No camera
  // term may ever enter this expression — the haze must read identically at
  // any dolly. Height falloff per §4: k · exp(−max(0, y − ${REF}) / ${FALL}).
  // Waterfall mist per §4: +${MB}× k within ${MR} m of the falls base
  // (${MX}, ${MZ}), below y ${MY}, smoothly feathered on both masks.
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogHeightK = fogDensity * exp( - max( vFogWorldPos.y - ${REF}, 0.0 ) / ${FALL} );
		float fogMist = ( 1.0 - smoothstep( ${MR} * 0.5, ${MR}, distance( vFogWorldPos.xz, vec2( ${MX}, ${MZ} ) ) ) )
			* ( 1.0 - smoothstep( ${MY} - 2.0, ${MY}, vFogWorldPos.y ) );
		fogHeightK *= 1.0 + ${MB} * fogMist;
		float fogFactor = 1.0 - exp( - fogHeightK * fogHeightK * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`
}

// ---------------------------------------------------------------------------
// Dome shaders
// ---------------------------------------------------------------------------

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position; // dome is origin-centred; direction == local position
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`

const DOME_FRAG = /* glsl */ `
  varying vec3 vDir;

  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uFogColor;
  uniform vec3  uCloudLit;
  uniform vec3  uCloudShadow;
  uniform vec3  uSunTint;
  uniform vec3  uSunDir;
  uniform float uTime;
  uniform float uCoverLow;    // 0..1 — higher = fewer clouds
  uniform float uCoverHigh;
  uniform float uCloudAmt;    // master cloud opacity
  uniform vec2  uWind;        // horizontal drift direction (unit)
  uniform float uDrift;       // drift speed multiplier

  // -- value noise + fBm -----------------------------------------------------
  float hash12(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * vnoise(p);
      p = R * p * 2.03 + 17.13;
      a *= 0.5;
    }
    return s;
  }

  // One projected cloud layer: ray from origin hits a virtual plane at height h,
  // giving genuine perspective foreshortening + parallax between layers.
  // Returns rgb premultiplied-ish colour in .rgb and coverage in .a.
  vec4 cloudLayer(vec3 dir, float h, float scale, vec2 drift, float cover,
                  float soft, float stretch) {
    float horiz = smoothstep(0.02, 0.16, dir.y);
    if (horiz <= 0.001) return vec4(0.0);

    vec2 base = dir.xz / max(dir.y, 0.045) * h;
    float distFade = 1.0 - smoothstep(2600.0, 7000.0, length(base));
    if (distFade <= 0.001) return vec4(0.0);

    vec2 uv = base * scale + drift;
    uv.x *= stretch; // cirrus streaking

    // domain warp -> cauliflower edges instead of raw noise blobs
    vec2 w = vec2(fbm(uv * 1.9 + 4.17), fbm(uv * 1.9 - 2.31));
    float d = fbm(uv + (w - 0.5) * 0.95);

    float m = smoothstep(cover, cover + soft, d);
    m *= m * (3.0 - 2.0 * m); // plump interiors, soft skirts

    // directional shading: probe density toward the sun; thinner sunward = lit
    vec2 sunOff = normalize(uSunDir.xz + vec2(1e-4)) * 0.42;
    vec2 w2 = vec2(fbm((uv + sunOff) * 1.9 + 4.17), fbm((uv + sunOff) * 1.9 - 2.31));
    float d2 = fbm(uv + sunOff + (w2 - 0.5) * 0.95);
    float lit = clamp(0.5 + (d - d2) * 3.2, 0.0, 1.0);

    // flat-ish bases: darken the lower fraction of each puff (screen heuristic)
    float baseShade = mix(0.82, 1.0, smoothstep(0.0, 0.5, m));
    vec3 c = mix(uCloudShadow, uCloudLit, lit) * baseShade;

    // silver lining on thin edges near the sun
    float rim = smoothstep(0.02, 0.22, m) * (1.0 - smoothstep(0.22, 0.62, m));
    float sunProx = pow(max(dot(dir, uSunDir), 0.0), 8.0);
    c += uSunTint * rim * sunProx * 0.85;

    return vec4(c, m * horiz * distFade);
  }

  void main() {
    vec3 dir = normalize(vDir);

    // ---- gradient ----------------------------------------------------------
    float up = clamp(dir.y, -1.0, 1.0);
    float g = pow(smoothstep(0.0, 0.62, max(up, 0.0)), 0.78);
    vec3 sky = mix(uHorizon, uZenith, g);

    // warm bias of the horizon toward the sun's azimuth
    vec2 flatDir = normalize(dir.xz + vec2(1e-5));
    vec2 flatSun = normalize(uSunDir.xz + vec2(1e-5));
    float azProx = pow(max(dot(flatDir, flatSun), 0.0), 2.0);
    sky = mix(sky, sky * vec3(1.07, 1.03, 0.96),
              azProx * (1.0 - clamp(up * 2.2, 0.0, 1.0)) * 0.65);

    // below the horizon the dome must read as the sage haze, never black
    sky = mix(sky, uFogColor, smoothstep(0.02, -0.18, up));

    // ---- sun disc + glow ---------------------------------------------------
    float cosA = clamp(dot(dir, uSunDir), -1.0, 1.0);
    float ang = acos(cosA);
    float disc = 1.0 - smoothstep(0.0185, 0.0265, ang);
    float glowNear = exp(-(ang * ang) / (2.0 * 0.115 * 0.115));
    float glowWide = exp(-ang / 0.42);
    sky += uSunTint * (glowNear * 0.50 + glowWide * 0.22);
    vec3 colOut = sky;

    // ---- clouds (high cirrus behind, low cumulus in front) -----------------
    vec2 windT = uWind * uTime * uDrift;
    vec4 hi = cloudLayer(dir, 1450.0, 0.00042, windT * 0.0022 + vec2(3.1, 8.7),
                         uCoverHigh, 0.34, 2.6);
    vec4 lo = cloudLayer(dir, 640.0, 0.00105, windT * 0.0060 + vec2(41.0, -7.0),
                         uCoverLow, 0.22, 1.0);

    colOut = mix(colOut, hi.rgb, hi.a * 0.55 * uCloudAmt);
    colOut = mix(colOut, lo.rgb, lo.a * 0.94 * uCloudAmt);

    // sun disc burns through thin cloud, dies under thick cloud
    float occl = clamp(lo.a * 1.35 + hi.a * 0.4, 0.0, 1.0);
    colOut += uSunTint * disc * 2.1 * (1.0 - occl * 0.92);

    // haze re-assertion right at the horizon line (clouds sink into it)
    colOut = mix(colOut, mix(uHorizon, uFogColor, 0.55),
                 (1.0 - smoothstep(0.0, 0.10, abs(up))) * 0.55);

    gl_FragColor = vec4(colOut, 1.0);
  }
`

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export function createSkyAndLights({ scene, renderer, terrain } = {}) {
  // -------------------------------------------------------------------------
  // Params — every number from ART_BIBLE §4, live-editable. Edit + apply().
  // -------------------------------------------------------------------------
  const params = {
    // sun
    sunAzimuth: 250, // degrees from north, clockwise (WSW)
    sunElevation: 58,
    sunColor: '#fff1d0',
    // Bible §4 authored pair, restored verbatim (R2). R1 shipped 3.0 / 0.40 to
    // deepen shade — but that was tuned against a frame whose real problem was
    // the flat fog veil lifting every shadow. With the height fog in place the
    // veil is gone and the authored 4.7:1 key:fill reads warm and directional
    // without re-crushing the fill (frame01's tree shade stays luminous green).
    sunIntensity: 2.6,

    // hemisphere ("the" ambient — bible: no other ambient)
    hemiSky: '#b9cbd8',
    hemiGround: '#66744f',
    hemiIntensity: 0.55, // bible §4 verbatim (see sunIntensity note)

    // fog — apply() keeps the derived values in sync; tune via fogDensityBase
    // / fogWaterAtten, NOT by writing fogDensity directly (apply() overwrites
    // it).
    fogColor: '#bcc8b2',
    // Bible §4 verbatim. k is a WORLD-SPACE CONSTANT: it must never be scaled
    // by camera dolly, view distance or viewport size (round-3 defect — see
    // header). The framing solver may move the camera freely; this stays.
    // ROUND 3 (integrator): 0.0072 → 0.0095. The framing solve compressed the
    // visible world from ~250 m of depth to ~90 m, so the bible's k — measured
    // against the old layout — leaves the top band only 31 % veiled where the
    // plate reads 55–70 %. At 0.0095: hero 47 m → 18 %, massif crown 62 m →
    // 29 %, top band 85 m → 48 %, far NW ocean 125 m → 76 %.
    fogDensityBase: 0.0095,
    // Published water density multiplier (assignment: the sea must keep its
    // saturation instead of greying out). 0.26 keeps the mid-left ocean band
    // under ~5 % sage — ≥55 % HSV saturation vs OCEAN_MID #2e6f95 after the
    // grade — while the far NW inlet still fades under distance + DOF.
    fogWaterAtten: 0.26,
    // DERIVED (apply() recomputes; initial values match the defaults above):
    fogLandDensity: 0.0095,             // scene.fog + height chunks
    fogDensity: 0.0095 * 0.26,          // PUBLISHED — water.js live-reads
    fogHeightRef: 8,        // baked into the land chunks at install; water.js
    fogHeightFalloff: 38,   // reads both live per frame
    // Waterfall mist (bible §4): +15 % local fog around the falls base.
    // ROUND 3 (integrator): the falls moved with the framing solve — a 9 m drop
    // at (−26, −40)/pool (−31, −33) became a 4 m drop at (−30.5, +3) → pool
    // (−30, +2), impact ≈ (−30.05, +2.1). The radius drops 30 → 8 m and the
    // ceiling 12 → 10 m to match the shorter fall; water.js caps its own mist
    // pads at y 9.9, and a 30 m bubble here would have veiled the whole gorge,
    // the castle plateau's west cliff and the river's exit reach.
    fogMist: { x: -30, z: 2, radius: 8, yTop: 10, boost: 0.15 },

    // dome
    domeRadius: 600, // stays inside the diorama rig's 700 m far plane
    zenith: '#7ba7d6',
    horizon: '#d9e4da',
    cloudLit: '#f6f8f1',
    cloudShadow: '#b9c6cf',
    cloudCoverLow: 0.58, // threshold: higher = emptier sky
    cloudCoverHigh: 0.52,
    cloudAmount: 1.0,
    cloudDrift: 1.0, // master drift speed
    windDeg: 70, // clouds drift toward ENE (wind out of the WSW, matching sun)

    // living-light drift (subtle; assignment asks for slow light drift)
    lightDrift: 1.0, // 0 disables
    breatheAmp: 0.014, // ±1.4 % sun intensity breathing
    swayDeg: 0.35, // ± azimuth sway over swayPeriod
    swayPeriod: 140, // seconds

    // shadows — bible: 2048², ~140 m box centred ahead of the boot camera,
    // far 200, bias −0.0006, normalBias 0.02, radius 4. Box is 148 m here:
    // the 140 m ground square projected into light space at el 58° plus the
    // 0–42 m terrain height range needs ~141 m — 148 keeps a safety margin
    // without measurably softening texels (7.2 cm/texel at 2048).
    shadow: {
      mapSize: 2048,
      extent: 148, // ortho box edge length, metres
      focusX: -38, // centred ahead of the boot camera (hero shelf → massif)
      focusZ: -16,
      near: 12,
      far: 200,
      bias: -0.0006,
      normalBias: 0.02,
      radius: 4,
      lightDist: 110, // sun position = focus + dir * lightDist
    },
  }

  // Height-falloff fog for every built-in-fog material (terrain, props,
  // scatter, hero). Must run before the first render (it does: materials
  // compile at first renderer.render, well after construction).
  installHeightFogChunks(params.fogHeightRef, params.fogHeightFalloff, params.fogMist)

  const group = new THREE.Group()
  group.name = 'SkyRig'

  // -------------------------------------------------------------------------
  // Dome
  // -------------------------------------------------------------------------
  const sunDir = sunDirFromAngles(params.sunAzimuth, params.sunElevation)

  const domeUniforms = {
    uZenith: { value: col(params.zenith) },
    uHorizon: { value: col(params.horizon) },
    uFogColor: { value: col(params.fogColor) },
    uCloudLit: { value: col(params.cloudLit) },
    uCloudShadow: { value: col(params.cloudShadow) },
    uSunTint: { value: col(params.sunColor) },
    uSunDir: { value: sunDir.clone() },
    uTime: { value: 0 },
    uCoverLow: { value: params.cloudCoverLow },
    uCoverHigh: { value: params.cloudCoverHigh },
    uCloudAmt: { value: params.cloudAmount },
    uWind: { value: new THREE.Vector2() },
    uDrift: { value: params.cloudDrift },
  }

  const domeMat = new THREE.ShaderMaterial({
    name: 'SkyDome',
    uniforms: domeUniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })

  const dome = new THREE.Mesh(new THREE.SphereGeometry(params.domeRadius, 48, 32), domeMat)
  dome.name = 'SkyDome'
  dome.renderOrder = -1000 // painted first, everything else draws over it
  dome.frustumCulled = false
  dome.matrixAutoUpdate = false
  group.add(dome)

  // -------------------------------------------------------------------------
  // Sun + shadow camera (fitted TIGHT to the diorama — loose frusta = blocky)
  // -------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(col(params.sunColor), params.sunIntensity)
  sun.name = 'Sun'
  sun.castShadow = true
  group.add(sun)
  group.add(sun.target)

  function fitShadow() {
    const s = params.shadow
    const half = s.extent * 0.5
    sun.target.position.set(s.focusX, 0, s.focusZ)
    sun.position
      .copy(sunDir)
      .multiplyScalar(s.lightDist)
      .add(new THREE.Vector3(s.focusX, 10, s.focusZ))
    const cam = sun.shadow.camera
    cam.left = -half
    cam.right = half
    cam.top = half
    cam.bottom = -half
    cam.near = s.near
    cam.far = s.far
    cam.updateProjectionMatrix()
    sun.shadow.mapSize.set(s.mapSize, s.mapSize)
    sun.shadow.bias = s.bias
    sun.shadow.normalBias = s.normalBias
    sun.shadow.radius = s.radius
    if (sun.shadow.map) {
      // map size changed after allocation → force re-create
      sun.shadow.map.dispose()
      sun.shadow.map = null
    }
  }
  fitShadow()

  // -------------------------------------------------------------------------
  // Hemisphere fill (this IS the ambient) + fog
  // -------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(
    col(params.hemiSky),
    col(params.hemiGround),
    params.hemiIntensity
  )
  hemi.name = 'HemiFill'
  hemi.position.set(0, 120, 0)
  group.add(hemi)

  // scene.fog carries the LAND density; the patched chunks add the height
  // term on top of it. Water fogs itself from params.fogDensity (attenuated).
  const fog = new THREE.FogExp2(col(params.fogColor).getHex(), params.fogLandDensity)
  if (scene) {
    scene.fog = fog
    // belt & braces: if the dome is ever culled/hidden, the clear colour must
    // still be the sage haze, never black.
    scene.background = col(params.fogColor)
  }

  // -------------------------------------------------------------------------
  // apply() — push params into lights / fog / dome uniforms
  // -------------------------------------------------------------------------
  function apply() {
    sunDirFromAngles(params.sunAzimuth, params.sunElevation, sunDir)
    domeUniforms.uSunDir.value.copy(sunDir)

    sun.color.set(params.sunColor)
    sun.intensity = params.sunIntensity
    fitShadow()

    hemi.color.set(params.hemiSky)
    hemi.groundColor.set(params.hemiGround)
    hemi.intensity = params.hemiIntensity

    // derive land + published-water densities (see header). fogDensity is the
    // value water.js live-reads — it must stay the ATTENUATED one. kLand is
    // the world-space constant, verbatim — NO camera/dolly/viewport term.
    const kLand = params.fogDensityBase
    params.fogLandDensity = kLand
    params.fogDensity = kLand * params.fogWaterAtten
    fog.color.set(params.fogColor)
    fog.density = kLand
    if (scene) {
      scene.fog = fog
      if (scene.background && scene.background.isColor) scene.background.set(params.fogColor)
    }

    domeUniforms.uZenith.value.set(params.zenith)
    domeUniforms.uHorizon.value.set(params.horizon)
    domeUniforms.uFogColor.value.set(params.fogColor)
    domeUniforms.uCloudLit.value.set(params.cloudLit)
    domeUniforms.uCloudShadow.value.set(params.cloudShadow)
    domeUniforms.uSunTint.value.set(params.sunColor)
    domeUniforms.uCoverLow.value = params.cloudCoverLow
    domeUniforms.uCoverHigh.value = params.cloudCoverHigh
    domeUniforms.uCloudAmt.value = params.cloudAmount
    domeUniforms.uDrift.value = params.cloudDrift
    const w = params.windDeg * DEG
    // compass heading the clouds drift TOWARD: north = −Z, east = +X
    domeUniforms.uWind.value.set(Math.sin(w), -Math.cos(w))
  }
  params.apply = apply
  params.setSunAngles = (az, el) => {
    params.sunAzimuth = az
    params.sunElevation = el
    apply()
  }
  params.fitShadowTo = (x, z, extent) => {
    params.shadow.focusX = x
    params.shadow.focusZ = z
    if (extent) params.shadow.extent = extent
    fitShadow()
  }
  apply()

  // -------------------------------------------------------------------------
  // update(t) — cloud drift + a barely-there living light
  // -------------------------------------------------------------------------
  const baseAz = () => params.sunAzimuth
  function update(t) {
    domeUniforms.uTime.value = t

    if (params.lightDrift > 0) {
      const k = params.lightDrift
      sun.intensity =
        params.sunIntensity * (1 + Math.sin(t * 0.11) * params.breatheAmp * k)
      const sway = Math.sin((t / params.swayPeriod) * Math.PI * 2) * params.swayDeg * k
      sunDirFromAngles(baseAz() + sway, params.sunElevation, sunDir)
      domeUniforms.uSunDir.value.copy(sunDir)
      const s = params.shadow
      sun.position
        .copy(sunDir)
        .multiplyScalar(s.lightDist)
        .add(_tmpFocus.set(s.focusX, 10, s.focusZ))
    }
  }
  const _tmpFocus = new THREE.Vector3()

  return {
    object3D: group,
    sun,
    ambient: hemi, // bible §4: the hemisphere is the ambient; nothing else
    hemi,
    fog,
    sunDir, // unit vector toward the sun — consumed by water.js
    update,
    params,
  }
}
