// 零区冲突 — 服务端入口：静态客户端与 WebSocket 联机（房间制，每厅最多 10 名真人）
// 反作弊：AC_MODE=off 可关闭惩罚（冷却/数值等功能校验仍生效），详见 server/anticheat/README.md
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

// 读取项目根目录的 .env。该文件不入库；进程里已有的环境变量优先。
(function loadLocalEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  } catch (_) {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();
const express = require('express');
const { WebSocketServer } = require('ws');
const World = require('./world');
const board = require('./leaderboard');
const cfg = require('./config');
const { AntiCheat, fpsPreset, createJsonStore, TokenBucket, RATE_PRESETS } = require('./anticheat');
const { normalizeIp } = require('./iputil');
const zard = require('./decoy/zard');

const PORT = process.env.PORT || 3066;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const NPC_TOKEN = process.env.NPC_TOKEN || crypto.randomBytes(16).toString('hex');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const queue = require('./queue');
const chatlog = require('./chatlog');
const { containsProfanity } = require('./chatfilter');
const oauthNl = require('./oauth-nodeloc');
const oauthLd = require('./oauth-linuxdo');
const app = express();
app.use(express.json({ limit: '2kb' }));

// OAuth：NodeLoc 回调 /oauth/nodeloc，LinuxDo 回调 /auth/callback（/oauth/linuxdo 仍可发起登录）
app.get('/oauth/nodeloc', (req, res) => oauthNl.route(req, res));
app.get('/auth/callback', (req, res) => oauthLd.route(req, res));
app.get('/oauth/linuxdo', (req, res) => oauthLd.route(req, res));

function oauthUserFromReq(req) {
  return oauthNl.userFromReq(req) || oauthLd.userFromReq(req);
}

function publicOauthUser(user) {
  if (!user) return null;
  const provider = user.provider || (String(user.id).startsWith('ld:') ? 'linuxdo' : 'nodeloc');
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    provider,
  };
}

app.get('/api/oauth/me', (req, res) => {
  const user = oauthUserFromReq(req);
  res.json({
    ok: true,
    enabled: oauthNl.enabled() || oauthLd.enabled(),
    nodelocEnabled: oauthNl.enabled(),
    linuxdoEnabled: oauthLd.enabled(),
    loggedIn: !!user,
    user: publicOauthUser(user),
    loginUrl: oauthNl.loginStartUrl(false),
    nativeLoginUrl: oauthNl.loginStartUrl(true),
    linuxdoLoginUrl: oauthLd.loginStartUrl(false),
    linuxdoNativeLoginUrl: oauthLd.loginStartUrl(true),
  });
});
app.post('/api/oauth/logout', (req, res) => {
  oauthNl.clearSessionCookie(res, req);
  oauthLd.clearSessionCookie(res, req);
  res.json({ ok: true });
});

/** 全厅真人合计（假人不占名额）。排队接口仍可读这个数。 */
function countActivePlayers() {
  return totalHumans();
}
function queueCap() { return cfg.RULES.queueCap; }
function canEnterWithoutQueue() {
  // 容量按厅计算，首页始终进入大厅
  return true;
}

// 入场门禁：人满时根路径只给轻量排队页，避免下载 Three.js / logo / 游戏脚本
app.get(['/', '/play'], (req, res) => {
  if (!canEnterWithoutQueue(req)) {
    return res.sendFile(path.join(PUBLIC_DIR, 'queue.html'));
  }
  // 未持票但有空位：签发短期准入，保证后续静态资源不被中间层拦下
  if (!queue.validAdmit(queue.admitFromReq(req))) {
    queue.setAdmitCookie(res, queue.issueAdmit());
  } else {
    // 续期 cookie（validAdmit 已滑动过期时间）
    const tok = queue.admitFromReq(req);
    if (tok) queue.setAdmitCookie(res, tok);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/queue', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'queue.html'));
});

function queuePayload(req, bodyTicket) {
  const ticket = bodyTicket || String(req.query.ticket || '');
  return queue.enter(countActivePlayers(), queueCap(), ticket || undefined);
}

app.post('/api/queue/enter', (req, res) => {
  const d = queuePayload(req, req.body && req.body.ticket);
  if (d.admitted && d.token) queue.setAdmitCookie(res, d.token);
  res.json(d);
});

app.get('/api/queue/status', (req, res) => {
  const d = queuePayload(req);
  if (d.admitted && d.token) queue.setAdmitCookie(res, d.token);
  res.json(d);
});

app.post('/api/queue/bypass', (req, res) => {
  const ip = normalizeIp(String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown');
  const d = queue.bypass(req.body && req.body.code, req.body && req.body.ticket, ip);
  if (d.ok && d.token) queue.setAdmitCookie(res, d.token);
  res.json(d);
});

// 人满且无准入时拦截重资源（排队页本身为零外链）
const HEAVY_ASSET = /^\/(index\.html|js\/|lib\/|css\/style\.css|icons\/)/i;
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!HEAVY_ASSET.test(req.path)) return next();
  if (canEnterWithoutQueue(req)) return next();
  res.status(503).type('text/plain').send('queue');
});

