// LinuxDo OAuth2 / OIDC：授权码流程 + 签名会话 Cookie
// 账号 id 加 ld: 前缀，避免和 NodeLoc 数字 id 撞档
'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const AUTH_URL = process.env.LINUXDO_AUTH_URL || 'https://connect.linux.do/oauth2/authorize';
const TOKEN_URL = process.env.LINUXDO_TOKEN_URL || 'https://connect.linux.do/oauth2/token';
const USER_URL = process.env.LINUXDO_USER_URL || 'https://connect.linux.do/api/user';
const CLIENT_ID = process.env.LINUXDO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.LINUXDO_CLIENT_SECRET || '';
const SCOPE = process.env.LINUXDO_SCOPE || 'openid profile';
const NATIVE_SCHEME = process.env.NATIVE_OAUTH_SCHEME || 'neonarena';
const COOKIE_SESSION = 'na_ld';
const COOKIE_STATE = 'na_ld_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function defaultRedirect() {
  const explicit = process.env.LINUXDO_REDIRECT_URI || process.env.LinuxDo_REDIRECT_URI;
  if (explicit) return explicit;
  return 'https://fps2.zard.loc.cc/auth/callback';
}

const REDIRECT_URI = defaultRedirect();
const SIGN_SECRET = process.env.LINUXDO_SESSION_SECRET
  || process.env.SESSION_SECRET
  || CLIENT_SECRET
  || 'neon-arena-linuxdo';

function enabled() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function loginStartUrl(native) {
  try {
    const u = new URL(REDIRECT_URI);
    if (native) u.searchParams.set('native', '1');
    return u.toString();
  } catch (_) {
    return native ? '/auth/callback?native=1' : '/auth/callback';
  }
}

function redirectUriFor() {
  return REDIRECT_URI;
}

let proxyCache;
function systemProxyUrl() {
  if (proxyCache !== undefined) return proxyCache;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || '';
  if (env) {
    proxyCache = env;
    return proxyCache;
  }
  proxyCache = '';
  if (process.platform !== 'win32') return proxyCache;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8' });
    const en = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (!en || (parseInt(en[1], 16) | 0) !== 1) return proxyCache;
    const srv = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out);
    if (!srv) return proxyCache;
    let p = srv[1].trim();
    const httpsPart = /https=([^;]+)/i.exec(p);
    if (httpsPart) p = httpsPart[1];
    else if (p.includes('=')) {
      const httpPart = /http=([^;]+)/i.exec(p);
      if (httpPart) p = httpPart[1];
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = 'http://' + p;
    proxyCache = p;
  } catch (_) { /* 没有系统代理就直连 */ }
  return proxyCache;
}

function fetchViaProxy(urlStr, options, proxyStr) {
  const target = new URL(urlStr);
  const proxy = new URL(proxyStr);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const headers = Object.assign({
    Host: target.host,
    'User-Agent': 'neon-arena',
    Accept: 'application/json',
  }, options.headers || {});
  const body = options.body == null ? '' : String(options.body);
  if (body && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const preq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: target.hostname + ':' + port,
      timeout: 15000,
    });
    const fail = (err) => {
      preq.destroy();
      reject(err);
    };
    preq.on('timeout', () => fail(new Error('连接 LinuxDo 超时')));
    preq.on('error', fail);
    preq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理连接失败: HTTP ' + res.statusCode));
        return;
      }
      const req = https.request({
        host: target.hostname,
        servername: target.hostname,
        socket,
        method: options.method || 'GET',
        path: target.pathname + target.search,
        headers,
        timeout: 15000,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: r.statusCode >= 200 && r.statusCode < 300,
            status: r.statusCode,
            text: async () => text,
          });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('连接 LinuxDo 超时'));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    preq.end();
  });
}

async function linuxdoFetch(urlStr, options) {
  const proxy = systemProxyUrl();
  if (proxy && /^https?:\/\//i.test(proxy)) {
    try {
      return await fetchViaProxy(urlStr, options || {}, proxy);
    } catch (e) {
      const err = new Error('无法连接 LinuxDo: ' + (e.message || e));
      err.cause = e;
      throw err;
    }
  }
  const headers = Object.assign({ 'User-Agent': 'neon-arena', Accept: 'application/json' }, (options && options.headers) || {});
  try {
    return await fetch(urlStr, Object.assign({}, options, {
      headers,
      signal: AbortSignal.timeout(15000),
    }));
  } catch (e) {
    throw new Error('无法连接 LinuxDo: ' + (e.message || e));
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
  const parts = ['Path=/', `Max-Age=${maxAgeSec}`, 'SameSite=Lax', 'HttpOnly'];
  if (cookieSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, line) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', line);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(line));
  else res.setHeader('Set-Cookie', [prev, line]);
}

function accountId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return s.startsWith('ld:') ? s : ('ld:' + s);
}

