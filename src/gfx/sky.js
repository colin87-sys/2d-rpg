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
 *   rig.fog      : the THREE.FogExp2 instance installed on the scene
 *   rig.params   : every number below, live; call params.apply() after edits.
 *
 * Art bible §4 numbers used verbatim:
 *   sun az/el 250°/58°  → dir (−0.498, +0.848, +0.181)   colour #fff1d0 @ 2.6
 *   hemisphere #b9cbd8 / #66744f @ 0.55
 *   fog #bcc8b2, exp2 k = 0.0072  (height falloff ref 8 m / 38 m is published
 *   in params for the custom water shaders; built-in FogExp2 has no height term)
 *   shadows: 2048², PCF-soft, bias −0.0006, normalBias 0.02, radius 4, ~140 m
 *   ortho box centred ahead of the boot camera, far 200.
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
    sunIntensity: 2.6,

    // hemisphere ("the" ambient — bible: no other ambient)
    hemiSky: '#b9cbd8',
    hemiGround: '#66744f',
    hemiIntensity: 0.55,

    // fog (exp2). Height-falloff terms are consumed by the custom water/sky
    // shaders; built-in FogExp2 cannot express them.
    fogColor: '#bcc8b2',
    fogDensity: 0.0072,
    fogHeightRef: 8,
    fogHeightFalloff: 38,

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

  const fog = new THREE.FogExp2(col(params.fogColor).getHex(), params.fogDensity)
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

    fog.color.set(params.fogColor)
    fog.density = params.fogDensity
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