app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    players: totalHumans(),
    rooms: rooms.size,
    roomCap: ROOM_CAP,
    activePlayers: countActivePlayers(),
    queue: queue.queueLen(),
    queueCap: queueCap(),
    spectators: countSpectators(),
    uptime: Math.round(process.uptime()),
    anticheat: ac.status(),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------- 广播 ----------
function countSpectators() {
  let n = 0;
  for (const ws of wss.clients) if (ws.spectator) n++;
  return n;
}
function rawSend(ws, str, droppable) {
  if (ws.readyState !== 1) return;
  if (droppable && ws.bufferedAmount > 256 * 1024) return; // 客户端拥塞时丢弃状态帧
  try { ws.send(str); } catch (_) { /* 忽略 */ }
}
function broadcast(obj, droppable) {
  const str = JSON.stringify(obj);
  for (const ws of wss.clients) rawSend(ws, str, droppable);
}
function sendTo(id, obj) {
  const ws = sockets.get(id);
  if (ws) rawSend(ws, JSON.stringify(obj));
}

const sockets = new Map(); // playerId -> ws

// ---------- 房间 ----------
const ROOM_CAP = 10;
const OFFICIAL_ID = 'official';
const MAX_CUSTOM_ROOMS = 20;
const ROOM_EMPTY_MS = 20000;
const rooms = new Map();
const ids = { n: 1 };
let roomSeq = 1;
let officialRoom = null;

