// ---------------------------------------------------------------------------
// src/battle/choreo.js — the scripted demo loop and turn logic.
//
// Contract (docs/BATTLE_CONTRACT.md — frozen):
//   export function createChoreography({ units, vfx, timeline, panels, callouts }): Choreo
//   Choreo = { update(dt): void, state: 'idle'|'acting'|'frozen' }
//
// This module renders nothing. It is the conductor: it owns WHO acts WHEN,
// mutates battle state only through `units` methods and stat fields, awaits
// `vfx.cast` so beats sequence instead of racing, and drives the rail by
// writing `queueEta` (timeline reads it; 240 ms re-sort slides are its job).
//
// The demo loop (BATTLE_BIBLE §9), cycling ≈ every 9 s:
//   ready → banner → cast → hit react → damage numerals → queue re-sort
// with the enemy's showpiece — hall: Firaga on a party target (frame04's
// exact moment), highland: Stonera (frame05's banner) — every third beat,
// and party turns (strikes, Fira, Blue Flash, Cure) between, so stats drift
// believably for minutes without anyone dying: damage floors, cure pull-back,
// MP drains with fallbacks, limits creep toward full, the break gauge wanders.
//
// Boot state — hall (binding, the frame04 readout):
//   Rain 2938/204 · Lasswell 2508/327 with FULL limit · Fina 1507/324 ·
//   Lid 1982/313. units.js boots these very numbers; the choreographer
//   re-asserts them (write-if-different, so panels sees no boot delta) and is
//   the module responsible for them staying true at the capture instant.
// Boot state — highland: re-seeded to the frame05 readout (1292/116,
//   1126/133, 904/220, 810/117 with near-full bars via lowered maxima, the
//   two petrified Ø statuses on Fina and Lid, a bright break gauge), then the
//   panels transient (ghost/count-down/hairline flash from the delta) is aged
//   out with a few clamped panels.update pumps before the first real frame.
//
// ---------------------------------------------------------------------------
// ?freeze=<effect> — THE DETERMINISTIC CAPTURE (why this is watertight)
// ---------------------------------------------------------------------------
// The review loop screenshots `battle.html?freeze=firaga` at an arbitrary
// wall-time after `__POC.ready`. Every capture must land on the SAME battle
// instant — the Firaga burst peak — while torches, fog, flames and sparks
// keep their living motion. The reasoning, subsystem by subsystem:
//
//  1. vfx.cast(key, …, { freeze:true }) marks the instance frozen. In
//     vfx.update, a frozen instance clamps its local clock tl = def.hold
//     (firaga 0.52 s — full column, sparks mid-flight) on EVERY frame, so all
//     tl-driven envelopes (shells, streaks, ring, ground glow, light ≈ 51 of
//     60) are bit-identical each frame; only ctx.t-driven shimmer (light
//     jitter, scroll phase, throttled steady-state spark churn) lives on.
//     Passing freeze:true explicitly also covers alias params (?freeze=fira
//     resolves to key 'firaga'; vfx's own URL check would miss the alias).
//  2. A frozen cast's Promise NEVER resolves (the finish branch is shadowed
//     by the clamp), so nothing downstream of `await` can ever run — the
//     machine cannot advance past the burst by construction. In freeze mode
//     the async loop is not even started.
//  3. PRE-PUMP: choreo.update runs FIRST in main's frame order. On the first
//     update we call vfx.update(0.1) twelve times (dt is clamped to 0.1
//     inside vfx; camera is an optional, guarded argument), advancing the
//     effect clock past every def's hold (max 0.9) before the FIRST frame is
//     rendered. Even a capture of frame #1 shows the held peak — there is no
//     window where a shot could catch the windup. The §8 flash/shake fire at
//     tl ≈ 0.27 DURING the pump and their 0.11 s / 0.18 s envelopes expire
//     within it, so no capture is washed by the screen flash (the plate is
//     shot past the flash too).
//  4. Impact consequences are suppressed: no hp mutation (the four panels
//     hold the frame04 readout bit-exact), no damage numeral (frame04 shows
//     none), no hit anim, no reticle. The victim still overexposes toward
//     #ffc2a3 because that is the units module's live response to the frozen
//     spell light — state, not an event.
//  5. queueEta is re-pinned to the boot values every update, so the rail is
//     the plate's rail forever (Rain in the active seat, enemy markers
//     mid-rail). Timeline's own arrival flash/morph transients die within
//     0.24 s of boot; panels are static (the full-limit shimmer and flame
//     flicker are sanctioned living motion); callouts pins the banner open
//     under any ?freeze= (its own freezeSticky) — we announce once and hold.
//
// Net: for any capture time T ≥ first frame, the battle state is constant;
// only flame flutter, fog drift, spark churn phase and shimmer phase differ —
// exactly "torches and fog keep animating".
//
// No wall-clock timers anywhere (no setTimeout / performance.now): all
// sequencing derives from update(dt), so software-GL frame rates cannot
// desync beats from state. All collaborator calls are defensively guarded —
// a missing sibling degrades the demo, never throws mid-frame.
// ---------------------------------------------------------------------------

