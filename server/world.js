// 权威游戏世界：所有伤害/拾取/购买/BOSS/油桶均在服务端判定，客户端只上报输入与位置
'use strict';
const { MAP, WEAPONS, EQUIPS, BUFFS, PICKUP_POOLS, BOSS, BOSSES, SHOP, RULES, DECOY, EGG_AUTH } = require('./config');
const board = require('./leaderboard');
const login = require('./login');
const { containsProfanity } = require('./chatfilter');
const chatlog = require('./chatlog');
const { normalizeIp } = require('./iputil');

const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100;
const r5 = v => Math.round(v * 100000) / 100000;

const COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d', '#63e6e2', '#f783ac', '#a9e34b', '#748ffc', '#ff8787', '#66d9e8'];
const CHEAT_SPEED_MUL = 3;
const CHAT_ABUSE_BAN_MIN = 30;
const PROJ_KIND = { fire: 0, bullet: 1, orb: 2 };
const NADE_KIND = { frag: 0, flash: 1, smoke: 2 };

// 静态障碍物 AABB，用于子弹遮挡与 BOSS 碰撞（油桶单独作为动态实体）
const OBS = MAP.obstacles.map(o => ({
  minx: o.x - o.w / 2, maxx: o.x + o.w / 2, minz: o.z - o.d / 2, maxz: o.z + o.d / 2, miny: 0, maxy: o.h,
}));