function humanCount(room) {
  let n = 0;
  if (!room) return 0;
  for (const pl of room.world.players.values()) if (!pl.isDecoy) n++;
  return n;
}
function occupantCount(room) {
  if (!room) return 0;
  let n = 0;
  for (const pl of room.world.players.values()) n++;
  return n;
}
function totalHumans() {
  let n = 0;
  for (const room of rooms.values()) n += humanCount(room);
  return n;
}
function spectatorCount(room) {
  let n = 0;
  if (!room) return 0;
  for (const client of wss.clients) {
    if (client.roomId === room.id && client.spectator && !client.playerId) n++;
  }
  return n;
}
function roomById(id) {
  return rooms.get(String(id || '')) || null;
}
function roomOf(ws) {
  return ws && ws.roomId ? rooms.get(ws.roomId) || null : null;
}
function findLive(id) {
  for (const room of rooms.values()) {
    const pl = room.world.players.get(id);
    if (pl) return { room, p: pl };
  }
  return null;
}
function roomBroadcast(room, obj, droppable) {
  if (!room) return;
  const str = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.roomId === room.id) rawSend(client, str, droppable);
  }
}
function makeWorld(room) {
  const cast = (obj, droppable) => roomBroadcast(room, obj, droppable);
  const tell = (id, obj) => {
    const client = sockets.get(id);
    if (client) rawSend(client, JSON.stringify(obj));
  };
  return new World(cast, tell, ac, ids);
}
function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    official: !!room.official,
    players: occupantCount(room),
    humans: humanCount(room),
    spectators: spectatorCount(room),
    locked: !!(room.password),
    cap: ROOM_CAP,
    owner: room.ownerName || '',
  };
}
function roomsPayload() {
  const list = [...rooms.values()].map(roomSummary).sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    return b.players - a.players || String(a.name).localeCompare(String(b.name), 'zh');
  });
  return { type: 'rooms', cap: ROOM_CAP, rooms: list };
}
function publishRooms() {
  const str = JSON.stringify(roomsPayload());
  for (const client of wss.clients) rawSend(client, str);
}
function noteOccupancy(room) {
  if (!room || room.official) return;
  const busy = humanCount(room) > 0 || spectatorCount(room) > 0;
  if (busy) room.emptyAt = 0;
  else if (!room.emptyAt) room.emptyAt = Date.now();
}
function openRoom(meta) {
  const room = {
    id: meta.id,
    name: meta.name,
    official: !!meta.official,
    ownerId: meta.ownerId || null,
    ownerName: meta.ownerName || '',
    password: meta.password || '',
    emptyAt: 0,
    world: null,
  };
  room.world = makeWorld(room);
  rooms.set(room.id, room);
  return room;
}
function cleanRoomName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 12);
}
function cleanRoomPassword(raw) {
  return String(raw || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16);
}
function roomPasswordMatch(expect, given) {
  const a = Buffer.from(String(expect || ''));
  const b = Buffer.from(cleanRoomPassword(given));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function roomAccessOk(room, ws, given) {
  if (!room || room.official || !room.password) return true;
  if (ws.oauth && !ws.guest && room.ownerId != null && String(room.ownerId) === String(ws.oauth.id)) return true;
  if (ws.roomId === room.id && (ws.spectator || ws.playerId)) return true;
  return roomPasswordMatch(room.password, given);
}
function denyRoomPassword(ws, room, given) {
  rawSend(ws, JSON.stringify({
    type: 'err',
    text: given ? '房间密码错误' : '该房间需要密码',
    needRoomPassword: true,
    roomId: room.id,
  }));
}
function createCustomRoom(ws, rawName, rawPassword) {
  if (!ws.oauth || ws.guest) return { error: '游客不可开房，请先登录' };
  const name = cleanRoomName(rawName);
  if (!name) return { error: '请填写房间名' };
  if (containsProfanity(name)) return { error: '房间名不可用' };
  let custom = 0;
  const low = name.toLowerCase();
  for (const room of rooms.values()) {
    if (room.official) continue;
    custom++;
    if (room.ownerId != null && String(room.ownerId) === String(ws.oauth.id)) {
      return { error: '你已有房间「' + room.name + '」' };
    }
    if (String(room.name).toLowerCase() === low) return { error: '已有同名房间' };
  }
  if (custom >= MAX_CUSTOM_ROOMS) return { error: '房间数量已达上限，稍后再试' };
  const ownerName = String(ws.oauth.username || ws.oauth.name || '玩家').replace(/[<>&"']/g, '').trim().slice(0, 12) || '玩家';
  const password = cleanRoomPassword(rawPassword);
  const room = openRoom({
    id: 'h' + (roomSeq++).toString(36),
    name,
    official: false,
    ownerId: ws.oauth.id,
    ownerName,
    password,
  });
  room.emptyAt = Date.now();
  return { room };
}
function accountBusy(nodelocId) {
  if (nodelocId == null || nodelocId === '') return false;
  const key = String(nodelocId);
  for (const room of rooms.values()) {
    for (const pl of room.world.players.values()) {
      if (pl.nodelocId != null && String(pl.nodelocId) === key) return true;
    }
  }
  return false;
}
function liveNames() {
  const names = [];
  for (const room of rooms.values()) {
    for (const pl of room.world.players.values()) names.push(pl.name);
  }
  return names;
}
function sweepRooms() {
  const t = Date.now();
  let changed = false;
  for (const room of [...rooms.values()]) {
    if (room.official) continue;
    noteOccupancy(room);
    if (room.emptyAt && t - room.emptyAt >= ROOM_EMPTY_MS && humanCount(room) === 0 && spectatorCount(room) === 0) {
      rooms.delete(room.id);
      changed = true;
    }
  }
  if (changed) publishRooms();
}

// ---------- 反作弊引擎 ----------
const acStore = createJsonStore(path.join(DATA_DIR, 'anticheat.json'));
const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE === 'on',
  store: acStore,
  onAction(key, action, reason) {
    const ws = sockets.get(key);
    const hit = findLive(key);
    const p = hit ? hit.p : null;
    if (p?.isDecoy) return;
    if (action === 'warn') {
      sendTo(key, { type: 'acwarn', text: '⚠️ 检测到异常操作，请规范游戏行为' });
      return;
    }
    const label = action === 'ban'
      ? `你已被临时封禁：${reason}`
      : `你已被移出对局：${reason}`;
    if (p && hit) {
      hit.room.world.broadcast({ type: 'sys', style: 'streak', text: `🚫 ${p.name} 因异常行为被系统${action === 'ban' ? '封禁' : '移出'}` });
    }
    if (ws) {
      rawSend(ws, JSON.stringify({ type: 'kicked', text: label }));
      setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) { /* 忽略 */ } }, 60);
    }
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule} ${e.detail} → score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);

