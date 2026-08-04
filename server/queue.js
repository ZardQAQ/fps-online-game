// 轻量入场排队：人满时只发准入票据，避免排队访客下载游戏资源
'use strict';
const crypto = require('crypto');

const TICKET_TTL_MS = 3 * 60 * 1000;
const ADMIT_TTL_MS = 5 * 60 * 1000;
const COOKIE = 'na_admit';
const ADMIN_CODE = process.env.QUEUE_ADMIN_CODE || 'zard666';
const BYPASS_WINDOW_MS = 60 * 1000;
const BYPASS_MAX_FAILS = 8;

/** @type {Map<string, { id: string, created: number, lastSeen: number }>} */
const tickets = new Map();
/** @type {Map<string, number>} token -> expireAt */
const admits = new Map();
/** @type {Map<string, { fails: number, resetAt: number }>} */
const bypassFails = new Map();

function now() { return Date.now(); }

function prune() {
  const t = now();
  for (const [id, q] of tickets) {
    if (t - q.lastSeen > TICKET_TTL_MS) tickets.delete(id);
  }
  for (const [tok, exp] of admits) {
    if (t >= exp) admits.delete(tok);
  }
}

function issueAdmit() {
  prune();
  const token = crypto.randomBytes(16).toString('hex');
  admits.set(token, now() + ADMIT_TTL_MS);
  return token;
}

function validAdmit(token) {
  if (!token || typeof token !== 'string') return false;
  prune();
  const exp = admits.get(token);
  if (!exp || now() >= exp) {
    if (exp) admits.delete(token);
    return false;
  }
  // 滑动续期：正在加载/游玩时保持准入
  admits.set(token, now() + ADMIT_TTL_MS);
  return true;
}

function parseCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function admitFromReq(req) {
  return parseCookie(req, COOKIE) || String(req.query.t || '');
}

function setAdmitCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(ADMIT_TTL_MS / 1000)}; SameSite=Lax; HttpOnly`);
}

function clearAdmitCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}

function orderedTickets() {
  return [...tickets.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

/**
 * @param {number} players 当前对局人数（不含排队）
 * @param {number} cap 软上限；人数 >= cap 时需排队
 * @param {string} [ticketId]
 */
function enter(players, cap, ticketId) {
  prune();
  const underCap = players < cap;
  if (underCap) {
    tickets.clear(); // 有空位时无需排队，清空残留票
    const token = issueAdmit();
    return {
      admitted: true,
      token,
      players,
      cap,
      queue: 0,
      position: 0,
      ticket: null,
    };
  }

  let ticket = ticketId ? tickets.get(ticketId) : null;
  if (!ticket) {
    const id = crypto.randomBytes(12).toString('hex');
    ticket = { id, created: now(), lastSeen: now() };
    tickets.set(id, ticket);
  } else {
    ticket.lastSeen = now();
  }

  const list = orderedTickets();
  const position = list.findIndex(q => q.id === ticket.id) + 1;
  const free = Math.max(0, cap - players);
  // 有空位时按排队顺序放行
  if (free > 0 && position > 0 && position <= free) {
    tickets.delete(ticket.id);
    const token = issueAdmit();
    return {
      admitted: true,
      token,
      players,
      cap,
      queue: Math.max(0, list.length - 1),
      position: 0,
      ticket: null,
    };
  }

  return {
    admitted: false,
    token: null,
    players,
    cap,
    queue: list.length,
    position,
    ticket: ticket.id,
  };
}

function status(players, cap, ticketId) {
  return enter(players, cap, ticketId);
}

/** 管理员口令免排队；成功后移除排队票并签发准入 */
function bypass(code, ticketId, ip) {
  prune();
  const key = String(ip || 'unknown');
  const t = now();
  let bucket = bypassFails.get(key);
  if (!bucket || t >= bucket.resetAt) {
    bucket = { fails: 0, resetAt: t + BYPASS_WINDOW_MS };
    bypassFails.set(key, bucket);
  }
  if (bucket.fails >= BYPASS_MAX_FAILS) {
    return { ok: false, text: '尝试过多，请稍后再试' };
  }
  if (String(code || '') !== ADMIN_CODE) {
    bucket.fails++;
    return { ok: false, text: '口令错误' };
  }
  bypassFails.delete(key);
  if (ticketId) tickets.delete(ticketId);
  const token = issueAdmit();
  return { ok: true, admitted: true, token, admin: true };
}

function queueLen() {
  prune();
  return tickets.size;
}

module.exports = {
  COOKIE,
  enter,
  status,
  bypass,
  validAdmit,
  admitFromReq,
  setAdmitCookie,
  clearAdmitCookie,
  issueAdmit,
  queueLen,
};
