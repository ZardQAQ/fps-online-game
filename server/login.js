// 七日登录 / 换装：仅 NodeLoc 会话可操作，档案按 nl:{id}（Token）绑定
'use strict';
const { SHOP, LOGIN_REWARDS, LOGIN_DUP_COINS, RULES, DECOY } = require('./config');
const board = require('./leaderboard');

const COS_SLOTS = ['head', 'face', 'back', 'fx'];

function isZardName(name) {
  return !!name && String(name).toLowerCase() === String(DECOY.name || 'zard').toLowerCase();
}

function allCosmeticIds() {
  return SHOP.filter(s => COS_SLOTS.includes(s.slot)).map(s => s.id);
}

/** 昵称为 zard：解锁全部时装外观，金币至少 10 万（幂等，可重复调用） */
function grantZardStarter(prof) {
  if (!prof || !isZardName(prof.name)) return false;
  const have = new Set(Array.isArray(prof.owned) ? prof.owned : []);
  for (const id of allCosmeticIds()) have.add(id);
  prof.owned = [...have];
  const floor = DECOY.starterCoins | 0;
  if ((prof.coins | 0) < floor) prof.coins = floor;
  return true;
}

function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function cleanName(raw) {
  return String(raw || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
}

function oauthId(oauth) {
  return oauth && oauth.id != null && oauth.id !== '' ? oauth.id : null;
}

function oauthSiteName(oauth) {
  if (!oauth) return '';
  return cleanName(oauth.username || oauth.name || '');
}

function needOauth() {
  return { ok: false, text: '请先使用 NodeLoc 登录', needOauth: true };
}

/**
 * 仅允许已登录的 NodeLoc 账号，昵称固定为站点用户名
 */
function checkAccess(ip, name, password, oauth) {
  const nlId = oauthId(oauth);
  if (nlId == null) return needOauth();

  const n = oauthSiteName(oauth);
  if (!n) {
    return { ok: false, text: '无法获取 NodeLoc 站点昵称' };
  }

  const mine = board.peekByNodeLoc(nlId);
  return { ok: true, name: n, prof: mine, nodelocId: nlId, viaOauth: true, ip };
}

function bindAuth(auth, ip) {
  return board.bindNodeLoc(auth.nodelocId, auth.name, ip || auth.ip);
}

function ensureProf(auth, ip) {
  const bound = bindAuth(auth, ip);
  if (!bound.ok) return null;
  return bound.prof;
}

function ensureLoginFields(prof) {
  if (!prof.loginDay || prof.loginDay < 1 || prof.loginDay > 7) prof.loginDay = 1;
  if (!prof.lastClaimDate) prof.lastClaimDate = '';
  if (!Array.isArray(prof.owned)) prof.owned = [];
  if (!prof.eq || typeof prof.eq !== 'object') prof.eq = { head: null, face: null, back: null, fx: null };
  for (const s of COS_SLOTS) if (!(s in prof.eq)) prof.eq[s] = null;
  if (prof.coins === null || prof.coins === undefined) prof.coins = RULES.startCoins;
  grantZardStarter(prof);
}

function shopItem(id) {
  return SHOP.find(s => s.id === id);
}

function loginStatus(prof) {
  ensureLoginFields(prof);
  const today = todayKey();
  return {
    day: prof.loginDay,
    claimedToday: prof.lastClaimDate === today,
    lastClaimDate: prof.lastClaimDate || '',
  };
}

function oauthExtras(oauth) {
  if (!oauthId(oauth)) return {};
  return {
    oauth: true,
    nodelocId: oauth.id,
    nodelocName: oauth.username || oauth.name || '',
  };
}

function profilePayload(ip, name, password, oauth) {
  const nlId = oauthId(oauth);
  if (nlId == null) return needOauth();

  const n = oauthSiteName(oauth);
  if (!n) {
    return { ok: false, text: '无法获取 NodeLoc 站点昵称', ...oauthExtras(oauth) };
  }

  const mine = board.peekByNodeLoc(nlId);
  if (mine) {
    mine.name = n;
    ensureLoginFields(mine);
    if (isZardName(n)) board.save();
    return {
      ok: true,
      name: n,
      hasPassword: false,
      locked: false,
      exists: true,
      oauthBound: true,
      coins: mine.coins,
      owned: mine.owned.slice(),
      eq: Object.assign({ head: null, face: null, back: null, fx: null }, mine.eq),
      login: loginStatus(mine),
      ...oauthExtras(oauth),
    };
  }

  const starter = { coins: RULES.startCoins, owned: [] };
  if (isZardName(n)) {
    starter.coins = DECOY.starterCoins | 0;
    starter.owned = allCosmeticIds();
  }
  return {
    ok: true,
    name: n,
    hasPassword: false,
    locked: false,
    exists: false,
    oauthBound: true,
    coins: starter.coins,
    owned: starter.owned.slice(),
    eq: { head: null, face: null, back: null, fx: null },
    login: { day: 1, claimedToday: false, lastClaimDate: '' },
    ...oauthExtras(oauth),
  };
}

function setPassword() {
  return { ok: false, text: '已改为 NodeLoc 登录，无需游戏密码' };
}

function claimLogin(ip, name, password, oauth) {
  const auth = checkAccess(ip, name, password, oauth);
  if (!auth.ok) return auth;
  const prof = ensureProf(auth, ip);
  if (!prof) return { ok: false, text: '无法绑定账号' };
  const bound = bindAuth(auth, ip);
  if (!bound.ok) return bound;
  const p = bound.prof;
  ensureLoginFields(p);
  const today = todayKey();
  if (p.lastClaimDate === today) {
    return { ok: false, text: '今日已领取，明天再来' };
  }
  const day = p.loginDay;
  const reward = LOGIN_REWARDS.find(r => r.day === day) || LOGIN_REWARDS[0];
  const item = shopItem(reward.item);
  if (!item) return { ok: false, text: '奖励配置错误' };

  let coinsGain = reward.coins;
  let gotItem = false;
  let dupBonus = 0;
  if (p.owned.includes(reward.item)) {
    dupBonus = LOGIN_DUP_COINS;
    coinsGain += dupBonus;
  } else {
    p.owned.push(reward.item);
    gotItem = true;
    if (!p.eq[item.slot]) p.eq[item.slot] = reward.item;
  }
  p.coins += coinsGain;
  p.lastClaimDate = today;
  p.loginDay = day >= 7 ? 1 : day + 1;
  board.save();

  return {
    ok: true,
    name: p.name,
    day,
    coinsGain,
    dupBonus,
    gotItem,
    item: reward.item,
    itemName: item.name,
    coins: p.coins,
    owned: p.owned.slice(),
    eq: Object.assign({}, p.eq),
    login: loginStatus(p),
    hasPassword: false,
    locked: false,
    text: gotItem
      ? `第 ${day} 天：获得「${item.name}」+ ${reward.coins} 金币`
      : `第 ${day} 天：已拥有该时装，补偿 ${coinsGain} 金币`,
    ...oauthExtras(oauth),
  };
}

function menuEquip(ip, name, slot, id, password, oauth) {
  const auth = checkAccess(ip, name, password, oauth);
  if (!auth.ok) return auth;
  if (!COS_SLOTS.includes(slot)) return { ok: false, text: '无效槽位' };
  const bound = bindAuth(auth, ip);
  if (!bound.ok) return bound;
  const prof = bound.prof;
  ensureLoginFields(prof);
  if (id !== null && id !== undefined && id !== '') {
    if (!prof.owned.includes(id)) return { ok: false, text: '尚未拥有该外观' };
    const item = shopItem(id);
    if (!item || item.slot !== slot) return { ok: false, text: '外观与槽位不匹配' };
    prof.eq[slot] = id;
  } else {
    prof.eq[slot] = null;
  }
  board.save();
  return {
    ok: true,
    name: prof.name,
    coins: prof.coins,
    owned: prof.owned.slice(),
    eq: Object.assign({}, prof.eq),
    login: loginStatus(prof),
    hasPassword: false,
    locked: false,
    ...oauthExtras(oauth),
  };
}

function menuBuy(ip, name, itemId, password, oauth) {
  const auth = checkAccess(ip, name, password, oauth);
  if (!auth.ok) return auth;
  const item = shopItem(itemId);
  if (!item) return { ok: false, text: '商品不存在' };
  if (item.giftOnly) return { ok: false, text: '彩蛋专属，无法购买' };
  if (item.loginOnly) return { ok: false, text: '七日登录专属，无法购买' };
  if (!COS_SLOTS.includes(item.slot)) return { ok: false, text: '局外仅可购买时装外观' };
  if (item.weaponId || item.buffId) return { ok: false, text: '局外仅可购买时装外观' };

  const bound = bindAuth(auth, ip);
  if (!bound.ok) return bound;
  const prof = bound.prof;
  ensureLoginFields(prof);
  if (prof.owned.includes(item.id)) return { ok: false, text: '已拥有该外观' };
  if (prof.coins < item.price) return { ok: false, text: '金币不足' };

  prof.coins -= item.price;
  prof.owned.push(item.id);
  prof.eq[item.slot] = item.id;
  board.save();

  return {
    ok: true,
    name: prof.name,
    item: item.id,
    itemName: item.name,
    coins: prof.coins,
    owned: prof.owned.slice(),
    eq: Object.assign({}, prof.eq),
    login: loginStatus(prof),
    hasPassword: false,
    locked: false,
    text: `购买成功：${item.name}（-${item.price} 金币）`,
    ...oauthExtras(oauth),
  };
}

module.exports = {
  todayKey, cleanName, oauthSiteName, profilePayload, claimLogin, menuEquip, menuBuy, setPassword, checkAccess, COS_SLOTS,
  isZardName, grantZardStarter, allCosmeticIds,
};