officialRoom = openRoom({ id: OFFICIAL_ID, name: '官方大厅', official: true, ownerName: '官方' });
const login = require('./login');

function otherGuestNames(exceptWs) {
  const names = [];
  for (const client of wss.clients) {
    if (client !== exceptWs && client.guestName) names.push(client.guestName);
  }
  return names;
}

function allocGuestName(ws) {
  const extra = otherGuestNames(ws).concat(liveNames());
  const w = officialRoom.world;
  if (ws.guestName && w.guestNameOk(ws.guestName, extra)) return ws.guestName;
  ws.guestName = w.makeGuestName(extra);
  ws.guest = true;
  return ws.guestName;
}

// 下发给新连接的静态定义（地图/武器/道具/商店），两端共用一份数据
const DEFS = {
  type: 'defs',
  map: cfg.MAP, weapons: cfg.WEAPONS, equips: cfg.EQUIPS, buffs: cfg.BUFFS,
  shop: cfg.SHOP, shopSlots: cfg.SHOP_SLOTS,
  loginRewards: cfg.LOGIN_REWARDS,
  rules: {
    maxHp: cfg.RULES.maxHp, maxArmor: cfg.RULES.maxArmor, baseSpeed: cfg.RULES.baseSpeed,
    jumpVel: cfg.RULES.jumpVel, gravity: cfg.RULES.gravity, eyeH: cfg.RULES.eyeH,
    groundAccel: cfg.RULES.groundAccel, airAccel: cfg.RULES.airAccel,
    friction: cfg.RULES.friction, stopSpeed: cfg.RULES.stopSpeed,
    airWishClip: cfg.RULES.airWishClip, airControl: cfg.RULES.airControl,
    bhopSpeedMul: cfg.RULES.bhopSpeedMul,
    pickupDist: cfg.RULES.pickupDist, merchantDist: cfg.RULES.merchantDist,
    respawnMs: cfg.RULES.respawnMs, protectMs: cfg.RULES.protectMs, shieldHp: cfg.RULES.shieldHp,
    dayMs: cfg.RULES.dayMs,
  },
  // 各类型 BOSS 的外形参数（客户端建模/命中预测用）
  bosses: Object.fromEntries(Object.entries(cfg.BOSSES).map(([k, b]) =>
    [k, {
      name: b.name, radius: b.radius, yc: b.yc, color: b.color,
      handAnchorBack: b.handAnchorBack, handAnchorSide: b.handAnchorSide,
      handAnchorElev: b.handAnchorElev, handAnchorMidY: b.handAnchorMidY,
    }])),
};

