// Zard 假人：随服自启，WebSocket 接入，A* 寻路 + 先找武器再战斗
'use strict';
const WebSocket = require('ws');
const { MAP, RULES, DECOY, WEAPONS } = require('../config');
const { findPath, blockedAt, nearestWalkableWorld, clampGoal, clearLos, steerStep } = require('./nav');

const MAP_HALF = MAP.half - 1;
const SPEED = 5.55;             // 略低于真人满速，避免“滑行感”
const EYE_H = RULES.eyeH;
const TICK_MS = 66;
const GUN_RANGE = 28;
const MELEE_RANGE = 2.9;
const BOSS_MIN_DIST = 10;
const BOSS_MAX_DIST = 24;
const BOSS_FLEE_DIST = 16;
const BOSS_AIM_Y = 2.0;
const PICKUP_RANGE = 2.8;
const VIEW_RANGE = 18;
const WP_REACH = 1.8;
const REPATH_DIST = 5;
const STUCK_TICKS = 10;
const BURST_SHOTS_MIN = 1;
const BURST_SHOTS_MAX = 4;
const REACT_MS_MIN = 200;
const REACT_MS_MAX = 400;
const GROUND_REACT_MIN = 180;   // 地面受击也要愣一下，别秒转头开枪
const GROUND_REACT_MAX = 480;
const REVENGE_SHOTS = 2;
const REVENGE_MS = 3000;
const HEAD_Y = 1.55;
const HIGH_Y = 1.5;
const CHASE_MS = 12000;
const ATTACKER_RANGE = 48;
const LOOK_TURN = 0.14;         // 转头慢一点，像人手滑鼠标
const AIM_FIRE_DOT = 0.92;      // 准星大致对上才开枪（不完全锁死）


let ws = null;
let tickTimer = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let running = false;
let opts = {};