'use strict'

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// §9 beat timing (nominal seconds; a full turn beat ≈ 2.6–3.4 s)
const T_READY = 0.35        // turn start: step to ready, reticle on
const T_BANNER_LEAD = 0.20  // banner in before the cast anim starts
const T_CAST_ANIM = 0.90    // cast 6 f / 0.9 s (§9)
const T_CAST_VFX_AT = 0.54  // VFX fires at f4 of 6 (§9) → 4/6 × 0.9
const T_ATTACK_HIT = 0.28   // dash 180 ms + strike f1 → slash vfx launch
const T_ATTACK_SETTLE = 0.75 // §9: recoil hop 240 ms + walk back 320 ms + breath
const T_CAST_SETTLE = 0.35  // caster lowers arms after the decay
const T_ENEMY_SETTLE = 0.50 // the monster resettles its mass
const T_BEAT_GAP = 0.45     // breath between beats (idle anims keep running)
const T_BOOT_SETTLE = 0.55  // let the set fade in before the first beat

// nominal whole-beat durations for eta scheduling — the rail is a time ruler,
// so these track the ACTUAL beat lengths above (§9: a turn ≈ 2.6–3.4 s)
const DUR_ATTACK = 2.15
const DUR_CAST = 2.90
const DUR_ENEMY = 3.10

// stat-drift model (floors guarantee the demo can soak for minutes, no KOs)
const HP_FLOOR_FRAC = 0.28      // party hp never sinks below max(28 %, 520)
const HP_FLOOR_ABS = 520
const ENEMY_HP_FLOOR_FRAC = 0.42
const ENEMY_RAGE_REGEN = 260    // hp/turn once beaten toward its floor
const MP_FLOOR = 40             // casters fall back to attacks below this
const CRIT_CHANCE = 0.14
const CRIT_MULT = 1.55

// enemy break-gauge (panels reads enemy.limit) wander band per variant
const BREAK_BAND = { hall: [0.30, 0.78], highland: [0.40, 0.85] }
const BREAK_PER_HIT = 0.032     // + up to 0.03 jitter, party hits chip it
const BREAK_ENEMY_TURN = 0.09   // the monster steadies itself when it acts

// ?freeze= banner text (unknown params fall back to Capitalized token)
const SPELL_LABEL = {
  firaga: 'Firaga', fira: 'Fira', fire: 'Fire', firaja: 'Firaja',
  stonera: 'Stonera', stone: 'Stone', stonega: 'Stonega', quake: 'Quake',
  cure: 'Cure', cura: 'Cura', curaga: 'Curaga', heal: 'Cure',
  slash: 'Attack', attack: 'Attack',
}

