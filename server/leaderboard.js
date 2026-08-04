// 历史排行榜 + 玩家档案。按 IP / NodeLoc(nl:id) 索引持久化到 data/profiles.json；昵称全局唯一
'use strict';
const fs = require('fs');
const path = require('path');
const { DECOY } = require('./config');
const { normalizeIp } = require('./iputil');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'profiles.json');
const LEGACY_PREFIX = 'legacy:';
const NL_PREFIX = 'nl:';

/** @type {Record<string, object>} ip|legacy:name|nl:id -> profile */
let profiles = {};
/** @type {Map<string, string>} nameLower -> profileKey */
const nameIndex = new Map();
let saveTimer = null;

function nlKey(id) {
  return NL_PREFIX + String(id);
}

function isNlKey(key) {
  return String(key || '').startsWith(NL_PREFIX);
}

function isDecoyName(name) {
  return !!name && name.toLowerCase() === DECOY.name.toLowerCase();
}

function looksLikeIp(key) {
  const s = String(key || '');
  if (s.startsWith(LEGACY_PREFIX) || s.startsWith(NL_PREFIX)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  if (s.includes(':')) return true;
  return false;
}

function isGhostProfile(p) {
  if (!p || typeof p !== 'object') return true;
  if (p.passHash) return false;
  if ((p.joins | 0) > 0) return false;
  if ((p.kills | 0) > 0 || (p.deaths | 0) > 0 || (p.bossKills | 0) > 0 || (p.bestStreak | 0) > 0) return false;
  if ((p.decoyKills | 0) > 0) return false;
  if (p.lastClaimDate) return false;
  if (Array.isArray(p.owned) && p.owned.length) return false;
  const eq = p.eq;
  if (eq && typeof eq === 'object' && (eq.head || eq.face || eq.back || eq.fx)) return false;
  return true;
}

function blankProfile(name, ip) {
  return {
    name: name || '',
    ip: ip || '',
    nodelocId: null,
    kills: 0, deaths: 0, bossKills: 0, bestStreak: 0, coins: null,
    owned: [], eq: {}, joins: 0, last: 0, decoyKills: 0, loginDay: 1, lastClaimDate: '',
  };
}

function normalize(prof) {
  if (!prof.name) prof.name = '';
  if (prof.ip === undefined) prof.ip = '';
  if (prof.nodelocId === undefined) prof.nodelocId = null;
  if (prof.bestStreak === undefined) prof.bestStreak = 0;
  if (prof.decoyKills === undefined) prof.decoyKills = 0;
  if (!prof.loginDay) prof.loginDay = 1;
  if (prof.lastClaimDate === undefined) prof.lastClaimDate = '';
  if (!Array.isArray(prof.owned)) prof.owned = [];
  if (!prof.eq || typeof prof.eq !== 'object') prof.eq = {};
  return prof;
}

function rebuildNameIndex() {
  nameIndex.clear();
  for (const [key, prof] of Object.entries(profiles)) {
    const n = String(prof.name || '').trim();
    if (!n || isDecoyName(n)) continue;
    const low = n.toLowerCase();
    if (!nameIndex.has(low)) nameIndex.set(low, key);
  }
}

function purgeDecoyProfiles() {
  for (const [key, prof] of Object.entries(profiles)) {
    // NodeLoc 真人可与假人同名（如 zard），勿清 nl: 档案
    if (isNlKey(key)) continue;
    if (isDecoyName(prof.name) || isDecoyName(key)) delete profiles[key];
  }
}

function purgeGhostProfiles() {
  let n = 0;
  for (const [key, prof] of Object.entries(profiles)) {
    if (isNlKey(key)) {
      if (isGhostProfile(prof)) { delete profiles[key]; n++; }
      continue;
    }
    if (isDecoyName(prof.name) || isGhostProfile(prof)) {
      delete profiles[key];
      n++;
    }
  }
  return n;
}

/** 旧版 name→档案 迁移为 IP 索引；无 IP 的挂到 legacy:昵称，首次同名加入时认领 */
function migrateRaw(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    if (looksLikeIp(key) && (val.name || val.ip !== undefined)) {
      const ip = normalizeIp(val.ip || key);
      const prof = normalize(Object.assign({}, val, { ip, name: String(val.name || '').trim() }));
      if (!prof.name) continue;
      out[ip] = prof;
      continue;
    }
    const name = String(val.name || key).trim();
    if (!name || isDecoyName(name)) continue;
    const legacyKey = LEGACY_PREFIX + name;
    out[legacyKey] = normalize(Object.assign({}, val, { name, ip: '' }));
  }
  return out;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
      const keys = Object.keys(raw);
      // 旧版：key 即昵称，且条目内无 name 字段
      const hasOldNameKeyed = keys.some(k => !looksLikeIp(k) && !String(k).startsWith(LEGACY_PREFIX)
        && raw[k] && typeof raw[k] === 'object' && (raw[k].name == null || raw[k].name === undefined));
      if (hasOldNameKeyed) {
        profiles = migrateRaw(raw);
        console.log('[leaderboard] 已将档案迁移为 IP 索引（无 IP 的旧档挂在 legacy:昵称，首次进房认领）');
      } else {
        profiles = {};
        for (const [key, val] of Object.entries(raw)) {
          if (!val || typeof val !== 'object') continue;
          if (String(key).startsWith(LEGACY_PREFIX)) {
            profiles[key] = normalize(Object.assign({}, val, {
              name: String(val.name || key.slice(LEGACY_PREFIX.length)).trim(),
              ip: val.ip || '',
            }));
          } else if (isNlKey(key)) {
            const id = val.nodelocId != null ? val.nodelocId : key.slice(NL_PREFIX.length);
            const nm = String(val.name || '').trim();
            if (!nm) continue;
            profiles[nlKey(id)] = normalize(Object.assign({}, val, {
              name: nm,
              nodelocId: id,
              ip: val.ip || '',
            }));
          } else {
            const ip = normalizeIp(val.ip || key);
            const nm = String(val.name || '').trim();
            if (!nm) continue;
            profiles[ip] = normalize(Object.assign({}, val, { ip, name: nm }));
          }
        }
      }
    }
    purgeDecoyProfiles();
    const ghosts = purgeGhostProfiles();
    if (ghosts) console.log(`[leaderboard] 已清理 ${ghosts} 个空壳档案`);
    rebuildNameIndex();
    saveNow();
  } catch (e) {
    console.error('[leaderboard] 读取失败，使用空档案:', e.message);
    profiles = {};
    nameIndex.clear();
  }
}