function syncLiveProfile(ws, payload) {
  if (!ws || !payload) return;
  const room = roomOf(ws);
  const world = room ? room.world : null;
  const p = world && ws.playerId ? world.players.get(ws.playerId) : null;
  if (!p || p.isDecoy) return;
  if (payload.coins !== undefined) p.coins = payload.coins;
  if (payload.owned) p.owned = payload.owned.slice();
  if (payload.eq) p.eq = Object.assign({ head: null, face: null, back: null, fx: null }, payload.eq);
  world.sendYou(p);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.spectator = false;
  ws.playerId = 0;
  ws.ip = normalizeIp(String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown');
  ws.oauth = oauthUserFromReq(req);
  ws.preBucket = new TokenBucket(6, 12);   // 加入前的连接级限速
  ws.on('pong', () => { ws.isAlive = true; });
  rawSend(ws, JSON.stringify(DEFS));
  rawSend(ws, JSON.stringify(officialRoom.world.boardMsg()));
  rawSend(ws, JSON.stringify(roomsPayload()));
  const oauthPublic = publicOauthUser(ws.oauth);
  rawSend(ws, JSON.stringify({
    type: 'oauth',
    enabled: oauthNl.enabled() || oauthLd.enabled(),
    nodelocEnabled: oauthNl.enabled(),
    linuxdoEnabled: oauthLd.enabled(),
    loggedIn: !!oauthPublic,
    user: oauthPublic,
    loginUrl: oauthNl.loginStartUrl(false),
    nativeLoginUrl: oauthNl.loginStartUrl(true),
    linuxdoLoginUrl: oauthLd.loginStartUrl(false),
    linuxdoNativeLoginUrl: oauthLd.loginStartUrl(true),
  }));

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    const room = roomOf(ws);
    const world = room ? room.world : null;
    const p = world && ws.playerId ? world.players.get(ws.playerId) : null;
    // 反作弊：分类型限速（未加入的连接走前置小桶）
    if (p && p.mon) {
      if (!p.mon.rate(m.type, ...(RATE_PRESETS[m.type] || RATE_PRESETS.default))) return;
    } else if (m.type !== 'ping' && !ws.preBucket.take()) return;

    switch (m.type) {
      case 'guest_login': {
        // 游客登录暂时关闭，恢复时删掉下面这行并还原原分配逻辑
        rawSend(ws, JSON.stringify({ type: 'guest', ok: false, text: '后续会开放游客登录' }));
        break;
      }
      case 'guest_logout': {
        if (p) return;
        ws.guest = false;
        ws.guestName = '';
        rawSend(ws, JSON.stringify({ type: 'guest', ok: false, cleared: true }));
        break;
      }
      case 'create_room': {
        if (p) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '请先返回菜单再开房' }));
          return;
        }
        const made = createCustomRoom(ws, m.name, m.password);
        if (made.error) {
          rawSend(ws, JSON.stringify({ type: 'err', text: made.error }));
          return;
        }
        rawSend(ws, JSON.stringify({ type: 'room_created', ok: true, room: roomSummary(made.room) }));
        publishRooms();
        break;
      }
      case 'join': {
        if (p) return;
        const isNpcJoin = m.npc === NPC_TOKEN;
        const guestJoin = !isNpcJoin && !ws.oauth && !!m.guest;
        if (guestJoin) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '后续会开放游客登录' }));
          return;
        }
        const target = isNpcJoin ? officialRoom : roomById(m.roomId);
        if (!target) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '房间不存在或已关闭' }));
          return;
        }
        if (!isNpcJoin && humanCount(target) >= ROOM_CAP) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '该房间已满（最多 10 人）' }));
          return;
        }
        if (!isNpcJoin && !roomAccessOk(target, ws, m.roomPassword)) {
          denyRoomPassword(ws, target, m.roomPassword);
          return;
        }
        if (!isNpcJoin && !ws.oauth && !guestJoin) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '请先登录或使用游客登录', needOauth: true }));
          return;
        }
        if (guestJoin && !ws.guest) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '请先点击游客登录' }));
          return;
        }
        let joinName = '';
        if (isNpcJoin) {
          joinName = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
        } else if (guestJoin) {
          joinName = allocGuestName(ws);
        } else {
          joinName = login.oauthSiteName(ws.oauth);
        }
        if (!isNpcJoin && !guestJoin && !joinName) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '无法获取站点昵称' }));
          return;
        }
        if (!joinName) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '无法分配游客昵称' }));
          return;
        }
        const banKeys = ['ip:' + ws.ip, 'name:' + joinName];
        if (ws.oauth && !guestJoin) banKeys.push('nl:' + ws.oauth.id);
        const ban = ac.isBanned(banKeys);
        if (ban) {
          const mins = Math.max(1, Math.ceil((ban.until - Date.now()) / 60000));
          rawSend(ws, JSON.stringify({ type: 'err', text: `你已被临时封禁（${ban.reason}），剩余约 ${mins} 分钟` }));
          return;
        }
        if (!isNpcJoin && !guestJoin && accountBusy(ws.oauth.id)) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '该账号已在游戏中' }));
          return;
        }
        if (!isNpcJoin && !guestJoin) {
          const auth = login.checkAccess(ws.ip, joinName, m.password, ws.oauth);
          if (!auth.ok) {
            rawSend(ws, JSON.stringify({
              type: 'err',
              text: auth.text,
              needOauth: !!auth.needOauth,
              needPassword: !!auth.needPassword,
            }));
            return;
          }
        }
        const prevId = ws.roomId || '';
        const wasSpec = !!ws.spectator;
        ws.spectator = false;
        ws.roomId = target.id;
        const np = target.world.addPlayer(joinName, ws.ip, {
          isDecoy: isNpcJoin,
          nodelocId: (!isNpcJoin && !guestJoin && ws.oauth) ? ws.oauth.id : null,
          guest: guestJoin,
          guestName: guestJoin ? joinName : '',
          extraNames: liveNames(),
        });
        if (!np || np.error) {
          ws.roomId = prevId;
          ws.spectator = wasSpec;
          rawSend(ws, JSON.stringify({ type: 'err', text: (np && np.error) || '该昵称已被系统占用' }));
          return;
        }
        if (guestJoin) ws.guestName = np.name;
        ws.playerId = np.id;
        ws.isDecoy = isNpcJoin;
        sockets.set(np.id, ws);
        rawSend(ws, JSON.stringify({
          type: 'joined', id: np.id, you: { coins: np.coins, owned: np.owned, eq: np.eq }, name: np.name, guest: !!np.guest,
          roomId: target.id,
        }));
        rawSend(ws, JSON.stringify(target.world.snapshot()));
        if (!isNpcJoin) {
          target.world.notifyChatMute(np);
          target.world.notifyJoinPrivTips(np);
        }
        if (prevId && prevId !== target.id) {
          const prev = rooms.get(prevId);
          if (prev) noteOccupancy(prev);
        }
        noteOccupancy(target);
        publishRooms();
        break;
      }
      case 'spectate': {
        const target = roomById(m.roomId) || room;
        if (!target) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '请选择房间' }));
          return;
        }
        if (!roomAccessOk(target, ws, m.roomPassword)) {
          denyRoomPassword(ws, target, m.roomPassword);
          return;
        }
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        const prev = room;
        ws.spectator = true;
        ws.roomId = target.id;
        if (prev && prev !== target) noteOccupancy(prev);
        noteOccupancy(target);
        rawSend(ws, JSON.stringify({ type: 'spec', roomId: target.id }));
        rawSend(ws, JSON.stringify(target.world.snapshot()));
        publishRooms();
        break;
      }
      case 'leave': {
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = false;
        ws.roomId = '';
        if (room) noteOccupancy(room);
        rawSend(ws, JSON.stringify({ type: 'left' }));
        publishRooms();
        break;
      }
      case 'move':   if (p) world.handleMove(p, m); break;
      case 'melee':  if (p) world.handleMelee(p, m); break;
      case 'fire':   if (p) world.handleFire(p, m); break;
      case 'nade_prime': if (p) world.handleNadePrime(p); break;
      case 'nade_throw': if (p) world.handleNadeThrow(p, m); break;
      case 'reload': if (p) world.handleReload(p); break;
      case 'switch': if (p) world.handleSwitch(p, m); break;
      case 'pickup': if (p) world.handlePickup(p, m); break;
      case 'chat':   if (p) world.handleChat(p, m, ws.ip); break;
      case 'buy':    if (p) world.handleBuy(p, m); break;
      case 'equip':  if (p) world.handleEquipCos(p, m); break;
      case 'profile': {
        const res = login.profilePayload(ws.ip, m.name, m.password, ws.oauth);
        rawSend(ws, JSON.stringify({ type: 'profile', ...res }));
        break;
      }
      case 'claim_login': {
        const res = login.claimLogin(ws.ip, m.name, m.password, ws.oauth);
        if (res.ok) syncLiveProfile(ws, res);
        rawSend(ws, JSON.stringify({ type: 'claim_login', ...res }));
        break;
      }
      case 'menu_equip': {
        const res = login.menuEquip(ws.ip, m.name, m.slot, m.id === undefined ? null : m.id, m.password, ws.oauth);
        if (res.ok) syncLiveProfile(ws, res);
        rawSend(ws, JSON.stringify({ type: 'menu_equip', ...res }));
        break;
      }
      case 'menu_buy': {
        const res = login.menuBuy(ws.ip, m.name, m.id, m.password, ws.oauth);
        if (res.ok) syncLiveProfile(ws, res);
        rawSend(ws, JSON.stringify({ type: 'menu_buy', ...res }));
        break;
      }
      case 'set_password': {
        const res = login.setPassword(ws.ip, m.name, m.password, m.oldPassword, ws.oauth);
        rawSend(ws, JSON.stringify({ type: 'set_password', ...res }));
        break;
      }
      case 'ping':
        if (p) world.noteRtt(p, m.rtt);
        rawSend(ws, JSON.stringify({ type: 'pong', t: m.t }));
        break;
    }
  });

  ws.on('close', () => {
    const prev = roomOf(ws);
    if (ws.playerId) {
      const wasDecoy = ws.isDecoy;
      const hit = findLive(ws.playerId);
      if (hit) hit.room.world.removePlayer(ws.playerId);
      sockets.delete(ws.playerId);
      if (wasDecoy && hit && hit.room.official && cfg.DECOY.enabled) zard.scheduleReconnect();
    }
    ws.roomId = '';
    if (prev) noteOccupancy(prev);
    publishRooms();
  });
  ws.on('error', () => { /* close 会跟着触发 */ });
});

