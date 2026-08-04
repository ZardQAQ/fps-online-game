// NodeLoc OAuth2：授权码流程 + 签名会话 Cookie（无 express-session 依赖）
// 安卓 App：?native=1 走系统浏览器授权，回调后用 neonarena:// deep link 回传会话 token
'use strict';
const crypto = require('crypto');

const BASE_URL = (process.env.NodeLoc_URL || process.env.NODELOC_URL || 'https://www.nodeloc.com').replace(/\/$/, '');

const REDIRECT_URI = process.env.NodeLoc_REDIRECT_URI || process.env.NODELOC_REDIRECT_URI
  || 'http://fps2.zard.loc.cc/oauth/nodeloc';
const SCOPE = process.env.NodeLoc_SCOPE || process.env.NODELOC_SCOPE || 'openid profile';
const NATIVE_SCHEME = process.env.NATIVE_OAUTH_SCHEME || 'neonarena';
const COOKIE_SESSION = 'na_nl';
const COOKIE_STATE = 'na_nl_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const STATE_TTL_MS = 10 * 60 * 1000;
const SIGN_SECRET = process.env.NODELOC_SESSION_SECRET
  || process.env.SESSION_SECRET
  || CLIENT_SECRET
  || 'neon-arena-nodeloc';

function enabled() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function oauthOrigin() {
  try { return new URL(REDIRECT_URI).origin; } catch (_) { return ''; }
}

function loginStartUrl(native) {
  try {
    const u = new URL(REDIRECT_URI);
    if (native) u.searchParams.set('native', '1');
    return u.toString();
  } catch (_) {
    return native ? '/oauth/nodeloc?native=1' : '/oauth/nodeloc';
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', SIGN_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SIGN_SECRET).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object') return null;
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function parseCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function parseQueryToken(req) {
  try {
    const rawUrl = req.url || '';
    const q = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    const params = new URLSearchParams(q);
    return params.get('nl') || params.get('t') || '';
  } catch (_) {
    return '';
  }
}

function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== 'string') return '';
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : '';
}

function cookieSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  if (String(REDIRECT_URI).startsWith('https://')) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function cookieFlags(req, maxAgeSec) {
  const parts = [`Path=/`, `Max-Age=${maxAgeSec}`, `SameSite=Lax`, `HttpOnly`];
  if (cookieSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, line) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', line);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(line));
  else res.setHeader('Set-Cookie', [prev, line]);
}

function makeSessionToken(user) {
  return sign({
    id: user.id,
    username: user.username || '',
    name: user.name || user.username || '',
    trust_level: user.trust_level | 0,
    avatar_url: user.avatar_url || '',
    exp: Date.now() + SESSION_TTL_MS,
  });
}

function setSessionCookie(res, req, user, tokenOpt) {
  const token = tokenOpt || makeSessionToken(user);
  appendCookie(res, `${COOKIE_SESSION}=${encodeURIComponent(token)}; ${cookieFlags(req, Math.floor(SESSION_TTL_MS / 1000))}`);
  return token;
}

function clearSessionCookie(res, req) {
  const secure = cookieSecure(req) ? '; Secure' : '';
  appendCookie(res, `${COOKIE_SESSION}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`);
}

function setStateCookie(res, req, state, native) {
  const token = sign({ state, native: !!native, exp: Date.now() + STATE_TTL_MS });
  appendCookie(res, `${COOKIE_STATE}=${encodeURIComponent(token)}; ${cookieFlags(req, Math.floor(STATE_TTL_MS / 1000))}`);
}

function clearStateCookie(res, req) {
  const secure = cookieSecure(req) ? '; Secure' : '';
  appendCookie(res, `${COOKIE_STATE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`);
}

function userFromToken(token) {
  const data = verify(token);
  if (!data || data.id == null || data.id === '') return null;
  return {
    id: data.id,
    username: String(data.username || ''),
    name: String(data.name || data.username || ''),
    trust_level: data.trust_level | 0,
    avatar_url: String(data.avatar_url || ''),
  };
}

function userFromReq(req) {
  return userFromToken(parseCookie(req, COOKIE_SESSION))
    || userFromToken(bearerToken(req))
    || userFromToken(parseQueryToken(req));
}

function authorizeUrl(state) {
  const u = new URL(BASE_URL + '/oauth-provider/authorize');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  return u.toString();
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(BASE_URL + '/oauth-provider/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!res.ok || !json || !json.access_token) {
    const msg = (json && (json.error_description || json.error)) || text.slice(0, 200) || ('HTTP ' + res.status);
    throw new Error('换取 token 失败: ' + msg);
  }
  return json;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch(BASE_URL + '/oauth-provider/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!res.ok || !json || json.id == null) {
    const msg = (json && (json.error_description || json.error || json.message)) || text.slice(0, 200) || ('HTTP ' + res.status);
    throw new Error('获取用户信息失败: ' + msg);
  }
  return {
    id: json.id,
    username: String(json.username || json.name || ('nl' + json.id)),
    name: String(json.name || json.username || ('nl' + json.id)),
    avatar_url: String(json.avatar_url || ''),
    trust_level: json.trust_level | 0,
    email: json.email ? String(json.email) : '',
  };
}

