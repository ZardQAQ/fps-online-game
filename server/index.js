// 零区冲突 — 服务端入口：一个 URL 同时提供静态客户端与 WebSocket 联机（单房间）
// 反作弊：AC_MODE=off 可关闭惩罚（冷却/数值等功能校验仍生效），详见 server/anticheat/README.md
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
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
const oauthNl = require('./oauth-nodeloc');
const app = express();
app.use(express.json({ limit: '2kb' }));

// NodeLoc OAuth：回调 URI 固定为 /oauth/nodeloc
app.get('/oauth/nodeloc', (req, res) => oauthNl.route(req, res));
app.get('/api/oauth/me', (req, res) => oauthNl.me(req, res));
app.post('/api/oauth/logout', (req, res) => oauthNl.logout(req, res));

/** 排队统计用：只计真人，假人不占软名额 */
function countActivePlayers() {
  let n = 0;
  for (const p of world.players.values()) if (!p.isDecoy) n++;
  return n;
}
function queueCap() { return cfg.RULES.queueCap; }
function canEnterWithoutQueue(req) {
  const players = countActivePlayers();
  if (players < queueCap()) return true;
  return queue.validAdmit(queue.admitFromReq(req));
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
    players: world.players.size,
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

// ---------- 反作弊引擎 ----------
const acStore = createJsonStore(path.join(DATA_DIR, 'anticheat.json'));
const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE === 'on',
  store: acStore,
  onAction(key, action, reason) {
    const ws = sockets.get(key);
    const p = world.players.get(key);
    if (p?.isDecoy) return;
    if (action === 'warn') {
      sendTo(key, { type: 'acwarn', text: '⚠️ 检测到异常操作，请规范游戏行为' });
      return;
    }
    const label = action === 'ban'
      ? `你已被临时封禁：${reason}`
      : `你已被移出对局：${reason}`;
    if (p) broadcast({ type: 'sys', style: 'streak', text: `🚫 ${p.name} 因异常行为被系统${action === 'ban' ? '封禁' : '移出'}` });
    if (ws) {
      rawSend(ws, JSON.stringify({ type: 'kicked', text: label }));
      setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) { /* 忽略 */ } }, 60);
    }
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule} ${e.detail} → score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);

const world = new World(broadcast, sendTo, ac);
const login = require('./login');

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
  const p = ws.playerId ? world.players.get(ws.playerId) : null;
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
  ws.oauth = oauthNl.userFromReq(req);
  ws.preBucket = new TokenBucket(6, 12);   // 加入前的连接级限速
  ws.on('pong', () => { ws.isAlive = true; });
  rawSend(ws, JSON.stringify(DEFS));
  rawSend(ws, JSON.stringify(world.boardMsg()));
  rawSend(ws, JSON.stringify(world.snapshot()));
  rawSend(ws, JSON.stringify({
    type: 'oauth',
    enabled: oauthNl.enabled(),
    loggedIn: !!ws.oauth,
    user: ws.oauth
      ? { id: ws.oauth.id, username: ws.oauth.username, name: ws.oauth.name }
      : null,
    loginUrl: oauthNl.loginStartUrl(false),
    nativeLoginUrl: oauthNl.loginStartUrl(true),
  }));

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    const p = ws.playerId ? world.players.get(ws.playerId) : null;
    // 反作弊：分类型限速（未加入的连接走前置小桶）
    if (p && p.mon) {
      if (!p.mon.rate(m.type, ...(RATE_PRESETS[m.type] || RATE_PRESETS.default))) return;
    } else if (m.type !== 'ping' && !ws.preBucket.take()) return;

    switch (m.type) {
      case 'join': {
        if (p) return;
        if (world.players.size >= cfg.RULES.maxPlayers) { rawSend(ws, JSON.stringify({ type: 'err', text: '房间已满，稍后再试' })); return; }
        const isNpcJoin = m.npc === NPC_TOKEN;
        if (!isNpcJoin && !ws.oauth) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '请先使用 NodeLoc 登录', needOauth: true }));
          return;
        }
        const joinName = isNpcJoin
          ? String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 12)
          : login.oauthSiteName(ws.oauth);
        if (!isNpcJoin && !joinName) {
          rawSend(ws, JSON.stringify({ type: 'err', text: '无法获取 NodeLoc 站点昵称' }));
          return;
        }
        const banKeys = ['ip:' + ws.ip, 'name:' + joinName];
        if (ws.oauth) banKeys.push('nl:' + ws.oauth.id);
        const ban = ac.isBanned(banKeys);
        if (ban) {
          const mins = Math.max(1, Math.ceil((ban.until - Date.now()) / 60000));
          rawSend(ws, JSON.stringify({ type: 'err', text: `你已被临时封禁（${ban.reason}），剩余约 ${mins} 分钟` }));
          return;
        }
        ws.spectator = false;
        if (!isNpcJoin) {
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
        const np = world.addPlayer(joinName, ws.ip, {
          isDecoy: isNpcJoin,
          nodelocId: (!isNpcJoin && ws.oauth) ? ws.oauth.id : null,
        });
        if (!np || np.error) {
          rawSend(ws, JSON.stringify({ type: 'err', text: (np && np.error) || '该昵称已被系统占用' }));
          return;
        }
        ws.playerId = np.id;
        ws.isDecoy = isNpcJoin;
        sockets.set(np.id, ws);
        rawSend(ws, JSON.stringify({ type: 'joined', id: np.id, you: { coins: np.coins, owned: np.owned, eq: np.eq }, name: np.name }));
        if (!isNpcJoin) {
          world.notifyChatMute(np);
          // 须在 sockets.set 之后：进场口令 / 昵称替换等 priv 才能送达左下角聊天
          world.notifyJoinPrivTips(np);
        }
        break;
      }
      case 'spectate': {
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = true;
        rawSend(ws, JSON.stringify({ type: 'spec' }));
        break;
      }
      case 'leave': {
        if (p) { world.removePlayer(p.id); sockets.delete(p.id); ws.playerId = 0; }
        ws.spectator = false;
        rawSend(ws, JSON.stringify({ type: 'left' }));
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
    if (ws.playerId) {
      const wasDecoy = ws.isDecoy;
      world.removePlayer(ws.playerId);
      sockets.delete(ws.playerId);
      if (wasDecoy && cfg.DECOY.enabled) zard.scheduleReconnect();
    }
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
  try { world.update(dt); } catch (e) { console.error('[world] update 异常:', e); }
}, 1000 / cfg.RULES.tickRate);

// 状态广播 15Hz（可丢帧）
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast(world.snapshot(), true);
}, 1000 / cfg.RULES.broadcastRate);

// 排行榜广播 2s
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast(world.boardMsg(), true);
}, 2000);

server.listen(PORT, () => {
  console.log(`[零区冲突] 服务已启动: http://0.0.0.0:${PORT}  (单房间, 最多 ${cfg.RULES.maxPlayers} 人, 反作弊${ac.status().enabled ? '开启' : '关闭'})`);
  if (oauthNl.enabled()) {
    console.log(`[oauth] NodeLoc 已启用 → 回调 ${oauthNl.REDIRECT_URI}`);
  } else {
    console.log('[oauth] NodeLoc 未配置（缺少 Client ID/Secret/Redirect）');
  }
  if (cfg.DECOY.enabled) {
    zard.start({ port: PORT, token: NPC_TOKEN, name: cfg.DECOY.name });
    console.log(`[decoy] Zard 假人已启用 (昵称: ${cfg.DECOY.name})`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { zard.stop(); board.saveNow(); chatlog.saveNow(); acStore.save(); process.exit(0); });
}