const state = {
  id: 0,
  alive: false,
  pos: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  hp: 100,
  hasGun: false,
  gunId: null,
  active: 'melee',
  ammo: 0,
  ammoReserve: 0,
  players: [],
  pickups: [],
  pickupDefs: [],
  boss: null,
  bossDefs: {},
  wanderTarget: null,
  wanderUntil: 0,
  relocateUntil: 0,
  burstShots: 0,
  nextFireAt: 0,
  nextMeleeAt: 0,
  wantFire: null,
  path: [],
  pathGoal: null,
  stuckTicks: 0,
  lastPosX: 0,
  lastPosZ: 0,
  lastHp: 100,
  reactUntil: 0,
  chaseUntil: 0,
  chasePlayerId: 0,
  revengeLock: false,
  revengeShotsLeft: 0,
  revengeUntil: 0,
  strafeSide: 1,
  strafeUntil: 0,
  // —— 拟人动作 ——
  combatStyle: 'strafe',       // strafe | peek | push | back
  combatStyleUntil: 0,
  burstLimit: 2,
  pauseUntil: 0,               // 短暂停顿（看路/犹豫）
  lookScanUntil: 0,
  lookScanYaw: 0,
  engageUntil: 0,              // 发现敌人后的反应延迟
  engageTargetId: 0,
  aimTx: 0,
  aimTy: 0,
  aimTz: 0,
  hasAim: false,
  jitterX: 0,
  jitterZ: 0,
  jitterUntil: 0,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function normalize(x, z) {
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function dist2d(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

function isArmed() {
  return state.hasGun && (state.ammo + state.ammoReserve > 0);
}

function isRelocating(now) {
  return now < state.relocateUntil;
}

function isReacting(now) {
  return now < state.reactUntil;
}

function findPlayerById(id) {
  return state.players.find(p => p.i === id && p.al === 1);
}

function getChasePlayer() {
  if (!state.chasePlayerId || Date.now() > state.chaseUntil) return null;
  const p = findPlayerById(state.chasePlayerId);
  if (!p || p.zg === 1) return null;
  return p;
}

function guessAttacker() {
  return nearestRealPlayer(ATTACKER_RANGE).player;
}

function isOnHighPlatform(player) {
  return !!player && (player.p[1] || 0) >= HIGH_Y;
}

function onPlayerHit(now, attackerId) {
  const attacker = (attackerId && findPlayerById(attackerId)) || guessAttacker();
  if (!attacker) return;

  state.burstShots = 0;
  state.wantFire = null;
  clearPath();

  // 没枪被打：不追人、不愣神，立刻继续找枪
  if (!isArmed()) {
    state.chasePlayerId = 0;
    state.chaseUntil = 0;
    clearRevenge();
    state.reactUntil = 0;
    state.relocateUntil = 0;
    return;
  }

  state.chasePlayerId = attacker.i;
  state.chaseUntil = now + CHASE_MS;
  state.relocateUntil = 0;

  // 高台锁头：自己有枪才触发
  if (isOnHighPlatform(attacker)) {
    const reactMs = REACT_MS_MIN + Math.random() * (REACT_MS_MAX - REACT_MS_MIN);
    state.reactUntil = now + reactMs;
    state.revengeLock = true;
    state.revengeShotsLeft = REVENGE_SHOTS;
    state.revengeUntil = now + REVENGE_MS;
    state.nextFireAt = now + reactMs;
  } else {
    // 地面被打：短硬直再追
    state.reactUntil = now + GROUND_REACT_MIN + Math.random() * (GROUND_REACT_MAX - GROUND_REACT_MIN);
    clearRevenge();
  }
}

function refreshCombatStyle(now) {
  if (now < state.combatStyleUntil) return;
  const styles = ['strafe', 'strafe', 'peek', 'push', 'back'];
  state.combatStyle = styles[(Math.random() * styles.length) | 0];
  state.combatStyleUntil = now + 1600 + Math.random() * 2800;
}

function refreshJitter(now) {
  if (now < state.jitterUntil) return;
  state.jitterX = (Math.random() - 0.5) * 2.4;
  state.jitterZ = (Math.random() - 0.5) * 2.4;
  state.jitterUntil = now + 400 + Math.random() * 900;
}

function maybeIdlePause(now) {
  if (now < state.pauseUntil) return true;
  if (Math.random() < 0.018) {
    state.pauseUntil = now + 350 + Math.random() * 900;
    state.lookScanYaw = state.yaw + (Math.random() - 0.5) * 1.4;
    state.lookScanUntil = state.pauseUntil;
    return true;
  }
  return now < state.pauseUntil;
}

function setAimPoint(tx, ty, tz) {
  state.aimTx = tx;
  state.aimTy = ty;
  state.aimTz = tz;
  state.hasAim = true;
}

function trackAim(now) {
  if (!state.hasAim) return;
  const aim = aimDir3(state.aimTx, state.aimTy, state.aimTz, 0);
  // 带一点过冲/滞后，不像每帧钉死
  const turn = LOOK_TURN * (0.85 + Math.random() * 0.35);
  state.yaw = lerpAngle(state.yaw, aim.yaw, turn);
  state.pitch = lerp(state.pitch, aim.pitch, turn * 0.9);
}

function aimAlignedEnough() {
  if (!state.hasAim) return true;
  const aim = aimDir3(state.aimTx, state.aimTy, state.aimTz, 0);
  const cur = {
    x: -Math.sin(state.yaw) * Math.cos(state.pitch),
    y: Math.sin(state.pitch),
    z: -Math.cos(state.yaw) * Math.cos(state.pitch),
  };
  const dot = cur.x * aim.d[0] + cur.y * aim.d[1] + cur.z * aim.d[2];
  return dot >= AIM_FIRE_DOT;
}

function humanAimErr(base) {
  // 偶尔明显打偏，平时也有手抖
  if (Math.random() < 0.12) return base + 0.18 + Math.random() * 0.2;
  return base + Math.random() * 0.08;
}

function clearRevenge() {
  state.revengeLock = false;
  state.revengeShotsLeft = 0;
  state.revengeUntil = 0;
}

/** 锁头是否仍有效：未打满 2 枪且未超时 */
function isRevengeActive(now) {
  if (!state.revengeLock) return false;
  if (now == null) now = Date.now();
  if (state.revengeShotsLeft <= 0 || now >= state.revengeUntil) {
    clearRevenge();
    return false;
  }
  return true;
}

function aimAtHead(enemy) {
  return {
    x: enemy.p[0],
    y: (enemy.p[1] || 0) + HEAD_Y,
    z: enemy.p[2],
  };
}

function faceTarget(tx, ty, tz) {
  const aim = aimDir3(tx, ty, tz, 0);
  state.yaw = aim.yaw;
  state.pitch = aim.pitch;
  return aim;
}

function bossDist() {
  if (!state.boss) return Infinity;
  return dist2d(state.pos.x, state.pos.z, state.boss.p[0], state.boss.p[2]);
}

function bossAimY() {
  if (!state.boss) return BOSS_AIM_Y;
  const def = state.bossDefs[state.boss.tp];
  return def?.yc ?? BOSS_AIM_Y;
}

function realPlayers() {
  return state.players.filter(p => p.i !== state.id && p.al === 1 && p.zg !== 1);
}

function nearestRealPlayer(maxDist) {
  let best = null;
  let bestDist = Infinity;
  for (const p of realPlayers()) {
    const d = dist2d(state.pos.x, state.pos.z, p.p[0], p.p[2]);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (maxDist !== undefined && bestDist > maxDist) return { player: null, dist: bestDist };
  return { player: best, dist: bestDist };
}

// 假人只在地面捡东西：高地/天台（含中央螺旋高台）不去爬，否则会贴墙卡死
function onGround(def) {
  if (!def) return false;
  if (def.platform || def.tower) return false;
  if ((def.y || 0) > 0.8) return false;
  return true;
}

function nearestPickup(filterFn) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < state.pickups.length; i++) {
    if (!state.pickups[i] || !state.pickupDefs[i]) continue;
    const def = state.pickupDefs[i];
    if (!onGround(def)) continue;
    if (blockedAt(def.x, def.z)) continue;
    if (filterFn && !filterFn(def, state.pickups[i])) continue;
    const d = dist2d(state.pos.x, state.pos.z, def.x, def.z);
    if (d < bestDist) {
      best = { index: i, x: def.x, z: def.z, cat: def.cat, item: state.pickups[i] };
      bestDist = d;
    }
  }
  return { pickup: best, dist: bestDist };
}

function pickNewRegion(now) {
  for (let i = 0; i < 16; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 22 + Math.random() * 28;
    const rawX = clamp(state.pos.x + Math.cos(angle) * dist, -MAP_HALF + 3, MAP_HALF - 3);
    const rawZ = clamp(state.pos.z + Math.sin(angle) * dist, -MAP_HALF + 3, MAP_HALF - 3);
    const spot = clampGoal(rawX, rawZ);
    if (!spot || blockedAt(spot.x, spot.z)) continue;
    state.wanderTarget = { x: spot.x, z: spot.z };
    state.wanderUntil = now + 5500 + Math.random() * 3500;
    state.relocateUntil = state.wanderUntil;
    state.burstShots = 0;
    clearPath();
    return state.wanderTarget;
  }
  const fallback = clampGoal(state.pos.x + 20, state.pos.z + 20) || { x: 30, z: 30 };
  state.wanderTarget = { x: fallback.x, z: fallback.z };
  state.wanderUntil = now + 5500 + Math.random() * 3500;
  state.relocateUntil = state.wanderUntil;
  state.burstShots = 0;
  clearPath();
  return state.wanderTarget;
}

function pickWanderTarget(now) {
  if (state.wanderTarget && now < state.wanderUntil) return state.wanderTarget;
  return pickNewRegion(now);
}

function nearestWeaponSpawn() {
  let best = null;
  let bestDist = Infinity;
  for (const def of state.pickupDefs) {
    if (def.cat !== 'wep' || !onGround(def)) continue;
    if (blockedAt(def.x, def.z)) continue;
    const d = dist2d(state.pos.x, state.pos.z, def.x, def.z);
    if (d < bestDist) { best = { x: def.x, z: def.z }; bestDist = d; }
  }
  return best;
}

function clearPath() {
  state.path = [];
  state.pathGoal = null;
}

function goalChanged(x, z) {
  if (!state.pathGoal) return true;
  return dist2d(x, z, state.pathGoal.x, state.pathGoal.z) > REPATH_DIST;
}

function setNavigateGoal(x, z, force) {
  if (!force && !goalChanged(x, z) && state.path.length) return;
  const goal = clampGoal(x, z) || nearestWalkableWorld(x, z);
  if (!goal) {
    startRelocate(Date.now());
    state.path = [];
    state.pathGoal = state.wanderTarget;
    return;
  }
  const path = findPath(state.pos.x, state.pos.z, goal.x, goal.z);
  if (path && path.length) {
    state.path = path;
    state.pathGoal = { x: goal.x, z: goal.z };
    return;
  }
  // 寻路失败：侧面绕行点再试，仍失败则换区
  const dx = goal.x - state.pos.x;
  const dz = goal.z - state.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const side = Math.random() < 0.5 ? 1 : -1;
  const bypass = clampGoal(
    state.pos.x + (-dz / len) * side * 12 + dx / len * 5,
    state.pos.z + (dx / len) * side * 12 + dz / len * 5,
  );
  if (bypass) {
    const alt = findPath(state.pos.x, state.pos.z, bypass.x, bypass.z);
    if (alt && alt.length) {
      state.path = alt;
      state.pathGoal = { x: bypass.x, z: bypass.z };
      return;
    }
  }
  startRelocate(Date.now());
  state.path = [];
  state.pathGoal = state.wanderTarget;
}

function nextWaypoint() {
  while (state.path.length) {
    const wp = state.path[0];
    if (dist2d(state.pos.x, state.pos.z, wp.x, wp.z) < WP_REACH) {
      state.path.shift();
      continue;
    }
    // 能直视更远路点就跳过中间点
    while (state.path.length >= 2) {
      const far = state.path[1];
      if (clearLos(state.pos.x, state.pos.z, far.x, far.z)) state.path.shift();
      else break;
    }
    return state.path[0];
  }
  return state.pathGoal;
}

function unstuckNudge(tx, tz) {
  const esc = nearestWalkableWorld(state.pos.x, state.pos.z);
  if (esc && dist2d(esc.x, esc.z, state.pos.x, state.pos.z) > 0.4) return esc;
  const open = clampGoal(tx, tz);
  if (open) return open;
  return { x: tx, z: tz };
}

function aimDir3(tx, ty, tz, err) {
  const ex = state.pos.x;
  const ey = state.pos.y + EYE_H;
  const ez = state.pos.z;
  const dx = tx - ex;
  const dy = ty - ey;
  const dz = tz - ez;
  const len = Math.hypot(dx, dy, dz) || 1;
  let nx = dx / len;
  let ny = dy / len;
  let nz = dz / len;
  if (err > 0) {
    nx += (Math.random() - 0.5) * err;
    ny += (Math.random() - 0.5) * err * 0.6;
    nz += (Math.random() - 0.5) * err;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;
  }
  return { d: [nx, ny, nz], pitch: Math.asin(clamp(ny, -1, 1)), yaw: Math.atan2(-nx, -nz) };
}

// 在瞄准方向上叠加当前枪械散布（准星不变，只有子弹偏）
function applyWeaponSpread(d) {
  const def = state.gunId && WEAPONS[state.gunId];
  const spread = def && def.spread != null ? def.spread : 0.02;
  if (!spread) return d;
  let x = d[0] + (Math.random() - 0.5) * spread * 2;
  let y = d[1] + (Math.random() - 0.5) * spread * 2;
  let z = d[2] + (Math.random() - 0.5) * spread * 2;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function ensureGun() {
  if (!state.hasGun) return false;
  if (state.active !== 'gun') {
    send({ type: 'switch', slot: 'gun' });
    return false;
  }
  return true;
}

function startRelocate(now) {
  pickNewRegion(now);
}

function fireAt(tx, ty, tz, err, now, intervalMin, intervalMax, opts = {}) {
  if (!isArmed() || now < state.nextFireAt) return false;
  setAimPoint(tx, ty, tz);
  // 准星还没跟上就先别开枪（锁头例外：允许更快）
  if (!opts.snapAim && !aimAlignedEnough()) {
    state.wantFire = { tx, ty, tz, err, intervalMin, intervalMax, opts };
    return false;
  }
  if (!ensureGun()) {
    state.wantFire = { tx, ty, tz, err, intervalMin, intervalMax, opts };
    return false;
  }
  state.wantFire = null;
  // 射击节奏加抖动，别像节拍器
  const pace = intervalMin + Math.random() * (intervalMax - intervalMin);
  state.nextFireAt = now + pace * (0.85 + Math.random() * 0.45);
  // 锁头必爆头：零散布、零手抖，准星钉头心
  const useErr = opts.perfectHS ? 0 : humanAimErr(err);
  const aim = aimDir3(tx, ty, tz, useErr);
  if (opts.snapAim || opts.perfectHS) {
    state.yaw = aim.yaw;
    state.pitch = aim.pitch;
  } else {
    state.yaw = lerpAngle(state.yaw, aim.yaw, 0.55);
    state.pitch = lerp(state.pitch, aim.pitch, 0.5);
  }
  let shotDir = aim.d;
  if (!opts.perfectHS && (opts.gunSpread || Math.random() < 0.75)) {
    shotDir = applyWeaponSpread(aim.d);
  }
  send({
    type: 'fire',
    o: [state.pos.x, state.pos.y + EYE_H, state.pos.z],
    d: shotDir,
  });
  if (isRevengeActive(now)) {
    state.revengeShotsLeft--;
    if (state.revengeShotsLeft <= 0) clearRevenge();
  } else {
    state.burstShots++;
    if (state.burstShots >= state.burstLimit) {
      state.burstShots = 0;
      state.burstLimit = BURST_SHOTS_MIN + ((Math.random() * (BURST_SHOTS_MAX - BURST_SHOTS_MIN + 1)) | 0);
      startRelocate(now);
    }
  }
  return true;
}

function meleeAt(tx, tz, now) {
  if (now < state.nextMeleeAt) return false;
  const dx = tx - state.pos.x;
  const dz = tz - state.pos.z;
  if (Math.hypot(dx, dz) > MELEE_RANGE) return false;
  state.nextMeleeAt = now + 1400 + Math.random() * 500;
  send({ type: 'switch', slot: 'melee' });
  send({ type: 'melee', d: [dx, 0, dz] });
  return true;
}

function fleeFromBoss() {
  const bx = state.boss.p[0];
  const bz = state.boss.p[2];
  const away = normalize(state.pos.x - bx, state.pos.z - bz);
  const raw = {
    x: clamp(state.pos.x + away.x * 22, -MAP_HALF, MAP_HALF),
    z: clamp(state.pos.z + away.z * 22, -MAP_HALF, MAP_HALF),
  };
  const spot = clampGoal(raw.x, raw.z) || raw;
  return { x: spot.x, z: spot.z, move: true };
}

function strafeNear(tx, tz, now) {
  refreshCombatStyle(now);
  refreshJitter(now);
  if (!now) now = Date.now();
  if (now >= state.strafeUntil) {
    state.strafeSide = Math.random() < 0.5 ? 1 : -1;
    state.strafeUntil = now + 1400 + Math.random() * 2200;
  }
  const dx = tx - state.pos.x;
  const dz = tz - state.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const side = state.strafeSide;
  const fx = dx / len, fz = dz / len;
  const sx = -dz / len, sz = dx / len;
  let mx = 0, mz = 0;
  const style = state.combatStyle;
  if (style === 'peek') {
    // 走走停停的探头：短侧移 + 偶尔站一下
    if (Math.random() < 0.28) {
      return { x: state.pos.x, z: state.pos.z, move: false, lookX: tx, lookZ: tz };
    }
    mx = sx * side * (2.2 + Math.random() * 2) + fx * 0.3;
    mz = sz * side * (2.2 + Math.random() * 2) + fz * 0.3;
  } else if (style === 'push') {
    mx = fx * (4 + Math.random() * 3) + sx * side * 1.5;
    mz = fz * (4 + Math.random() * 3) + sz * side * 1.5;
  } else if (style === 'back') {
    mx = -fx * (3 + Math.random() * 2.5) + sx * side * 2.5;
    mz = -fz * (3 + Math.random() * 2.5) + sz * side * 2.5;
  } else {
    // 不规则绕圈，加抖动
    mx = sx * side * (3.5 + Math.random() * 3) + fx * (0.2 + Math.random() * 1.2);
    mz = sz * side * (3.5 + Math.random() * 3) + fz * (0.2 + Math.random() * 1.2);
  }
  const raw = {
    x: clamp(state.pos.x + mx + state.jitterX, -MAP_HALF, MAP_HALF),
    z: clamp(state.pos.z + mz + state.jitterZ, -MAP_HALF, MAP_HALF),
  };
  const spot = clampGoal(raw.x, raw.z) || raw;
  return {
    x: spot.x,
    z: spot.z,
    move: true,
    lookX: tx,
    lookZ: tz,
  };
}

function attackBoss(now) {
  if (!state.boss || !isArmed() || isRelocating(now)) return null;
  const bx = state.boss.p[0];
  const bz = state.boss.p[2];
  const aimY = bossAimY();
  const dist = bossDist();

  if (dist >= BOSS_MIN_DIST && dist <= BOSS_MAX_DIST) {
    fireAt(bx, aimY, bz, 0.16, now, 850, 1550, { gunSpread: true });
    return strafeNear(bx, bz, now);
  }
  if (dist < BOSS_MIN_DIST && dist > 4) {
    return fleeFromBoss();
  }
  if (dist <= MELEE_RANGE + 1.2) {
    meleeAt(bx, bz, now);
    return fleeFromBoss();
  }
  return { x: bx, z: bz, move: true, lookX: bx, lookZ: bz };
}

function attackPlayer(enemy, dist, now) {
  if (enemy.zg === 1 || !isArmed() || isRelocating(now)) return null;
  const revenge = isRevengeActive(now);
  if (revenge) {
    const head = aimAtHead(enemy);
    setAimPoint(head.x, head.y, head.z);
    // 视野内：钉头心必爆头；出视野则先贴近再锁
    if (dist <= VIEW_RANGE) {
      fireAt(head.x, head.y, head.z, 0, now, 700, 1100, { perfectHS: true, snapAim: true });
      return { x: state.pos.x, z: state.pos.z, move: false, lookX: head.x, lookZ: head.z };
    }
    return { x: head.x, z: head.z, move: true, lookX: head.x, lookZ: head.z };
  }
  const ex = enemy.p[0];
  const ey = (enemy.p[1] || 0) + 1.05;
  const ez = enemy.p[2];
  setAimPoint(ex, ey, ez);
  const chasing = (() => {
    const c = getChasePlayer();
    return !!c && c.i === enemy.i;
  })();

  if (chasing) {
    fireAt(ex, ey, ez, 0.16, now, 720, 1600, { gunSpread: true });
    if (dist < GUN_RANGE) return strafeNear(ex, ez, now);
    // 追击时路线加点偏，别直线锁人
    refreshJitter(now);
    return {
      x: ex + state.jitterX * 1.5,
      z: ez + state.jitterZ * 1.5,
      move: true,
      lookX: ex,
      lookZ: ez,
    };
  }

  if (dist < GUN_RANGE) {
    fireAt(ex, ey, ez, 0.18, now, 800, 1500, { gunSpread: true });
    return strafeNear(ex, ez, now);
  }
  if (dist < MELEE_RANGE && Math.abs((enemy.p[1] || 0) - state.pos.y) < 1.8) {
    meleeAt(ex, ez, now);
    return strafeNear(ex, ez, now);
  }
  return { x: ex, z: ez, move: true, lookX: ex, lookZ: ez };
}

function decideTarget(now) {
  // 高台锁头优先：不受禁区撤离 / 卡住换位打断
  if (isRevengeActive(now) || (isReacting(now) && state.revengeLock)) {
    if (isReacting(now)) {
      const chase = getChasePlayer();
      if (chase) {
        const head = aimAtHead(chase);
        faceTarget(head.x, head.y, head.z);
      }
      return { freeze: true };
    }
    const chase = getChasePlayer();
    if (chase && isArmed()) {
      const pDist = dist2d(state.pos.x, state.pos.z, chase.p[0], chase.p[2]);
      const move = attackPlayer(chase, pDist, now);
      if (move) return move;
    }
  }

  // 有枪才进受击追击；没枪走后面的找枪逻辑
  const chaseHit = getChasePlayer();
  if (chaseHit && isArmed()) {
    const pDist = dist2d(state.pos.x, state.pos.z, chaseHit.p[0], chaseHit.p[2]);
    const move = attackPlayer(chaseHit, pDist, now);
    if (move) return move;
    return { x: chaseHit.p[0], z: chaseHit.p[2], move: true, lookX: chaseHit.p[0], lookZ: chaseHit.p[2] };
  }

  // 已误入中央高台禁区：先撤到最近可走点，避免贴墙卡死
  if (blockedAt(state.pos.x, state.pos.z)) {
    const esc = nearestWalkableWorld(state.pos.x, state.pos.z);
    if (esc) return { x: esc.x, z: esc.z, move: true };
  }

  // 受击硬直（仅高台锁头前仍可能走到这里）
  if (isReacting(now)) {
    return { freeze: true };
  }

  if (state.stuckTicks >= STUCK_TICKS) {
    startRelocate(now);
    return Object.assign(state.wanderTarget, { move: true });
  }

  if (isRelocating(now)) {
    if (maybeIdlePause(now)) {
      return { x: state.pos.x, z: state.pos.z, move: false };
    }
    return Object.assign(pickWanderTarget(now), { move: true });
  }

  if (!isArmed()) {
    const { pickup, dist } = nearestPickup(def => def.cat === 'wep');
    if (pickup) {
      // 到了也不秒捡，像反应慢半拍
      if (dist < PICKUP_RANGE) send({ type: 'pickup', id: pickup.index });
      return { x: pickup.x, z: pickup.z, move: true };
    }
    const spawn = nearestWeaponSpawn();
    if (spawn) return { x: spawn.x, z: spawn.z, move: true };
    if (maybeIdlePause(now)) return { x: state.pos.x, z: state.pos.z, move: false };
    return Object.assign(pickWanderTarget(now), { move: true });
  }

  const bDist = bossDist();
  if (state.boss && bDist < BOSS_FLEE_DIST) {
    return fleeFromBoss();
  }

  if (state.hp < 40) {
    const { pickup, dist } = nearestPickup((def, item) => def.cat === 'equip' && item === 'health');
    if (pickup && dist < 30) {
      if (dist < PICKUP_RANGE) send({ type: 'pickup', id: pickup.index });
      return { x: pickup.x, z: pickup.z, move: true };
    }
  }

  const { player, dist: pDist } = nearestRealPlayer(VIEW_RANGE);
  if (player && pDist < VIEW_RANGE) {
    // 发现敌人先愣一下再动手，别秒锁
    if (state.engageTargetId !== player.i || now > state.engageUntil) {
      if (state.engageTargetId !== player.i) {
        state.engageTargetId = player.i;
        state.engageUntil = now + 220 + Math.random() * 480;
        setAimPoint(player.p[0], (player.p[1] || 0) + 1.05, player.p[2]);
        return { x: state.pos.x, z: state.pos.z, move: false, lookX: player.p[0], lookZ: player.p[2] };
      }
    }
    if (now < state.engageUntil) {
      setAimPoint(player.p[0], (player.p[1] || 0) + 1.05, player.p[2]);
      return { x: state.pos.x, z: state.pos.z, move: Math.random() < 0.4, lookX: player.p[0], lookZ: player.p[2] };
    }
    const withBoss = !!state.boss;
    if (withBoss || Math.random() < DECOY.pvpAggro) {
      const move = attackPlayer(player, pDist, now);
      if (move) return move;
    }
  } else {
    state.engageTargetId = 0;
  }

  if (state.boss && state.alive) {
    const bossMove = attackBoss(now);
    if (bossMove) return bossMove;
  }

  if (Math.random() < 0.12) {
    const { pickup, dist } = nearestPickup(def => def.cat === 'equip' || def.cat === 'buff');
    if (pickup && dist < 22) {
      if (dist < PICKUP_RANGE) send({ type: 'pickup', id: pickup.index });
      return { x: pickup.x, z: pickup.z, move: true };
    }
  }

  if (maybeIdlePause(now)) return { x: state.pos.x, z: state.pos.z, move: false };
  return Object.assign(pickWanderTarget(now), { move: true });
}

function tick() {
  if (!running || !state.id || !state.alive) return;
  const now = Date.now();
  refreshCombatStyle(now);
  trackAim(now);

  if (isReacting(now)) {
    if (isRevengeActive(now) || state.hasAim) {
      const chase = getChasePlayer();
      if (chase) {
        const head = aimAtHead(chase);
        setAimPoint(head.x, head.y, head.z);
      }
    }
    // 硬直时也轻微转头，别完全僵住
    if (now < state.lookScanUntil) {
      state.yaw = lerpAngle(state.yaw, state.lookScanYaw, 0.08);
    }
    send({
      type: 'move',
      p: [Number(state.pos.x.toFixed(2)), state.pos.y, Number(state.pos.z.toFixed(2))],
      ya: Number(state.yaw.toFixed(4)),
      pi: Number(state.pitch.toFixed(4)),
      an: 0,
    });
    return;
  }

  if (state.wantFire && state.active === 'gun') {
    const w = state.wantFire;
    fireAt(w.tx, w.ty, w.tz, w.err, now, w.intervalMin, w.intervalMax, w.opts || {});
  }

  const prevX = state.lastPosX;
  const prevZ = state.lastPosZ;
  state.lastPosX = state.pos.x;
  state.lastPosZ = state.pos.z;

  const target = decideTarget(now);
  if (!target || target.freeze) return;

  if (target.move !== false) {
    const moved = dist2d(state.pos.x, state.pos.z, prevX, prevZ);
    if (moved < 0.05) state.stuckTicks++;
    else state.stuckTicks = 0;
  } else {
    state.stuckTicks = 0;
  }

  let moveX = target.x;
  let moveZ = target.z;

  if (target.move !== false) {
    setNavigateGoal(target.x, target.z, state.stuckTicks >= 6);
    const wp = nextWaypoint();
    if (wp) {
      moveX = wp.x;
      moveZ = wp.z;
    }
  } else if (target.lookX != null) {
    setAimPoint(target.lookX, state.aimTy || (state.pos.y + 1.05), target.lookZ);
  }

  if (state.stuckTicks >= 6) {
    const nudge = unstuckNudge(moveX, moveZ);
    moveX = nudge.x;
    moveZ = nudge.z;
  }

  const dir = normalize(moveX - state.pos.x, moveZ - state.pos.z);
  let targetYaw;
  if (target.lookX != null && target.lookZ != null) {
    targetYaw = Math.atan2(-(target.lookX - state.pos.x), -(target.lookZ - state.pos.z));
    setAimPoint(target.lookX, (state.hasAim ? state.aimTy : state.pos.y + 1.05), target.lookZ);
  } else if (now < state.lookScanUntil) {
    targetYaw = state.lookScanYaw;
  } else {
    targetYaw = Math.atan2(-dir.x, -dir.z);
  }
  state.yaw = lerpAngle(state.yaw, targetYaw, LOOK_TURN);

  const step = SPEED * (TICK_MS / 1000);
  const moving = target.move !== false && (Math.abs(dir.x) + Math.abs(dir.z) > 1e-4);
  let nextX = state.pos.x;
  let nextZ = state.pos.z;
  if (moving) {
    const steered = steerStep(state.pos.x, state.pos.z, moveX, moveZ, step);
    nextX = steered.x;
    nextZ = steered.z;
  }

  state.pos.x = nextX;
  state.pos.z = nextZ;

  send({
    type: 'move',
    p: [Number(nextX.toFixed(2)), state.pos.y, Number(nextZ.toFixed(2))],
    ya: Number(state.yaw.toFixed(4)),
    pi: Number(state.pitch.toFixed(4)),
    an: moving ? 1 : 0,
  });
}

function handleMessage(msg) {
  if (msg.type === 'defs') {
    if (msg.map) state.pickupDefs = msg.map.pickups || [];
    if (msg.bosses) state.bossDefs = msg.bosses;
    return;
  }
  if (msg.type === 'joined') {
    state.id = msg.id;
    state.alive = true;
    reconnectDelay = 3000;
    clearPath();
    state.burstShots = 0;
    state.burstLimit = BURST_SHOTS_MIN + ((Math.random() * (BURST_SHOTS_MAX - BURST_SHOTS_MIN + 1)) | 0);
    state.relocateUntil = 0;
    state.reactUntil = 0;
    state.chaseUntil = 0;
    state.chasePlayerId = 0;
    clearRevenge();
    state.strafeSide = 1;
    state.strafeUntil = 0;
    state.combatStyle = 'strafe';
    state.combatStyleUntil = 0;
    state.pauseUntil = 0;
    state.lookScanUntil = 0;
    state.engageUntil = 0;
    state.engageTargetId = 0;
    state.hasAim = false;
    state.lastHp = 100;
    return;
  }
  // 精确用 hit.by 锁定攻击者（含高台上的人）
  if (msg.type === 'fx' && msg.k === 'hit' && msg.tg === state.id && msg.by) {
    onPlayerHit(Date.now(), msg.by);
    return;
  }
  if (msg.type !== 'state') return;

  state.players = msg.pl || [];
  state.pickups = msg.pk || [];
  state.boss = msg.boss || null;

  const me = state.players.find(p => p.i === state.id);
  if (!me) return;

  state.pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
  state.alive = me.al === 1;
  state.hp = me.hp;
  if (state.alive && me.hp < state.lastHp) {
    // fx 已锁定攻击者时不再用「最近玩家」猜，避免打错人
    if (!getChasePlayer()) onPlayerHit(Date.now());
  }
  state.lastHp = me.hp;
  state.hasGun = Boolean(me.gw);
  state.gunId = me.gw || null;
  state.active = me.ac || 'melee';
  state.ammo = me.am || 0;
  state.ammoReserve = me.re || 0;
}

function connect() {
  if (!running) return;
  if (ws) {
    try { ws.close(); } catch (_) { /* 忽略 */ }
    ws = null;
  }

  const host = `ws://127.0.0.1:${opts.port}`;
  ws = new WebSocket(host);

  ws.on('open', () => {
    send({ type: 'join', name: opts.name || DECOY.name, npc: opts.token });
  });

  ws.on('message', data => {
    try { handleMessage(JSON.parse(data)); } catch (_) { /* 忽略 */ }
  });

  ws.on('close', () => {
    state.id = 0;
    state.alive = false;
    clearPath();
    if (running) scheduleReconnect();
  });

  ws.on('error', () => { /* close 会跟着触发 */ });
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!running) return;
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  }, reconnectDelay);
}

function start(options) {
  if (running) return;
  running = true;
  opts = options || {};
  reconnectDelay = 3000;
  connect();
  tickTimer = setInterval(tick, TICK_MS);
}

function stop() {
  running = false;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    try { ws.close(); } catch (_) { /* 忽略 */ }
    ws = null;
  }
  state.id = 0;
  clearPath();
}

module.exports = { start, stop, scheduleReconnect };