// The frame04 readout — BINDING for the hall capture (BATTLE_CONTRACT).
// eta values reproduce the plate's rail (Rain active, cluster mid-rail,
// enemy markers at x ≈ 0.45 fw). Matches units.js BOOT_STATS by design;
// choreo re-asserts so the capture cannot drift even if boots diverge.
const FRAME04_BOOT = {
  rain:     { hp: 2938, hpMax: 3150, mp: 204, mpMax: 238, limit: 0.34, eta: 0.0 },
  lasswell: { hp: 2508, hpMax: 2680, mp: 327, mpMax: 402, limit: 1.00, eta: 6.6 },
  fina:     { hp: 1507, hpMax: 2440, mp: 324, mpMax: 458, limit: 0.18, eta: 7.4 },
  lid:      { hp: 1982, hpMax: 2560, mp: 313, mpMax: 396, limit: 0.52, eta: 8.1 },
  enemy:    { eta: 5.9 },
}

// The frame05 readout — highland boot. The plate's party is battle-worn with
// NEAR-FULL bars (different, smaller-statured roster), so maxima come down
// with the values; two Ø (stone) diamonds sit at Fina's and Lid's feet, and
// the sorcerer's HP / break bars read bright. Limits are thin per the plate.
const FRAME05_BOOT = {
  rain:     { hp: 1292, hpMax: 1470, mp: 116, mpMax: 141, limit: 0.30, statuses: [] },
  lasswell: { hp: 1126, hpMax: 1280, mp: 133, mpMax: 162, limit: 0.22, statuses: [] },
  fina:     { hp: 904,  hpMax: 1030, mp: 220, mpMax: 268, limit: 0.10, statuses: ['stone'] },
  lid:      { hp: 810,  hpMax: 930,  mp: 117, mpMax: 143, limit: 0.38, statuses: ['stone'] },
  enemy:    { hpFrac: 0.93, limit: 0.80 },
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** Deterministic RNG — the drift is identical run to run (review stability). */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function labelFor(key) {
  const k = String(key || '').toLowerCase()
  if (SPELL_LABEL[k]) return SPELL_LABEL[k]
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Firaga'
}

// ---------------------------------------------------------------------------
// createChoreography
// ---------------------------------------------------------------------------

export function createChoreography({ units, vfx, timeline, panels, callouts } = {}) {
  void timeline // read-model collaborator: it consumes queueEta; nothing to call

  const rnd = mulberry32(0x9a17c3)

  // ---- collaborator shims (never throw mid-frame) -------------------------
  const U = {
    get(id) { try { return units && units.get ? units.get(id) : null } catch (_) { return null } },
    enemy() { return (units && units.enemy) || null },
    roster() { return (units && units.roster) || [] },
    play(id, name, opts) { try { if (units && units.playAnim) units.playAnim(id, name, opts) } catch (_) { /* demo survives */ } },
  }
  const C = {
    announce(text) { try { if (callouts && callouts.announce) callouts.announce(text) } catch (_) {} },
    number(id, v, kind) { try { if (callouts && callouts.number) callouts.number(id, v, kind) } catch (_) {} },
    reticle(id) { try { if (callouts && callouts.reticle) callouts.reticle(id) } catch (_) {} },
    status(id) { try { if (callouts && callouts.status) callouts.status(id) } catch (_) {} },
  }

  // ---- variant ------------------------------------------------------------
  // The enemy id is ground truth (units placed a sorcerer ⇒ highland set);
  // the URL is the fallback when units is absent.
  let variant = 'hall'
  const en = U.enemy()
  if (en && en.id === 'sorcerer') variant = 'highland'
  else if (!en) {
    try {
      if (/[?&]variant=highland/.test(String(window.location.search || ''))) variant = 'highland'
    } catch (_) { /* keep hall */ }
  }
  const isHall = variant === 'hall'
  const enemyId = en ? en.id : 'enemy'
  const showpiece = isHall ? 'firaga' : 'stonera' // frame04 / frame05 banners

  // ---- ?freeze= detection -------------------------------------------------
  let freezeKey = null
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.has('freeze')) freezeKey = String(q.get('freeze') || '').toLowerCase().trim() || 'firaga'
  } catch (_) { freezeKey = null }

  // ---- dt-driven clock + waits (the only scheduler in this module) --------
  let now = 0
  let waits = [] // { at, resolve }
  function waitS(s) {
    return new Promise((resolve) => { waits.push({ at: now + Math.max(0, s), resolve }) })
  }
  function pumpWaits() {
    if (!waits.length) return
    const due = []
    const keep = []
    for (const w of waits) (now >= w.at ? due : keep).push(w)
    if (due.length) {
      waits = keep
      due.sort((a, b) => a.at - b.at)
      for (const w of due) w.resolve()
    }
  }

  // ---- state ---------------------------------------------------------------
  let state = 'idle'          // 'idle' | 'acting' | 'frozen' (contract)
  let started = false
  let currentActor = null     // id whose eta is pinned to 0 while acting
  let beatCount = 0
  const pinnedEta = {}        // freeze: the plate's rail, forever

  // ------------------------------------------------------------------------
  // Boot seeding
  // ------------------------------------------------------------------------

  /** Write a stat only when different — panels' delta detection sees nothing
   *  on an equal write, so the hall re-assert is invisible by construction. */
  function setStat(u, key, v) {
    if (u && v != null && u[key] !== v) u[key] = v
  }

  function assertHallBoot() {
    for (const id of ['rain', 'lasswell', 'fina', 'lid']) {
      const b = FRAME04_BOOT[id]
      const u = U.get(id)
      if (!u) continue
      setStat(u, 'hp', b.hp); setStat(u, 'hpMax', b.hpMax)
      setStat(u, 'mp', b.mp); setStat(u, 'mpMax', b.mpMax)
      setStat(u, 'limit', b.limit)
      setStat(u, 'queueEta', b.eta)
    }
    const e = U.enemy()
    if (e) setStat(e, 'queueEta', FRAME04_BOOT.enemy.eta)
  }

  function seedHighlandBoot() {
    for (const id of ['rain', 'lasswell', 'fina', 'lid']) {
      const b = FRAME05_BOOT[id]
      const u = U.get(id)
      if (!u) continue
      setStat(u, 'hpMax', b.hpMax); setStat(u, 'hp', b.hp)
      setStat(u, 'mpMax', b.mpMax); setStat(u, 'mp', b.mp)
      setStat(u, 'limit', b.limit)
      if (b.statuses && b.statuses.length && u.statuses && u.statuses.length === 0) {
        for (const s of b.statuses) u.statuses.push(s)
        C.status(id) // pop the newest icon; the per-frame sync keeps it anyway
      }
    }
    const e = U.enemy()
    if (e) {
      setStat(e, 'hp', Math.round((e.hpMax || 74000) * FRAME05_BOOT.enemy.hpFrac))
      setStat(e, 'limit', FRAME05_BOOT.enemy.limit)
    }
    // The panels module snapshotted its prev-stats at construction (before
    // choreo exists), so the seed above registers as damage: ghost 400 ms,
    // count-down 350 ms, hairline flash 300 ms. Age all three out NOW —
    // panels clamps dt to 0.1 per call — so the first rendered highland
    // frame is clean, settled, plate-like.
    try {
      if (panels && panels.update) for (let i = 0; i < 6; i++) panels.update(0.1)
    } catch (_) { /* worst case: a 0.4 s boot transient */ }
  }

  // ------------------------------------------------------------------------
  // FREEZE MODE — everything here is reasoned through in the header comment
  // ------------------------------------------------------------------------

  function enterFreeze() {
    state = 'frozen'

    // 1) the plate's readout at the capture instant, bit-exact
    if (isHall) assertHallBoot()
    else seedHighlandBoot()

    // 2) pin the rail: snapshot every eta as it stands (hall = frame04's)
    for (const u of U.roster()) pinnedEta[u.id] = u.queueEta
    const e = U.enemy()
    if (e) pinnedEta[e.id] = e.queueEta

    // 3) the banner, pinned open by callouts' own ?freeze= sticky hold
    C.announce(labelFor(freezeKey))
    C.reticle(null) // the plate shows no reticle — the burst owns the frame

    // 4) the held cast: enemy → Rain (the plate's victim; vfx's own fallback
    //    anchor is Rain's §1 feet). freeze:true survives alias params. The
    //    promise never resolves — deliberately unawaited, the hold IS the
    //    state. No onImpact: stats, numerals and poses must not move.
    if (vfx && vfx.cast) {
      try {
        const p = vfx.cast(freezeKey, enemyId, 'rain', { freeze: true })
        if (p && p.catch) p.catch(() => {}) // defensive; cast never rejects
      } catch (_) { /* a missing effect must not take the capture down */ }
    }

    // 5) pre-pump the effect clock past every def's hold (max 0.9 s) so the
    //    FIRST rendered frame is already the held peak, and the §8
    //    flash/shake envelopes (fired mid-pump) are spent before any capture.
    //    vfx.update clamps dt to 0.1 and guards its optional camera argument.
    try {
      if (vfx && vfx.update) for (let i = 0; i < 12; i++) vfx.update(0.1)
    } catch (_) { /* degrade: the hold is still reached in ≤ 1 s of real frames */ }
  }

  function updateFrozen() {
    // Re-pin every eta each frame: nothing may drift the plate's rail.
    for (const u of U.roster()) if (pinnedEta[u.id] != null) u.queueEta = pinnedEta[u.id]
    const e = U.enemy()
    if (e && pinnedEta[e.id] != null) e.queueEta = pinnedEta[e.id]
  }

  // ------------------------------------------------------------------------
  // LIVE MODE — the ~9 s demo cycle
  // ------------------------------------------------------------------------

  // Beat rotation: enemy showpiece after every 2 party beats ([P,P,E] ≈
  // 2.45+2.85+3.45 + 3 gaps ≈ 9.6 s — "cycling about every 9 s"). The boot
  // order honours the boot rail (hall: Rain at eta 0 acts first, the enemy
  // next in from 5.9; highland: the sorcerer opens with the frame05 banner).
  const partyOrder = isHall ? ['rain', 'lasswell', 'fina', 'lid'] : ['rain', 'lasswell']
  // (highland: Fina and Lid are petrified — they hold their slots on the rail
  //  but skip their beats, like the plate's Ø-marked pair)
  let partyIx = 0
  let sincePartyBeats = isHall ? 0 : 2 // highland: enemy leads immediately
  const bootLead = isHall // hall: rain → ENEMY → steady [P,P,E]

  function nextActorId(advance) {
    // Steady pattern: P P E P P E …  (hall boot special-cases to P E, so the
    // dragon's first Firaga lands ≈ t+6 s, echoing the plate's fresh burst.)
    const enemyDue = sincePartyBeats >= (bootLead && beatCount < 2 ? 1 : 2)
    if (enemyDue) {
      if (advance) sincePartyBeats = 0
      return enemyId
    }
    const id = partyOrder.length ? partyOrder[partyIx % partyOrder.length] : null
    if (advance) { partyIx++; sincePartyBeats++ }
    return id
  }

  /** Pure lookahead over the rotation → seconds until each unit next acts.
   *  Written into queueEta at every re-sort; the timeline slides (240 ms). */
  function reseedEtas() {
    let ix = partyIx
    let since = sincePartyBeats
    let bc = beatCount
    let tAcc = T_BEAT_GAP
    const eta = {}
    const need = new Set(partyOrder)
    need.add(enemyId)
    for (let step = 0; step < 16 && need.size; step++) {
      let id
      const enemyDue = since >= (bootLead && bc < 2 ? 1 : 2)
      if (enemyDue) { id = enemyId; since = 0 } else {
        id = partyOrder.length ? partyOrder[ix % partyOrder.length] : enemyId
        ix++; since++
      }
      bc++
      if (need.has(id)) { eta[id] = tAcc; need.delete(id) }
      tAcc += (id === enemyId ? DUR_ENEMY : id === 'fina' ? DUR_CAST : DUR_ATTACK) + T_BEAT_GAP
    }
    for (const u of U.roster()) {
      if (u.id === currentActor) continue
      if (eta[u.id] != null) u.queueEta = eta[u.id]
      else u.queueEta = Math.max(u.queueEta, 6.5 + rnd() * 3) // petrified: park deep
    }
    const e = U.enemy()
    if (e && eta[e.id] != null) e.queueEta = eta[e.id]
  }

  /** Continuous drift between re-sorts: the rail is a time ruler. The actor
   *  sits at the head; everyone else slides toward it in real seconds. */
  function driftEtas(dt) {
    for (const u of U.roster()) {
      if (u.id === currentActor) { u.queueEta = 0; continue }
      u.queueEta = Math.max(0.12, u.queueEta - dt)
    }
    const e = U.enemy()
    if (e && e.id !== currentActor) e.queueEta = Math.max(0.1, e.queueEta - dt)
    else if (e) e.queueEta = 0
  }

  // ---- stat mutations (the only writers besides boot seeding) -------------

  function partyFloor(u) { return Math.max(Math.round(u.hpMax * HP_FLOOR_FRAC), Math.min(HP_FLOOR_ABS, u.hpMax - 1)) }

  function hurtParty(victimId, dmg, crit) {
    const u = U.get(victimId)
    if (!u) return
    u.hp = clamp(Math.round(u.hp - dmg), partyFloor(u), u.hpMax)
    u.limit = clamp(u.limit + 0.10 + rnd() * 0.10, 0, 1) // being hit charges it
    U.play(victimId, 'hit') // §9: 2×60 ms flash, −0.35 m recoil, settle
    C.number(victimId, dmg, crit ? 'crit' : 'damage')
  }

  function hurtEnemy(dmg, crit) {
    const e = U.enemy()
    if (!e) return
    const floor = Math.round(e.hpMax * ENEMY_HP_FLOOR_FRAC)
    e.hp = clamp(Math.round(e.hp - dmg), floor, e.hpMax)
    const band = BREAK_BAND[variant] || BREAK_BAND.hall
    e.limit = clamp(e.limit - (BREAK_PER_HIT + rnd() * 0.03), band[0], band[1])
    U.play(e.id, 'hit') // 60 ms white flash + 0.15 m recoil (§6)
    C.number(e.id, dmg, crit ? 'crit' : 'damage')
  }

  function healParty(targetId, amount) {
    const u = U.get(targetId)
    if (!u) return
    u.hp = clamp(Math.round(u.hp + amount), 0, u.hpMax)
    C.number(targetId, amount, 'heal')
  }

  function lowestAlly() {
    let best = null
    let bestFrac = 1
    for (const u of U.roster()) {
      if (u.alive === false) continue
      const f = u.hpMax > 0 ? u.hp / u.hpMax : 1
      if (f < bestFrac) { bestFrac = f; best = u }
    }
    return bestFrac < 0.92 ? best : null
  }

  function roll(lo, hi) { return lo + rnd() * (hi - lo) }
  function rollCrit() { return rnd() < CRIT_CHANCE }

  // ---- cast wrapper: awaitable even with a missing/broken vfx -------------
  function safeCast(name, casterId, targetId, onImpact) {
    if (vfx && vfx.cast) {
      try {
        const p = vfx.cast(name, casterId, targetId, { onImpact })
        if (p && p.then) return p
      } catch (_) { /* fall through to the timed stand-in */ }
    }
    // Stand-in beat: impact at the §9 hit-react moment, resolve after decay.
    return (async () => {
      await waitS(0.35)
      if (onImpact) onImpact()
      await waitS(0.9)
    })()
  }

  /** Impact bookkeeping: vfx calls onImpact exactly once mid-effect; the
   *  post-await apply is belt-and-braces should an effect ever skip it. */
  function impactOnce(fn) {
    let done = false
    const fire = () => { if (!done) { done = true; fn() } }
    fire.ensure = fire
    return fire
  }

  // ---- the beats ----------------------------------------------------------

  const victimRotation = isHall ? ['rain', 'lasswell', 'lid', 'fina'] : ['lasswell', 'rain']
  let victimIx = 0
  function nextVictim() {
    for (let i = 0; i < victimRotation.length; i++) {
      const id = victimRotation[victimIx % victimRotation.length]
      victimIx++
      const u = U.get(id)
      if (u && u.alive !== false) return id
    }
    return 'rain'
  }

  /** ENEMY SHOWPIECE — the assigned loop: ready → banner → cast firaga (hall)
   *  / stonera (highland) on a party target → hit react → numeral → re-sort. */
  async function enemyBeat() {
    const e = U.enemy()
    if (!e) return
    const victimId = nextVictim()
    // rage regen once beaten low — the soak never runs the monster dry
    if (e.hp < e.hpMax * (ENEMY_HP_FLOOR_FRAC + 0.06)) e.hp = Math.min(e.hpMax, e.hp + ENEMY_RAGE_REGEN)
    const band = BREAK_BAND[variant] || BREAK_BAND.hall
    e.limit = clamp(e.limit + BREAK_ENEMY_TURN, band[0], band[1])

    await waitS(T_READY)                       // its markers kiss the rail head
    C.announce(labelFor(showpiece))            // frame04 'Firaga' / frame05 'Stonera'
    await waitS(T_BANNER_LEAD)
    U.play(enemyId, 'cast')                    // §6 procedural lunge, 0.9 s
    await waitS(T_CAST_VFX_AT)                 // §9: VFX fires at f4

    const dmg = Math.round(roll(430, 640) * (isHall ? 1 : 0.55)) // highland party is smaller
    const crit = rollCrit()
    const total = Math.round(dmg * (crit ? CRIT_MULT : 1))
    const impact = impactOnce(() => hurtParty(victimId, total, crit))
    await safeCast(showpiece, enemyId, victimId, impact)
    impact.ensure()                            // idempotent
    await waitS(T_ENEMY_SETTLE)                // the wall of painting resettles
  }

  /** Party melee: dash-in is the units module's own attack lunge; the slash
   *  rig bites at the strike frame; the monster flashes and recoils. */
  async function strikeBeat(actorId, opts) {
    const named = opts && opts.banner
    await waitS(T_READY)
    U.play(actorId, 'ready')
    C.reticle(enemyId)
    if (named) {
      C.announce(named)
      await waitS(T_BANNER_LEAD)
    } else {
      await waitS(0.12)
    }
    U.play(actorId, 'attack')
    await waitS(T_ATTACK_HIT)

    const base = roll(700, 1300) * (opts && opts.power ? opts.power : 1)
    const crit = rollCrit()
    const total = Math.round(base * (crit ? CRIT_MULT : 1))
    const impact = impactOnce(() => hurtEnemy(total, crit))
    await safeCast('slash', actorId, enemyId, impact)
    impact.ensure()
    if (opts && opts.mp) {
      const u = U.get(actorId)
      if (u) u.mp = Math.max(MP_FLOOR, u.mp - opts.mp)
    }
    C.reticle(null)
    await waitS(T_ATTACK_SETTLE) // §9: recoil hop → walk back, ease-in-out
  }

  /** Party offensive magic — Rain lobbing Fira back across the duel line
   *  (same firaga family; its light spill repaints the monster). */
  async function spellBeat(actorId, spellKey, label, mpCost) {
    await waitS(T_READY)
    U.play(actorId, 'ready')
    C.reticle(enemyId)
    C.announce(label)
    await waitS(T_BANNER_LEAD)
    U.play(actorId, 'cast')
    await waitS(T_CAST_VFX_AT)

    const crit = rollCrit()
    const total = Math.round(roll(1450, 2050) * (crit ? CRIT_MULT : 1))
    const impact = impactOnce(() => hurtEnemy(total, crit))
    await safeCast(spellKey, actorId, enemyId, impact)
    impact.ensure()
    const u = U.get(actorId)
    if (u) u.mp = Math.max(MP_FLOOR, u.mp - mpCost)
    C.reticle(null)
    await waitS(T_CAST_SETTLE)
  }

  /** Fina's Cure on the most-wounded ally — the green ghost + heal numeral
   *  that pulls the drift back so the loop breathes instead of bleeding out. */
  async function cureBeat(actorId, targetId) {
    await waitS(T_READY)
    U.play(actorId, 'ready')
    C.reticle(targetId)
    C.announce('Cure')
    await waitS(T_BANNER_LEAD)
    U.play(actorId, 'cast')
    await waitS(T_CAST_VFX_AT)

    const target = U.get(targetId)
    const missing = target ? target.hpMax - target.hp : 0
    const amount = Math.min(missing, Math.round(roll(350, 520) * (isHall ? 1 : 0.55)))
    const impact = impactOnce(() => healParty(targetId, amount))
    await safeCast('cure', actorId, targetId, impact)
    impact.ensure()
    const u = U.get(actorId)
    if (u) u.mp = Math.max(MP_FLOOR, u.mp - 32)
    C.reticle(null)
    await waitS(T_CAST_SETTLE)
  }

  /** Dispatch one party member's turn with per-character flavour + fallbacks. */
  async function partyBeat(actorId) {
    const u = U.get(actorId)
    if (!u || u.alive === false) return
    u.limit = clamp(u.limit + 0.035, 0, 1) // acting charges a sliver too

    if (actorId === 'fina') {
      const target = lowestAlly()
      if (target && u.mp > MP_FLOOR + 20) return cureBeat(actorId, target.id)
      return strikeBeat(actorId, { power: 0.6 })
    }
    if (actorId === 'rain') {
      const wantSpell = beatCount % 4 === 2 && u.mp > MP_FLOOR + 20
      if (wantSpell) return spellBeat(actorId, 'fira', 'Fira', 24)
      return strikeBeat(actorId)
    }
    if (actorId === 'lasswell') {
      const flashy = beatCount % 4 === 3 && u.mp > MP_FLOOR + 10
      if (flashy) return strikeBeat(actorId, { banner: 'Blue Flash', power: 1.25, mp: 12 })
      return strikeBeat(actorId)
    }
    return strikeBeat(actorId) // lid: wrench work
  }

  // ---- the loop -----------------------------------------------------------

  async function runLoop() {
    await waitS(T_BOOT_SETTLE)
    // Soak forever; every beat is dt-driven and every await resolves in live
    // mode (vfx falls unknown effects back to a resolving slash).
    for (;;) {
      const actorId = nextActorId(true)
      beatCount++
      if (!actorId) { await waitS(1); continue }
      currentActor = actorId
      state = 'acting'
      try {
        if (actorId === enemyId) await enemyBeat()
        else await partyBeat(actorId)
      } catch (_) {
        // A collaborator hiccup skips the beat, never kills the conductor.
      }
      currentActor = null
      state = 'idle'
      reseedEtas()            // §7.1: entries slide to new x over 240 ms
      await waitS(T_BEAT_GAP + rnd() * 0.30)
    }
  }

  // ------------------------------------------------------------------------
  // update(dt) — main calls this FIRST each frame (before units/vfx/UI)
  // ------------------------------------------------------------------------

  function update(dt) {
    dt = typeof dt === 'number' && isFinite(dt) ? clamp(dt, 0, 0.25) : 1 / 60

    if (!started) {
      started = true
      if (freezeKey != null) {
        enterFreeze()          // synchronous: frame #1 already holds the peak
      } else {
        if (isHall) assertHallBoot()
        else seedHighlandBoot()
        runLoop()              // detached; sequenced purely by waitS/cast
      }
    }

    if (state === 'frozen') {
      updateFrozen()
      return                   // no clock: nothing may ever advance
    }

    now += dt
    driftEtas(dt)
    pumpWaits()
  }

  return {
    update,
    get state() { return state },
    // additive, non-contract (UI/main may ignore): handy for integrator logs
    meta: { variant, get beat() { return beatCount }, get frozen() { return state === 'frozen' } },
  }
}