function wantNative(req) {
  const q = req.query || {};
  return q.native === '1' || q.native === 'true';
}

function startLogin(req, res) {
  if (!enabled()) {
    res.status(503).type('html').send(pageMsg('未配置 NodeLoc OAuth', '缺少 Client ID / Secret / Redirect URI。', '/'));
    return;
  }
  const native = wantNative(req);
  const state = crypto.randomBytes(16).toString('hex');
  setStateCookie(res, req, state, native);
  res.redirect(302, authorizeUrl(state));
}

function readState(req) {
  return verify(parseCookie(req, COOKIE_STATE));
}

function nativeDeepLink(params) {
  const u = new URL(NATIVE_SCHEME + '://oauth');
  Object.keys(params).forEach((k) => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  return u.toString();
}

function nativeReturnHtml(deepLink, title, body) {
  const safeLink = String(deepLink).replace(/"/g, '&quot;');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#dcecff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{max-width:420px;padding:28px;border:1px solid rgba(53,224,255,.25);border-radius:12px;background:rgba(20,30,48,.9)}
a.btn{display:inline-block;margin-top:14px;padding:10px 16px;border-radius:8px;background:#35e0ff;color:#041018;font-weight:700;text-decoration:none}
p{line-height:1.5;color:#9fb4c9}</style>
<script>location.href=${JSON.stringify(deepLink)};setTimeout(function(){location.href=${JSON.stringify(deepLink)};},400);</script>
</head><body><div class="card"><h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
<p>${body}</p><p><a class="btn" href="${safeLink}">返回游戏 App</a></p></div></body></html>`;
}

function finishNative(res, params, title, body) {
  const deep = nativeDeepLink(params);
  res.status(200).type('html').send(nativeReturnHtml(deep, title, body));
}

async function handleCallback(req, res) {
  const { code, state, error, error_description: errDesc } = req.query || {};
  const stateData = readState(req);
  const native = !!(stateData && stateData.native);
  clearStateCookie(res, req);

  if (error) {
    const tip = error === 'access_denied' ? '你取消了 NodeLoc 授权。' : ('授权失败：' + (errDesc || error));
    if (native) return finishNative(res, { error: tip }, '登录取消', tip);
    res.redirect(302, '/?oauth_error=' + encodeURIComponent(tip));
    return;
  }
  if (!code) {
    const tip = '缺少授权码';
    if (native) return finishNative(res, { error: tip }, '登录失败', tip);
    res.redirect(302, '/?oauth_error=' + encodeURIComponent(tip));
    return;
  }
  if (!(stateData && stateData.state && state && stateData.state === state)) {
    const tip = '登录状态校验失败，请重试';
    if (native) return finishNative(res, { error: tip }, '登录失败', tip);
    res.redirect(302, '/?oauth_error=' + encodeURIComponent(tip));
    return;
  }

  try {
    const token = await exchangeCode(code);
    const user = await fetchUserInfo(token.access_token);
    const sessionToken = setSessionCookie(res, req, user);
    const nameHint = String(user.username || user.name || '').slice(0, 12);
    if (native) {
      return finishNative(res, { t: sessionToken, name: nameHint }, '登录成功', '正在返回游戏 App…若未自动跳转请点下方按钮。');
    }
    res.redirect(302, '/?oauth=1&name=' + encodeURIComponent(nameHint));
  } catch (e) {
    console.error('[oauth-nodeloc]', e.message || e);
    const tip = e.message || '登录失败';
    if (native) return finishNative(res, { error: tip }, '登录失败', tip);
    res.redirect(302, '/?oauth_error=' + encodeURIComponent(tip));
  }
}

function logout(req, res) {
  clearSessionCookie(res, req);
  res.json({ ok: true });
}

function me(req, res) {
  const user = userFromReq(req);
  res.json({
    ok: true,
    enabled: enabled(),
    loggedIn: !!user,
    user: user || null,
    loginUrl: loginStartUrl(false),
    nativeLoginUrl: loginStartUrl(true),
    redirectUri: REDIRECT_URI,
    oauthOrigin: oauthOrigin(),
  });
}

function pageMsg(title, body, href) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#dcecff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;padding:28px;border:1px solid rgba(53,224,255,.25);border-radius:12px;background:rgba(20,30,48,.9)}
a{color:#35e0ff}</style></head><body><div class="card"><h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
<p style="line-height:1.5;color:#9fb4c9">${body}</p><p><a href="${href}">返回游戏</a></p></div></body></html>`;
}

function route(req, res) {
  if (req.query && (req.query.code || req.query.error)) {
    Promise.resolve(handleCallback(req, res)).catch((e) => {
      console.error('[oauth-nodeloc] callback crash:', e);
      if (!res.headersSent) {
        res.redirect(302, '/?oauth_error=' + encodeURIComponent('登录回调异常，请重试'));
      }
    });
    return;
  }
  return startLogin(req, res);
}

module.exports = {
  enabled, userFromReq, userFromToken, startLogin, handleCallback, logout, me, route,
  loginStartUrl, makeSessionToken, REDIRECT_URI, CLIENT_ID, BASE_URL, NATIVE_SCHEME,
};