function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    purgeDecoyProfiles();
    rebuildNameIndex();
    fs.writeFileSync(FILE, JSON.stringify(profiles));
  } catch (e) {
    console.error('[leaderboard] 保存失败:', e.message);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 2000);
}

function peekByIp(ip) {
  const key = normalizeIp(ip);
  if (!key || key === 'unknown') return null;
  const prof = profiles[key];
  return prof ? normalize(prof) : null;
}

function peekByNodeLoc(id) {
  if (id == null || id === '') return null;
  const prof = profiles[nlKey(id)];
  return prof ? normalize(prof) : null;
}

function peekByName(name) {
  if (!name || isDecoyName(name)) return null;
  const key = nameIndex.get(String(name).toLowerCase());
  if (!key) return null;
  const prof = profiles[key];
  return prof ? normalize(prof) : null;
}

function keyOfName(name) {
  if (!name) return null;
  return nameIndex.get(String(name).toLowerCase()) || null;
}

function isNameTaken(name, exceptKey) {
  const key = keyOfName(name);
  return !!(key && key !== exceptKey);
}

/**
 * 绑定/改名：同一 IP 只维护一份档案；改名不新建账号
 * @returns {{ ok: true, prof: object, renamed: boolean } | { ok: false, text: string }}
 */
function bind(ip, rawName) {
  const ipKey = normalizeIp(ip);
  const name = String(rawName || '').trim().slice(0, 12);
  if (!name) return { ok: false, text: '请输入有效昵称' };
  if (isDecoyName(name)) return { ok: false, text: '该昵称已被系统占用' };
  if (!ipKey || ipKey === 'unknown') return { ok: false, text: '无法识别网络地址' };

  let mine = profiles[ipKey];
  if (mine) {
    normalize(mine);
    const renamed = mine.name.toLowerCase() !== name.toLowerCase();
    mine.name = name;
    mine.ip = ipKey;
    rebuildNameIndex();
    if (renamed) saveNow();
    return { ok: true, prof: mine, renamed };
  }

  const ownerKey = keyOfName(name);
  if (ownerKey && ownerKey.startsWith(LEGACY_PREFIX)) {
    const legacy = profiles[ownerKey];
    delete profiles[ownerKey];
    normalize(legacy);
    legacy.name = name;
    legacy.ip = ipKey;
    profiles[ipKey] = legacy;
    rebuildNameIndex();
    saveNow();
    return { ok: true, prof: legacy, renamed: false };
  }

  const prof = blankProfile(name, ipKey);
  profiles[ipKey] = prof;
  rebuildNameIndex();
  saveNow();
  return { ok: true, prof: normalize(prof), renamed: false };
}