function makeSessionToken(user) {
  return sign({
    id: accountId(user.id),
    username: user.username || '',
    name: user.name || user.username || '',
    trust_level: user.trust_level | 0,
    avatar_url: user.avatar_url || '',
    provider: 'linuxdo',
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

function setStateCookie(res, req, state, native, redirectUri) {
  const token = sign({
    state,
    native: !!native,
    redirect: redirectUri || '',
    exp: Date.now() + STATE_TTL_MS,
  });
  appendCookie(res, `${COOKIE_STATE}=${encodeURIComponent(token)}; ${cookieFlags(req, Math.floor(STATE_TTL_MS / 1000))}`);
}

function clearStateCookie(res, req) {
  const secure = cookieSecure(req) ? '; Secure' : '';
  appendCookie(res, `${COOKIE_STATE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`);
}

function userFromToken(token) {
  const data = verify(token);
  if (!data || data.id == null || data.id === '') return null;
  if (data.provider && data.provider !== 'linuxdo') return null;
  return {
    id: accountId(data.id),
    username: String(data.username || ''),
    name: String(data.name || data.username || ''),
    trust_level: data.trust_level | 0,
    avatar_url: String(data.avatar_url || ''),
    provider: 'linuxdo',
  };
}

function userFromReq(req) {
  return userFromToken(parseCookie(req, COOKIE_SESSION))
    || userFromToken(bearerToken(req))
    || userFromToken(parseQueryToken(req));
}

function authorizeUrl(state, redirectUri) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  return u.toString();
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await linuxdoFetch(TOKEN_URL, {
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

function unwrapUser(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.user && typeof json.user === 'object') return json.user;
  return json;
}

async function fetchUserInfo(accessToken) {
  const res = await linuxdoFetch(USER_URL, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  const user = unwrapUser(json);
  const rawId = user && (user.id != null ? user.id : user.sub);
  if (!res.ok || rawId == null || rawId === '') {
    const msg = (json && (json.error_description || json.error || json.message)) || text.slice(0, 200) || ('HTTP ' + res.status);
    throw new Error('获取用户信息失败: ' + msg);
  }
  const username = String(user.username || user.login || user.preferred_username || user.name || ('ld' + rawId));
  return {
    id: accountId(rawId),
    username,
    name: String(user.name || username),
    avatar_url: String(user.avatar_url || user.avatar_template || user.avatar || ''),
    trust_level: user.trust_level | 0,
    provider: 'linuxdo',
  };
}

function wantNative(req) {
  const q = req.query || {};
  return q.native === '1' || q.native === 'true';
}

function pageMsg(title, body, href) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#dcecff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;padding:28px;border:1px solid rgba(53,224,255,.25);border-radius:12px;background:rgba(20,30,48,.9)}
a{color:#35e0ff}</style></head><body><div class="card"><h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
<p style="line-height:1.5;color:#9fb4c9">${body}</p><p><a href="${href}">返回游戏</a></p></div></body></html>`;
}

function startLogin(req, res) {
  if (!enabled()) {
    res.status(503).type('html').send(pageMsg('未配置 LinuxDo OAuth', '缺少 Client ID / Secret / Redirect URI。', '/'));
    return;
  }
  const native = wantNative(req);
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = redirectUriFor(req);
  setStateCookie(res, req, state, native, redirectUri);
  res.redirect(302, authorizeUrl(state, redirectUri));
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
  res.status(200).type('html').send(nativeReturnHtml(nativeDeepLink(params), title, body));
}

async function handleCallback(req, res) {
  const { code, state, error, error_description: errDesc } = req.query || {};
  const stateData = readState(req);
  const native = !!(stateData && stateData.native);
  clearStateCookie(res, req);

  if (error) {
    const tip = error === 'access_denied' ? '你取消了 LinuxDo 授权。' : ('授权失败：' + (errDesc || error));
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
    const redirectUri = (stateData && stateData.redirect) || redirectUriFor(req);
    const token = await exchangeCode(code, redirectUri);
    const user = await fetchUserInfo(token.access_token);
    const sessionToken = setSessionCookie(res, req, user);
    try { require('./oauth-nodeloc').clearSessionCookie(res, req); } catch (_) { /* 忽略 */ }
    const nameHint = String(user.username || user.name || '').slice(0, 12);
    if (native) {
      return finishNative(res, { t: sessionToken, name: nameHint, provider: 'linuxdo' }, '登录成功', '正在返回游戏 App…若未自动跳转请点下方按钮。');
    }
    res.redirect(302, '/?oauth=1&provider=linuxdo&name=' + encodeURIComponent(nameHint));
  } catch (e) {
    console.error('[oauth-linuxdo]', e.message || e);
    const tip = e.message || '登录失败';
    if (native) return finishNative(res, { error: tip }, '登录失败', tip);
    res.redirect(302, '/?oauth_error=' + encodeURIComponent(tip));
  }
}

function route(req, res) {
  if (req.query && (req.query.code || req.query.error)) {
    Promise.resolve(handleCallback(req, res)).catch((e) => {
      console.error('[oauth-linuxdo] callback crash:', e);
      if (!res.headersSent) {
        res.redirect(302, '/?oauth_error=' + encodeURIComponent('登录回调异常，请重试'));
      }
    });
    return;
  }
  return startLogin(req, res);
}

module.exports = {
  enabled, userFromReq, userFromToken, startLogin, handleCallback, route,
  loginStartUrl, clearSessionCookie, REDIRECT_URI, CLIENT_ID,
};