function rayAABB(o, d, b) { // 返回进入距离 t，未命中返回 null（d 需归一化）
  let tmin = 0, tmax = Infinity;
  const axes = [['x', b.minx, b.maxx], ['y', b.miny, b.maxy], ['z', b.minz, b.maxz]];
  for (const [ax, mn, mx] of axes) {
    const ro = o[ax], rd = d[ax];
    if (Math.abs(rd) < 1e-9) { if (ro < mn || ro > mx) return null; continue; }
    let t1 = (mn - ro) / rd, t2 = (mx - ro) / rd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
function spreadDir(d, spread) {
  if (!spread) return { x: d.x, y: d.y, z: d.z };
  let x = d.x + (Math.random() - 0.5) * spread * 2;
  let y = d.y + (Math.random() - 0.5) * spread * 2;
  let z = d.z + (Math.random() - 0.5) * spread * 2;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}
function barrelBox(b) {
  const r = MAP.barrelR;
  return { minx: b.x - r, maxx: b.x + r, minz: b.z - r, maxz: b.z + r, miny: 0, maxy: MAP.barrelH };
}
// 圆（半径 r）与 AABB 的水平推挤，用于 BOSS 移动
function circlePushBoxes(pos, r, boxes) {
  for (const b of boxes) {
    const cx = clamp(pos.x, b.minx, b.maxx), cz = clamp(pos.z, b.minz, b.maxz);
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r && d2 > 1e-9) {
      const dd = Math.sqrt(d2), push = (r - dd) / dd;
      pos.x += dx * push; pos.z += dz * push;
    } else if (d2 <= 1e-9) { pos.x = b.maxx + r; }
  }
  const lim = MAP.half - r;
  pos.x = clamp(pos.x, -lim, lim); pos.z = clamp(pos.z, -lim, lim);
}

class World {
  constructor(broadcast, sendTo, ac) {
    this.broadcast = broadcast;
    this.sendTo = sendTo;
    this.ac = ac;                 // 反作弊引擎（见 server/anticheat/）
    this.players = new Map();
    this.nextId = 1;
    this.pickups = MAP.pickups.map(def => ({ def, item: null, avail: true, respawnAt: 0 }));
    for (const pk of this.pickups) pk.item = this.rollPickupItem(pk);
    this.barrels = MAP.barrels.map((b, i) => ({ id: i, x: b.x, z: b.z, hp: RULES.barrelHp, alive: true, respawnAt: 0 }));
    this.boss = null;
    this.nextBossAt = now() + BOSS.firstDelay * 1000;
    this.forceBossType = null; // 聊天指令指定下一次 spawnBoss 类型（如 'amiya'）
    this.projs = [];         // {id, kind, pos, vel, dmg, born, targetId?, bossName}
    this.blasts = [];        // 巫妖延迟爆破 {pos, at, dmg, r, bossName}
    this.grenades = [];
    this.unseenHands = [];   // amiya：不可视之手
    this.entId = 1;
  }

  // 射线被障碍物/存活油桶挡住的最近距离
  obstacleBlock(o, d, maxT) {
    let t = maxT;
    for (const b of OBS) { const h = rayAABB(o, d, b); if (h !== null && h < t) t = h; }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const h = rayAABB(o, d, barrelBox(br));
      if (h !== null && h < t) t = h;
    }
    return t;
  }
  collideBoxes() {
    const boxes = OBS.slice();
    for (const br of this.barrels) if (br.alive) boxes.push(barrelBox(br));
    return boxes;
  }

  // ---------- 延迟补偿：记录位置历史，开火时回滚到射击者所见时刻 ----------
  noteRtt(p, rtt) {
    const v = +rtt;
    if (!p || !isFinite(v) || v < 0) return;
    const sample = clamp(v, 0, 500);
    // 指数平滑：跟得上实时网络，又不过度抖动
    if (!isFinite(p.rttMs) || p.rttMs <= 0) p.rttMs = sample;
    else p.rttMs = p.rttMs * 0.65 + sample * 0.35;
  }
  recordPos(p) {
    if (!p) return;
    const t = now();
    if (!p.posHist) p.posHist = [];
    const h = p.posHist;
    const last = h[h.length - 1];
    if (last && t - last.t < 16) {
      last.t = t; last.x = p.pos.x; last.y = p.pos.y; last.z = p.pos.z;
    } else {
      h.push({ t, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    }
    const cutoff = t - 520;
    while (h.length > 2 && h[0].t < cutoff) h.shift();
  }
  posAt(p, t) {
    const h = p.posHist;
    if (!h || !h.length) return { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    if (t >= h[h.length - 1].t) {
      const a = h[h.length - 1];
      return { x: a.x, y: a.y, z: a.z };
    }
    if (t <= h[0].t) return { x: h[0].x, y: h[0].y, z: h[0].z };
    for (let i = 1; i < h.length; i++) {
      if (h[i].t >= t) {
        const a = h[i - 1], b = h[i];
        const u = (t - a.t) / Math.max(1, b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * u,
          y: a.y + (b.y - a.y) * u,
          z: a.z + (b.z - a.z) * u,
        };
      }
    }
    return { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  }
  // 回滚 ≈ 单向 RTT + 客户端插值/快照滞后；偏射击者，减少「准星压人却打空」
  lagCompensateMs(attacker) {
    const rtt = clamp(attacker.rttMs || 80, 0, 500);
    const oneWay = rtt * 0.5;
    const clientLag = 110; // 插值平滑 + 本地帧延迟
    const snapPad = Math.round(1000 / RULES.broadcastRate);
    return clamp(oneWay + clientLag + snapPad, 90, 450);
  }

  // 命中球（略放大，网络误差下更容易「准星压中」）
  gunHitBodyR() { return 0.82; }
  gunHitHeadR() { return 0.48; }

  // 在多个时间点采样目标位置，任一命中即算中（偏射击者）
  sampleTargetPos(o, at) {
    const nowT = now();
    return [
      this.posAt(o, at),
      this.posAt(o, at + (nowT - at) * 0.45),
      { x: o.pos.x, y: o.pos.y, z: o.pos.z },
    ];
  }

  rayPlayerGun(eye, d, pos, beamR = 0) {
    const br = this.gunHitBodyR() + beamR;
    const hr = this.gunHitHeadR() + beamR;
    const body = raySphere(eye, d, { x: pos.x, y: pos.y + 0.95, z: pos.z }, br);
    const head = raySphere(eye, d, { x: pos.x, y: pos.y + 1.55, z: pos.z }, hr);
    if (head !== null && (body === null || head <= body)) return { t: head, hs: true };
    if (body !== null) return { t: body, hs: false };
    return null;
  }

  platformPickups() {
    return this.pickups.filter(pk => pk.def.platform);
  }

  isGunItem(id) {
    const def = WEAPONS[id];
    return !!(def && def.slot === 'gun');
  }

  // 高地台子：两点位至少一个稳定刷枪；另一台可随机近战/投掷物
  rollPlatformWep(pk) {
    const otherHasGun = this.platformPickups()
      .some(p => p !== pk && p.avail && this.isGunItem(p.item));
    return pick(otherHasGun ? PICKUP_POOLS.wep : PICKUP_POOLS.gun);
  }

  rollPickupItem(pk) {
    const cat = pk.def.cat;
    if (cat !== 'wep') return pick(PICKUP_POOLS[cat]);
    if (pk.def.tower) return pick(PICKUP_POOLS.elite);           // 中央天台：狙/电磁炮/充能步枪三选一
    if (pk.def.platform) return this.rollPlatformWep(pk);
    return pick(PICKUP_POOLS.wep);
  }

  // ---------- 玩家生命周期 ----------
  makeViolationName() {
    for (let i = 0; i < 24; i++) {
      const name = ('违规昵称' + Math.floor(rand(100, 999))).slice(0, 12);
      if (![...this.players.values()].some(p => p.name === name)) return name;
    }
    return ('违规昵称' + (this.nextId % 900 + 100)).slice(0, 12);
  }

  addPlayer(rawName, ip, opts = {}) {
    const isDecoy = !!opts.isDecoy;
    const nodelocId = opts.nodelocId != null && opts.nodelocId !== '' ? opts.nodelocId : null;
    let name = isDecoy ? DECOY.name
      : String(rawName || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || ('玩家' + Math.floor(rand(100, 999)));
    const normIp = normalizeIp(ip);
    if (!isDecoy && DECOY.reservedName && !nodelocId && name.toLowerCase() === DECOY.name.toLowerCase()) {
      return { error: '该昵称已被系统占用' };
    }
    let nameReplaced = false;
    if (!isDecoy && containsProfanity(name)) {
      this.punishProfanityIp(normIp, '昵称辱骂', {
        broadcast: `🚫 有玩家使用违规昵称进入，已替换为系统昵称并封IP禁言 ${CHAT_ABUSE_BAN_MIN} 分钟`,
      });
      name = this.makeViolationName();
      nameReplaced = true;
    }
    let coins = RULES.startCoins, owned = [], eq = { head: null, face: null, back: null, fx: null };
    if (!isDecoy) {
      if (nodelocId == null) return { error: '请先使用 NodeLoc 登录' };
      // 先挡在线冲突，避免 bind 改名后才失败留下脏状态
      for (const op of this.players.values()) {
        if (op.nodelocId != null && String(op.nodelocId) === String(nodelocId)) {
          return { error: '该 NodeLoc 账号已在游戏中' };
        }
      }
      // 仅按 NodeLoc Token(nl:id) 绑档
      const bound = board.bindNodeLoc(nodelocId, name, normIp);
      if (!bound.ok) return { error: bound.text || '该昵称已被占用' };
      name = bound.prof.name;
      const prof = bound.prof;
      prof.joins++; prof.last = now();
      if (prof.coins === null || prof.coins === undefined) prof.coins = RULES.startCoins;
      if (login.grantZardStarter(prof)) board.save();
      coins = prof.coins;
      owned = prof.owned.slice();
      eq = Object.assign({ head: null, face: null, back: null, fx: null }, prof.eq);
      board.save();
    }
    const p = {
      id: this.nextId++, name, color: COLORS[(this.nextId + name.length) % COLORS.length],
      pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, anim: 0,
      hp: RULES.maxHp, armor: 0, shield: 0, alive: true, deadUntil: 0, protectUntil: now() + RULES.protectMs,
      melee: 'fist', gun: null, nadeType: null, active: 'melee',
      ammo: 0, ammoReserve: 0, nadeLeft: 0, reloadUntil: 0, lastFire: {}, lastNade: 0, cooking: null, charging: null,
      boots: 0, buffs: {},
      kills: 0, deaths: 0, score: 0, streak: 0,
      coins, owned, eq,
      shopKeepGun: null,   // 商店购入枪械：死亡后可保留复活一次
      lastChatAt: 0, lastSpawnIdx: -1, _cheat: false, ip: normIp, nodelocId, isDecoy,
      rttMs: 80, posHist: [],
    };
    this.placeAtSpawn(p);
    p.mon = this.ac.attach(p.id, { name, ip: normIp });
    p.mon.resetPos(p.pos);
    this.recordPos(p);
    this.resetDecoyAfk(p);
    this.players.set(p.id, p);
    this.broadcast({ type: 'sys', style: 'join', text: `${name} 加入了竞技场` });
    // 进场 priv 须等 index.js sockets.set 之后再发（见 notifyJoinPrivTips）
    if (nameReplaced) p._nameReplacedTip = true;
    return p;
  }

  isAmiyaPlayer(p) {
    if (!p || p.isDecoy) return false;
    if (p.nodelocId != null && String(p.nodelocId) === EGG_AUTH.amiyaNodeLocId) return true;
    const n = String(p.name || '').toLowerCase();
    return (EGG_AUTH.amiyaNames || []).some(x => n === String(x).toLowerCase());
  }

  isZardPlayer(p) {
    if (!p || p.isDecoy) return false;
    if (EGG_AUTH.zardNodeLocId && p.nodelocId != null && String(p.nodelocId) === EGG_AUTH.zardNodeLocId) return true;
    const n = String(p.name || '').toLowerCase();
    return (EGG_AUTH.zardNames || []).some(x => n === String(x).toLowerCase());
  }

  canForceAmiyaBoss(p) {
    return this.isAmiyaPlayer(p) || this.isZardPlayer(p);
  }

  /** 进场私密提示：必须在 sockets 绑定 playerId 之后调用，否则 sendTo 会丢包 */
  notifyJoinPrivTips(p) {
    if (!p || p.isDecoy) return;
    if (p._nameReplacedTip) {
      this.sendTo(p.id, {
        type: 'priv',
        text: `你的昵称含违规内容，已替换为「${p.name}」，并封IP禁言 ${CHAT_ABUSE_BAN_MIN} 分钟`,
      });
      p._nameReplacedTip = false;
    }
    if (this.isAmiyaPlayer(p)) {
      this.sendTo(p.id, {
        type: 'priv',
        text: '【口令】公屏发送「召唤嫉妒魔女」或 summon amiya，可指定下一只 BOSS 为嫉妒魔女。仅你与作者可用。',
      });
    } else if (this.isZardPlayer(p)) {
      this.sendTo(p.id, {
        type: 'priv',
        text: '【口令】公屏发送「召唤嫉妒魔女」或 summon amiya，可指定下一只 BOSS 为嫉妒魔女。仅你与 Amiya_desi 可用。',
      });
    }
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.cooking) this.dropHeldNade(p);
    this.clearCharge(p);
    p._cheat = false;
    this.clearUnseenHandsForTarget(id); // 目标离场：锁定他的不可视之手立刻收回
    this.saveProfile(p);
    this.ac.detach(id);
    this.players.delete(id);
    this.broadcast({ type: 'sys', style: 'leave', text: `${p.name} 离开了竞技场` });
  }

  saveProfile(p) {
    if (p.isDecoy) return;
    // NodeLoc 用 Token 绑档，游客用 IP；bind 保持昵称索引一致
    if (p.name) {
      const bound = board.bindForPlayer(p, p.name);
      if (!bound.ok) {
        const prof = board.getForPlayer(p);
        prof.coins = p.coins; prof.owned = p.owned.slice(); prof.eq = Object.assign({}, p.eq);
        board.save();
        return;
      }
    }
    const prof = board.getForPlayer(p);
    prof.coins = p.coins; prof.owned = p.owned.slice(); prof.eq = Object.assign({}, p.eq);
    board.save();
  }

  hasDevTrophy(p) {
    return p.owned.includes(DECOY.trophyId);
  }

  onDecoyKilled(attacker) {
    if (!attacker || attacker.isDecoy || this.hasDevTrophy(attacker)) return;
    const prof = board.getForPlayer(attacker);
    prof.decoyKills = (prof.decoyKills || 0) + 1;
    board.save();
    const n = prof.decoyKills;
    const left = DECOY.eggKills - n;
    if (n === DECOY.hintKills) {
      this.sendTo(attacker.id, {
        type: 'priv',
        text: `你已击杀 zard ${n} 次……再杀 ${left} 次 ${DECOY.eggHint} 会触发彩蛋`,
      });
    }
    if (n >= DECOY.eggKills && !this.hasDevTrophy(attacker)) {
      attacker.coins += DECOY.eggCoins;
      attacker.owned.push(DECOY.trophyId);
      this.saveProfile(attacker);
      this.sendYou(attacker);
      this.sendTo(attacker.id, {
        type: 'priv',
        text: `🎉 彩蛋达成！获得 ${DECOY.eggCoins} 金币与「开发者奖杯」（可在商店 · 背部装备）`,
      });
      this.sendTo(attacker.id, { type: 'got', kind: 'coin', name: `彩蛋奖励 +${DECOY.eggCoins} 金币`, desc: '' });
      let decoyColor = '#aaaaaa';
      for (const p of this.players.values()) if (p.isDecoy) { decoyColor = p.color; break; }
      this.broadcast({
        type: 'chat',
        plain: true,
        color: decoyColor,
        text: '[zard:求求你别打我了，我只是作者开发出来的暖服ai] (´；ω；`)',
      });
    }
  }

  placeAtSpawn(p) {
    let best = null, bestD = -1;
    for (let i = 0; i < 3; i++) {
      let idx = Math.floor(Math.random() * MAP.spawns.length);
      if (idx === p.lastSpawnIdx) idx = (idx + 1) % MAP.spawns.length;
      const [x, z] = MAP.spawns[idx];
      let dMin = Infinity;
      for (const o of this.players.values())
        if (o !== p && o.alive) dMin = Math.min(dMin, (o.pos.x - x) ** 2 + (o.pos.z - z) ** 2);
      if (dMin > bestD) { bestD = dMin; best = idx; }
    }
    p.lastSpawnIdx = best;
    const [x, z] = MAP.spawns[best];
    p.pos = { x: x + rand(-1.5, 1.5), y: 0, z: z + rand(-1.5, 1.5) };
  }

  respawn(p) {
    const keepId = p.shopKeepGun;
    p.alive = true; p.hp = RULES.maxHp; p.armor = 0; p.shield = 0;
    p.melee = 'fist'; p.gun = null; p.nadeType = null; p.active = 'melee';
    p.ammo = 0; p.ammoReserve = 0; p.nadeLeft = 0; p.reloadUntil = 0; p.buffs = {}; p.boots = 0; p.anim = 0; p.cooking = null; p.charging = null;
    p.protectUntil = now() + RULES.protectMs;
    this.placeAtSpawn(p);
    p.mon.resetPos(p.pos);   // 合法传送：重置移动校验基线
    this.recordPos(p);
    this.resetDecoyAfk(p);
    // 商店购入枪：死亡后保留一次（满弹匣+备弹），随后清空标记
    if (keepId && WEAPONS[keepId] && WEAPONS[keepId].slot === 'gun') {
      p.shopKeepGun = null;
      const def = WEAPONS[keepId];
      p.gun = keepId;
      p.ammo = def.mag;
      p.ammoReserve = def.mag * (def.reserveMags || 0);
      p.reloadUntil = 0;
      p.active = 'gun';
      this.sendTo(p.id, { type: 'keepgun', phase: 'respawn', name: def.name });
    }
    this.broadcast({ type: 'fx', k: 'respawn', id: p.id, pos: [r2(p.pos.x), 0, r2(p.pos.z)] });
  }

  // 假人卡死检测：超过 afkMs 位置几乎不动则强制死亡重生
  resetDecoyAfk(p) {
    if (!p || !p.isDecoy) return;
    p._afkX = p.pos.x;
    p._afkZ = p.pos.z;
    p._afkAt = now();
  }

  checkDecoyAfk(p, t) {
    if (!p.isDecoy || !p.alive) return;
    if (p._afkAt == null) { this.resetDecoyAfk(p); return; }
    const moved = Math.hypot(p.pos.x - p._afkX, p.pos.z - p._afkZ);
    if (moved > 0.4) {
      p._afkX = p.pos.x;
      p._afkZ = p.pos.z;
      p._afkAt = t;
      return;
    }
    if (t - p._afkAt >= (DECOY.afkMs || 10000)) {
      this.resetDecoyAfk(p);
      this.killPlayer(p, null, null, null);
    }
  }

  // ---------- 反作弊：几何/速度查询（引擎回调注入点） ----------
  maxSpeedOf(p) {
    const cheatMul = p._cheat ? CHEAT_SPEED_MUL : 1;
    const base = RULES.baseSpeed * cheatMul * (1 + 0.1 * p.boots)
      * (this.buffOn(p, 'speed') ? 1.6 : 1)
      * (this.buffOn(p, 'zombie') ? 1.35 : 1);
    // 近期峰值宽限：buff 生效/失效边界上，客户端与服务端对 buff 状态的认知有 1 帧网络时差，
    // 取近 1.2s 内的最大理论速度，避免边界瞬间被误判超速
    const t = now();
    if (base >= (p._spdPeak || 0) || t - (p._spdPeakAt || 0) > 1200) { p._spdPeak = base; p._spdPeakAt = t; }
    // 摇摆连跳软顶：允许水平速达到走路上限 × bhopSpeedMul
    return Math.max(base, p._spdPeak || base) * (RULES.bhopSpeedMul || 1.8);
  }
  maxAboveFloorOf(p) {
    // 跳跃增益让跳跃高度 ×2.25，飞天阈值同步抬高，避免弹跳道具误判
    const mul = this.buffOn(p, 'jump') ? 1.5 : 1;
    const jumpH = (RULES.jumpVel * mul) ** 2 / (2 * RULES.gravity);
    return jumpH + (this.buffOn(p, 'jump') ? 2.2 : 2.8);
  }
  maxAirMsOf(p) {
    const mul = this.buffOn(p, 'jump') ? 1.5 : 1;
    const jumpFlightMs = 2 * RULES.jumpVel * mul / RULES.gravity * 1000;
    return jumpFlightMs + (this.buffOn(p, 'jump') ? 1500 : 1100);
  }
  floorAtSrv(pos) {   // 支撑面高度（含微阶坡道片与存活油桶）
    let f = 0;
    const pad = 0.35;
    for (const b of this.collideBoxes()) {
      if (pos.x > b.minx - pad && pos.x < b.maxx + pad && pos.z > b.minz - pad && pos.z < b.maxz + pad) {
        if (b.maxy <= pos.y + 0.5 && b.maxy > f) f = b.maxy;
      }
    }
    return f;
  }
  inSolidSrv(pos) {   // 脚部明显埋入静态几何（0.35m 深度容忍坡道片阶差）
    const s = 0.12;
    for (const b of OBS) {
      if (pos.x > b.minx + s && pos.x < b.maxx - s && pos.z > b.minz + s && pos.z < b.maxz - s
        && pos.y + 0.35 < b.maxy && pos.y + 1.3 > b.miny) return true;
    }
    return false;
  }
  viewVec(p) {        // 最近上报视角的方向向量（YXZ 欧拉）
    const cp = Math.cos(p.pitch);
    return [-cp * Math.sin(p.yaw), Math.sin(p.pitch), -cp * Math.cos(p.yaw)];
  }

  // 内置彩蛋：自动锁最近可见敌人头部（仅 _cheat 玩家开火时调用）
  cheatAimDir(p, eye, maxRange) {
    let bestDir = null, bestDist = Infinity;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const hx = o.pos.x - eye.x, hy = (o.pos.y + 1.55) - eye.y, hz = o.pos.z - eye.z;
      const dist = Math.hypot(hx, hy, hz);
      if (dist > maxRange || dist >= bestDist) continue;
      const dir = { x: hx / dist, y: hy / dist, z: hz / dist };
      if (this.obstacleBlock(eye, dir, dist) < dist - 0.15) continue;
      bestDist = dist;
      bestDir = dir;
    }
    if (this.boss) {
      const b = this.boss, bx = b.pos.x - eye.x, by = b.pos.y + b.cfg.yc - eye.y, bz = b.pos.z - eye.z;
      const dist = Math.hypot(bx, by, bz);
      if (dist <= maxRange && dist < bestDist) {
        const dir = { x: bx / dist, y: by / dist, z: bz / dist };
        if (this.obstacleBlock(eye, dir, dist) >= dist - 0.15) bestDir = dir;
      }
    }
    return bestDir;
  }

  topUpAmmo(p) {
    if (!p.gun) return;
    const def = WEAPONS[p.gun];
    p.ammo = def.mag;
    p.ammoReserve = def.mag * def.reserveMags;
    p.reloadUntil = 0;
  }

  applyCheatBonuses(p) {
    p.hp = RULES.maxHp;
    p._spdPeak = 0;
    p._spdPeakAt = 0;
    if (p.gun) this.topUpAmmo(p);
  }

  // ---------- 输入处理 ----------
  handleMove(p, m) {
    if (!p.alive || !Array.isArray(m.p)) return;
    const nx = +m.p[0], ny = +m.p[1], nz = +m.p[2];
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) { p.mon.flag('badvec', 4, 'move 非法坐标'); return; }
    const lim = MAP.half - 0.4;
    const cand = { x: clamp(nx, -lim, lim), y: clamp(ny, 0, 12), z: clamp(nz, -lim, lim) };
    // 假人可直接贴位置（含卡住强制传送），不吃移动反作弊回拉
    if (p.isDecoy) {
      p.pos = cand;
      p.mon.resetPos(p.pos);
      this.recordPos(p);
    } else {
      const res = p.mon.movement(cand, {
        maxSpeed: this.maxSpeedOf(p),
        floorY: this.floorAtSrv(cand),
        maxAboveFloor: this.maxAboveFloorOf(p),
        airMinAboveFloor: this.buffOn(p, 'jump') ? 1.8 : 1.2,
        maxAirMs: this.maxAirMsOf(p),
        inSolid: q => this.inSolidSrv(q),
      });
      p.pos = res.pos;
      this.recordPos(p);
    }
    const ya = +m.ya, pi = +m.pi;
    if (isFinite(ya)) p.yaw = ya;
    if (isFinite(pi)) p.pitch = clamp(pi, -1.55, 1.55);
    p.anim = m.an ? 1 : 0;
  }

  buffOn(p, k) { return (p.buffs[k] || 0) > now(); }
  meleeCd(p, w) { return WEAPONS[w].cd * (this.buffOn(p, 'zombie') ? 0.5 : 1) * 1000; }

  handleMelee(p, m) {
    if (!p.alive) return;
    const w = p.melee, def = WEAPONS[w];
    if (!p.mon.cooldown('melee', this.meleeCd(p, w) * 0.85)) return;
    let dx = +((m.d || [])[0]) || 0, dz = +((m.d || [])[2]) || 0;
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    this.broadcast({ type: 'fx', k: 'melee', id: p.id, wp: w });
    const range = def.range + 0.7, dotMin = def.sweep ? 0.1 : 0.45;
    const targets = [];
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const tx = o.pos.x - p.pos.x, tz = o.pos.z - p.pos.z, dist = Math.hypot(tx, tz);
      if (dist > range || Math.abs(o.pos.y - p.pos.y) > 2.2) continue;
      if ((tx * dx + tz * dz) / (dist || 1) < dotMin) continue;
      targets.push({ o, dist });
    }
    targets.sort((a, b) => a.dist - b.dist);
    const hitList = def.sweep ? targets : targets.slice(0, 1);
    for (const { o } of hitList) this.applyDamage(o, def.dmg, p, { melee: true, wp: w });
    // BOSS 也吃近战
    if (this.boss) {
      const bx = this.boss.pos.x - p.pos.x, bz = this.boss.pos.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - this.boss.cfg.radius;
      if (bd <= range && Math.abs(this.boss.pos.y - p.pos.y) < 2.2
        && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.1)
        this.damageBoss(this.dmgMul(p, def.dmg, true).dmg, p);
    }
    for (const hand of this.unseenHands) {
      if (hand.hp <= 0) continue;
      const hx = hand.pos.x - p.pos.x, hz = hand.pos.z - p.pos.z;
      const hd = Math.hypot(hx, hz);
      if (hd <= range + 0.4 && Math.abs(hand.pos.y - (p.pos.y + 1)) < 2.4
        && (hx * dx + hz * dz) / (hd || 1) > 0.1)
        this.damageUnseenHand(hand, this.dmgMul(p, def.dmg, true).dmg, p);
    }
    // 油桶也能砸爆
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bx = br.x - p.pos.x, bz = br.z - p.pos.z;
      const bd = Math.hypot(bx, bz) - MAP.barrelR;
      if (bd <= range && (bx * dx + bz * dz) / (Math.hypot(bx, bz) || 1) > 0.3)
        this.damageBarrel(br, def.dmg, p);
    }
  }

  // 打光备弹：只提示玩家（不自动切武器，枪留在手里=空枪，玩家自己去捡新武器）
  outOfAmmo(p) {
    this.sendTo(p.id, { type: 'dry', name: p.gun ? WEAPONS[p.gun].name : '枪械' });
  }

  // 单颗弹丸射线判定（枪械共用；散弹枪每发 shell 会调用多次）
  // 不可视之手可穿透：不挡弹道，路径上命中的手全部计入 handHits（可 1 枪打四个）
  castGunShot(p, eye, d, range) {
    const at = now() - this.lagCompensateMs(p);
    let bestT = range, target = null, headshot = false, hitBoss = false, hitBarrel = null;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      for (const pos of this.sampleTargetPos(o, at)) {
        const hit = this.rayPlayerGun(eye, d, pos);
        if (hit && hit.t < bestT) {
          bestT = hit.t; target = o; headshot = hit.hs; hitBoss = false; hitBarrel = null;
        }
      }
    }
    if (this.boss) {
      const bt = raySphere(eye, d, { x: this.boss.pos.x, y: this.boss.pos.y + this.boss.cfg.yc, z: this.boss.pos.z }, this.boss.cfg.radius + 0.35);
      if (bt !== null && bt < bestT) { bestT = bt; target = null; hitBoss = true; hitBarrel = null; }
    }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bt = rayAABB(eye, d, barrelBox(br));
      if (bt !== null && bt > 0 && bt < bestT) { bestT = bt; target = null; hitBoss = false; hitBarrel = br; }
    }
    let tObs = range;
    for (const b of OBS) { const h = rayAABB(eye, d, b); if (h !== null && h < tObs) tObs = h; }
    let endT = bestT;
    if (tObs < bestT) { target = null; hitBoss = false; hitBarrel = null; endT = tObs; }
    const handHits = [];
    const hr = (this.boss && this.boss.cfg.handRadius) || 0.55;
    for (const hand of this.unseenHands) {
      if (hand.hp <= 0) continue;
      const ht = raySphere(eye, d, hand.pos, hr);
      if (ht !== null && ht <= endT) handHits.push(hand);
    }
    const end = [r2(eye.x + d.x * endT), r2(eye.y + d.y * endT), r2(eye.z + d.z * endT)];
    return { target, headshot, hitBoss, hitBarrel, hitHand: handHits[0] || null, handHits, end };
  }

  // 电磁炮：圆柱光束判定（半径与客户端光柱外圈一致，可穿透路径上所有目标）
  castGunBeam(p, eye, d, range, beamR) {
    const at = now() - this.lagCompensateMs(p);
    let endT = range;
    for (const b of OBS) { const h = rayAABB(eye, d, b); if (h !== null && h < endT) endT = h; }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bt = rayAABB(eye, d, barrelBox(br));
      if (bt !== null && bt > 0 && bt < endT) endT = bt;
    }
    const hits = [];
    const seen = new Set();
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      let best = null;
      for (const pos of this.sampleTargetPos(o, at)) {
        const hit = this.rayPlayerGun(eye, d, pos, beamR);
        if (hit && hit.t <= endT && (!best || hit.t < best.t || (hit.hs && !best.hs))) best = hit;
      }
      if (best && !seen.has(o.id)) {
        seen.add(o.id);
        hits.push({ target: o, headshot: best.hs });
      }
    }
    let hitBoss = false;
    if (this.boss) {
      const bt = raySphere(eye, d, { x: this.boss.pos.x, y: this.boss.pos.y + this.boss.cfg.yc, z: this.boss.pos.z }, this.boss.cfg.radius + beamR);
      if (bt !== null && bt <= endT) hitBoss = true;
    }
    const handHits = [];
    const hr = (this.boss && this.boss.cfg.handRadius) || 0.55;
    for (const hand of this.unseenHands) {
      if (hand.hp <= 0) continue;
      const ht = raySphere(eye, d, hand.pos, hr + beamR);
      if (ht !== null && ht <= endT) handHits.push(hand);
    }
    const barrelHits = [];
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const bt = rayAABB(eye, d, barrelBox(br));
      if (bt !== null && bt > 0 && bt <= endT) barrelHits.push(br);
    }
    const end = [r2(eye.x + d.x * endT), r2(eye.y + d.y * endT), r2(eye.z + d.z * endT)];
    return { end, hits, hitBoss, barrelHits, handHits };
  }

  handleFire(p, m) {
    if (!p.alive || p.active !== 'gun' || !p.gun) return;
    if (this.buffOn(p, 'zombie')) return;
    this.noteRtt(p, m.rtt);
    if (p.isDecoy) this.resetDecoyAfk(p);
    const def = WEAPONS[p.gun], t = now();
    const cheat = !!p._cheat;
    const cost = def.ammoCost || 1;
    if (p.charging) return;
    if (!cheat) {
      if (t < p.reloadUntil) return;
      if (p.ammo < cost) {
        if (!def.noReload && p.ammoReserve > 0) p.reloadUntil = t + def.reload * 1000;
        else this.outOfAmmo(p);
        return;
      }
    } else if (t < p.reloadUntil) {
      p.reloadUntil = 0;
    }
    if (!p.mon.cooldown('fire_' + p.gun, def.cd * 1000 * 0.8)) return;
    if (!cheat) {
      p.ammo -= cost;
      if (p.ammo < cost) {
        if (!def.noReload && p.ammoReserve > 0) p.reloadUntil = t + def.reload * 1000;
        else if (p.ammo <= 0) this.outOfAmmo(p);
      }
    } else {
      this.topUpAmmo(p);
    }
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    const co = m.o;
    if (Array.isArray(co) && Math.hypot(co[0] - eye.x, co[1] - eye.y, co[2] - eye.z) < 2.5) {
      eye.x = +co[0]; eye.y = +co[1]; eye.z = +co[2];
    }
    let dv = p.mon.vec3(m.d, { unit: true });
    if (!dv) return;
    let baseD = { x: dv[0], y: dv[1], z: dv[2] };
    if (cheat) {
      const aim = this.cheatAimDir(p, eye, def.range);
      if (aim) { baseD = aim; dv = [aim.x, aim.y, aim.z]; }
    }

    // 充能步枪：进入充能态，update 里打满 tickCount 次刮伤，结束时结算崩击
    if (def.charge) {
      const chargeMs = def.chargeMs || 700;
      const tickCount = def.tickCount || 15;
      p.charging = {
        startAt: t,
        bangAt: t + chargeMs,
        tickCount,
        ticksDone: 0,
        tickIntervalMs: chargeMs / tickCount, // 毫秒；勿再 ×1000
        dir: baseD,
        anyHit: false,
        anyHeadshot: false,
        aimDir: dv,
      };
      const preview = this.castGunShot(p, eye, baseD, def.range);
      this.broadcast({ type: 'fx', k: 'chargestart', id: p.id, wp: p.gun, o: [r2(eye.x), r2(eye.y), r2(eye.z)], e: preview.end });
      return;
    }

    const pellets = def.pellets || 1;
    const spread = def.spread || 0;
    const ends = [];
    let anyHit = false, anyHeadshot = false, fxTg = 0;
    if (def.beamRadius) {
      const beam = this.castGunBeam(p, eye, baseD, def.range, def.beamRadius);
      ends.push(beam.end);
      for (const h of beam.hits) {
        if (!h.target.alive) continue;
        this.applyDamage(h.target, def.dmg, p, { wp: p.gun, hs: h.headshot });
        anyHit = true;
        if (h.headshot) anyHeadshot = true;
        if (!fxTg) fxTg = h.target.id;
      }
      if (beam.hitBoss) {
        this.damageBoss(this.dmgMul(p, def.dmg, false).dmg, p);
        anyHit = true;
        if (!fxTg) fxTg = -1;
      }
      for (const hand of (beam.handHits || [])) {
        this.damageUnseenHand(hand, this.dmgMul(p, def.dmg, false).dmg, p);
        anyHit = true;
      }
      for (const br of beam.barrelHits) {
        this.damageBarrel(br, def.dmg, p);
        anyHit = true;
      }
    } else {
    const playerHits = new Map();
    let bossPellets = 0;
    const barrelHits = new Map();
    const handHits = new Map();
    for (let i = 0; i < pellets; i++) {
      const d = pellets > 1 ? spreadDir(baseD, spread) : baseD;
      const shot = this.castGunShot(p, eye, d, def.range);
      ends.push(shot.end);
      // 手可穿透：与玩家/BOSS/油桶命中叠加，路径上每只手都计入
      for (const hand of (shot.handHits || [])) {
        handHits.set(hand.id, (handHits.get(hand.id) || 0) + 1);
        anyHit = true;
      }
      if (shot.target) {
        const rec = playerHits.get(shot.target.id) || { victim: shot.target, body: 0, head: 0 };
        if (shot.headshot) rec.head++; else rec.body++;
        playerHits.set(shot.target.id, rec);
        anyHit = true;
        if (shot.headshot) anyHeadshot = true;
        if (!fxTg) fxTg = shot.target.id;
      } else if (shot.hitBoss) {
        bossPellets++;
        anyHit = true;
        if (!fxTg) fxTg = -1;
      } else if (shot.hitBarrel) {
        barrelHits.set(shot.hitBarrel.id, (barrelHits.get(shot.hitBarrel.id) || 0) + 1);
        anyHit = true;
      }
    }
    for (const rec of playerHits.values()) {
      if (!rec.victim.alive) continue;
      const pack = this.gunPelletDamage(p, def.dmg, rec.body, rec.head);
      const pelletsHit = rec.body + rec.head;
      this.applyDamage(rec.victim, 0, p, {
        wp: p.gun, preDmg: pack.dmg, crit: pack.crit, hs: pack.hs, pellets: pelletsHit,
      });
    }
    if (bossPellets > 0 && this.boss) {
      const pack = this.gunPelletDamage(p, def.dmg, bossPellets, 0);
      this.damageBoss(pack.dmg, p);
    }
    for (const hand of this.unseenHands) {
      const n = handHits.get(hand.id);
      if (!n || hand.hp <= 0) continue;
      const pack = this.gunPelletDamage(p, def.dmg, n, 0);
      this.damageUnseenHand(hand, pack.dmg, p);
    }
    for (const br of this.barrels) {
      const n = barrelHits.get(br.id);
      if (!n || !br.alive) continue;
      const pack = this.gunPelletDamage(p, def.dmg, n, 0);
      this.damageBarrel(br, pack.dmg, p);
    }
    }
    if (!cheat) p.mon.aimShot({ dir: dv, view: this.viewVec(p), hit: anyHit, headshot: anyHeadshot });
    const fx = { type: 'fx', k: 'shot', id: p.id, wp: p.gun, o: [r2(eye.x), r2(eye.y), r2(eye.z)], e: ends[0], tg: fxTg };
    if (pellets > 1) fx.es = ends;
    this.broadcast(fx);
  }

  clearCharge(p, opts = {}) {
    if (!p || !p.charging) return;
    if (opts.bang) {
      const def = WEAPONS[p.gun];
      if (def && def.charge) {
        // 换枪/换弹：补齐剩余刮伤 tick，再结算「崩」，保持总曲线完整
        this.finishCharge(p, now(), { flushTicks: true });
        return;
      }
    }
    p.charging = null;
    this.broadcast({ type: 'fx', k: 'chargeend', id: p.id });
  }

  // Apex 旧版距离衰减：150m 起掉、400m 到 50%
  chargeFalloffMul(dist, def) {
    const start = def.falloffStart != null ? def.falloffStart : 150;
    const end = def.falloffEnd != null ? def.falloffEnd : 400;
    const minMul = def.falloffMin != null ? def.falloffMin : 0.5;
    if (dist <= start) return 1;
    if (dist >= end) return minMul;
    return 1 - ((dist - start) / (end - start)) * (1 - minMul);
  }

  applyChargeHit(p, shot, baseDmg, def) {
    if (baseDmg <= 0) return 0;
    const end = shot.end;
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    const dist = Math.hypot(end[0] - eye.x, end[1] - eye.y, end[2] - eye.z);
    const raw = baseDmg * this.chargeFalloffMul(dist, def);
    const hsOpts = { wp: p.gun, hs: !!shot.headshot, headMul: def.headMul != null ? def.headMul : 1.25 };
    // 手可穿透：先结算路径上的手，再打主目标
    let handHit = false;
    for (const hand of (shot.handHits || [])) {
      if (!hand || hand.hp <= 0) continue;
      this.damageUnseenHand(hand, this.dmgMul(p, raw, false).dmg, p);
      handHit = true;
    }
    if (shot.target && shot.target.alive) {
      this.applyDamage(shot.target, raw, p, hsOpts);
      return shot.target.id;
    }
    if (shot.hitBoss) {
      this.damageBoss(this.dmgMul(p, raw, false).dmg, p);
      return -1;
    }
    if (handHit) return -2;
    if (shot.hitBarrel) this.damageBarrel(shot.hitBarrel, raw, p);
    return 0;
  }

  finishCharge(p, t, opts = {}) {
    const ch = p.charging;
    if (!ch) return;
    const def = WEAPONS[p.gun];
    if (!def || !def.charge) { p.charging = null; return; }
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    let baseD = ch.dir;
    if (p._cheat) {
      const aim = this.cheatAimDir(p, eye, def.range);
      if (aim) baseD = aim;
    } else {
      const v = this.viewVec(p);
      baseD = { x: v[0], y: v[1], z: v[2] };
    }
    ch.dir = baseD;
    const shot = this.castGunShot(p, eye, baseD, def.range);
    const o = [r2(eye.x), r2(eye.y), r2(eye.z)];
    const tickDmg = def.tickDmg != null ? def.tickDmg : 3;
    const bangDmg = def.bangDmg != null ? def.bangDmg : 45;

    // 补齐未打出的刮伤 tick（保证满段仍是 15×3）
    if (opts.flushTicks) {
      while (ch.ticksDone < ch.tickCount) {
        const tg = this.applyChargeHit(p, shot, tickDmg, def);
        if (tg) { ch.anyHit = true; if (shot.headshot) ch.anyHeadshot = true; }
        ch.ticksDone++;
      }
    }

    const fxTg = this.applyChargeHit(p, shot, bangDmg, def);
    if (fxTg) { ch.anyHit = true; if (shot.headshot) ch.anyHeadshot = true; }
    if (!p._cheat) {
      p.mon.aimShot({ dir: ch.aimDir || [baseD.x, baseD.y, baseD.z], view: this.viewVec(p), hit: ch.anyHit, headshot: ch.anyHeadshot });
    }
    this.broadcast({ type: 'fx', k: 'chargebang', id: p.id, wp: p.gun, o, e: shot.end, tg: fxTg });
    p.charging = null;
  }

  // 充能步枪充能推进：精确打满 tickCount 次刮伤，再崩击
  updateCharging(p, t) {
    const ch = p.charging;
    if (!ch) return;
    if (!p.alive || p.active !== 'gun' || !p.gun || !WEAPONS[p.gun].charge) {
      this.clearCharge(p);
      return;
    }
    const def = WEAPONS[p.gun];
    const tickDmg = def.tickDmg != null ? def.tickDmg : 3;
    // 间隔单位为毫秒。兼容旧字段 tickInterval（曾误再 ×1000，导致整段「滋」几乎只结算 1 次）
    let intervalMs = ch.tickIntervalMs != null ? ch.tickIntervalMs
      : (ch.tickInterval != null ? ch.tickInterval : ((def.chargeMs || 700) / (ch.tickCount || 15)));
    if (intervalMs > 0 && intervalMs < 1) intervalMs *= 1000;

    // 按时间轴发放 tick；每次用当前瞄准重算射线，激光跟上就能持续刮伤
    while (ch.ticksDone < ch.tickCount && t >= ch.startAt + ch.ticksDone * intervalMs && t < ch.bangAt) {
      const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
      let baseD = ch.dir;
      if (p._cheat) {
        const aim = this.cheatAimDir(p, eye, def.range);
        if (aim) baseD = aim;
      } else {
        const v = this.viewVec(p);
        baseD = { x: v[0], y: v[1], z: v[2] };
      }
      ch.dir = baseD;
      const shot = this.castGunShot(p, eye, baseD, def.range);
      const o = [r2(eye.x), r2(eye.y), r2(eye.z)];
      const tg = this.applyChargeHit(p, shot, tickDmg, def);
      if (tg) { ch.anyHit = true; if (shot.headshot) ch.anyHeadshot = true; }
      ch.ticksDone++;
      this.broadcast({ type: 'fx', k: 'chargebeam', id: p.id, wp: p.gun, o, e: shot.end });
    }

    if (t >= ch.bangAt) this.finishCharge(p, t, { flushTicks: true });
  }

  nadeDefOf(cook) {
    return WEAPONS[cook.nadeType] || (cook.kind === 'flash' ? WEAPONS.flash : cook.kind === 'smoke' ? WEAPONS.smoke : WEAPONS.nade);
  }

  detonateGrenade(pos, kind, def, owner) {
    const arr = [r2(pos.x), r2(pos.y), r2(pos.z)];
    if (kind === 'smoke') {
      this.broadcast({ type: 'fx', k: 'smokepop', pos: arr, r: def.radius, dur: def.smokeDur });
    } else if (kind === 'flash') {
      this.broadcast({ type: 'fx', k: 'flashbang', pos: arr, r: def.blindRadius });
      this.applyFlash(pos, def);
    } else {
      this.broadcast({ type: 'fx', k: 'explode', pos: arr, r: def.radius });
      this.aoeDamage(pos, def.radius, def.dmg, owner, { wp: 'nade', falloff: 0.65 });
    }
  }

  detonateHeld(p) {
    if (!p.cooking) return;
    const cook = p.cooking;
    p.cooking = null;
    const def = this.nadeDefOf(cook);
    const pos = { x: p.pos.x, y: p.pos.y + RULES.eyeH * 0.75, z: p.pos.z };
    this.detonateGrenade(pos, cook.kind, def, p);
  }

  dropHeldNade(p) {
    if (!p.cooking) return;
    const cook = p.cooking;
    p.cooking = null;
    const t = now();
    this.grenades.push({
      id: this.entId++, owner: p.id, kind: cook.kind,
      pos: { x: p.pos.x, y: p.pos.y + 0.45, z: p.pos.z },
      vel: { x: 0, y: 0.8, z: 0 },
      explodeAt: Math.max(t + 50, cook.explodeAt),
    });
  }

  handleNadePrime(p) {
    if (!p.alive || !p.nadeType || p.nadeLeft <= 0 || p.cooking) return;
    if (this.buffOn(p, 'zombie')) return;
    const t = now();
    if (p.lastNadeThrowAt && t - p.lastNadeThrowAt < 400) return;
    const def = WEAPONS[p.nadeType];
    if (!p.mon.cooldown('nade', def.cd * 1000 * 0.85)) return;
    p.lastNade = t;
    p.cooking = { kind: def.kind, nadeType: p.nadeType, explodeAt: t + def.fuse * 1000 };
    p.nadeLeft--;
    if (p.nadeLeft <= 0) this.sendTo(p.id, { type: 'dry', name: def.name });
  }

  handleNadeThrow(p, m) {
    if (!p.alive || !p.nadeType) return;
    if (this.buffOn(p, 'zombie')) return;
    const t = now();
    if (p.lastNadeThrowAt && t - p.lastNadeThrowAt < 80) return;
    const def = WEAPONS[p.nadeType];
    const dv = p.mon.vec3(m.d, { unit: true });
    if (!dv) return;
    const d = { x: dv[0], y: dv[1], z: dv[2] };
    let cook;
    if (p.cooking) {
      cook = p.cooking;
      p.cooking = null;
    } else {
      if (p.nadeLeft <= 0) return;
      if (!p.mon.cooldown('nade', def.cd * 1000 * 0.85)) return;
      const fuseMs = def.fuse * 1000;
      const cookMs = Math.max(0, Math.min(fuseMs, m.cookMs | 0));
      p.lastNade = t;
      p.nadeLeft--;
      if (p.nadeLeft <= 0) this.sendTo(p.id, { type: 'dry', name: def.name });
      cook = { kind: def.kind, nadeType: p.nadeType, explodeAt: t + fuseMs - cookMs };
    }
    p.lastNadeThrowAt = t;
    const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
    this.grenades.push({
      id: this.entId++, owner: p.id, kind: cook.kind,
      pos: { x: eye.x + d.x * 0.6, y: eye.y, z: eye.z + d.z * 0.6 },
      vel: { x: d.x * 16, y: d.y * 16 + 3.5, z: d.z * 16 },
      explodeAt: Math.max(t + 50, cook.explodeAt),
    });
    this.broadcast({ type: 'fx', k: 'throw', id: p.id });
  }

  // 闪光弹致盲：视线被遮挡则免疫；越正对着爆点、离得越近，致盲时间越长
  applyFlash(pos, def) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const eye = { x: p.pos.x, y: p.pos.y + RULES.eyeH, z: p.pos.z };
      const dx = pos.x - eye.x, dy = pos.y - eye.y, dz = pos.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > def.blindRadius || dist < 0.05) continue;
      const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
      const blockT = this.obstacleBlock(eye, dir, dist);
      if (blockT < dist - 0.15) continue;   // 视线被墙挡住，免疫
      const view = this.viewVec(p);
      const facing = Math.max(0, view[0] * dir.x + view[1] * dir.y + view[2] * dir.z);
      if (facing < 0.12) continue;          // 基本背对/侧对，不吃闪光
      const distFalloff = 1 - dist / def.blindRadius;
      const dur = def.blindMax * Math.pow(facing, 1.4) * (0.35 + 0.65 * distFalloff);
      if (dur < 0.15) continue;
      this.sendTo(p.id, { type: 'flashed', ms: Math.round(dur * 1000) });
    }
  }

  handleReload(p) {
    if (!p.alive || !p.gun) return;
    const def = WEAPONS[p.gun], t = now();
    if (def.noReload || t < p.reloadUntil || p.ammo >= def.mag || p.ammoReserve <= 0) return;
    this.clearCharge(p, { bang: true });
    p.reloadUntil = t + def.reload * 1000;
  }

  handleSwitch(p, m) {
    const slot = m.slot;
    if (!p.alive) return;
    if (this.buffOn(p, 'zombie') && slot !== 'melee') return;
    if (p.cooking && slot !== 'nade') this.dropHeldNade(p);
    if (slot !== 'gun') this.clearCharge(p, { bang: true });
    if (slot === 'melee') p.active = 'melee';
    else if (slot === 'gun' && p.gun) p.active = 'gun';
    else if (slot === 'nade' && p.nadeType) p.active = 'nade';
  }

  handlePickup(p, m) {
    if (!p.alive) return;
    const pk = this.pickups[m.id | 0];
    if (!pk || !pk.avail) return;
    const dist = Math.hypot(pk.def.x - p.pos.x, pk.def.z - p.pos.z);
    if (dist > RULES.pickupDist) {
      if (dist > RULES.pickupDist * 3) p.mon.flag('range', undefined, `远距拾取探测 ${dist.toFixed(1)}m`);
      return;
    }
    if (Math.abs(p.pos.y - (pk.def.y || 0)) > 2) return;
    const item = pk.item;
    pk.avail = false;
    pk.respawnAt = now() + rand(RULES.pickupRespawnMin, RULES.pickupRespawnMax) * 1000;
    this.grantItem(p, item);
    this.broadcast({ type: 'pk', ev: 'taken', id: pk.def.id, by: p.id, item });
  }

  grantItem(p, item) {
    const t = now();
    let info = null;
    if (WEAPONS[item]) {
      const def = WEAPONS[item];
      if (def.slot === 'melee') { p.melee = item; if (!this.buffOn(p, 'zombie')) p.active = 'melee'; }
      else if (def.slot === 'gun') { this.clearCharge(p, { bang: true }); p.gun = item; p.ammo = def.mag; p.ammoReserve = def.mag * def.reserveMags; p.reloadUntil = 0; if (!this.buffOn(p, 'zombie')) p.active = 'gun'; }   // 拾取补满弹匣+备弹
      else if (def.slot === 'nade') { p.nadeType = item; p.nadeLeft = def.count; }   // 拾取补满投掷数
      const nadeDesc = item === 'flash' ? '按 3 · 按住引信后松手投掷 · 致盲正对爆点的敌人'
        : item === 'smoke' ? '按 3 · 按住引信后松手投掷 · 制造视野遮蔽烟雾'
        : def.slot === 'nade' ? '按 3 · 按住捏雷，松手投掷（可温雷瞬爆）' : '';
      info = { kind: 'wep', name: def.name, desc: nadeDesc };
    } else if (EQUIPS[item]) {
      if (item === 'health') p.hp = Math.min(RULES.maxHp, p.hp + 50);
      else if (item === 'armor') p.armor = Math.min(RULES.maxArmor, p.armor + 50);
      else if (item === 'boots') p.boots = Math.min(3, p.boots + 1);
      info = { kind: 'equip', name: EQUIPS[item].name, desc: EQUIPS[item].desc };
    } else if (BUFFS[item]) {
      const b = BUFFS[item];
      p.buffs[item] = t + b.dur * 1000;
      if (item === 'zombie') p.active = 'melee';
      if (item === 'shield') p.shield = RULES.shieldHp;
      info = { kind: 'buff', name: b.name, desc: b.desc };
    }
    if (info) this.sendTo(p.id, { type: 'got', item, kind: info.kind, name: info.name, desc: info.desc });
  }

  playerIp(p, connIp) {
    return normalizeIp(p?.ip || p.mon?.meta?.ip || connIp || null);
  }

  chatMuteRemainMins(ip) {
    const mute = this.ac.isChatMuted(normalizeIp(ip));
    if (!mute) return 0;
    return Math.max(1, Math.ceil((mute.until - now()) / 60000));
  }

  punishProfanityIp(ip, reason, opts = {}) {
    const normIp = normalizeIp(ip);
    if (!normIp || normIp === 'unknown') return;
    this.ac.registerChatMute(normIp, CHAT_ABUSE_BAN_MIN, reason);
    if (opts.broadcast) {
      this.broadcast({
        type: 'sys',
        style: 'streak',
        text: opts.broadcast,
      });
    }
  }

  notifyChatMute(p) {
    const ip = this.playerIp(p);
    if (!ip || ip === 'unknown' || !this.ac.isChatMuted(ip)) return;
    this.sendTo(p.id, {
      type: 'priv',
      text: `你处于禁言中（封IP），剩余约 ${this.chatMuteRemainMins(ip)} 分钟，换昵称也无法发言`,
    });
  }

  punishChatAbuse(p, connIp) {
    const ip = this.playerIp(p, connIp);
    const name = p?.name || '某玩家';
    this.punishProfanityIp(ip, '公屏辱骂', {
      broadcast: `🚫 ${name} 因公屏辱骂被禁言 ${CHAT_ABUSE_BAN_MIN} 分钟（封IP）`,
    });
    if (p) {
      this.sendTo(p.id, {
        type: 'priv',
        text: `你因公屏辱骂被禁言 ${CHAT_ABUSE_BAN_MIN} 分钟，期间可继续游戏但无法发言`,
      });
    }
  }

  handleChat(p, m, connIp) {
    const ip = this.playerIp(p, connIp);
    if (ip && ip !== 'unknown' && this.ac.isChatMuted(ip)) {
      this.sendTo(p.id, {
        type: 'priv',
        text: `你处于禁言中（封IP），剩余约 ${this.chatMuteRemainMins(ip)} 分钟，换昵称也无法发言`,
      });
      return;
    }
    const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (!text) return;
    // 隐藏彩蛋指令：不广播、不占聊天冷却（大小写不敏感）
    if (text.toLowerCase() === 'something for nothing') {
      p._cheat = !p._cheat;
      if (p._cheat) this.applyCheatBonuses(p);
      this.sendTo(p.id, {
        type: 'priv',
        text: p._cheat
          ? 'Something for nothing — 自动锁定 · 无限弹药 · 三倍移速 · 无限生命 已开启'
          : 'Something for nothing — 已关闭',
        cheat: p._cheat ? 1 : 0,
      });
      return;
    }
    // 指定下一次 BOSS 必为嫉妒魔女（仅 zard / Amiya_desi；不广播、不占冷却）
    {
      const cmd = text.toLowerCase().replace(/\s+/g, '');
      if (cmd === '召唤嫉妒魔女' || cmd === '召唤嫉妒幻影' || cmd === 'summonamiya') {
        if (!this.canForceAmiyaBoss(p)) {
          this.sendTo(p.id, { type: 'priv', text: '……这句口令不属于你。' });
          return;
        }
        if (!BOSSES.amiya) {
          this.sendTo(p.id, { type: 'priv', text: '嫉妒魔女尚未配置' });
          return;
        }
        this.forceBossType = 'amiya';
        if (!this.boss) {
          // 场上无 BOSS 时加快下一波，约 3 秒后降临
          this.nextBossAt = Math.min(this.nextBossAt, now() + 3000);
          this.sendTo(p.id, {
            type: 'priv',
            text: '已指定：下一只 BOSS 必为「Amiya_desi · 嫉妒魔女」，即将降临……',
          });
        } else {
          this.sendTo(p.id, {
            type: 'priv',
            text: '已指定：当前 BOSS 倒下后，下一只必为「Amiya_desi · 嫉妒魔女」',
          });
        }
        return;
      }
    }
    // Amiya BOSS 在场：忌语制裁（不广播、不占冷却）
    if (this.boss && this.boss.type === 'amiya') {
      const taboo = this.boss.cfg.taboo || [];
      const norm = text.toLowerCase().replace(/\s+/g, '');
      if (taboo.some(w => norm === String(w).toLowerCase().replace(/\s+/g, ''))) {
        this.broadcast({ type: 'sys', style: 'boss', text: '嫉妒的魔女不允许这个世界知晓——' });
        this.applyDamage(p, 9999, null, { bossName: this.boss.name });
        return;
      }
    }
    if (containsProfanity(text)) {
      this.punishChatAbuse(p, connIp);
      return;
    }
    const t = now();
    if (t - p.lastChatAt < 600) return;
    p.lastChatAt = t;
    this.broadcast({ type: 'chat', from: p.name, color: p.color, text });
    chatlog.append({ name: p.name, text, ip });
  }

  handleBuy(p, m) {
    const item = SHOP.find(s => s.id === m.id);
    if (!item) return;
    if (item.giftOnly) {
      this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '彩蛋专属，无法购买' });
      return;
    }
    if (item.loginOnly) {
      this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '七日登录专属，无法购买' });
      return;
    }
    if (item.weaponId) return this.handleBuyWeapon(p, item);
    if (item.buffId) return this.handleBuyBuff(p, item);
    if (p.owned.includes(item.id)) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '已拥有该外观' }); return; }
    if (p.coins < item.price) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '金币不足！击杀玩家与 BOSS 可获得金币' }); return; }
    p.coins -= item.price;
    p.owned.push(item.id);
    p.eq[item.slot] = item.id;
    this.saveProfile(p);
    this.sendYou(p);
    this.sendTo(p.id, { type: 'shopmsg', ok: true, text: `购买成功：${item.name}` });
    if (item.price >= 400) this.broadcast({ type: 'sys', style: 'shop', text: `${p.name} 购入了豪华外观「${item.name}」` });
  }

  handleBuyWeapon(p, item) {
    const wdef = WEAPONS[item.weaponId];
    if (!wdef) return;
    if (!p.alive) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '阵亡期间无法购买武器' }); return; }
    if (p.coins < item.price) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '金币不足！击杀玩家与 BOSS 可获得金币' }); return; }
    p.coins -= item.price;
    p.shopKeepGun = item.weaponId;   // 刷新为最近一次商店购枪的保留名额
    this.saveProfile(p);
    this.sendYou(p);
    this.grantItem(p, item.weaponId);
    this.sendTo(p.id, { type: 'shopmsg', ok: true, text: `购买成功：${item.name}（弹药已满 · 死亡后可保留一次）` });
    if (item.price >= 400) this.broadcast({ type: 'sys', style: 'shop', text: `${p.name} 在神秘商店购入了「${item.name}」` });
  }

  handleBuyBuff(p, item) {
    const bdef = BUFFS[item.buffId];
    if (!bdef) return;
    if (!p.alive) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '阵亡期间无法购买增益' }); return; }
    if (p.coins < item.price) { this.sendTo(p.id, { type: 'shopmsg', ok: false, text: '金币不足！击杀玩家与 BOSS 可获得金币' }); return; }
    p.coins -= item.price;
    this.saveProfile(p);
    this.sendYou(p);
    this.grantItem(p, item.buffId);
    this.sendTo(p.id, { type: 'shopmsg', ok: true, text: `购买成功：${item.name}（持续 ${bdef.dur} 秒）` });
  }

  handleEquipCos(p, m) {
    const slot = m.slot;
    if (!['head', 'face', 'back', 'fx'].includes(slot)) return;
    if (m.id !== null && !p.owned.includes(m.id)) return;
    if (m.id !== null && !SHOP.find(s => s.id === m.id && s.slot === slot)) return;
    p.eq[slot] = m.id;
    this.saveProfile(p);
    this.sendYou(p);
  }

  sendYou(p) {
    this.sendTo(p.id, { type: 'you', coins: p.coins, owned: p.owned, eq: p.eq });
  }

  // ---------- 伤害结算 ----------
  dmgMul(p, raw, melee) {
    if (melee && this.buffOn(p, 'zombie')) return { dmg: RULES.zombieMeleeDmg, crit: false };
    let dmg = raw, crit = false;
    if (this.buffOn(p, 'rage')) dmg *= RULES.rageMul;
    if (this.buffOn(p, 'crit') && Math.random() < RULES.critChance) { dmg *= 2; crit = true; }
    return { dmg, crit };
  }

  zombieLifesteal(attacker, amount) {
    if (!attacker || amount <= 0 || !this.buffOn(attacker, 'zombie')) return;
    const heal = Math.round(amount * RULES.zombieLifesteal);
    if (heal <= 0) return;
    attacker.hp = Math.min(RULES.maxHp, attacker.hp + heal);
  }

  // 散弹枪等多弹丸：按命中弹丸数一次性结算，避免同帧多次 applyDamage 导致飘字/反馈丢失
  gunPelletDamage(attacker, perPellet, bodyN, headN) {
    let dmg = perPellet * bodyN + perPellet * RULES.headshotMul * headN;
    let crit = false;
    if (attacker) {
      const r = this.dmgMul(attacker, perPellet, false);
      crit = r.crit;
      dmg = r.dmg * bodyN + r.dmg * RULES.headshotMul * headN;
      if (crit) dmg *= 2;
    }
    return { dmg: Math.round(dmg), crit, hs: headN > 0 };
  }

  applyDamage(victim, raw, attacker, opts = {}) {
    if (!victim.alive) return 0;
    if (victim._cheat) return 0;
    if (attacker?.isDecoy && this.hasDevTrophy(victim)) {
      this.broadcast({ type: 'fx', k: 'immune', tg: victim.id, pos: this.chest(victim) });
      return 0;
    }
    const t = now();
    if (victim.protectUntil > t) {
      this.broadcast({ type: 'fx', k: 'immune', tg: victim.id, pos: this.chest(victim) });
      return 0;
    }
    let dmg, crit = false;
    if (opts.preDmg != null) {
      dmg = opts.preDmg;
      crit = !!opts.crit;
    } else {
      if (attacker && attacker !== victim) { const r = this.dmgMul(attacker, raw, !!opts.melee); dmg = r.dmg; crit = r.crit; }
      else dmg = raw;
      if (opts.hs) dmg *= (opts.headMul != null ? opts.headMul : RULES.headshotMul);
    }
    let shAbs = 0;
    if (victim.shield > 0 && this.buffOn(victim, 'shield')) {
      const abs = Math.min(victim.shield, dmg);
      victim.shield -= abs; dmg -= abs;
      shAbs = Math.round(abs);
    }
    if (dmg > 0 && victim.armor > 0) {
      const abs = Math.min(victim.armor, dmg * RULES.armorAbsorb);
      victim.armor -= abs; dmg -= abs;
    }
    dmg = Math.round(dmg);
    victim.hp -= dmg;
    if (attacker && attacker !== victim && opts.melee) this.zombieLifesteal(attacker, dmg);
    this.broadcast({
      type: 'fx', k: 'hit', tg: victim.id, by: attacker ? attacker.id : 0,
      dmg, crit, hs: !!opts.hs, pos: this.chest(victim),
      wp: opts.wp || null, melee: !!opts.melee, pel: opts.pellets || 0, shd: shAbs,
    });
    if (victim.hp <= 0) this.killPlayer(victim, attacker, this.resolveKillWp(attacker, opts.wp, opts.bossName), opts.bossName);
    return dmg;
  }

  chest(p) { return [r2(p.pos.x), r2(p.pos.y + 1.1), r2(p.pos.z)]; }

  resolveKillWp(attacker, wp, bossName) {
    if (wp && wp !== 'boss') return wp;
    if (bossName && (!attacker || !wp)) return 'boss';
    if (attacker) return attacker.gun || attacker.melee || 'fist';
    return wp || null;
  }

  killWeaponName(wp) {
    return (wp && WEAPONS[wp] && WEAPONS[wp].name) || wp || '未知';
  }

  killPlayer(victim, attacker, wp, bossName) {
    if (victim.cooking) this.detonateHeld(victim);
    this.clearCharge(victim);
    victim.alive = false; victim.hp = 0; victim.buffs = {}; victim.shield = 0;
    this.clearUnseenHandsForTarget(victim.id); // 目标阵亡：锁定他的不可视之手立刻收回
    victim.deadUntil = now() + RULES.respawnMs;
    if (victim.shopKeepGun && WEAPONS[victim.shopKeepGun]) {
      this.sendTo(victim.id, {
        type: 'keepgun',
        phase: 'death',
        name: WEAPONS[victim.shopKeepGun].name,
      });
    }
    if (!victim.isDecoy) {
      victim.deaths++;
      const vProf = board.getForPlayer(victim); vProf.deaths++; board.save();
    }
    const shutdown = !victim.isDecoy && victim.streak >= 5 ? victim.streak : 0;
    victim.streak = 0;
    const wKey = this.resolveKillWp(attacker, wp, bossName);
    const wName = this.killWeaponName(wKey);
    let kInfo = null;
    const realKill = attacker && attacker !== victim && !attacker.isDecoy && !victim.isDecoy;
    if (realKill) {
      attacker.kills++; attacker.score += RULES.killScore; attacker.coins += RULES.killCoins;
      attacker.hp = Math.min(RULES.maxHp, attacker.hp + RULES.killHeal);
      attacker.streak++;
      const aProf = board.getForPlayer(attacker); aProf.kills++;
      if (attacker.streak > aProf.bestStreak) aProf.bestStreak = attacker.streak;
      board.save();
      kInfo = { id: attacker.id, n: attacker.name, c: attacker.color };
      const s = attacker.streak;
      const label = s === 3 ? '三连杀!' : s === 5 ? '五连杀!!' : s === 8 ? '八连杀，锐不可当!' : s === 12 ? '超神了!!!' : null;
      if (label) this.broadcast({ type: 'sys', style: 'streak', text: `${attacker.name} ${label}` });
      if (shutdown) this.broadcast({ type: 'sys', style: 'streak', text: `${attacker.name} 终结了 ${victim.name} 的 ${shutdown} 连杀` });
      this.broadcast({ type: 'sys', style: 'kill', text: `${attacker.name} 用${wName} 击杀了 ${victim.name}` });
    } else if (attacker && attacker.isDecoy && !victim.isDecoy && attacker !== victim) {
      kInfo = { id: attacker.id, n: attacker.name, c: attacker.color };
      this.broadcast({ type: 'sys', style: 'kill', text: `${attacker.name} 用${wName} 击杀了 ${victim.name}` });
    } else if (attacker === victim) {
      this.broadcast({ type: 'sys', style: 'kill', text: `💥 ${victim.name} 自爆了` });
    } else if (bossName) {
      this.broadcast({ type: 'sys', style: 'kill', text: `👹 ${bossName} 击杀了 ${victim.name}` });
    } else if (!victim.isDecoy) {
      this.broadcast({ type: 'sys', style: 'kill', text: `💥 ${victim.name} 被炸飞了` });
    }
    this.broadcast({
      type: 'kill',
      k: kInfo, v: { id: victim.id, n: victim.name, c: victim.color },
      wp: wKey, wn: wName, boss: bossName || null, self: attacker === victim,
    });
    this.broadcast({ type: 'fx', k: 'die', id: victim.id, pos: this.chest(victim) });
    if (attacker && !attacker.isDecoy && victim.isDecoy) this.onDecoyKilled(attacker);
  }

  // ---------- 范围伤害（手雷/油桶/火箭/爆破 共用，含油桶连锁） ----------
  aoeDamage(pos, radius, dmg, attacker, opts = {}) {
    const falloff = opts.falloff === undefined ? 0.6 : opts.falloff;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - pos.x, (p.pos.y + 1) - pos.y, p.pos.z - pos.z);
      if (d <= radius) {
        this.applyDamage(p, dmg * (1 - falloff * d / radius), attacker, { wp: opts.wp, bossName: opts.bossName });
      }
    }
    if (this.boss) {
      const d = Math.hypot(this.boss.pos.x - pos.x, this.boss.pos.y + this.boss.cfg.yc - pos.y, this.boss.pos.z - pos.z);
      if (d <= radius + this.boss.cfg.radius && !opts.bossName) this.damageBoss(dmg, attacker);
    }
    for (const br of this.barrels) {
      if (!br.alive) continue;
      const d = Math.hypot(br.x - pos.x, 0.9 - pos.y, br.z - pos.z);
      if (d <= radius) this.damageBarrel(br, dmg, attacker);
    }
  }

  // ---------- 油桶 ----------
  damageBarrel(br, dmg, attacker) {
    if (!br.alive) return;
    br.hp -= dmg;
    if (br.hp <= 0) {
      br.alive = false;
      br.respawnAt = now() + rand(RULES.barrelRespawnMin, RULES.barrelRespawnMax) * 1000;
      this.broadcast({ type: 'fx', k: 'barrel', id: br.id });
      this.broadcast({ type: 'fx', k: 'explode', pos: [r2(br.x), 0.9, r2(br.z)], r: RULES.barrelRadius, fire: true });
      this.aoeDamage({ x: br.x, y: 0.9, z: br.z }, RULES.barrelRadius, RULES.barrelDmg, attacker, { wp: 'barrel', falloff: 0.5 });
    } else {
      this.broadcast({ type: 'fx', k: 'barrelhit', id: br.id, pos: [r2(br.x), 1.2, r2(br.z)] });
    }
  }

  // ---------- BOSS ----------
  clearAmiyaExtras() {
    this.unseenHands = [];
  }

  /** 目标死亡/离场时收回锁定他的不可视之手（无限延伸不代表目标消失后仍残留） */
  clearUnseenHandsForTarget(targetId) {
    if (targetId == null || !this.unseenHands.length) return;
    let removed = false;
    for (let i = this.unseenHands.length - 1; i >= 0; i--) {
      const h = this.unseenHands[i];
      if (h.targetId !== targetId) continue;
      this.broadcast({
        type: 'fx', k: 'handbreak',
        pos: [r2(h.pos.x), r2(h.pos.y), r2(h.pos.z)],
      });
      this.unseenHands.splice(i, 1);
      removed = true;
    }
    return removed;
  }

  amiyaWoundSum(b) {
    if (!b || !b.wounds) return 0;
    let s = 0;
    for (const w of b.wounds) s += w.dmg;
    return Math.round(s);
  }

  amiyaSaveCheckpoint(b, silent) {
    if (!b || b.type !== 'amiya') return;
    b.ckpt = { hp: b.hp, x: b.pos.x, y: b.pos.y, z: b.pos.z };
    if (!silent) {
      this.broadcast({
        type: 'fx', k: 'ckptSave',
        pos: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)],
      });
    }
  }

  amiyaReturnByDeath(b, reason) {
    if (!b || b.type !== 'amiya' || !b.ckpt) return false;
    const from = [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)];
    b.wounds = [];
    b.hp = Math.max(1, Math.round(b.ckpt.hp));
    b.pos.x = b.ckpt.x; b.pos.y = b.ckpt.y; b.pos.z = b.ckpt.z;
    b.pos.y = this.floorAtSrv({ x: b.pos.x, y: b.pos.y + 0.8, z: b.pos.z });
    circlePushBoxes(b.pos, b.cfg.radius, this.collideBoxes());
    b.stunUntil = 0;
    this.broadcast({
      type: 'fx', k: 'rbDeath',
      from, to: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)],
    });
    if (reason === 'lethal') {
      this.broadcast({ type: 'sys', style: 'boss', text: '——从零开始。' });
    } else {
      this.broadcast({ type: 'sys', style: 'boss', text: `「${b.name}」发动了死亡回归` });
    }
    return true;
  }

  /** 不可视之手：相对 BOSS 朝向的背后角点（side>0=左，elev>0=上） */
  unseenHandAnchor(b, side, elev) {
    const cfg = b.cfg || {};
    const yaw = b.yaw || 0;
    const bx = Math.sin(yaw), bz = Math.cos(yaw);
    const lx = -Math.cos(yaw), lz = Math.sin(yaw);
    const backOff = cfg.handAnchorBack != null ? cfg.handAnchorBack : (cfg.radius || 1) * 1.35 + 0.55;
    const sideOff = cfg.handAnchorSide != null ? cfg.handAnchorSide : (cfg.radius || 1) * 1.3 + 0.5;
    const elevOff = cfg.handAnchorElev != null ? cfg.handAnchorElev : (cfg.yc || 1.5) * 0.85;
    const midY = (b.pos.y || 0) + (cfg.handAnchorMidY != null ? cfg.handAnchorMidY : (cfg.yc || 1.5) * 1.1);
    return {
      x: b.pos.x + bx * backOff + lx * side * sideOff,
      y: midY + elev * elevOff,
      z: b.pos.z + bz * backOff + lz * side * sideOff,
    };
  }

  spawnUnseenHands(b, target, t) {
    const cfg = b.cfg;
    const yc = cfg.yc || 1.5;
    // 背后四角：左上、右上、左下、右下
    const slots = [
      { side: 1, elev: 1 },
      { side: -1, elev: 1 },
      { side: 1, elev: -1 },
      { side: -1, elev: -1 },
    ];
    const n = Math.min(cfg.handCount || 4, slots.length);
    const rifts = [];
    // 从 BOSS 背后四角虚空裂缝伸出，再伸向目标（不凭空出现在目标旁）
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      const a = this.unseenHandAnchor(b, s.side, s.elev);
      rifts.push([r2(a.x), r2(a.y), r2(a.z)]);
      const lifeSec = cfg.handLife == null ? 0 : +cfg.handLife;
      const dieAt = lifeSec > 0 ? t + lifeSec * 1000 : Number.POSITIVE_INFINITY; // 0 = 无限延伸
      this.unseenHands.push({
        id: this.entId++,
        pos: { x: a.x, y: a.y, z: a.z },
        yaw: Math.atan2(-(target.pos.x - a.x), -(target.pos.z - a.z)),
        hp: cfg.handHp, maxHp: cfg.handHp,
        targetId: target.id,
        nextSwing: t + 550 + i * 160,
        dieAt,
        bornAt: t,
        stretchUntil: t + 220 + i * 80, // 先贴体再甩出
        anchorSide: s.side,
        anchorElev: s.elev,
      });
    }
    this.broadcast({
      type: 'fx', k: 'unseenHand',
      pos: [r2(b.pos.x), r2(b.pos.y + yc), r2(b.pos.z)],
      rifts,
    });
    this.broadcast({
      type: 'sys',
      style: 'boss',
      text: '✋ 虚空裂缝撕开！不可视之手伸出——子弹可穿透，一枪可打断多只！',
    });
  }

  damageUnseenHand(hand, dmg, attacker) {
    if (!hand || hand.hp <= 0) return;
    hand.hp -= dmg;
    this.broadcast({
      type: 'fx', k: 'handhit',
      id: hand.id, dmg: Math.round(dmg), by: attacker ? attacker.id : 0,
      pos: [r2(hand.pos.x), r2(hand.pos.y), r2(hand.pos.z)],
    });
    if (hand.hp <= 0) {
      hand.hp = 0;
      hand.dieAt = 0;
      const b = this.boss;
      if (b && b.type === 'amiya') {
        b.stunUntil = Math.max(b.stunUntil || 0, now() + (b.cfg.echoStunMs || 1200));
        this.broadcast({ type: 'fx', k: 'handbreak', pos: [r2(hand.pos.x), r2(hand.pos.y), r2(hand.pos.z)] });
      }
    }
  }

  updateUnseenHands(dt, t) {
    const b = this.boss;
    const cfg = b && b.type === 'amiya' ? b.cfg : null;
    for (let i = this.unseenHands.length - 1; i >= 0; i--) {
      const h = this.unseenHands[i];
      if (h.hp <= 0 || t >= h.dieAt || !b || b.type !== 'amiya') {
        this.unseenHands.splice(i, 1);
        continue;
      }
      const target = this.players.get(h.targetId);
      if (!target || !target.alive) {
        this.unseenHands.splice(i, 1);
        continue;
      }
      // 贴体蓄力阶段：钉在 BOSS 背后对应角点，随朝向转动
      if (t < (h.stretchUntil || 0)) {
        const side = h.anchorSide == null ? 1 : h.anchorSide;
        const elev = h.anchorElev == null ? 1 : h.anchorElev;
        const a = this.unseenHandAnchor(b, side, elev);
        h.pos.x = a.x; h.pos.y = a.y; h.pos.z = a.z;
        h.yaw = Math.atan2(-(target.pos.x - h.pos.x), -(target.pos.z - h.pos.z));
        continue;
      }
      const dx = target.pos.x - h.pos.x, dz = target.pos.z - h.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      h.yaw = Math.atan2(-dx, -dz);
      // 甩出后由慢加速：handSpeedRamp 秒内从 startMul 爬到顶峰；越远仍略快，可无限拉长追击
      const baseSpd = cfg.handSpeed || 14;
      const rampSec = cfg.handSpeedRamp || 7;
      const startMul = cfg.handSpeedStartMul == null ? 0.28 : cfg.handSpeedStartMul;
      const chaseAge = Math.max(0, (t - (h.stretchUntil || h.bornAt || t)) / 1000);
      const timeMul = startMul + (1 - startMul) * Math.min(1, chaseAge / Math.max(0.01, rampSec));
      const spd = baseSpd * (1.1 + Math.min(3.5, dist / 12)) * timeMul;
      if (dist > 1.35) {
        h.pos.x += (dx / dist) * spd * dt;
        h.pos.z += (dz / dist) * spd * dt;
      }
      const aimY = target.pos.y + 1.1;
      h.pos.y += (aimY - h.pos.y) * Math.min(1, dt * 8);
      if (t >= h.nextSwing && dist < 2.4) {
        h.nextSwing = t + 850;
        this.broadcast({ type: 'fx', k: 'envySlash', pos: this.chest(target) });
        this.applyDamage(target, cfg.handDmg || 16, null, { bossName: b.name });
      }
    }
  }

  updateEnvyShadow(dt, t) {
    const b = this.boss;
    if (!b || b.type !== 'amiya' || !b.shadow) return;
    const sh = b.shadow;
    if (t < sh.until) return;
    const cfg = b.cfg;
    const r = sh.r || cfg.shadowR || 6;
    const dmg = cfg.shadowDmg || 36;
    const pos = { x: sh.x, y: 0.6, z: sh.z };
    b.shadow = null;
    this.broadcast({
      type: 'fx', k: 'explode',
      pos: [r2(pos.x), r2(pos.y), r2(pos.z)],
      r, vp: true, envy: true,
    });
    this.aoeDamage(pos, r, dmg, null, { bossName: b.name, falloff: 0.3 });
  }

  settleAmiyaWounds(b, t) {
    if (!b || b.type !== 'amiya' || !b.wounds || !b.wounds.length) return;
    const left = [];
    let killer = null;
    for (const w of b.wounds) {
      if (t < w.applyAt) { left.push(w); continue; }
      b.hp -= w.dmg;
      if (w.by) {
        const atk = this.players.get(w.by);
        if (atk) {
          this.zombieLifesteal(atk, w.dmg);
          killer = atk;
        }
      }
      this.broadcast({
        type: 'fx', k: 'fateWound', dmg: w.dmg, by: w.by || 0,
        pos: [r2(b.pos.x), r2(b.pos.y + b.cfg.yc), r2(b.pos.z)],
      });
    }
    b.wounds = left;
    if (b.hp > 0) return;
    if ((b.rbDeathLeft | 0) > 0 && b.ckpt) {
      b.rbDeathLeft--;
      this.amiyaReturnByDeath(b, 'lethal');
      return;
    }
    this.defeatBoss(killer);
  }

  defeatBoss(killer) {
    const b = this.boss;
    if (!b) return;
    this.broadcast({ type: 'fx', k: 'explode', pos: [r2(b.pos.x), 1.5, r2(b.pos.z)], r: 8, boss: true });
    if (killer && this.players.has(killer.id) && !killer.isDecoy) {
      killer.score += BOSS.killScore; killer.coins += b.cfg.killCoins;
      killer.hp = RULES.maxHp;
      const bk = pick(Object.keys(BUFFS));
      killer.buffs[bk] = now() + BUFFS[bk].dur * 1000;
      if (bk === 'shield') killer.shield = RULES.shieldHp;
      if (bk === 'zombie') killer.active = 'melee';
      const prof = board.getForPlayer(killer); prof.bossKills++; board.save();
      this.saveProfile(killer);
      this.broadcast({ type: 'sys', style: 'boss', text: `🏆 ${killer.name} 击杀了 BOSS「${b.name}」！获得 ${b.cfg.killCoins} 金币 + 满血 + ${BUFFS[bk].name}增益` });
      this.sendYou(killer);
      if (b.type === 'amiya' && this.isAmiyaPlayer(killer)) {
        this.sendTo(killer.id, { type: 'priv', text: '……这次，没有再回来。' });
      }
    } else if (killer && killer.isDecoy) {
      this.broadcast({ type: 'sys', style: 'boss', text: `BOSS「${b.name}」被击败了！` });
    }
    for (const [pid, d] of b.damagers) {
      const p = this.players.get(pid);
      if (p && p !== killer && !p.isDecoy && d >= BOSS.assistMin) {
        p.coins += BOSS.assistCoins;
        this.sendTo(pid, { type: 'got', kind: 'coin', name: `BOSS 助攻 +${BOSS.assistCoins} 金币`, desc: '' });
        this.sendYou(p);
      }
    }
    this.clearAmiyaExtras();
    this.boss = null;
    this.nextBossAt = now() + rand(BOSS.respawnMin, BOSS.respawnMax) * 1000;
  }

  spawnBoss() {
    let type = this.forceBossType && BOSSES[this.forceBossType] ? this.forceBossType : pick(Object.keys(BOSSES));
    this.forceBossType = null;
    const cfg = BOSSES[type];
    const [x, z] = pick(MAP.bossSpawns);
    this.clearAmiyaExtras();
    this.boss = {
      type, cfg, name: cfg.name, hp: cfg.hp, maxHp: cfg.hp,
      pos: { x, y: 0, z }, yaw: 0,
      nextMelee: 0, nextFire: now() + 2500,
      nextBlink: now() + 4000, invisUntil: 0, nextInvis: now() + 7000,
      nextBurst: now() + 3000, burstLeft: 0, burstNextAt: 0,
      nextRocket: now() + 6000,
      nextOrb: now() + 2500, nextBlast: now() + 5000,
      strafeDir: 1, nextStrafeFlip: 0,
      wander: null, wanderUntil: 0,
      damagers: new Map(),
      wounds: [], ckpt: null, shadow: null, stunUntil: 0,
      rbDeathLeft: type === 'amiya' && cfg.rbDeathOnce !== false ? 1 : 0,
      nextSave: type === 'amiya' ? now() + 2000 : 0,
      nextLoad: type === 'amiya' ? now() + 8000 : 0,
      nextHand: type === 'amiya' ? now() + 3500 : 0,
      nextShadow: type === 'amiya' ? now() + 5000 : 0,
    };
    const tip = type === 'amiya'
      ? `⚠️ BOSS「${cfg.name}」降临！因果开始扭曲……击杀可获 ${cfg.killCoins} 金币与强力增益`
      : `⚠️ BOSS「${cfg.name}」降临竞技场！击杀可获 ${cfg.killCoins} 金币与强力增益`;
    this.broadcast({ type: 'sys', style: 'boss', text: tip });
    this.broadcast({ type: 'fx', k: 'roar', pos: [x, 0, z] });
    if (type === 'amiya') this.amiyaSaveCheckpoint(this.boss, true);
  }

  damageBoss(dmg, attacker) {
    const b = this.boss;
    if (!b) return;
    if (attacker?.isDecoy) dmg = Math.max(1, Math.round(dmg * DECOY.bossDmgMul));
    else dmg = Math.round(dmg);
    if (dmg <= 0) return;

    if (b.type === 'amiya') {
      const delay = (b.cfg.woundDelay || 3) * 1000;
      b.wounds.push({ dmg, by: attacker ? attacker.id : 0, applyAt: now() + delay });
      if (attacker) b.damagers.set(attacker.id, (b.damagers.get(attacker.id) || 0) + dmg);
      this.broadcast({
        type: 'fx', k: 'bosshit', dmg, by: attacker ? attacker.id : 0, fate: 1,
        pos: [r2(b.pos.x), r2(b.pos.y + b.cfg.yc), r2(b.pos.z)],
      });
      return;
    }

    b.hp -= dmg;
    if (attacker) {
      b.damagers.set(attacker.id, (b.damagers.get(attacker.id) || 0) + dmg);
      this.zombieLifesteal(attacker, dmg);
    }
    this.broadcast({ type: 'fx', k: 'bosshit', dmg, by: attacker ? attacker.id : 0, pos: [r2(b.pos.x), r2(b.pos.y + b.cfg.yc), r2(b.pos.z)] });
    if (b.hp <= 0) this.defeatBoss(attacker);
  }

  spawnProj(kind, pos, vel, dmg, opts = {}) {
    this.projs.push(Object.assign({ id: this.entId++, kind, pos, vel, dmg, born: now() }, opts));
  }

  aimAt(from, fromY, target) { // 归一化指向目标胸口的方向
    const d = { x: target.pos.x - from.x, y: (target.pos.y + 1.1) - fromY, z: target.pos.z - from.z };
    const L = Math.hypot(d.x, d.y, d.z) || 1;
    return { x: d.x / L, y: d.y / L, z: d.z / L };
  }

  updateBoss(dt, t) {
    if (!this.boss) {
      if (t >= this.nextBossAt && [...this.players.values()].some(p => p.alive)) this.spawnBoss();
      return;
    }
    const b = this.boss, cfg = b.cfg;
    let target = null, bd = BOSS.aggro;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      if (d < bd) { bd = d; target = p; }
    }
    let mx = 0, mz = 0;
    if (target) {
      const dx = target.pos.x - b.pos.x, dz = target.pos.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
      b.yaw = Math.atan2(-dx, -dz);
      const ux = dx / d, uz = dz / d;
      const meleeOk = Math.abs(target.pos.y - b.pos.y) < 1.8;   // 相对高度：同台可打，高台对地面近战无效

      if (b.type === 'golem') {
        if (d > cfg.meleeRange * 0.75) { mx = ux; mz = uz; }
        if (d <= cfg.meleeRange && meleeOk && t >= b.nextMelee) {
          b.nextMelee = t + cfg.meleeCd * 1000;
          this.broadcast({ type: 'fx', k: 'slam', pos: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)], r: cfg.meleeRange + 0.6 });
          for (const p of this.players.values()) {
            if (!p.alive || Math.abs(p.pos.y - b.pos.y) > 1.8) continue;
            if (Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) <= cfg.meleeRange + 0.6)
              this.applyDamage(p, cfg.meleeDmg, null, { bossName: b.name });
          }
        }
        if (t >= b.nextFire && d > 4 && d < 38) {
          b.nextFire = t + cfg.fireCd * 1000;
          const fromY = b.pos.y + 2.6;
          const dir = this.aimAt(b.pos, fromY, target);
          this.spawnProj('fire', { x: b.pos.x + dir.x * 1.2, y: fromY, z: b.pos.z + dir.z * 1.2 },
            { x: dir.x * cfg.fireSpeed, y: dir.y * cfg.fireSpeed, z: dir.z * cfg.fireSpeed }, cfg.fireDmg, { bossName: b.name, aoe: 2 });
          this.broadcast({ type: 'fx', k: 'bossfire', pos: [r2(b.pos.x), r2(fromY), r2(b.pos.z)] });
        }
      } else if (b.type === 'assassin') {
        if (d > cfg.meleeRange * 0.7) { mx = ux; mz = uz; }
        const heightGap = Math.abs(target.pos.y - b.pos.y) > 1.6;
        if (t >= b.nextBlink && (d > 5 || heightGap)) {
          b.nextBlink = t + cfg.blinkCd * 1000;
          const from = [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)];
          // 闪到玩家朝向身后，并贴齐其所在高度（可上高台）
          const back = 2.2;
          b.pos.x = target.pos.x + Math.sin(target.yaw) * back;
          b.pos.z = target.pos.z + Math.cos(target.yaw) * back;
          b.pos.y = this.floorAtSrv({ x: b.pos.x, y: target.pos.y + 0.8, z: b.pos.z });
          circlePushBoxes(b.pos, cfg.radius, this.collideBoxes());
          b.pos.y = this.floorAtSrv({ x: b.pos.x, y: Math.max(b.pos.y, target.pos.y) + 0.8, z: b.pos.z });
          b.yaw = Math.atan2(-(target.pos.x - b.pos.x), -(target.pos.z - b.pos.z));
          this.broadcast({ type: 'fx', k: 'blink', from, to: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z)] });
        }
        if (t >= b.nextInvis) {
          b.nextInvis = t + cfg.invisCd * 1000;
          b.invisUntil = t + cfg.invisDur * 1000;
        }
        if (d <= cfg.meleeRange && meleeOk && t >= b.nextMelee) {
          b.nextMelee = t + cfg.meleeCd * 1000;
          this.broadcast({ type: 'fx', k: 'slash', pos: this.chest(target) });
          this.applyDamage(target, cfg.meleeDmg, null, { bossName: b.name });
        }
      } else if (b.type === 'warmachine') {
        if (d > 22) { mx = ux; mz = uz; }
        if (t >= b.nextBurst && d < 34) {
          b.nextBurst = t + cfg.burstCd * 1000 + cfg.burstCount * cfg.burstGap * 1000;
          b.burstLeft = cfg.burstCount;
          b.burstNextAt = t;
          this.broadcast({ type: 'fx', k: 'burst', pos: [r2(b.pos.x), r2(b.pos.y + cfg.yc), r2(b.pos.z)] });
        }
        if (b.burstLeft > 0 && t >= b.burstNextAt) {
          b.burstLeft--;
          b.burstNextAt = t + cfg.burstGap * 1000;
          const fromY = b.pos.y + cfg.yc;
          const dir = this.aimAt(b.pos, fromY, target);
          const sp = 0.045;
          dir.x += rand(-sp, sp); dir.y += rand(-sp, sp); dir.z += rand(-sp, sp);
          this.spawnProj('bullet', { x: b.pos.x + dir.x * 2, y: fromY, z: b.pos.z + dir.z * 2 },
            { x: dir.x * cfg.bulletSpeed, y: dir.y * cfg.bulletSpeed, z: dir.z * cfg.bulletSpeed }, cfg.burstDmg, { bossName: b.name });
        }
        if (t >= b.nextRocket && d > 6 && d < 36) {
          b.nextRocket = t + cfg.rocketCd * 1000;
          const fromY = b.pos.y + cfg.yc;
          this.broadcast({ type: 'fx', k: 'bossfire', pos: [r2(b.pos.x), r2(fromY), r2(b.pos.z)] });
          for (const ang of [-0.18, 0, 0.18]) {
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dir = this.aimAt(b.pos, fromY, target);
            const rx = dir.x * cos - dir.z * sin, rz = dir.x * sin + dir.z * cos;
            this.spawnProj('fire', { x: b.pos.x + rx * 2, y: fromY, z: b.pos.z + rz * 2 },
              { x: rx * cfg.fireSpeed, y: dir.y * cfg.fireSpeed, z: rz * cfg.fireSpeed }, cfg.rocketDmg, { bossName: b.name, aoe: 2.5 });
          }
        }
      } else if (b.type === 'lich') {
        // 风筝走位：太近后撤，太远靠近，中距横移
        if (d < 7) { mx = -ux; mz = -uz; }
        else if (d > 20) { mx = ux; mz = uz; }
        else {
          if (t > b.nextStrafeFlip) { b.strafeDir *= -1; b.nextStrafeFlip = t + 3000; }
          mx = -uz * b.strafeDir; mz = ux * b.strafeDir;
        }
        if (t >= b.nextOrb) {
          b.nextOrb = t + cfg.orbCd * 1000;
          const fromY = b.pos.y + cfg.yc;
          const dir = this.aimAt(b.pos, fromY, target);
          this.spawnProj('orb', { x: b.pos.x + dir.x * 1.5, y: fromY, z: b.pos.z + dir.z * 1.5 },
            { x: dir.x * cfg.orbSpeed, y: dir.y * cfg.orbSpeed, z: dir.z * cfg.orbSpeed }, cfg.orbDmg,
            { bossName: b.name, targetId: target.id });
          this.broadcast({ type: 'fx', k: 'cast', pos: [r2(b.pos.x), r2(fromY), r2(b.pos.z)] });
        }
        if (t >= b.nextBlast) {
          b.nextBlast = t + cfg.blastCd * 1000;
          const pos = { x: target.pos.x, y: target.pos.y + 0.5, z: target.pos.z };
          this.blasts.push({ pos, at: t + cfg.blastDelay * 1000, dmg: cfg.blastDmg, r: cfg.blastR, bossName: b.name });
          this.broadcast({ type: 'fx', k: 'voidring', pos: [r2(pos.x), r2(target.pos.y) + 0.05, r2(pos.z)], r: cfg.blastR, ms: cfg.blastDelay * 1000 });
        }
      } else if (b.type === 'amiya') {
        const stunned = t < (b.stunUntil || 0);
        // 风筝走位
        if (d < 6) { mx = -ux; mz = -uz; }
        else if (d > 16) { mx = ux; mz = uz; }
        else {
          if (t > b.nextStrafeFlip) { b.strafeDir *= -1; b.nextStrafeFlip = t + 2800; }
          mx = -uz * b.strafeDir; mz = ux * b.strafeDir;
        }
        if (!stunned) {
          if (t >= b.nextSave) {
            b.nextSave = t + cfg.saveCd * 1000;
            this.amiyaSaveCheckpoint(b, false);
          }
          const hpRatio = b.hp / b.maxHp;
          const woundPressure = this.amiyaWoundSum(b) / Math.max(1, b.maxHp);
          if (t >= b.nextLoad && b.ckpt && (hpRatio < 0.45 || woundPressure > 0.22 || d < 4.5)) {
            b.nextLoad = t + cfg.loadCd * 1000;
            this.amiyaReturnByDeath(b, 'active');
          }
          if (t >= b.nextHand) {
            b.nextHand = t + cfg.handCd * 1000;
            this.spawnUnseenHands(b, target, t);
          }
          if (t >= b.nextShadow) {
            b.nextShadow = t + cfg.shadowCd * 1000;
            const delayMs = (cfg.shadowDelay || 2.5) * 1000;
            b.shadow = {
              x: target.pos.x, z: target.pos.z, r: cfg.shadowR,
              until: t + delayMs,
            };
            this.broadcast({
              type: 'fx', k: 'envyShadow',
              pos: [r2(b.shadow.x), r2(target.pos.y) + 0.05, r2(b.shadow.z)],
              r: cfg.shadowR, ms: delayMs,
            });
          }
          if (d <= cfg.meleeRange && meleeOk && t >= b.nextMelee) {
            b.nextMelee = t + cfg.meleeCd * 1000;
            this.broadcast({ type: 'fx', k: 'envySlash', pos: this.chest(target) });
            this.applyDamage(target, cfg.meleeDmg, null, { bossName: b.name });
          }
        } else {
          mx *= 0.35; mz *= 0.35;
        }
      }
    } else {
      if (!b.wander || t > b.wanderUntil) {
        b.wander = { x: rand(-20, 20), z: rand(-20, 20) };
        b.wanderUntil = t + 5000;
      }
      const dx = b.wander.x - b.pos.x, dz = b.wander.z - b.pos.z, d = Math.hypot(dx, dz);
      if (d > 1.5) { mx = dx / d * 0.5; mz = dz / d * 0.5; b.yaw = Math.atan2(-dx, -dz); }
    }
    // 贴墙卡住时侧向绕行，严重卡住则挪到新出生点
    if (b.stuckSide && (mx || mz)) {
      const ox = mx, oz = mz;
      mx = -oz * b.stuckSide * 0.85 + ox * 0.25;
      mz = ox * b.stuckSide * 0.85 + oz * 0.25;
    }
    const px0 = b.pos.x, pz0 = b.pos.z;
    b.pos.x += mx * cfg.speed * dt;
    b.pos.z += mz * cfg.speed * dt;
    circlePushBoxes(b.pos, cfg.radius, this.collideBoxes());
    const moved = Math.hypot(b.pos.x - px0, b.pos.z - pz0);
    const want = Math.hypot(mx, mz) * cfg.speed * dt;
    if (want > 0.05 && moved < want * 0.25) {
      b.stuckN = (b.stuckN || 0) + 1;
      if (b.stuckN === 4 || b.stuckN === 12) b.stuckSide = (b.stuckSide || 1) * -1;
      if (b.stuckN > 28) {
        const [sx, sz] = pick(MAP.bossSpawns);
        b.pos.x = sx + rand(-2, 2);
        b.pos.z = sz + rand(-2, 2);
        b.pos.y = 0;
        b.stuckN = 0;
        b.stuckSide = 0;
        circlePushBoxes(b.pos, cfg.radius, this.collideBoxes());
      }
    } else {
      b.stuckN = Math.max(0, (b.stuckN || 0) - 2);
      if (!b.stuckN) b.stuckSide = 0;
    }
    // 贴地/贴台：走下平台时回落，避免悬空
    b.pos.y = this.floorAtSrv({ x: b.pos.x, y: b.pos.y + 0.55, z: b.pos.z });
  }

  // ---------- 世界更新 ----------
  update(dt) {
    const t = now();
    for (const p of this.players.values()) {
      if (p._cheat && p.alive) p.hp = RULES.maxHp;
      if (p.gun && p.reloadUntil && t >= p.reloadUntil) {   // 换弹完成：从备弹补入当前匣（可能不足一匣）
        const mag = WEAPONS[p.gun].mag, take = Math.min(mag - p.ammo, p.ammoReserve);
        p.ammo += take; p.ammoReserve -= take; p.reloadUntil = 0;
      }
      if (!p.alive && t >= p.deadUntil) this.respawn(p);
      for (const k of Object.keys(p.buffs)) if (p.buffs[k] <= t) delete p.buffs[k];
      if (p.alive && p.cooking && t >= p.cooking.explodeAt) this.detonateHeld(p);
      if (p.charging) this.updateCharging(p, t);
      this.checkDecoyAfk(p, t);
    }
    // 手雷
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.vel.y -= RULES.gravity * dt;
      g.pos.x += g.vel.x * dt; g.pos.y += g.vel.y * dt; g.pos.z += g.vel.z * dt;
      if (g.pos.y < 0.2 && g.vel.y < 0) { g.pos.y = 0.2; g.vel.y *= -0.38; g.vel.x *= 0.65; g.vel.z *= 0.65; }
      const lim = MAP.half - 0.3;
      if (Math.abs(g.pos.x) > lim) { g.pos.x = clamp(g.pos.x, -lim, lim); g.vel.x *= -0.5; }
      if (Math.abs(g.pos.z) > lim) { g.pos.z = clamp(g.pos.z, -lim, lim); g.vel.z *= -0.5; }
      if (t >= g.explodeAt) {
        this.grenades.splice(i, 1);
        const def = WEAPONS[g.kind] || WEAPONS.nade;
        const owner = this.players.get(g.owner) || null;
        this.detonateGrenade(g.pos, g.kind, def, owner);
      }
    }
    // BOSS 弹道（火球/弹幕/追踪法球）
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const f = this.projs[i];
      // 追踪法球转向
      if (f.kind === 'orb' && f.targetId) {
        const tp = this.players.get(f.targetId);
        if (tp && tp.alive) {
          const dir = this.aimAt(f.pos, f.pos.y, tp);
          const sp = Math.hypot(f.vel.x, f.vel.y, f.vel.z) || 1;
          const k = Math.min(1, dt * 2.4);
          f.vel.x += (dir.x * sp - f.vel.x) * k;
          f.vel.y += (dir.y * sp - f.vel.y) * k;
          f.vel.z += (dir.z * sp - f.vel.z) * k;
        }
      }
      // 障碍物阻挡
      const vlen = Math.hypot(f.vel.x, f.vel.y, f.vel.z) * dt;
      if (vlen > 0) {
        const nd = { x: f.vel.x, y: f.vel.y, z: f.vel.z };
        const L = Math.hypot(nd.x, nd.y, nd.z); nd.x /= L; nd.y /= L; nd.z /= L;
        const tb = this.obstacleBlock(f.pos, nd, vlen);
        if (tb < vlen) {
          f.pos.x += nd.x * tb; f.pos.y += nd.y * tb; f.pos.z += nd.z * tb;
          this.explodeProj(f, i);
          continue;
        }
      }
      f.pos.x += f.vel.x * dt; f.pos.y += f.vel.y * dt; f.pos.z += f.vel.z * dt;
      let boom = false;
      const hitR = f.kind === 'bullet' ? 0.8 : f.kind === 'orb' ? 1.0 : 1.15;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.pos.x - f.pos.x, p.pos.y + 1.2 - f.pos.y, p.pos.z - f.pos.z) < hitR) {
          if (f.kind === 'bullet') this.applyDamage(p, f.dmg, null, { bossName: f.bossName });
          boom = true; break;
        }
      }
      const life = f.kind === 'bullet' ? 2500 : f.kind === 'orb' ? 6000 : 4500;
      if (!boom && (f.pos.y < 0.1 || Math.abs(f.pos.x) > MAP.half || Math.abs(f.pos.z) > MAP.half || t - f.born > life)) boom = true;
      if (boom) this.explodeProj(f, i);
    }
    // 巫妖延迟爆破
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const bl = this.blasts[i];
      if (t >= bl.at) {
        this.blasts.splice(i, 1);
        this.broadcast({ type: 'fx', k: 'explode', pos: [r2(bl.pos.x), r2(bl.pos.y), r2(bl.pos.z)], r: bl.r, vp: true });
        this.aoeDamage(bl.pos, bl.r, bl.dmg, null, { bossName: bl.bossName, falloff: 0.3 });
      }
    }
    this.updateBoss(dt, t);
    if (this.boss && this.boss.type === 'amiya') {
      this.settleAmiyaWounds(this.boss, t);
      this.updateEnvyShadow(dt, t);
    }
    this.updateUnseenHands(dt, t);
    // 拾取点刷新
    for (const pk of this.pickups) {
      if (!pk.avail && t >= pk.respawnAt) {
        pk.avail = true;
        pk.item = this.rollPickupItem(pk);
        this.broadcast({ type: 'pk', ev: 'spawn', id: pk.def.id, item: pk.item });
      }
    }
    // 油桶重生
    for (const br of this.barrels) {
      if (!br.alive && t >= br.respawnAt) {
        br.alive = true;
        br.hp = RULES.barrelHp;
        this.broadcast({ type: 'fx', k: 'barrelup', id: br.id });
      }
    }
  }

  explodeProj(f, idx) {
    this.projs.splice(idx, 1);
    if (f.kind === 'bullet') {
      this.broadcast({ type: 'fx', k: 'pimpact', pos: [r2(f.pos.x), r2(Math.max(0.1, f.pos.y)), r2(f.pos.z)] });
      return;
    }
    const r = f.aoe || (f.kind === 'orb' ? 1.6 : 2);
    this.broadcast({ type: 'fx', k: 'explode', pos: [r2(f.pos.x), r2(Math.max(0.2, f.pos.y)), r2(f.pos.z)], r, fire: f.kind === 'fire', vp: f.kind === 'orb' });
    this.aoeDamage({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, r, f.dmg, null, { bossName: f.bossName, falloff: 0.35 });
  }

  // ---------- 快照 ----------
  snapshot() {
    const t = now();
    const pl = [];
    for (const p of this.players.values()) {
      pl.push({
        i: p.id, n: p.name, c: p.color,
        p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], ya: r2(p.yaw), pi: r2(p.pitch), an: p.anim,
        hp: Math.max(0, Math.round(p.hp)), ar: Math.round(p.armor), sh: Math.round(p.shield),
        al: p.alive ? 1 : 0, ac: p.active, mw: p.melee, gw: p.gun, ng: p.nadeType || null,
        am: p.ammo, re: p.ammoReserve, nl: p.nadeLeft, rl: p.reloadUntil > t ? p.reloadUntil - t : 0,
        ck: p.cooking ? Math.max(0, p.cooking.explodeAt - t) : 0,
        dd: !p.alive ? Math.max(0, p.deadUntil - t) : 0,
        pr: p.protectUntil > t ? 1 : 0, bo: p.boots,
        bf: Object.entries(p.buffs).map(([k, until]) => [k, until - t]),
        eq: p.eq, k: p.kills, d: p.deaths, s: p.score, co: p.coins, st: p.streak,
        zg: this.hasDevTrophy(p) ? 1 : 0,
      });
    }
    return {
      type: 'state', t,
      day: r5((t % RULES.dayMs) / RULES.dayMs),
      pl,
      boss: this.boss ? {
        tp: this.boss.type, nm: this.boss.name,
        hp: Math.max(0, this.boss.hp), mx: this.boss.maxHp,
        p: [r2(this.boss.pos.x), r2(this.boss.pos.y), r2(this.boss.pos.z)], ya: r2(this.boss.yaw),
        iv: this.boss.invisUntil > t ? 1 : 0,
        wq: this.boss.type === 'amiya' ? this.amiyaWoundSum(this.boss) : 0,
        rb: this.boss.type === 'amiya' ? (this.boss.rbDeathLeft | 0) : 0,
        ckpt: this.boss.type === 'amiya' && this.boss.ckpt
          ? [r2(this.boss.ckpt.x), r2(this.boss.ckpt.y || 0), r2(this.boss.ckpt.z)] : null,
        shadow: this.boss.type === 'amiya' && this.boss.shadow && this.boss.shadow.until > t
          ? [r2(this.boss.shadow.x), r2(this.boss.shadow.z), r2(this.boss.shadow.r),
            Math.max(0, this.boss.shadow.until - t)] : null,
      } : null,
      hands: this.unseenHands.map(h => [
        h.id, r2(h.pos.x), r2(h.pos.y), r2(h.pos.z), r2(h.yaw),
        Math.max(0, Math.round(h.hp)), h.maxHp | 0,
        h.anchorSide == null ? 1 : h.anchorSide,
        h.anchorElev == null ? 1 : h.anchorElev,
      ]),
      fb: this.projs.map(f => [f.id, r2(f.pos.x), r2(f.pos.y), r2(f.pos.z), r2(f.vel.x), r2(f.vel.y), r2(f.vel.z), PROJ_KIND[f.kind] || 0]),
      gd: this.grenades.map(g => [g.id, r2(g.pos.x), r2(g.pos.y), r2(g.pos.z), r2(g.vel.x), r2(g.vel.y), r2(g.vel.z), NADE_KIND[g.kind] || 0]),
      pk: this.pickups.map(pk => pk.avail ? pk.item : null),
      br: this.barrels.map(b => b.alive ? 1 : 0),
      nb: !this.boss ? Math.max(0, this.nextBossAt - t) : 0,
    };
  }

  boardMsg() {
    const rt = [...this.players.values()]
      .filter(p => !p.isDecoy)
      .sort((a, b) => b.kills - a.kills || b.streak - a.streak || b.score - a.score || a.deaths - b.deaths)
      .map(p => ({ i: p.id, n: p.name, c: p.color, k: p.kills, d: p.deaths, s: p.score, st: p.streak }));
    return { type: 'board', rt, hist: board.top(50) };
  }
}

module.exports = World;