// 心跳：清理断线连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* 忽略 */ }
  }
}, 15000);

// 模拟循环 30Hz
let last = Date.now();
setInterval(() => {
  const t = Date.now();
  const dt = Math.min(0.25, (t - last) / 1000);
  last = t;
  for (const room of rooms.values()) {
    try { room.world.update(dt); } catch (e) { console.error('[world] update 异常:', e); }
  }
}, 1000 / cfg.RULES.tickRate);

// 状态广播（可丢帧）。只发给已进房或观战的连接。
// 菜单背景是客户端本地演示，不推官厅快照，避免空闲连接吃带宽。
setInterval(() => {
  if (wss.clients.size === 0) return;
  for (const room of rooms.values()) {
    let need = false;
    for (const client of wss.clients) if (client.roomId === room.id) { need = true; break; }
    if (!need) continue;
    const snap = JSON.stringify(room.world.snapshot());
    for (const client of wss.clients) {
      if (client.roomId === room.id) rawSend(client, snap, true);
    }
  }
}, 1000 / cfg.RULES.broadcastRate);

// 排行榜 + 厅堂列表
setInterval(() => {
  if (wss.clients.size === 0) return;
  for (const room of rooms.values()) {
    const msg = JSON.stringify(room.world.boardMsg());
    for (const client of wss.clients) {
      if (client.roomId === room.id) rawSend(client, msg, true);
      else if (!client.roomId && room.official) rawSend(client, msg, true);
    }
  }
  publishRooms();
  sweepRooms();
}, 2000);

server.listen(PORT, () => {
  console.log(`[零区冲突] 服务已启动: http://0.0.0.0:${PORT}  (房间制, 每厅最多 ${ROOM_CAP} 人, 官厅常开, 反作弊${ac.status().enabled ? '开启' : '关闭'})`);
  if (oauthNl.enabled()) {
    console.log(`[oauth] NodeLoc 已启用 → 回调 ${oauthNl.REDIRECT_URI}`);
  } else {
    console.log('[oauth] NodeLoc 未配置（缺少 Client ID/Secret/Redirect）');
  }
  if (oauthLd.enabled()) {
    console.log(`[oauth] LinuxDo 已启用 → 回调 ${oauthLd.REDIRECT_URI}`);
  } else {
    console.log('[oauth] LinuxDo 未配置（缺少 Client ID/Secret/Redirect）');
  }
  if (cfg.DECOY.enabled) {
    zard.start({ port: PORT, token: NPC_TOKEN, name: cfg.DECOY.name });
    console.log(`[decoy] Zard 假人已启用 (昵称: ${cfg.DECOY.name})`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { zard.stop(); board.saveNow(); chatlog.saveNow(); acStore.save(); process.exit(0); });
}