/**
 * NodeLoc 账号绑定/改名：按 nl:{id} 索引，与 IP 档案独立
 * @returns {{ ok: true, prof: object, renamed: boolean } | { ok: false, text: string }}
 */
function bindNodeLoc(nlId, rawName, ip) {
  if (nlId == null || nlId === '') return { ok: false, text: '无效的 NodeLoc 账号' };
  const key = nlKey(nlId);
  const name = String(rawName || '').trim().slice(0, 12);
  if (!name) return { ok: false, text: '请输入有效昵称' };
  const ipKey = ip ? normalizeIp(ip) : '';

  let mine = profiles[key];
  if (mine) {
    normalize(mine);
    mine.nodelocId = nlId;
    if (ipKey && ipKey !== 'unknown') mine.ip = ipKey;
    const renamed = mine.name.toLowerCase() !== name.toLowerCase();
    mine.name = name;
    rebuildNameIndex();
    if (renamed) saveNow();
    return { ok: true, prof: mine, renamed };
  }

  const ownerKey = keyOfName(name);
  if (ownerKey && ownerKey.startsWith(LEGACY_PREFIX)) {
    const legacy = profiles[ownerKey];
    delete profiles[ownerKey];
    normalize(legacy);
    legacy.name = name;
    legacy.nodelocId = nlId;
    if (ipKey && ipKey !== 'unknown') legacy.ip = ipKey;
    profiles[key] = legacy;
    rebuildNameIndex();
    saveNow();
    return { ok: true, prof: legacy, renamed: false };
  }

  const prof = blankProfile(name, ipKey && ipKey !== 'unknown' ? ipKey : '');
  prof.nodelocId = nlId;
  profiles[key] = prof;
  rebuildNameIndex();
  saveNow();
  return { ok: true, prof: normalize(prof), renamed: false };
}

function getByIp(ip) {
  const key = normalizeIp(ip);
  if (!key || key === 'unknown') return blankProfile('', key);
  if (!profiles[key]) profiles[key] = blankProfile('', key);
  const prof = normalize(profiles[key]);
  prof.ip = key;
  return prof;
}

function getByNodeLoc(id) {
  if (id == null || id === '') return blankProfile('', '');
  const key = nlKey(id);
  if (!profiles[key]) {
    profiles[key] = blankProfile('', '');
    profiles[key].nodelocId = id;
  }
  const prof = normalize(profiles[key]);
  prof.nodelocId = id;
  return prof;
}

/** 按玩家会话取档：有 NodeLoc 会话用 Token(nl:id)，否则用 IP */
function getForPlayer(p) {
  if (!p) return blankProfile('', '');
  if (p.nodelocId != null && p.nodelocId !== '') return getByNodeLoc(p.nodelocId);
  return getByIp(p.ip);
}

function bindForPlayer(p, rawName) {
  if (!p) return { ok: false, text: '无效玩家' };
  if (p.nodelocId != null && p.nodelocId !== '') {
    return bindNodeLoc(p.nodelocId, rawName || p.name, p.ip);
  }
  return bind(p.ip, rawName || p.name);
}

/** 兼容：优先按 IP，否则按昵称只读/返回空壳（不再按昵称建新档） */
function get(nameOrIp) {
  if (looksLikeIp(nameOrIp)) return getByIp(nameOrIp);
  const byName = peekByName(nameOrIp);
  if (byName) return byName;
  return blankProfile(String(nameOrIp || ''), '');
}

function peek(nameOrIp) {
  if (looksLikeIp(nameOrIp)) return peekByIp(nameOrIp);
  return peekByName(nameOrIp);
}

function top(n = 10) {
  return Object.values(profiles)
    .filter(p => p && p.name && !isDecoyName(p.name))
    .map(p => ({ n: p.name, k: p.kills | 0, d: p.deaths | 0, bk: p.bossKills | 0, bs: p.bestStreak | 0 }))
    .filter(e => e.k > 0 || e.bk > 0 || e.d > 0)
    .sort((a, b) => b.k - a.k || b.bs - a.bs || b.bk - a.bk || a.d - b.d)
    .slice(0, n);
}

load();
module.exports = {
  get, peek, getByIp, getByNodeLoc, getForPlayer, peekByIp, peekByName, peekByNodeLoc,
  keyOfName, isNameTaken, bind, bindNodeLoc, bindForPlayer,
  nlKey, save, saveNow, top,
};
