// 主逻辑：网络同步 / 第一·第三人称 / 战斗 / 昼夜 / HUD / 聊天 / 商店(3D预览) / 排行榜 / 观战 / 设置
(function () {
  const T = THREE;
  const $ = id => document.getElementById(id);
  const V3 = (x, y, z) => new T.Vector3(x, y, z);
  const now = () => Date.now();
  const qs = new URLSearchParams(location.search);
  const NOLOCK = qs.get('nolock') === '1';
  const IS_NATIVE_APP = !!(window.Capacitor && (
    (typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
    || window.Capacitor.getPlatform?.() === 'android'
  ));
  const NATIVE_GAME_ORIGIN = 'http://fps.zard.loc.cc';
  const NL_TOKEN_KEY = 'na_nl_token';
  const NATIVE_OAUTH_SCHEME = 'neonarena';

  // ---------- 移动端检测 + 画质分级 ----------
  // 判定依据：主指针精度（pointer:coarse = 触屏/手写笔），可用 ?touch=1/0 强制覆盖用于桌面调试
  const TOUCH = (() => {
    const f = qs.get('touch');
    if (f === '1') return true;
    if (f === '0') return false;
    if (matchMedia('(pointer: coarse)').matches) return true;
    if (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches) return true;
    return false;
  })();
  document.body.classList.toggle('mobile', TOUCH);

  // ---------- 移动端自动横屏（全屏 + 系统锁屏，无 CSS 强制旋转） ----------
  function isPortrait() { return innerHeight > innerWidth; }
  function setRotateStatus(text) {
    const el = $('rotateStatus');
    if (el) el.textContent = text || '';
  }
  function resizeViewport() {
    if (innerWidth <= 0 || innerHeight <= 0) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  async function requestLandscape() {
    if (!TOUCH) return;
    setRotateStatus('正在进入全屏…');
    const root = document.documentElement;
    try {
      if (root.requestFullscreen) await root.requestFullscreen();
      else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
      else if (root.webkitEnterFullscreen) await root.webkitEnterFullscreen();
    } catch (_) {
      setRotateStatus('无法进入全屏，请手动旋转屏幕');
      updateRotateHint();
      return;
    }
    await new Promise(r => setTimeout(r, 120));
    updateRotateHint();
    resizeViewport();
    setRotateStatus(isPortrait() ? '已进入全屏，请现在旋转手机至横屏' : '已进入全屏');
  }
  function updateRotateHint() {
    if (!TOUCH) return;
    const portrait = isPortrait();
    document.body.classList.toggle('portrait', portrait);
    const hint = $('rotateHint');
    if (hint) hint.classList.toggle('hidden', !portrait);
  }
  function onViewportChange() {
    updateRotateHint();
    resizeViewport();
    if (TOUCH) applyTouchLayoutAll();
  }
  function initMobileLandscape() {
    if (!TOUCH) return;
    updateRotateHint();
    addEventListener('orientationchange', () => setTimeout(onViewportChange, 120));
    const btn = $('btnRotateLandscape');
    if (btn) btn.addEventListener('click', e => { e.stopPropagation(); requestLandscape(); });
    const pauseBtn = $('btnPauseLandscape');
    if (pauseBtn) pauseBtn.addEventListener('click', () => requestLandscape());
  }

  // 画质仅影响阴影分辨率/抗锯齿/像素比这类纯观感开销，绝不缩短视距/雾距——
  // 视野范围是竞技公平性的一部分，任何设备都必须能看到同样远的敌人
  const QUALITY = {
    high:   { pr: 2,    aa: true,  shadow: 2048, soft: true  },
    medium: { pr: 1.5,  aa: true,  shadow: 1024, soft: false },
    low:    { pr: 1.15, aa: false, shadow: 512,  soft: false },
  };
  const quality = (() => {
    const forced = qs.get('quality');
    if (QUALITY[forced]) return QUALITY[forced];
    if (!TOUCH) return QUALITY.high;
    const hwc = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    return (hwc <= 4 || mem <= 3) ? QUALITY.low : QUALITY.medium;
  })();

  const WICON = { fist: '👊', knife: '🔪', sword: '⚔️', hammer: '🔨', pistol: '🔫', mg: '💥', shotgun: '💢', sniper: '🎯', charge: '🔶', railgun: '⚡', nade: '🧨', flash: '🔆', smoke: '💨', boss: '👹', barrel: '🛢️' };
  const COS_ICON = {
    hat_cowboy: '🤠', hat_beret: '🧢', hat_horns: '😈', hat_crown: '👑', hat_halo: '😇',
    face_shades: '🕶️', face_visor: '🥽', face_oni: '👹', face_kitsune: '🦊', face_holo: '💠',
    back_cape: '🦸', back_jet: '🚀', back_wings: '👼', back_phoenix: '🔥', back_dragon: '🐉', back_void: '🌌',
    back_solar: '💿', back_aether: '💠',
    fx_ice: '❄️', fx_gold: '✨', fx_plasma: '⚡', fx_rainbow: '🌈', trophy_dev: '🏆',
    login_cap: '🧢', login_goggles: '🥽', login_scarf: '🧣', login_helm: '⛑️',
    login_mask: '🎭', login_pack: '🎒', login_aura: '💜',
  };

  // ---------- 渲染器 ----------
  const canvas = $('cv');
  const renderer = new T.WebGLRenderer({ canvas, antialias: quality.aa, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(quality.pr, window.devicePixelRatio));
  const vp0 = { w: innerWidth, h: innerHeight };
  renderer.setSize(vp0.w, vp0.h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = quality.soft ? T.PCFSoftShadowMap : T.PCFShadowMap;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  const scene = new T.Scene();
  const BASE_FOV = 75;
  const VIEW_LAYER = 1;
  const camera = new T.PerspectiveCamera(BASE_FOV, vp0.w / vp0.h, 0.08, 400);
  camera.rotation.order = 'YXZ';
  addEventListener('resize', onViewportChange);
  initMobileLandscape();

  // ---------- 设置（持久化） ----------
  const settings = {
    music: localStorage.getItem('na_music') !== '0',
    sfx: localStorage.getItem('na_sfx') !== '0',
    sens: Math.max(0.3, Math.min(2, parseFloat(localStorage.getItem('na_sens')) || 1)),
    gyroSens: Math.max(0.3, Math.min(2.5, parseFloat(localStorage.getItem('na_gyro_sens')) || 1)),
    gyroInvert: localStorage.getItem('na_gyro_invert') === '1',
    view: localStorage.getItem('na_view') === 'tp' ? 'tp' : 'fp',
    gyro: localStorage.getItem('na_gyro') === '1',
  };
  G.audio.setMusic(settings.music);
  G.audio.setSfx(settings.sfx);
  G.audio.setLite(TOUCH);   // 轻量BGM：移动端减少同时发声的振荡器数量
  // 移动端音频解锁：触屏比鼠标点击更早触发，touchstart 抢在 click 之前解锁 AudioContext
  addEventListener('touchstart', () => G.audio.init(), { once: true, passive: true });
  // 触屏/桌面各自的操作说明（触控层显隐由 updateTouchLayout 按模式统一管理）
  $('helpDesktop').classList.toggle('hidden', TOUCH);
  $('helpTouch').classList.toggle('hidden', !TOUCH);
  $('touchLayer').classList.add('hidden');   // 启动在菜单态，先整体收起；进 play/spec 时由 updateTouchLayout 展开

  // ---------- 全局状态 ----------
  let ws = null, wsOk = false, defs = null, worldBuilt = false;
  let mode = 'menu';            // menu | play | spec
  let myId = 0, myName = localStorage.getItem('na_name') || '';
  let you = { coins: 0, owned: [], eq: { head: null, face: null, back: null, fx: null } };
  let menuLogin = { day: 1, claimedToday: true };
  let nameHasPassword = false;
  let profileLocked = false;
  let sessionPass = '';
  let pendingAuthAction = null;
  let oauthUser = null;
  let oauthEnabled = true;
  let oauthLoginUrl = '/oauth/nodeloc';
  let oauthNativeLoginUrl = '';
  let linuxdoLoginUrl = '/oauth/linuxdo';
  let linuxdoNativeLoginUrl = '';
  let nodelocEnabled = true;
  let linuxdoEnabled = true;
  let oauthToken = '';
  try { oauthToken = localStorage.getItem(NL_TOKEN_KEY) || ''; } catch (_) { oauthToken = ''; }
  let guestMode = false;
  let guestName = '';
  let guestJoinQueued = false;
  let reconnectTimer = null;
  let wardTab = 'all';
  let wardPage = 0;
  const WARD_PAGE_ALL = 6;
  const WARD_PAGE_SLOT = 5;   // 非「全部」每页最多 5 条（不含卸下）
  let wardPre = null;
  let arsenalPre = null;
  let arsenalFocus = null;   // 聚焦某把枪时相机缓动目标 id
  let arsenalFocusT = 0;
  let wardHoverEq = null;
  let mySnap = null;
  let lastKillerText = '';
  let pendingKeepGun = null;   // 商店枪保留提示（死亡界面与消息时序）
  let rejoinWanted = false;
  let selectedRoomId = 'official';
  let roomCap = 10;
  let hasServerRooms = false;
  let roomList = [{ id: 'official', name: '官方大厅', official: true, players: 0, spectators: 0, cap: 10, owner: '官方' }];
  const roomPassCache = new Map();
  let roomGateMode = 'play';
  let pendingRoomPass = '';
  let kickedText = null;        // 被反作弊踢出/封禁的原因（断线重连提示优先展示）
  let pingMs = 0, lastPingAt = 0;
  let dayBase = 0, dayAt = 0, dayMs = 600000;

  const me = {
    pos: V3(0, 0, 0), vx: 0, vy: 0, vz: 0, grounded: true, yaw: 0, pitch: 0,
    active: 'melee', ammoL: 0, reserve: 0, nadeLeft: 0, reloadUntil: 0, reloadDur: 1, chargingUntil: 0,
    lastMelee: 0, lastShot: 0, lastNade: -99999, lastSwitch: 0,
    cookLeft: 0, cookExpireAt: 0, nadeHolding: false, nadePrimeSent: false, nadeDryFired: false,
    moving: false, zoom: 0, stepT: 0, spread: 0, fallV: 0,
    swayX: 0, swayY: 0, cheatOn: false,
  };
  const keys = {};
  let mouseDown = false, rmbDown = false, lockWanted = false;
  // 触屏摇杆/视角状态：joyX/joyZ 为 -1..1 模拟量（movement() 里与键盘输入二选一）
  const touch = { joyId: null, joyBaseX: 0, joyBaseY: 0, joyX: 0, joyZ: 0, lookId: null };
  const activeTouches = new Map();   // touch identifier -> {role:'joy'|'look', ...}

  const ents = new Map();
  let bossEnt = null;
  const handEnts = new Map();   // amiya 不可视之手
  let ckptMesh = null;          // 死亡回归记录点
  let shadowMesh = null;        // 嫉妒之影地面环
  let pickupMeshes = [];
  let projMeshes = [];          // {id, kind, g, target, vel, netAt}
  let nadeMeshes = [];          // {id, g, target, vel, netAt}
  let merchants = [];
  let vm = null;
  let vmSwingT = 9, vmKick = 0, vmThrowT = 9;
  const INSPECT_DUR = 2.45;
  let vmInspectT = 99;   // >= INSPECT_DUR 表示空闲
  let recoilPitch = 0;   // 重武器开火瞬间上抬，随后回落到准心（不改真实瞄准角）
  let myModel = null;           // 第三人称下渲染自己的模型
  let specFollowId = null, specFree = { pos: V3(0, 18, 30) }, specView = 'tp', specSpeed = 1;   // 跟随用玩家 id（不是数组下标），避免目标死亡/进出场导致跟随对象乱跳
  let shopPre = null, hoverEq = null;
  let lastBeatAt = 0;
  let blindUntil = 0, blindTotal = 1;   // 闪光弹致盲：结束时间戳 + 本次总时长（算白屏淡出曲线用）
  const COOK_RING_LEN = 175.93;

  // ---------- 网络 ----------
  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const endpoint = new URL(IS_NATIVE_APP ? NATIVE_GAME_ORIGIN : location.origin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    if (IS_NATIVE_APP && oauthToken) endpoint.searchParams.set('nl', oauthToken);
    ws = new WebSocket(endpoint.href);
    ws.onopen = () => {
      wsOk = true;
      $('lost').classList.add('hidden');
      if (rejoinWanted && myName && isOauthLoggedIn()) send(joinMsg());
      else if (guestMode && !isOauthLoggedIn()) send({ type: 'guest_login' });
      else if (mode === 'menu') requestMenuProfile();
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      handleMsg(m);
    };
    ws.onclose = () => {
      wsOk = false;
      if (kickedText) {
        rejoinWanted = false;
        backToMenu();
        $('lost').classList.remove('hidden');
        $('lostText').textContent = kickedText;
        setTimeout(() => { $('lost').classList.add('hidden'); kickedText = null; }, 6000);
      } else if (mode !== 'menu' || rejoinWanted) {
        rejoinWanted = mode === 'play' || rejoinWanted;
        $('lost').classList.remove('hidden');
        $('lostText').textContent = '连接已断开，正在重连…';
      }
      reconnectTimer = setTimeout(connect, 2500);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function reconnectNow() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try {
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    } catch (_) { /* ignore */ }
    connect();
  }
  function send(obj) { if (wsOk && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function handleMsg(m) {
    switch (m.type) {
      case 'defs': onDefs(m); break;
      case 'state': onState(m); break;
      case 'joined':
        myId = m.id; myName = m.name;
        if (m.roomId) selectedRoomId = m.roomId;
        if (m.guest) {
          guestMode = true;
          guestName = m.name || '';
          if ($('nameInput')) {
            $('nameInput').value = guestName;
            $('nameInput').readOnly = true;
          }
        } else {
          guestMode = false;
          guestName = '';
          localStorage.setItem('na_name', myName);
          if ($('nameInput')) $('nameInput').value = myName;
        }
        you = m.you; rejoinWanted = false;
        profileLocked = false;
        updateOauthUi();
        updatePassHint();
        enterPlay();
        break;
      case 'guest':
        if (m.cleared) break;
        if (!m.ok) {
          if (!isOauthLoggedIn()) {
            guestMode = false;
            guestName = '';
            myName = '';
            if ($('nameInput')) $('nameInput').value = '';
          }
          if (m.text) $('menuErr').textContent = m.text;
          updateOauthUi();
          updatePassHint();
          syncGuestChatLock();
          guestJoinQueued = false;
          break;
        }
        if (isOauthLoggedIn()) { guestJoinQueued = false; break; }
        guestMode = true;
        guestName = m.name || '';
        myName = guestName;
        if ($('nameInput')) {
          $('nameInput').value = guestName;
          $('nameInput').readOnly = true;
        }
        $('menuErr').textContent = '';
        updateOauthUi();
        updatePassHint();
        syncGuestChatLock();
        if (guestJoinQueued && mode === 'menu') {
          guestJoinQueued = false;
          doJoinPlay();
        } else if (rejoinWanted && mode !== 'menu') send(joinMsg());
        break;
      case 'rooms':
        hasServerRooms = true;
        renderRooms(m);
        break;
      case 'room_created':
        if (m.ok && m.room && m.room.id) {
          selectedRoomId = m.room.id;
          if (pendingRoomPass) roomPassCache.set(m.room.id, pendingRoomPass);
          pendingRoomPass = '';
          if ($('roomNameInput')) $('roomNameInput').value = '';
          if ($('roomPassInput')) $('roomPassInput').value = '';
          if ($('roomPassToggle')) $('roomPassToggle').checked = false;
          if ($('roomPassInput')) $('roomPassInput').classList.add('hidden');
          if ($('roomCreateHint')) {
            $('roomCreateHint').textContent = '已创建房间，正在进入…';
            $('roomCreateHint').className = 'room-hint ok';
          }
          doJoinPlay();
        }
        break;
      case 'spec': mode = 'spec'; enterSpec(); break;
      case 'left': backToMenu(); break;
      case 'you': you = { coins: m.coins, owned: m.owned, eq: m.eq }; renderShop(); updateMenuProfile(); renderWardrobe(); break;
      case 'oauth':
        applyOauthState(m);
        break;
      case 'profile':
        if (!m.ok) {
          if (m.needOauth) highlightNeedOauth(m.text);
          updateMenuProfile(null);
          break;
        }
        applyMenuProfile(m);
        break;
      case 'claim_login':
        if (!m.ok) {
          setLoginMsg(m.text || '领取失败', false);
          if (m.needOauth) highlightNeedOauth(m.text);
          G.audio.deny();
          break;
        }
        applyMenuProfile(m);
        setLoginMsg(m.text, true);
        G.audio.buy();
        notice(m.text, true);
        renderLoginDays();
        break;
      case 'menu_equip':
        if (!m.ok) {
          setWardMsg(m.text || '换装失败', false);
          if (m.needOauth) highlightNeedOauth(m.text);
          G.audio.deny();
          break;
        }
        applyMenuProfile(m);
        setWardMsg('已更新外观', true);
        G.audio.ui();
        break;
      case 'menu_buy':
        if (!m.ok) {
          setWardMsg(m.text || '购买失败', false);
          if (m.needOauth) highlightNeedOauth(m.text);
          G.audio.deny();
          break;
        }
        applyMenuProfile(m);
        setWardMsg(m.text || '购买成功', true);
        G.audio.buy();
        notice(m.text || `购买成功：${m.itemName}`, true);
        break;
      case 'set_password':
        break;
      case 'fx': onFx(m); break;
      case 'kill': onKill(m); break;
      case 'chat':
        if (m.plain) addChat(`<span style="color:${m.color || '#ccc'}">${esc(m.text)}</span>`);
        else addChat(`<span class="cname" style="color:${m.color}">${esc(m.from)}</span>：${esc(m.text)}`);
        if (m.from && m.from !== myName) G.audio.chat();
        break;
      case 'sys': onSys(m); break;
      case 'pk': onPk(m); break;
      case 'got': onGot(m); break;
      case 'board': renderBoard(m); break;
      case 'shopmsg': shopMsg(m.text, m.ok); if (m.ok) G.audio.buy(); else G.audio.deny(); break;
      case 'err':
        if (m.needRoomPassword) {
          if (m.roomId) {
            roomPassCache.delete(m.roomId);
            selectedRoomId = m.roomId;
          }
          openRoomGate(m.text || '该房间需要密码');
          $('menuErr').textContent = m.text || '';
          break;
        }
        $('menuErr').textContent = m.text || '';
        if ($('roomCreateHint') && /房|厅/.test(m.text || '')) {
          $('roomCreateHint').textContent = m.text;
          $('roomCreateHint').className = 'room-hint warn';
        }
        if (m.needOauth) highlightNeedOauth(m.text);
        break;
      case 'kicked': kickedText = m.text || '你已被移出对局'; rejoinWanted = false; break;
      case 'flashed': {
        const newUntil = now() + m.ms;
        if (newUntil > blindUntil) { blindUntil = newUntil; blindTotal = m.ms; }
        break;
      }
      case 'acwarn':
        bigNotice(m.text);
        addChat(`<span class="sys-text">${esc(m.text)}</span>`, 'sys streak');
        break;
      case 'priv':   // 仅自己可见的私密提示（彩蛋指令等）
        me.cheatOn = !!m.cheat;
        addChat(`<span class="sys-text">${esc(m.text)}</span>`, 'sys priv');
        break;
      case 'dry':   // 弹药/投掷物用光：只提示，玩家自己去武器点获取新武器（不自动切武器）
        G.audio.dryFire();
        notice(`⚠️ ${m.name}用光了 · 去武器点获取新武器`, true);
        break;
      case 'keepgun':
        if (m.phase === 'death') {
          pendingKeepGun = m.name;
          const el = $('deathKeep');
          el.textContent = `🛡️ 商店枪械「${m.name}」将在复活时保留一次`;
          el.classList.remove('hidden');
          notice(`🛡️ 商店枪械「${m.name}」复活后保留一次`, true);
        } else {
          pendingKeepGun = null;
          $('deathKeep').classList.add('hidden');
          notice(`🛡️ 已保留商店枪械「${m.name}」（下次死亡不再保留）`, true);
          G.audio.pickup();
        }
        break;
      case 'pong': pingMs = now() - m.t; break;
    }
  }

  function onDefs(m) {
    defs = m;
    dayMs = (m.rules && m.rules.dayMs) || 600000;
    if (!worldBuilt) {
      worldBuilt = true;
      G.world.build(scene, defs.map, quality.shadow);
      G.fx.init(scene);
      const pts = defs.map.merchants || (defs.map.merchant ? [defs.map.merchant] : []);
      merchants = pts.map(pt => {
        const m = G.models.makeMerchant();
        m.position.set(pt.x, 0, pt.z);
        m.rotation.y = Math.atan2(-(0 - pt.x), -(0 - pt.z));
        scene.add(m);
        return m;
      });
      pickupMeshes = defs.map.pickups.map(pt => ({ pt, item: null, mesh: null, lastTry: 0 }));
      vm = G.models.makeViewModel();
      vm.group.traverse(o => { o.layers.set(VIEW_LAYER); });
      camera.add(vm.group);
      scene.add(camera);
      buildShopTabs();
      buildWardTabs();
      camera.position.set(0, 14, 42);
      camera.lookAt(0, 0, 0);
      renderLoginDays();
      requestMenuProfile();
      if (mode === 'menu') startMenuDemo();
    }
  }

  function siteName() {
    if (!isOauthLoggedIn()) return '';
    return String(oauthUser.username || oauthUser.name || '').slice(0, 12);
  }
  function isGuest() { return guestMode && !isOauthLoggedIn(); }
  function menuName() {
    if (isOauthLoggedIn()) return siteName();
    if (isGuest()) return (guestName || '').slice(0, 12);
    return ($('nameInput').value.trim() || myName || '').slice(0, 12);
  }
  function syncSiteName() {
    const n = siteName() || String($('nameInput') && $('nameInput').value || '').trim().slice(0, 12);
    if (!n) return;
    myName = n;
    if ($('nameInput')) $('nameInput').value = n;
    localStorage.setItem('na_name', n);
  }
  function menuPass() { return ''; }
  function isOauthLoggedIn() { return !!(oauthUser && oauthUser.id != null); }
  function providerLabel() {
    if (oauthUser && (oauthUser.provider === 'linuxdo' || String(oauthUser.id).startsWith('ld:'))) return 'LinuxDo';
    return 'NodeLoc';
  }
  function applyOauthState(m) {
    if (m && m.nodelocEnabled != null) nodelocEnabled = !!m.nodelocEnabled;
    if (m && m.linuxdoEnabled != null) linuxdoEnabled = !!m.linuxdoEnabled;
    if (m && m.nodelocEnabled == null && m.linuxdoEnabled == null && m.enabled === false) nodelocEnabled = false;
    oauthEnabled = nodelocEnabled || linuxdoEnabled;
    if (m && m.loginUrl) oauthLoginUrl = m.loginUrl;
    if (m && m.nativeLoginUrl) oauthNativeLoginUrl = m.nativeLoginUrl;
    if (m && m.linuxdoLoginUrl) linuxdoLoginUrl = m.linuxdoLoginUrl;
    if (m && m.linuxdoNativeLoginUrl) linuxdoNativeLoginUrl = m.linuxdoNativeLoginUrl;
    if (m && m.loggedIn && m.user) {
      const wasGuest = guestMode;
      oauthUser = m.user;
      guestMode = false;
      guestName = '';
      syncSiteName();
      if (wasGuest) send({ type: 'guest_logout' });
    } else if (m && m.loggedIn === false) {
      oauthUser = null;
      if (!guestMode) {
        if ($('nameInput')) $('nameInput').value = '';
        myName = '';
      }
    }
    updateOauthUi();
    updatePassHint();
    if (isOauthLoggedIn() && menuName()) requestMenuProfile();
  }
  function capPlugin(name) {
    try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]; }
    catch (_) { return null; }
  }
  function resolveNativeLoginUrl() {
    if (oauthNativeLoginUrl) return oauthNativeLoginUrl;
    if (oauthLoginUrl && /^https?:\/\//i.test(oauthLoginUrl)) {
      try {
        const u = new URL(oauthLoginUrl);
        u.searchParams.set('native', '1');
        return u.toString();
      } catch (_) { /* fall through */ }
    }
    return 'https://fps2.zard.loc.cc/oauth/nodeloc?native=1';
  }
  async function openNativeOauth(url) {
    const Browser = capPlugin('Browser');
    if (Browser && typeof Browser.open === 'function') {
      await Browser.open({ url, presentationStyle: 'fullscreen' });
      return;
    }
    window.open(url, '_blank');
  }
  function applyNativeOauthUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.startsWith(NATIVE_OAUTH_SCHEME + '://oauth')) return false;
    let u;
    try { u = new URL(url); } catch (_) { return false; }
    const Browser = capPlugin('Browser');
    if (Browser && typeof Browser.close === 'function') {
      Browser.close().catch(() => {});
    }
    const err = u.searchParams.get('error');
    const t = u.searchParams.get('t');
    const name = u.searchParams.get('name');
    if (err) {
      $('menuErr').textContent = err;
      highlightNeedOauth(err);
      return true;
    }
    if (!t) return true;
    oauthToken = t;
    try { localStorage.setItem(NL_TOKEN_KEY, t); } catch (_) { /* ignore */ }
    if (name) {
      $('nameInput').value = name;
      myName = name;
      try { localStorage.setItem('na_name', myName); } catch (_) { /* ignore */ }
    }
    const prov = u.searchParams.get('provider') === 'linuxdo' ? 'LinuxDo' : 'NodeLoc';
    $('menuErr').textContent = prov + ' 登录成功';
    reconnectNow();
    return true;
  }
  function setupNativeOauthReturn() {
    if (!IS_NATIVE_APP) return;
    const App = capPlugin('App');
    if (!App) return;
    if (typeof App.addListener === 'function') {
      App.addListener('appUrlOpen', (e) => { applyNativeOauthUrl(e && e.url); });
    }
    if (typeof App.getLaunchUrl === 'function') {
      App.getLaunchUrl().then((r) => { if (r && r.url) applyNativeOauthUrl(r.url); }).catch(() => {});
    }
  }
  function updateOauthUi() {
    const btn = $('btnNodeLoc');
    const session = $('oauthSession');
    const status = $('oauthStatus');
    const logout = $('btnOauthLogout');
    if (!btn) return;
    const guestBtn = $('btnGuest');
    if (session) session.classList.remove('guest');
    if (isOauthLoggedIn()) {
      btn.classList.add('hidden');
      if (guestBtn) guestBtn.classList.add('hidden');
      if (session) session.classList.remove('hidden');
      if (status) {
        const name = oauthUser.username || oauthUser.name || oauthUser.id;
        status.textContent = providerLabel() + ' · ' + name;
        status.title = '已登录：' + name;
      }
      if (logout) logout.textContent = '退出';
    } else if (guestMode) {
      btn.classList.add('hidden');
      if (guestBtn) guestBtn.classList.add('hidden');
      if (session) {
        session.classList.remove('hidden');
        session.classList.add('guest');
      }
      if (status) {
        status.textContent = guestName ? ('游客 · ' + guestName + ' · 不存档') : '游客 · 分配昵称中';
        status.title = '游客不保存数据，不能局内发言，不能修改昵称';
      }
      if (logout) logout.textContent = '退出';
    } else {
      btn.classList.remove('hidden');
      btn.textContent = '登录';
      btn.disabled = false;
      if (guestBtn) guestBtn.classList.remove('hidden');
      if (session) session.classList.add('hidden');
    }
    updateRoomCreateUi();
  }
  function updateRoomCreateUi() {
    const btn = $('btnCreateRoom');
    const hint = $('roomCreateHint');
    const input = $('roomNameInput');
    const tag = $('roomAuthTag');
    if (!btn) return;
    const ok = isOauthLoggedIn() && !isGuest();
    btn.disabled = false;
    if (input) input.disabled = false;
    if (tag) {
      if (ok) {
        tag.textContent = '可创建';
        tag.className = 'rc-tag ok';
      } else if (isGuest()) {
        tag.textContent = '游客不可用';
        tag.className = 'rc-tag warn';
      } else {
        tag.textContent = '需登录';
        tag.className = 'rc-tag';
      }
    }
    if (!hint) return;
    if (isGuest()) {
      hint.textContent = '游客无法开房，可直接选择下方房间进入';
      hint.className = 'room-hint warn';
    } else if (!isOauthLoggedIn()) {
      hint.textContent = '登录后可开房 · 游客只能进入已有房间';
      hint.className = 'room-hint';
    } else {
      hint.textContent = '每房最多 10 人 · 空房 20 秒后自动关闭';
      hint.className = 'room-hint ok';
    }
  }
  function highlightNeedOauth(text) {
    updatePassHint();
    if (text) $('menuErr').textContent = text;
    const hint = $('passHint');
    if (hint) {
      hint.textContent = text || '请先登录';
      hint.className = 'pass-hint warn';
    }
  }
  function goNodeLocLogin() {
    if (IS_NATIVE_APP) {
      openNativeOauth(resolveNativeLoginUrl()).catch((e) => {
        $('menuErr').textContent = (e && e.message) || '无法打开登录页';
        highlightNeedOauth($('menuErr').textContent);
      });
      return;
    }
    location.href = oauthLoginUrl || '/oauth/nodeloc';
  }
  function nativeUrl(url, fallback) {
    if (url && /^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url);
        u.searchParams.set('native', '1');
        return u.toString();
      } catch (_) { /* fall through */ }
    }
    return fallback;
  }
  function goLinuxDoLogin() {
    if (!linuxdoEnabled) {
      highlightNeedOauth('LinuxDo 登录未配置');
      return;
    }
    const url = IS_NATIVE_APP
      ? (linuxdoNativeLoginUrl || nativeUrl(linuxdoLoginUrl, 'https://fps2.zard.loc.cc/auth/callback?native=1'))
      : (linuxdoLoginUrl || 'https://fps2.zard.loc.cc/auth/callback');
    if (IS_NATIVE_APP) {
      openNativeOauth(url).catch((e) => {
        $('menuErr').textContent = (e && e.message) || '无法打开登录页';
        highlightNeedOauth($('menuErr').textContent);
      });
      return;
    }
    location.href = url;
  }
  function openAuthPick() {
    if (isOauthLoggedIn() || guestMode) return;
    const nl = $('btnPickNodeLoc');
    const ld = $('btnPickLinuxDo');
    if (nl) {
      nl.disabled = !nodelocEnabled;
      const label = nl.querySelector('.auth-label');
      if (label) label.textContent = nodelocEnabled ? 'NodeLoc 登录' : 'NodeLoc 未配置';
    }
    if (ld) {
      ld.disabled = !linuxdoEnabled;
      const label = ld.querySelector('.auth-label');
      if (label) label.textContent = linuxdoEnabled ? 'LinuxDo 登录' : 'LinuxDo 未配置';
    }
    const guestMsg = $('authPickMsg');
    if (guestMsg) { guestMsg.textContent = ''; guestMsg.classList.add('hidden'); }
    $('authPick').classList.remove('hidden');
  }
  function closeAuthPick() {
    const el = $('authPick');
    if (el) el.classList.add('hidden');
  }
  async function logoutOauth() {
    if (IS_NATIVE_APP) {
      oauthToken = '';
      try { localStorage.removeItem(NL_TOKEN_KEY); } catch (_) { /* ignore */ }
    } else {
      try {
        await fetch('/api/oauth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) { /* ignore */ }
    }
    oauthUser = null;
    you = { coins: 0, owned: [], eq: { head: null, face: null, back: null, fx: null } };
    menuLogin = { day: 1, claimedToday: true };
    updateOauthUi();
    updatePassHint();
    updateMenuProfile(null);
    $('menuErr').textContent = '已退出登录';
    reconnectNow();
  }
  function updatePassHint() {
    const hint = $('passHint');
    if (!hint) return;
    if (isOauthLoggedIn()) {
      hint.textContent = '游戏昵称固定为 ' + providerLabel() + ' 用户名';
      hint.className = 'pass-hint ok';
    } else if (guestMode) {
      hint.textContent = guestName
        ? `游客「${guestName}」不保存数据，不能发言，不能改名`
        : '正在分配游客昵称…不保存数据，不能发言，不能改名';
      hint.className = 'pass-hint warn';
    } else {
      hint.textContent = 'NodeLoc 或 LinuxDo 登录可保存数据；游客登录不保存、不能发言、不能改名';
      hint.className = 'pass-hint';
    }
  }
  /** 七日登录 / 换装等需要存档的功能：游客与未登录都拦截 */
  function requireAuth(action) {
    if (isGuest()) {
      $('menuErr').textContent = '游客不保存数据，该功能需登录账号';
      return;
    }
    if (!isOauthLoggedIn()) {
      highlightNeedOauth('请先登录');
      return;
    }
    action();
  }
  function requestMenuProfile() {
    const n = menuName();
    if (isGuest() || !isOauthLoggedIn() || !n || !wsOk) {
      updateMenuProfile(null);
      updatePassHint();
      return;
    }
    send({ type: 'profile', name: n, password: '' });
  }
  function applyMenuProfile(m) {
    nameHasPassword = false;
    profileLocked = false;
    if ($('menuErr') && ($('menuErr').textContent || '').includes('已被占用')) {
      $('menuErr').textContent = '';
    }
    you = {
      coins: m.coins | 0,
      owned: (m.owned || []).slice(),
      eq: Object.assign({ head: null, face: null, back: null, fx: null }, m.eq || {}),
    };
    if (m.login) menuLogin = m.login;
    if (m.name) {
      myName = m.name;
      if (m.oauthBound) syncSiteName();
    }
    updateMenuProfile(m);
    updatePassHint();
    renderLoginDays();
    renderWardrobe();
    renderShop();
  }
  function updateMenuProfile(m) {
    const box = $('menuProfile');
    const badge = $('menuLoginBadge');
    if (!isOauthLoggedIn() || !menuName()) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    $('menuCoins').textContent = (m && m.coins !== undefined) ? m.coins : (you.coins | 0);
    const canClaim = menuLogin && !menuLogin.claimedToday;
    badge.classList.toggle('hidden', !canClaim);
    $('btnClaimLogin').disabled = !canClaim || !menuName();
  }
  function setLoginMsg(text, ok) {
    const el = $('loginMsg');
    el.textContent = text || '';
    el.className = 'login-msg' + (ok ? '' : ' bad');
  }
  function setWardMsg(text, ok) {
    const el = $('wardMsg');
    el.textContent = text || '';
    el.className = 'login-msg' + (ok ? '' : ' bad');
  }
  function renderLoginDays() {
    if (!defs || !defs.loginRewards) return;
    const wrap = $('loginDays');
    wrap.innerHTML = '';
    const cur = menuLogin.day || 1;
    const claimedToday = !!menuLogin.claimedToday;
    for (const r of defs.loginRewards) {
      const item = defs.shop.find(s => s.id === r.item);
      const div = document.createElement('div');
      let cls = 'login-day';
      if (r.day < cur) cls += ' done';
      else if (r.day === cur && !claimedToday) cls += ' current';
      else cls += ' locked';
      div.className = cls;
      div.innerHTML = `<div class="ld-day">第${r.day}天</div>
        <div class="ld-ico">${COS_ICON[r.item] || '🎁'}</div>
        <div class="ld-name">${item ? item.name : r.item}</div>
        <div class="ld-coin">🪙 ${r.coins}</div>`;
      wrap.appendChild(div);
    }
    const n = menuName();
    $('loginHint').textContent = n
      ? (claimedToday ? `昵称「${n}」今日已领取，明天继续第 ${cur} 天` : `昵称「${n}」可领取第 ${cur} 天奖励`)
      : '登录后输入昵称可按日领取时装与金币';
    $('btnClaimLogin').disabled = !isOauthLoggedIn() || !n || claimedToday;
    $('btnClaimLogin').textContent = claimedToday ? '今日已领取' : '领取今日奖励';
  }
  function toggleLoginPanel(open) {
    const el = $('loginPanel');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    if (want) {
      requireAuth(() => {
        requestMenuProfile();
        renderLoginDays();
        setLoginMsg('', true);
        el.classList.remove('hidden');
      });
    } else el.classList.add('hidden');
  }
  function togglePassPanel() { /* 已改为 NodeLoc 登录，不再使用游戏密码 */ }
  function buildWardTabs() {
    const tabs = $('wardTabs');
    if (!tabs || !defs) return;
    tabs.innerHTML = '';
    const slots = { all: '全部', head: '头部', face: '面部', back: '背部', fx: '武器光效' };
    for (const [slot, label] of Object.entries(slots)) {
      const b = document.createElement('button');
      b.className = 'tab' + (slot === wardTab ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { wardTab = slot; wardPage = 0; wardHoverEq = null; buildWardTabs(); renderWardrobe(); };
      tabs.appendChild(b);
    }
  }
  function initWardPre() {
    if (wardPre) return;
    const cv = $('wardCv');
    const r = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setSize(220, 300, false);
    r.outputEncoding = T.sRGBEncoding;
    const sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xbfd9ff, 0x282030, 0.95));
    const dl = new T.DirectionalLight(0xffffff, 0.9);
    dl.position.set(2, 3, 2.5);
    sc.add(dl);
    const cam = new T.PerspectiveCamera(38, 220 / 300, 0.1, 20);
    cam.position.set(0, 1.35, 3.5);
    cam.lookAt(0, 1.0, 0);
    const model = G.models.makePlayer('#4dabf7', myName || '我');
    model.plate.visible = false;
    G.models.setPlayerWeapon(model, 'sword');
    sc.add(model.group);
    wardPre = { r, sc, cam, model };
  }
  function renderWardPre(dt) {
    if (!wardPre || $('wardrobe').classList.contains('hidden')) return;
    const eq = wardHoverEq || you.eq || {};
    const fxPreview = ['knife', 'sword', 'pistol', 'shotgun', 'mg', 'sniper', 'charge'];
    const showFx = wardTab === 'fx' || wardTab === 'all' || !!eq.fx;
    const previewWeapon = showFx ? fxPreview[Math.floor(perfNow / 1400) % fxPreview.length] : 'sword';
    G.models.setPlayerWeapon(wardPre.model, previewWeapon);
    G.models.applyCosmetics(wardPre.model, eq);
    G.models.animateCosmetics(wardPre.model, perfNow / 1000);
    G.models.applyWeaponFx(wardPre.model, eq.fx, perfNow / 1000);
    wardPre.model.group.rotation.y += dt * 0.9;
    wardPre.r.render(wardPre.sc, wardPre.cam);
  }
  function renderWardrobe() {
    if (!defs) return;
    $('wardCoins').textContent = you.coins | 0;
    const grid = $('wardGrid');
    grid.innerHTML = '';
    const cosSlots = ['head', 'face', 'back', 'fx'];
    const slotLabel = { head: '头部', face: '面部', back: '背部', fx: '光效' };
    const isAll = wardTab === 'all';
    const pageSize = isAll ? WARD_PAGE_ALL : WARD_PAGE_SLOT;

    if (!isAll) {
      const none = document.createElement('div');
      none.className = 'shop-item';
      none.innerHTML = `<div class="si-preview">➖</div><div class="si-name">卸下</div><div class="si-price">清空本槽</div>`;
      const noneBtn = document.createElement('button');
      noneBtn.textContent = you.eq[wardTab] ? '卸下' : '未装备';
      noneBtn.disabled = !you.eq[wardTab];
      noneBtn.onclick = () => {
        const n = menuName();
        if (!n) { setWardMsg('请先登录', false); return; }
        requireAuth(() => send({ type: 'menu_equip', name: n, slot: wardTab, id: null, password: menuPass() }));
      };
      none.appendChild(noneBtn);
      grid.appendChild(none);
    }

    const cosItems = defs.shop.filter(s =>
      cosSlots.includes(s.slot)
      && (!s.giftOnly || you.owned.includes(s.id))
      && (isAll || s.slot === wardTab)
      && (you.owned.includes(s.id) || s.loginOnly || (!s.loginOnly && !s.giftOnly && s.price > 0)));

    // 已拥有 → 七日登录未拥有 → 可购买；同组按价格
    cosItems.sort((a, b) => {
      const rank = (it) => {
        if (you.owned.includes(it.id)) return 0;
        if (it.loginOnly) return 1;
        return 2;
      };
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.slot !== b.slot) return cosSlots.indexOf(a.slot) - cosSlots.indexOf(b.slot);
      return (a.price | 0) - (b.price | 0);
    });

    const totalPages = Math.max(1, Math.ceil(cosItems.length / pageSize));
    if (wardPage >= totalPages) wardPage = totalPages - 1;
    if (wardPage < 0) wardPage = 0;
    const pageItems = cosItems.slice(wardPage * pageSize, wardPage * pageSize + pageSize);

    for (const item of pageItems) {
      const owned = you.owned.includes(item.id);
      const equipped = you.eq[item.slot] === item.id;
      const div = document.createElement('div');
      div.className = 'shop-item';
      let hint;
      if (owned) {
        hint = isAll
          ? `${slotLabel[item.slot] || item.slot} · ${item.giftOnly ? '彩蛋背饰' : item.loginOnly ? '七日登录' : '已拥有'}`
          : (item.giftOnly ? '彩蛋背饰' : item.loginOnly ? '七日登录' : '已拥有');
      } else if (item.loginOnly) {
        hint = isAll
          ? `${slotLabel[item.slot] || item.slot} · 七日登录专属`
          : '七日登录专属 · 可预览';
      } else {
        hint = isAll
          ? `${slotLabel[item.slot] || item.slot} · 🪙 ${item.price}`
          : `🪙 ${item.price}`;
      }
      div.innerHTML = `<div class="si-preview">${COS_ICON[item.id] || '🎁'}</div>
        <div class="si-name">${item.name}</div>
        <div class="si-hint">${hint}</div>`;
      const btn = document.createElement('button');
      if (!owned && item.loginOnly) {
        btn.textContent = '签到获取';
        btn.disabled = true;
        btn.title = '在七日登录中领取后可装备';
      } else if (!owned) {
        btn.textContent = '购买';
        btn.disabled = (you.coins | 0) < item.price;
        btn.onclick = () => {
          const n = menuName();
          if (!n) { setWardMsg('请先登录', false); return; }
          requireAuth(() => send({ type: 'menu_buy', name: n, id: item.id, password: menuPass() }));
        };
      } else if (equipped) {
        btn.textContent = '已装备';
        btn.className = 'equipped';
        btn.onclick = () => {
          requireAuth(() => send({ type: 'menu_equip', name: menuName(), slot: item.slot, id: null, password: menuPass() }));
        };
      } else {
        btn.textContent = '装备';
        btn.className = 'owned';
        btn.onclick = () => {
          const n = menuName();
          if (!n) { setWardMsg('请先登录', false); return; }
          requireAuth(() => send({ type: 'menu_equip', name: n, slot: item.slot, id: item.id, password: menuPass() }));
        };
      }
      div.appendChild(btn);
      // 未拥有的登录时装也可悬停预览
      div.addEventListener('mouseenter', () => { wardHoverEq = Object.assign({}, you.eq, { [item.slot]: item.id }); });
      div.addEventListener('mouseleave', () => { wardHoverEq = null; });
      grid.appendChild(div);
    }
    if (!cosItems.length) {
      const tip = document.createElement('div');
      tip.className = 'shop-item';
      tip.innerHTML = `<div class="si-preview">📭</div><div class="si-name">暂无外观</div><div class="si-hint">去七日登录获取专属时装</div>`;
      grid.appendChild(tip);
    }

    const pager = $('wardPager');
    if (pager) {
      pager.classList.toggle('hidden', cosItems.length <= pageSize);
      $('wardPageInfo').textContent = `${wardPage + 1} / ${totalPages}`;
      $('wardPrev').disabled = wardPage <= 0;
      $('wardNext').disabled = wardPage >= totalPages - 1;
    }
  }
  function toggleWardrobe(open) {
    const el = $('wardrobe');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    if (want) {
      requireAuth(() => {
        requestMenuProfile();
        initWardPre();
        wardPage = 0;
        buildWardTabs();
        renderWardrobe();
        setWardMsg('', true);
        el.classList.remove('hidden');
      });
    } else {
      el.classList.add('hidden');
      wardHoverEq = null;
    }
  }

  // ---------- 状态同步 ----------
  function onState(m) {
    if (!defs || mode === 'menu') return;
    dayBase = m.day || 0; dayAt = performance.now();
    if ($('hudOnline')) $('hudOnline').textContent = m.pl.length;
    if (!hasServerRooms && Array.isArray(m.pl)) {
      const shown = m.pl.length;
      if ($('menuOnline')) $('menuOnline').textContent = String(shown);
      if (roomList.length === 1 && roomList[0].official && roomList[0].players !== shown) {
        roomList[0].players = shown;
        renderRooms({ cap: roomCap, rooms: roomList });
      }
    }
    const seen = new Set();
    for (const s of m.pl) {
      seen.add(s.i);
      if (s.i === myId) { onMySnap(s); continue; }
      let e = ents.get(s.i);
      if (!e) {
        const model = G.models.makePlayer(s.c, s.n);
        scene.add(model.group);
        e = { id: s.i, name: s.n, color: s.c, model, cur: null, disp: { x: s.p[0], y: s.p[1], z: s.p[2], ya: s.ya, pi: s.pi }, lastHp: -1 };
        ents.set(s.i, e);
      }
      e.cur = s;
    }
    for (const [id, e] of ents) {
      if (!seen.has(id)) { scene.remove(e.model.group); ents.delete(id); }
    }
    // BOSS（多类型）
    if (m.boss) {
      if (!bossEnt || bossEnt.tp !== m.boss.tp) {
        if (bossEnt) scene.remove(bossEnt.model.group);
        const info = (defs.bosses && defs.bosses[m.boss.tp]) || { color: '#ff6a1a' };
        const model = G.models.makeBoss(m.boss.tp, m.boss.nm, info.color);
        scene.add(model.group);
        bossEnt = { tp: m.boss.tp, model, disp: { x: m.boss.p[0], y: m.boss.p[1] || 0, z: m.boss.p[2], ya: m.boss.ya }, lastIv: -1 };
        $('bossBar').classList.remove('hidden');
        $('bossBar').classList.toggle('amiya', m.boss.tp === 'amiya');
        $('bossName').textContent = m.boss.nm;
      }
      bossEnt.cur = m.boss;
      $('bossFill').style.width = (m.boss.hp / m.boss.mx * 100) + '%';
      if (bossEnt.lastIv !== m.boss.iv) {
        bossEnt.lastIv = m.boss.iv;
        G.models.setBossOpacity(bossEnt.model, m.boss.iv ? 0.14 : 1);
      }
      const woundEl = $('bossWound');
      const woundFill = $('bossWoundFill');
      const woundNum = $('bossWoundNum');
      if (woundEl && m.boss.tp === 'amiya') {
        woundEl.classList.remove('hidden');
        const wq = m.boss.wq | 0;
        const mx = Math.max(1, m.boss.mx | 0);
        const pct = Math.min(100, (wq / mx) * 100);
        if (woundNum) {
          const rb = (m.boss.rb | 0) > 0 ? ' · 仍可死亡回归' : '';
          woundNum.textContent = wq > 0 ? `${wq}${rb}` : (rb ? `0${rb}` : '0');
        }
        if (woundFill) woundFill.style.width = pct + '%';
      } else if (woundEl) {
        woundEl.classList.add('hidden');
        if (woundFill) woundFill.style.width = '0%';
      }
    } else if (bossEnt) {
      scene.remove(bossEnt.model.group);
      bossEnt = null;
      $('bossBar').classList.add('hidden');
      $('bossBar').classList.remove('amiya');
      const woundEl = $('bossWound');
      const woundFill = $('bossWoundFill');
      if (woundEl) woundEl.classList.add('hidden');
      if (woundFill) woundFill.style.width = '0%';
    }
    if (!m.boss && m.nb > 0) {
      $('bossTimer').classList.remove('hidden');
      $('bossTimer').textContent = `👹 BOSS 将在 ${Math.ceil(m.nb / 1000)}s 后降临`;
    } else $('bossTimer').classList.add('hidden');
    G.audio.setIntensity(m.boss ? 1 : 0);   // BOSS 在场时 BGM 进入高强度段

    // Amiya：记录点 / 嫉妒之影 / 不可视之手
    syncAmiyaExtras(m);

    // 弹道 / 手雷 / 油桶
    syncProjs(m.fb);
    syncNades(m.gd);
    if (m.br) G.world.setBarrels(m.br);
    // 拾取点
    for (let i = 0; i < pickupMeshes.length; i++) {
      const pm = pickupMeshes[i], item = m.pk[i];
      if (item !== pm.item) {
        if (pm.mesh) { scene.remove(pm.mesh); pm.mesh = null; }
        pm.item = item;
        if (item) {
          pm.mesh = G.models.makePickup(item, defs);
          pm.mesh.position.set(pm.pt.x, pm.pt.y || 0, pm.pt.z);
          scene.add(pm.mesh);
        }
      }
    }
  }
  function makeProjMesh(kind) {
    const g = new T.Group();
    if (kind === 1) {          // 机炮弹幕
      const s = new T.Mesh(new T.SphereGeometry(0.11, 6, 6), new T.MeshBasicMaterial({ color: '#ffd23c' }));
      g.add(s);
    } else if (kind === 2) {   // 追踪法球
      const s = new T.Mesh(new T.SphereGeometry(0.28, 10, 8), new T.MeshBasicMaterial({ color: '#a98aff' }));
      const glow = new T.Sprite(new T.SpriteMaterial({ color: '#8f5bff', transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(1.5);
      g.add(s, glow);
    } else {                   // 火球
      const s = new T.Mesh(new T.SphereGeometry(0.32, 10, 8), new T.MeshBasicMaterial({ color: '#ff8a30' }));
      const glow = new T.Sprite(new T.SpriteMaterial({ color: '#ff5a10', transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(1.6);
      g.add(s, glow);
    }
    return g;
  }
  function makeNadeMesh(kind) {
    if (kind === 1) {   // 闪光弹：银罐
      const g = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.2, 8),
        new T.MeshStandardMaterial({ color: '#c8ccd4', metalness: 0.7, roughness: 0.3 }));
      g.castShadow = true;
      return g;
    }
    if (kind === 2) {   // 烟雾弹：灰罐黄环
      const grp = new T.Group();
      const body = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.22, 8),
        new T.MeshStandardMaterial({ color: '#5a626e', roughness: 0.6 }));
      body.castShadow = true;
      const band = new T.Mesh(new T.CylinderGeometry(0.085, 0.085, 0.05, 8),
        new T.MeshStandardMaterial({ color: '#ffd23c' }));
      grp.add(body, band);
      return grp;
    }
    const g = new T.Mesh(new T.SphereGeometry(0.13, 8, 8), new T.MeshStandardMaterial({ color: '#3c5232' }));
    g.castShadow = true;
    return g;
  }
  function readProj(a, i) {
    if (a.length >= 8) return { id: 'p' + a[0], pos: V3(a[1], a[2], a[3]), vel: V3(a[4], a[5], a[6]), kind: a[7] || 0 };
    return { id: 'po' + i, pos: V3(a[0], a[1], a[2]), vel: V3(0, 0, 0), kind: a[3] || 0 };
  }
  function readNade(a, i) {
    if (a.length >= 8) return { id: 'g' + a[0], pos: V3(a[1], a[2], a[3]), vel: V3(a[4], a[5], a[6]), kind: a[7] || 0 };
    if (a.length >= 7) return { id: 'g' + a[0], pos: V3(a[1], a[2], a[3]), vel: V3(a[4], a[5], a[6]), kind: 0 };
    return { id: 'go' + i, pos: V3(a[0], a[1], a[2]), vel: V3(0, 0, 0), kind: 0 };
  }
  function syncMoving(pool, arr, make, read) {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      const n = read(arr[i], i);
      seen.add(n.id);
      let idx = pool.findIndex(e => e.id === n.id);
      if (idx >= 0 && pool[idx].kind !== n.kind) {
        scene.remove(pool[idx].g);
        pool.splice(idx, 1);
        idx = -1;
      }
      let e = idx >= 0 ? pool[idx] : null;
      if (!e) {
        e = { id: n.id, kind: n.kind, g: make(n.kind), target: n.pos.clone(), vel: n.vel.clone(), netAt: perfNow };
        e.g.position.copy(n.pos);
        scene.add(e.g);
        pool.push(e);
      }
      e.target.copy(n.pos);
      e.vel.copy(n.vel);
      e.netAt = perfNow;
    }
    for (let i = pool.length - 1; i >= 0; i--) {
      if (seen.has(pool[i].id)) continue;
      scene.remove(pool[i].g);
      pool.splice(i, 1);
    }
  }
  function syncAmiyaExtras(m) {
    const ck = m.boss && m.boss.ckpt;
    if (ck) {
      if (!ckptMesh) {
        const g = new THREE.Group();
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.18, 0.28, 2.4, 10, 1, true),
          new THREE.MeshBasicMaterial({ color: '#ff8fb8', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
        );
        beam.position.y = 1.2;
        const base = new THREE.Mesh(
          new THREE.RingGeometry(0.35, 0.7, 24),
          new THREE.MeshBasicMaterial({ color: '#ff8fb8', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
        );
        base.rotation.x = -Math.PI / 2; base.position.y = 0.04;
        g.add(beam, base);
        scene.add(g);
        ckptMesh = g;
      }
      ckptMesh.position.set(ck[0], ck[1] || 0, ck[2]);
      ckptMesh.visible = true;
    } else if (ckptMesh) {
      ckptMesh.visible = false;
    }

    const sh = m.boss && m.boss.shadow;
    if (sh) {
      const r = sh[2] || 6;
      if (!shadowMesh) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.2, r - 0.35), r, 48),
          new THREE.MeshBasicMaterial({ color: '#2a1020', transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        const fill = new THREE.Mesh(
          new THREE.CircleGeometry(r, 40),
          new THREE.MeshBasicMaterial({ color: '#ff8fb8', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
        );
        fill.rotation.x = -Math.PI / 2; fill.position.y = 0.01;
        const g = new THREE.Group(); g.add(ring, fill);
        scene.add(g);
        shadowMesh = { g, ring, fill, r: 0 };
      }
      if (Math.abs(shadowMesh.r - r) > 0.05) {
        shadowMesh.ring.geometry.dispose();
        shadowMesh.fill.geometry.dispose();
        shadowMesh.ring.geometry = new THREE.RingGeometry(Math.max(0.2, r - 0.35), r, 48);
        shadowMesh.fill.geometry = new THREE.CircleGeometry(r, 40);
        shadowMesh.r = r;
      }
      shadowMesh.g.position.set(sh[0], 0.03, sh[1]);
      shadowMesh.g.visible = true;
      // 延迟爆炸预警：越接近起爆越亮
      const rem = Math.max(0, sh[3] || 0);
      const delayMs = ((defs.bosses && defs.bosses.amiya && defs.bosses.amiya.shadowDelay) || 2.5) * 1000;
      const urgency = 1 - Math.min(1, rem / delayMs);
      shadowMesh.ring.material.opacity = 0.3 + 0.55 * urgency;
      shadowMesh.fill.material.opacity = 0.08 + 0.22 * urgency;
    } else if (shadowMesh) {
      shadowMesh.g.visible = false;
    }

    const seen = new Set();
    for (const row of (m.hands || [])) {
      const id = row[0];
      seen.add(id);
      let e = handEnts.get(id);
      if (!e) {
        const model = G.models.makeUnseenHand();
        const tether = G.models.makeHandTether();
        const rift = G.models.makeVoidRift();
        scene.add(model.group);
        scene.add(tether.mesh);
        scene.add(rift.group);
        e = { id, model, tether, rift, disp: { x: row[1], y: row[2], z: row[3], ya: row[4] || 0 } };
        handEnts.set(id, e);
      }
      e.target = { x: row[1], y: row[2], z: row[3], ya: row[4] || 0 };
      e.hp = row[5]; e.mx = row[6];
      e.anchorSide = row[7] == null ? 1 : row[7];
      e.anchorElev = row[8] == null ? 1 : row[8];
    }
    for (const [id, e] of handEnts) {
      if (!seen.has(id)) {
        scene.remove(e.model.group);
        if (e.tether) scene.remove(e.tether.mesh);
        if (e.rift) scene.remove(e.rift.group);
        handEnts.delete(id);
      }
    }
  }

  function syncProjs(arr) {
    syncMoving(projMeshes, arr || [], makeProjMesh, readProj);
  }
  function syncNades(arr) {
    syncMoving(nadeMeshes, arr || [], makeNadeMesh, readNade);
  }
  function advanceMoving(pool, dt, ballistic) {
    const k = 1 - Math.exp(-dt * 20);
    const grav = defs && defs.rules ? defs.rules.gravity : 22;
    for (const e of pool) {
      const lead = Math.min(0.14, Math.max(0, (perfNow - e.netAt) / 1000));
      const want = e.target.clone().addScaledVector(e.vel, lead);
      if (ballistic) want.y -= 0.5 * grav * lead * lead;
      if (e.g.position.distanceToSquared(want) > 64) e.g.position.copy(want);
      else e.g.position.lerp(want, k);
      e.g.rotation.x += dt * 7;
      e.g.rotation.y += dt * 4;
    }
  }
  function renderMovingProjectiles(dt) {
    advanceMoving(projMeshes, dt, false);
    advanceMoving(nadeMeshes, dt, true);
  }

  function gunHasZoom(gw) { return !!(gw && defs.weapons[gw] && defs.weapons[gw].zoom); }
  function gunShotFx(wp, o, e, muzzlePos) {
    const os = Array.isArray(o) ? o : [o.x, o.y, o.z];
    const es = Array.isArray(e) ? e : [e.x, e.y, e.z];
    if (wp === 'railgun') {
      G.fx.railBeam(os, es);
      G.fx.muzzle(muzzlePos || V3(os[0], os[1], os[2]), 0x7df9ff);
    } else {
      G.fx.tracer(os, es, wp === 'shotgun' ? '#ffc878' : '#ffe0a0');
      G.fx.muzzle(muzzlePos || V3(os[0], os[1], os[2]));
    }
  }
  function onMySnap(s) {
    const wasAlive = mySnap ? mySnap.al : 1;
    mySnap = s;
    if (s.rl > 0) { me.reloadUntil = now() + s.rl; me.reloadDur = defs.weapons[s.gw] ? defs.weapons[s.gw].reload * 1000 : 1000; }
    else if (me.reloadUntil > now() + 200) me.reloadUntil = 0;
    if (Math.abs(s.am - me.ammoL) > 1 || s.rl > 0) me.ammoL = s.am;
    me.reserve = s.re | 0; me.nadeLeft = s.nl | 0;   // 备弹/投掷数以服务端为准
    me.cookLeft = s.ck || 0;
    if (me.cookLeft > 0) {
      me.cookExpireAt = now() + me.cookLeft;
      me.nadeHolding = true;
    } else if (!me.nadeHolding) {
      me.cookExpireAt = 0;
      me.nadePrimeSent = false;
    }
    const zomb = s.bf.some(b => b[0] === 'zombie');
    if (zomb) me.active = 'melee';
    else if (now() - me.lastSwitch > 600 && s.ac !== me.active) me.active = s.ac;
    if (me.active === 'gun' && !s.gw) me.active = 'melee';
    if (wasAlive && !s.al) onMyDeath();
    if (!wasAlive && s.al && mode === 'play') {
      $('death').classList.add('hidden');
      me.pos.set(s.p[0], s.p[1], s.p[2]);
      me.vx = me.vy = me.vz = 0;
      me.grounded = true;
      G.audio.respawn();
    }
    const d2 = (me.pos.x - s.p[0]) ** 2 + (me.pos.z - s.p[2]) ** 2;
    if (d2 > 36 && s.al) {
      me.pos.set(s.p[0], s.p[1], s.p[2]);
      me.vx = me.vz = 0;
    }
    updateHud();
  }

  // ---------- FX 事件 ----------
  function entPos(id) {
    if (id === myId) return [me.pos.x, me.pos.y + 1, me.pos.z];
    const e = ents.get(id);
    return e ? [e.disp.x, e.disp.y + 1, e.disp.z] : null;
  }
  function distToMe(pos) {
    return Math.hypot(pos[0] - camera.position.x, pos[2] - camera.position.z);
  }
  // 客户端已知的活跃烟雾云：用于隐藏烟中玩家名牌 + 让触屏辅助瞄准无法隔烟锁人（公平性）
  const activeSmokes = [];
  function inSmoke(x, y, z) {
    const t = now();
    for (let i = activeSmokes.length - 1; i >= 0; i--) {
      const s = activeSmokes[i];
      if (s.until < t) { activeSmokes.splice(i, 1); continue; }
      if (Math.hypot(x - s.x, y - s.y, z - s.z) < s.r * 0.85) return true;
    }
    return false;
  }
  function smokeBlocks(o, d, dist) {   // 视线段是否穿过烟雾球
    const t = now();
    for (const s of activeSmokes) {
      if (s.until < t) continue;
      const cx = s.x - o.x, cy = s.y - o.y, cz = s.z - o.z;
      const b = cx * d.x + cy * d.y + cz * d.z;
      if (b < 0 || b > dist) continue;
      const px = o.x + d.x * b - s.x, py = o.y + d.y * b - s.y, pz = o.z + d.z * b - s.z;
      if (px * px + py * py + pz * pz < (s.r * 0.7) ** 2) return true;
    }
    return false;
  }
  // 受击后仰：给挨打的模型一个短促的、朝攻击者反方向的位移，装饰性叠加在网络同步位置上，
  // 不改 e.disp（下一帧仍从服务器权威位置重新插值），纯视觉，不会造成位置误差累积
  function triggerFlinch(tgId, byId) {
    const tgPos = entPos(tgId);
    const byPos = byId ? entPos(byId) : null;
    let dir;
    if (tgPos && byPos && (Math.abs(tgPos[0] - byPos[0]) > 1e-3 || Math.abs(tgPos[2] - byPos[2]) > 1e-3)) {
      dir = V3(tgPos[0] - byPos[0], 0, tgPos[2] - byPos[2]).normalize();
    } else {
      dir = V3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    }
    if (tgId === myId) { if (myModel) { myModel.flinchAt = now(); myModel.flinchDir = dir; } return; }
    const e = ents.get(tgId);
    if (e) { e.flinchAt = now(); e.flinchDir = dir; }
  }
  function onFx(m) {
    if (mode === 'menu') return;
    switch (m.k) {
      case 'shot': {
        if (m.id === myId) break;
        const ends = m.es || [m.e];
        if (m.wp === 'railgun') {
          G.fx.railBeam(m.o, ends[0]);
          G.fx.muzzle(V3(m.o[0], m.o[1], m.o[2]), 0x7df9ff);
          if (!m.tg) G.fx.impactSpark(ends[0], '#7df9ff');
        } else {
          for (const ep of ends) {
            G.fx.tracer(m.o, ep, '#ffd98a');
            if (!m.tg) G.fx.impactSpark(ep, '#ffe6a8');
          }
          G.fx.muzzle(V3(m.o[0], m.o[1], m.o[2]));
        }
        if (distToMe(m.o) < 75) G.audio.shot(m.wp);
        const e = ents.get(m.id);
        if (e) e.model.attackT = 0;
        break;
      }
      case 'chargestart': {
        if (m.id !== myId && distToMe(m.o) < 80) G.audio.chargeZap();
        if (m.id !== myId) {
          G.fx.setChargeBeam(m.id, m.o, m.e);
          G.fx.muzzle(V3(m.o[0], m.o[1], m.o[2]), 0xff7a1a);
        }
        const e = ents.get(m.id);
        if (e) e.model.attackT = 0;
        break;
      }
      case 'chargebeam': {
        if (m.id === myId) break;
        G.fx.setChargeBeam(m.id, m.o, m.e);
        break;
      }
      case 'chargebang': {
        G.fx.clearChargeBeam(m.id);
        G.fx.chargeBangFx(m.o, m.e);
        G.fx.muzzle(V3(m.o[0], m.o[1], m.o[2]), 0xff9a3c);
        if (distToMe(m.o) < 85) G.audio.chargeBang();
        if (m.id === myId) {
          me.chargingUntil = 0;
          G.fx.punch(camDir(), 1.45);
          G.fx.shake(0.52);
          vmKick = Math.min(2.4, vmKick + 1.85);
          recoilPitch = Math.min(0.13, recoilPitch + 0.095);
          me.pitch += 0.014;
        }
        const e = ents.get(m.id);
        if (e) e.model.attackT = 0;
        break;
      }
      case 'chargeend': {
        G.fx.clearChargeBeam(m.id);
        if (m.id === myId) me.chargingUntil = 0;
        break;
      }
      case 'melee': {
        if (m.id === myId) break;
        const e = ents.get(m.id);
        if (e) { e.model.attackT = 0; e.model.attackDur = 0.3; }
        const p = entPos(m.id);
        if (p && distToMe(p) < 40) G.audio.melee(m.wp);
        break;
      }
      case 'hit': {
        const isMelee = !!(m.wp && defs.weapons[m.wp] && defs.weapons[m.wp].slot === 'melee');
        let hitDir = null;
        if (m.by) { const bp = entPos(m.by); if (bp) hitDir = V3(m.pos[0] - bp[0], 0.3, m.pos[2] - bp[2]).normalize(); }
        G.fx.blood(m.pos, hitDir);
        triggerFlinch(m.tg, m.by);
        if (m.by === myId) {
          const hm = $('hitmarker');
          hm.classList.remove('show', 'crit'); void hm.offsetWidth;
          if (m.crit || m.hs) hm.classList.add('crit');
          hm.classList.add('show');
          if (m.hs) G.audio.headshot();
          else if (isMelee) G.audio.meleeHit(m.wp);
          else G.audio.hit(m.crit);
          const shd = m.shd | 0;
          if (shd > 0) {
            const sp = [m.pos[0], m.pos[1] + (m.dmg > 0 ? 0.55 : 0.4), m.pos[2]];
            G.fx.damageText(sp, shd + ' (🛡️)', '#fff', false);
          }
          if (m.dmg > 0) {
            G.fx.damageText(m.pos, (m.hs ? '爆头 ' : '') + m.dmg + (m.crit ? '!' : ''), m.crit ? '#ffd23c' : m.hs ? '#ff9c3c' : '#fff', m.crit || m.hs || (m.pel | 0) >= 4);
          }
          if (isMelee) G.fx.punch(camDir(), m.wp === 'hammer' ? 1.5 : m.wp === 'sword' ? 1.1 : 0.8);   // 近战命中：扎实一下前顶
        }
        if (m.tg === myId) {
          G.audio.hurt();
          const dv = $('dmgVignette');
          dv.style.opacity = Math.min(1, 0.35 + m.dmg / 60);
          setTimeout(() => dv.style.opacity = 0, 140);
          G.fx.shake(Math.min(0.5, m.dmg / 80));
          let awayDir = null;
          if (m.by) { const ap = entPos(m.by); if (ap) { showDmgDir(ap); awayDir = V3(me.pos.x - ap[0], 0, me.pos.z - ap[2]); } }
          else if (bossEnt) { showDmgDir([bossEnt.disp.x, bossEnt.disp.y || 0, bossEnt.disp.z]); awayDir = V3(me.pos.x - bossEnt.disp.x, 0, me.pos.z - bossEnt.disp.z); }
          if (awayDir && awayDir.lengthSq() > 1e-6) { awayDir.normalize(); G.fx.punch(awayDir, Math.min(1.6, 0.5 + m.dmg / 35)); }
        }
        break;
      }
      case 'immune': G.fx.damageText(m.pos, '免疫', '#9fd8ef', false); if (m.tg !== myId) G.audio.immune(); break;
      case 'explode':
        G.fx.explosion(m.pos, m.r, { fire: m.fire, boss: m.boss, vp: m.vp });
        if (m.envy) {
          G.fx.envyRing(m.pos, m.r, 180);
          G.fx.sparkle(m.pos, '#ff8fb8');
        }
        if (distToMe(m.pos) < 90) G.audio.explosion(m.boss || m.r > 4);
        break;
      case 'flashbang':
        G.fx.flashPop(m.pos, m.r);
        if (distToMe(m.pos) < 60) G.audio.flashPop();
        break;
      case 'smokepop':
        G.fx.smokeCloud(m.pos, m.r, m.dur);
        activeSmokes.push({ x: m.pos[0], y: m.pos[1] + 1, z: m.pos[2], r: m.r, until: now() + (m.dur || 9000) });
        if (distToMe(m.pos) < 50) G.audio.smokePop();
        break;
      case 'throw': {
        if (m.id !== myId) G.audio.throwNade();
        const e = ents.get(m.id);
        if (e) { e.model.attackT = 0; e.model.attackDur = 0.3; }
        break;
      }
      case 'die': {
        const e = ents.get(m.id);
        G.fx.die(m.pos, e ? e.color : '#ff6b6b');
        if (distToMe(m.pos) < 60) G.audio.die();
        break;
      }
      case 'respawn': G.fx.respawnBeam(m.pos); break;
      case 'slam': G.fx.slam(m.pos, m.r); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 70) G.audio.slam(); break;
      case 'slash': G.fx.impact(m.pos, '#ff4060'); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 50) G.audio.melee('knife'); break;
      case 'blink':
        G.fx.sparkle(m.from, '#b46bff'); G.fx.sparkle(m.to, '#b46bff');
        if (distToMe(m.to) < 60) G.audio.blink();
        break;
      case 'burst': if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 80) G.audio.burstFire(); break;
      case 'cast': G.fx.sparkle(m.pos, '#8f7bff'); if (bossEnt) bossEnt.model.slamT = 0; if (distToMe(m.pos) < 70) G.audio.cast(); break;
      case 'voidring': G.fx.telegraph(m.pos, m.r, m.ms); if (distToMe(m.pos) < 70) G.audio.cast(); break;
      case 'pimpact': G.fx.impact(m.pos, '#ffd98a'); break;
      case 'roar': G.fx.roarWave(m.pos); G.audio.roar(); break;
      case 'bossfire': if (distToMe(m.pos) < 80) G.audio.bossFire(); break;
      case 'bosshit':
        G.fx.impact(m.pos, m.fate ? '#ff8fb8' : '#ff8a50');
        if (bossEnt) bossEnt.flinchAt = now();
        if (m.by === myId) {
          G.fx.damageText(m.pos, m.fate ? `?${m.dmg}` : m.dmg, m.fate ? '#ffb0cc' : '#ff9c3c', false);
          G.audio.hit(false); G.fx.punch(camDir(), 0.5);
        }
        break;
      case 'fateWound':
        G.fx.fateWoundFx(m.pos);
        G.fx.damageText(m.pos, m.dmg, '#ff8fb8', true);
        if (bossEnt) bossEnt.model.slamT = 0;
        if (distToMe(m.pos) < 70) G.audio.hit(true);
        break;
      case 'ckptSave':
        G.fx.ckptSaveFx(m.pos);
        if (bossEnt) bossEnt.model.slamT = 0;
        if (distToMe(m.pos) < 80) G.audio.cast();
        break;
      case 'rbDeath':
        G.fx.rbDeathFx(m.from, m.to);
        if (bossEnt) bossEnt.model.slamT = 0;
        if (distToMe(m.to || m.from) < 90) G.audio.blink();
        break;
      case 'envyShadow':
        G.fx.envyRing(m.pos, m.r, m.ms);
        if (bossEnt) bossEnt.model.slamT = 0;
        if (distToMe(m.pos) < 80) G.audio.cast();
        break;
      case 'envySlash':
        G.fx.impact(m.pos, '#ff8fb8');
        if (bossEnt) bossEnt.model.slamT = 0;
        if (distToMe(m.pos) < 55) G.audio.melee('knife');
        break;
      case 'unseenHand':
        G.fx.voidRiftOpen(m.rifts, m.pos);
        if (distToMe(m.pos) < 70) G.audio.cast();
        break;
      case 'handhit':
        G.fx.impact(m.pos, '#c49bff');
        if (m.by === myId) { G.fx.damageText(m.pos, m.dmg, '#c49bff', false); G.audio.hit(false); }
        break;
      case 'handbreak':
        G.fx.sparkle(m.pos, '#9b5cff');
        G.fx.impact(m.pos, '#2a1040');
        if (distToMe(m.pos) < 60) G.audio.die();
        break;
      case 'barrel': {
        const br = G.world.barrelAt(m.id);
        if (br) br.group.visible = false;
        break;
      }
      case 'barrelhit': G.fx.impact(m.pos, '#ffb02e'); if (distToMe(m.pos) < 50) G.audio.hit(false); break;
      case 'barrelup': {
        const br = G.world.barrelAt(m.id);
        if (br) { br.group.visible = true; G.fx.sparkle([br.x, 0.8, br.z], '#ffb02e'); }
        break;
      }
    }
  }

  function killWeaponLabel(m) {
    if (m.wn) return esc(m.wn);
    const wp = m.wp && m.wp !== 'boss' ? m.wp : null;
    if (wp && defs?.weapons[wp]) return esc(defs.weapons[wp].name);
    return esc(wp || '未知武器');
  }

  function killWeaponIcon(m) {
    if (m.boss && !m.k) return '👹';
    const wp = m.wp && m.wp !== 'boss' ? m.wp : null;
    return (wp && WICON[wp]) || '🔫';
  }

  function onKill(m) {
    const icon = killWeaponIcon(m);
    const wLabel = killWeaponLabel(m);
    let html;
    if (m.self) html = `<b style="color:${m.v.c}">${esc(m.v.n)}</b><span class="wp">${icon}</span>自爆了`;
    else if (m.boss && !m.k) html = `<b style="color:#ff9c5c">👹 ${esc(m.boss)}</b><span class="wp">${icon}</span><b style="color:${m.v.c}">${esc(m.v.n)}</b>`;
    else if (!m.k) html = `<b style="color:${m.v.c}">${esc(m.v.n)}</b><span class="wp">💥</span>被炸飞了`;
    else html = `<b style="color:${m.k.c}">${esc(m.k.n)}</b><span class="wp" title="${wLabel}">${icon}</span><b style="color:${m.v.c}">${esc(m.v.n)}</b>`;
    addKillfeed(html);
    if (m.k && m.k.id === myId && m.v.id !== myId) {
      G.audio.kill();
      notice(`击杀 ${m.v.n} +25🪙`, true);
      // 击杀确认：准星短暂变骷髅 + 一记前顶
      const hm = $('hitmarker');
      hm.textContent = '💀';
      hm.classList.remove('show', 'crit'); void hm.offsetWidth;
      hm.classList.add('crit', 'show');
      setTimeout(() => { hm.textContent = '✕'; }, 500);
      G.fx.punch(camDir(), 0.5);
    }
    if (m.v.id === myId) {
      lastKillerText = m.self ? '你被自己的爆炸送走了' :
        m.boss && !m.k ? `被 BOSS「${esc(m.boss)}」击杀` :
        !m.k ? '被爆炸送走了' :
        `被 <b style="color:${m.k.c}">${esc(m.k.n)}</b> 用 <b>${wLabel}</b> 击杀`;
    }
  }

  function onSys(m) {
    addChat(`<span class="sys-text">${esc(m.text)}</span>`, 'sys ' + (m.style || ''));
    if (m.style === 'boss' || m.style === 'streak') bigNotice(m.text);
    if (m.style === 'boss' && m.text.includes('降临')) {
      G.audio.roar();
      const bf = $('bossFlash');
      bf.classList.remove('show'); void bf.offsetWidth; bf.classList.add('show');
    }
  }

  function onPk(m) {
    const pt = defs.map.pickups[m.id];
    if (!pt) return;
    const y = (pt.y || 0) + 0.5;
    if (m.ev === 'taken') G.fx.sparkle([pt.x, y, pt.z], '#9ff3ff');
    else if (m.ev === 'spawn') G.fx.sparkle([pt.x, y, pt.z], '#fff2a8');
  }

  function onGot(m) {
    if (m.kind === 'buff') {
      G.audio.buff();
      if (m.item === 'zombie') G.audio.zombie();
      notice(`${defs.buffs[m.item] ? defs.buffs[m.item].icon : '✨'} ${m.name} · ${m.desc}`, true);
    } else if (m.kind === 'coin') {
      G.audio.buy(); notice(m.name, true);
    } else {
      G.audio.pickup();
      notice(`获得 ${WICON[m.item] || '📦'} ${m.name}${m.desc ? ' · ' + m.desc : ''}`);
    }
  }

  // ---------- 模式切换 ----------
  // 触控层按钮显隐：按 游戏 / 观战自由 / 观战跟随 三态区分，避免观战时还显示开火跳跃等无意义键
  function updateTouchLayout() {
    if (!TOUCH) return;
    const play = mode === 'play', spec = mode === 'spec';
    const specFree = spec && !isFollowing();
    const show = (id, on) => $(id).classList.toggle('hidden', !on);
    $('touchLayer').classList.toggle('hidden', !(play || spec));   // 菜单态整体收起
    show('tFire', play);
    show('tFireLeft', false);
    show('tJump', play);
    show('tReload', play);
    show('tInspect', play);
    if (!play) {
      $('tScope').classList.add('hidden');
      $('tReload').classList.add('hidden');
      if ($('tInspect')) $('tInspect').classList.add('hidden');
    }
    show('tUp', specFree);                                         // 升降键仅观战自由飞行
    show('tDown', specFree);
    show('tMenu', play || spec);
    show('tBoard', play || spec);
    show('tChat', play || spec);
    if (TOUCH) applyTouchLayoutAll();
  }

  // ---------- 触屏按键布局（可自定义，localStorage 持久化） ----------
  const TOUCH_LAYOUT_DEFAULT = {
    tFire:   { x: 0.905, y: 0.82 },
    tFireLeft: { x: 0.22, y: 0.58 },
    tJump:   { x: 0.785, y: 0.80 },
    tReload: { x: 0.685, y: 0.78 },
    tInspect:{ x: 0.585, y: 0.78 },
    tScope:  { x: 0.905, y: 0.62 },
    tMenu:   { x: 0.965, y: 0.08 },
    tBoard:  { x: 0.885, y: 0.08 },
    tChat:   { x: 0.805, y: 0.08 },
    tUp:     { x: 0.965, y: 0.72 },
    tDown:   { x: 0.965, y: 0.88 },
    joy:     { x: 0.13, y: 0.82, r: 0.09 },
  };
  const TOUCH_EDIT_BTNS = ['tFire', 'tFireLeft', 'tJump', 'tReload', 'tInspect', 'tScope', 'tMenu', 'tBoard', 'tChat', 'tUp', 'tDown'];
  const TOUCH_BTN_SIZE = {
    tFire: 82, tFireLeft: 96, tJump: 60, tReload: 56, tInspect: 52, tScope: 56,
    tMenu: 42, tBoard: 42, tChat: 42, tUp: 44, tDown: 44,
  };
  const TOUCH_LABELS = {
    tFire: '开火', tFireLeft: '左手开火', tJump: '跳跃', tReload: '换弹', tInspect: '检视', tScope: '开镜', tMenu: '设置', tBoard: '榜单', tChat: '聊天',
    tUp: '上升', tDown: '下降', joy: '摇杆区',
  };
  function cloneTouchLayout(src) {
    const o = {};
    for (const k of Object.keys(TOUCH_LAYOUT_DEFAULT)) {
      o[k] = { ...TOUCH_LAYOUT_DEFAULT[k], ...(src && src[k] ? src[k] : {}) };
    }
    // 摇杆外观半径固定为默认小圆；可触摸范围是屏幕左三分之一，不跟这个圆走
    if (o.joy) o.joy.r = TOUCH_LAYOUT_DEFAULT.joy.r;
    return o;
  }
  function loadTouchLayout() {
    try {
      const raw = localStorage.getItem('na_touch_layout');
      if (raw) return cloneTouchLayout(JSON.parse(raw));
    } catch (_) {}
    return cloneTouchLayout(null);
  }
  let touchLayout = loadTouchLayout();
  let touchEditMode = false;
  let touchEditSnapshot = null;
  let touchEditDrag = null;

  function clampTouchCenter(cx, cy, w, h) {
    return {
      x: Math.max(w / 2, Math.min(innerWidth - w / 2, cx)),
      y: Math.max(h / 2, Math.min(innerHeight - h / 2, cy)),
    };
  }
  function placeTouchEl(el, pos, size) {
    if (!el || !pos) return;
    const w = size || el.offsetWidth || 56;
    const h = size || el.offsetHeight || w;
    const c = clampTouchCenter(pos.x * innerWidth, pos.y * innerHeight, w, h);
    el.style.left = (c.x - w / 2) + 'px';
    el.style.top = (c.y - h / 2) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function applyTouchLayoutAll() {
    if (!TOUCH) return;
    document.body.classList.add('touch-layout-active');
    TOUCH_EDIT_BTNS.forEach(id => {
      const el = $(id);
      if (!el) return;
      placeTouchEl(el, touchLayout[id], TOUCH_BTN_SIZE[id]);
      el.dataset.touchLabel = TOUCH_LABELS[id] || id;
    });
    const hint = $('joyHint');
    const joy = touchLayout.joy;
    if (hint && joy) {
      const visR = joy.r * Math.min(innerWidth, innerHeight);
      const d = visR * 2;
      hint.style.width = d + 'px';
      hint.style.height = d + 'px';
      placeTouchEl(hint, joy, d);
      hint.dataset.touchLabel = TOUCH_LABELS.joy;
    }
  }
  function saveTouchLayout() {
    localStorage.setItem('na_touch_layout', JSON.stringify(touchLayout));
  }
  function enterTouchEdit() {
    if (!TOUCH) { notice('按键布局调整请在手机端进行', false); return; }
    if (mode !== 'play' && mode !== 'spec') { notice('请先进入战斗或观战后再调整', false); return; }
    touchEditSnapshot = cloneTouchLayout(touchLayout);
    touchEditMode = true;
    $('pause').classList.add('hidden');
    $('touchEditBar').classList.remove('hidden');
    $('touchLayer').classList.remove('hidden');
    document.body.classList.add('touch-edit');
    TOUCH_EDIT_BTNS.forEach(id => { const el = $(id); if (el) el.classList.remove('hidden'); });
    $('joyHint').style.opacity = '1';
    applyTouchLayoutAll();
  }
  function exitTouchEdit(save) {
    touchEditMode = false;
    touchEditDrag = null;
    document.body.classList.remove('touch-edit');
    $('touchEditBar').classList.add('hidden');
    if (!save) touchLayout = touchEditSnapshot || cloneTouchLayout(null);
    else {
      saveTouchLayout();
      notice('按键布局已保存', true);
    }
    touchEditSnapshot = null;
    $('joyHint').style.opacity = '';
    applyTouchLayoutAll();
    updateTouchLayout();
    openPause();
  }
  function resetTouchLayoutToDefault() {
    touchLayout = cloneTouchLayout(null);
    applyTouchLayoutAll();
    G.audio.ui();
  }
  function onTouchEditPointerDown(e) {
    if (!touchEditMode) return;
    const el = e.currentTarget;
    const key = el.id === 'joyHint' ? 'joy' : el.id;
    if (!touchLayout[key]) return;
    e.preventDefault();
    e.stopPropagation();
    touchEditDrag = {
      key,
      ptr: e.pointerId,
      w: el.offsetWidth || 56,
      h: el.offsetHeight || 56,
    };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onTouchEditPointerMove(e) {
    if (!touchEditMode || !touchEditDrag || e.pointerId !== touchEditDrag.ptr) return;
    e.preventDefault();
    const c = clampTouchCenter(e.clientX, e.clientY, touchEditDrag.w, touchEditDrag.h);
    touchLayout[touchEditDrag.key].x = c.x / innerWidth;
    touchLayout[touchEditDrag.key].y = c.y / innerHeight;
    applyTouchLayoutAll();
  }
  function onTouchEditPointerUp(e) {
    if (!touchEditDrag || e.pointerId !== touchEditDrag.ptr) return;
    touchEditDrag = null;
    G.audio.ui();
  }
  function initTouchLayoutEditor() {
    if (!TOUCH) return;
    document.body.classList.add('touch-layout-active');
    applyTouchLayoutAll();
    const dragTargets = [...TOUCH_EDIT_BTNS.map(id => $(id)), $('joyHint')].filter(Boolean);
    dragTargets.forEach(el => {
      el.addEventListener('pointerdown', onTouchEditPointerDown);
      el.addEventListener('pointermove', onTouchEditPointerMove);
      el.addEventListener('pointerup', onTouchEditPointerUp);
      el.addEventListener('pointercancel', onTouchEditPointerUp);
    });
    if ($('btnTouchLayout')) {
      $('btnTouchLayout').onclick = () => { G.audio.ui(); enterTouchEdit(); };
    }
    if ($('btnTouchSave')) $('btnTouchSave').onclick = () => { G.audio.ui(); exitTouchEdit(true); };
    if ($('btnTouchCancel')) $('btnTouchCancel').onclick = () => { G.audio.ui(); exitTouchEdit(false); };
    if ($('btnTouchReset')) $('btnTouchReset').onclick = () => resetTouchLayoutToDefault();
  }
  function enterPlay() {
    stopMenuDemo();
    mode = 'play';
    me.cheatOn = false;
    $('menu').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('chatBox').classList.remove('hidden');
    $('specBar').classList.add('hidden');
    $('death').classList.add('hidden');
    me.active = 'melee'; me.ammoL = 0; me.lastNade = -99999;
    if (mySnap) { me.pos.set(mySnap.p[0], mySnap.p[1], mySnap.p[2]); }
    me.vx = me.vy = me.vz = 0;
    me.grounded = true;
    updateTouchLayout();
    resetGyroBase();
    syncGyroListener();
    syncGuestChatLock();
    requestLock();
  }
  function enterSpec() {
    stopMenuDemo();
    mode = 'spec';
    me.cheatOn = false;
    $('menu').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('death').classList.add('hidden');
    $('chatBox').classList.remove('hidden');
    $('specBar').classList.remove('hidden');
    mySnap = null; myId = 0;
    specFollowId = null; specView = 'tp';
    specFree.pos = camera.position.clone();
    updateSpecBar();
    updateTouchLayout();
    resetGyroBase();
    syncGyroListener();
    requestLock();
  }
  function backToMenu() {
    mode = 'menu';
    mySnap = null; myId = 0;
    pendingKeepGun = null;
    me.cheatOn = false;
    if (myModel) myModel.group.visible = false;
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('specBar').classList.add('hidden');
    $('death').classList.add('hidden');
    $('shop').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('about').classList.add('hidden');
    $('loginPanel').classList.add('hidden');
    const authPick = $('authPick');
    if (authPick) authPick.classList.add('hidden');
    $('wardrobe').classList.add('hidden');
    if ($('passPanel')) $('passPanel').classList.add('hidden');
    if ($('unlockPanel')) $('unlockPanel').classList.add('hidden');
    updateTouchLayout();
    resetGyroBase();
    syncGyroListener();
    document.exitPointerLock && document.exitPointerLock();
    requestMenuProfile();
    startMenuDemo();
  }
  function onMyDeath() {
    $('death').classList.remove('hidden');
    $('deathBy').innerHTML = lastKillerText || '';
    const keepEl = $('deathKeep');
    if (pendingKeepGun) {
      keepEl.textContent = `🛡️ 商店枪械「${pendingKeepGun}」将在复活时保留一次`;
      keepEl.classList.remove('hidden');
    } else {
      keepEl.classList.add('hidden');
    }
    me.zoom = 0;
    me.chargingUntil = 0;
    if (myId) G.fx.clearChargeBeam(myId);
    me.cookLeft = 0;
    me.cookExpireAt = 0;
    me.nadeHolding = false;
    me.nadePrimeSent = false;
  }

  // ---------- UI 工具 ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function addChat(html, cls) {
    const div = document.createElement('div');
    div.className = 'cmsg ' + (cls || '');
    div.innerHTML = html;
    const box = $('chatMsgs');
    box.appendChild(div);
    while (box.children.length > 40) box.removeChild(box.firstChild);
    setTimeout(() => { if (div.parentNode) div.style.opacity = '0.45'; }, 12000);
  }
  function addKillfeed(html) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = html;
    const kf = $('killfeed');
    kf.appendChild(div);
    while (kf.children.length > 6) kf.removeChild(kf.firstChild);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 6500);
  }
  function notice(text, gold) {
    const div = document.createElement('div');
    div.className = 'notice-item' + (gold ? ' gold' : '');
    div.textContent = text;
    const n = $('notice');
    n.appendChild(div);
    while (n.children.length > 4) n.removeChild(n.firstChild);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 2700);
  }
  function bigNotice(text) {
    const b = $('bigNotice');
    b.textContent = text;
    b.classList.remove('show'); void b.offsetWidth;
    b.classList.add('show');
  }
  function shopMsg(text, ok) {
    const el = $('shopMsg');
    el.textContent = text;
    el.className = ok ? '' : 'bad';
  }
  // 受击方向指示（红色弧线指向攻击者）
  const dmgArcs = [];
  function showDmgDir(apos) {
    const wrap = $('dmgDirWrap');
    let arc = dmgArcs.find(a => !a.busy);
    if (!arc) {
      if (dmgArcs.length >= 4) return;
      const div = document.createElement('div');
      div.className = 'dmg-arc';
      wrap.appendChild(div);
      arc = { div, busy: false };
      dmgArcs.push(arc);
    }
    const bearing = Math.atan2(-(apos[0] - camera.position.x), -(apos[2] - camera.position.z));
    let rel = bearing - me.yaw;
    const deg = -rel * 180 / Math.PI;
    arc.busy = true;
    arc.div.style.setProperty('--ang', deg + 'deg');
    arc.div.classList.remove('show'); void arc.div.offsetWidth;
    arc.div.classList.add('show');
    setTimeout(() => { arc.busy = false; }, 800);
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!mySnap || mode !== 'play') return;
    const s = mySnap;
    $('hpFill').style.width = s.hp + '%'; $('hpNum').textContent = s.hp;
    document.querySelector('.bar.hp').classList.toggle('low', s.hp <= 30);
    $('arFill').style.width = s.ar + '%'; $('arNum').textContent = s.ar;
    const shRow = $('shieldRow');
    shRow.style.display = s.sh > 0 ? 'flex' : 'none';
    $('shFill').style.width = s.sh + '%'; $('shNum').textContent = s.sh;
    $('coinNum').textContent = s.co;
    you.coins = s.co;
    $('shopCoins').textContent = s.co;
    const zomb = s.bf.some(b => b[0] === 'zombie');
    const sm = $('slotMelee');
    sm.querySelector('.wico').textContent = zomb ? '🧟' : WICON[s.mw];
    sm.querySelector('.wname').textContent = zomb ? '丧尸利爪' : defs.weapons[s.mw].name;
    sm.classList.toggle('active', me.active === 'melee');
    const sg = $('slotGun');
    sg.classList.toggle('empty', !s.gw);
    sg.classList.toggle('active', me.active === 'gun');
    if (s.gw) {
      sg.querySelector('.wico').textContent = WICON[s.gw];
      const gdef = defs.weapons[s.gw];
      sg.querySelector('.wname').textContent = gdef.name;
      const empty = me.ammoL < (gdef.ammoCost || 1) && (gdef.noReload || me.reserve <= 0);
      sg.querySelector('.wammo').textContent = empty ? '空·补给' : gdef.noReload ? `${me.ammoL}/${gdef.mag}` : `${me.ammoL}/${gdef.mag} · ${me.reserve}`;
      sg.classList.toggle('out', empty);
    } else {
      sg.querySelector('.wico').textContent = '·';
      sg.querySelector('.wname').textContent = '未拾取枪械';
      sg.querySelector('.wammo').textContent = '';
      sg.classList.remove('out');
    }
    const sn = $('slotNade');
    sn.classList.toggle('empty', !s.ng);
    sn.classList.toggle('active', me.active === 'nade');
    sn.querySelector('.wico').textContent = s.ng ? WICON[s.ng] : '🧨';
    sn.querySelector('.wname').textContent = s.ng ? defs.weapons[s.ng].name : '未拾取投掷物';
    const nadeCdMs = s.ng && defs.weapons[s.ng] ? defs.weapons[s.ng].cd * 1000 : 2000;
    const nadeCd = Math.max(0, nadeCdMs - (now() - me.lastNade));
    sn.querySelector('.wammo').textContent = s.ng ? (`×${me.nadeLeft}` + (nadeCd > 0 ? ` ${(nadeCd / 1000).toFixed(1)}s` : '')) : '';
    const br = $('buffRow');
    br.innerHTML = s.bf.map(([k, ms]) => {
      const b = defs.buffs[k];
      if (!b) return '';
      return `<div class="buff-chip" style="--bc:${b.color}">${b.icon} ${b.name} ${(ms / 1000).toFixed(0)}s</div>`;
    }).join('');
    $('zombieTint').style.opacity = zomb ? 1 : 0;
    $('protectHint').classList.toggle('hidden', !s.pr);
  }

  // ---------- 排行榜（含首页历史榜） ----------
  function renderBoard(m) {
    const mkRows = (rows, isRt) => {
      // 6 列：# 玩家 击杀 死亡 得分/BOSS 连杀。连杀列(实时=当前连杀/历史=最高连杀)参与排序，服务端已排好
      const col5 = isRt ? '得分' : 'BOSS';
      let html = `<div class="brow head"><span>#</span><span>玩家</span><span class="num">击杀</span><span class="num">死亡</span><span class="num">${col5}</span><span class="num">连杀</span></div>`;
      rows.forEach((r, i) => {
        const meCls = (isRt && r.i === myId) || (!isRt && r.n === myName) ? ' me' : '';
        const streakVal = isRt ? (r.st | 0) : (r.bs | 0);
        const streakCls = streakVal >= 3 ? ' streak-hot' : '';
        html += `<div class="brow${meCls}"><span class="rank r${i + 1}">${i + 1}</span><span style="color:${r.c || '#cfe6f5'}">${esc(r.n)}</span><span class="num">${r.k}</span><span class="num">${r.d}</span><span class="num">${isRt ? (r.s | 0) : (r.bk | 0)}</span><span class="num${streakCls}">${streakVal > 0 ? '🔥' + streakVal : '-'}</span></div>`;
      });
      if (!rows.length) html += '<div class="brow"><span></span><span style="color:#7591ad">暂无数据</span></div>';
      return html;
    };
    $('boardRt').innerHTML = mkRows(m.rt, true);
    $('boardHist').innerHTML = mkRows(m.hist, false);
    // 首页历史榜完整渲染，列表区域滚动查看（滚动条已隐藏）
    $('menuHist').innerHTML = mkRows(m.hist, false);
  }
  $('tabRt').onclick = () => { $('tabRt').classList.add('active'); $('tabHist').classList.remove('active'); $('boardRt').classList.remove('hidden'); $('boardHist').classList.add('hidden'); };
  $('tabHist').onclick = () => { $('tabHist').classList.add('active'); $('tabRt').classList.remove('active'); $('boardHist').classList.remove('hidden'); $('boardRt').classList.add('hidden'); };

  // ---------- 商店（含 3D 试穿预览） ----------
  let shopTab = 'weapon';
  let hoverWeapon = null;
  function buildShopTabs() {
    const tabs = $('shopTabs');
    tabs.innerHTML = '';
    for (const [slot, label] of Object.entries(defs.shopSlots)) {
      const b = document.createElement('button');
      b.className = 'tab' + (slot === shopTab ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { shopTab = slot; hoverEq = null; hoverWeapon = null; buildShopTabs(); renderShop(); };
      tabs.appendChild(b);
    }
  }
  function initShopPre() {
    if (shopPre) return;
    const cv = $('shopCv');
    const r = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setSize(240, 320, false);
    r.outputEncoding = T.sRGBEncoding;
    const sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xbfd9ff, 0x282030, 0.95));
    const dl = new T.DirectionalLight(0xffffff, 0.9);
    dl.position.set(2, 3, 2.5);
    sc.add(dl);
    const cam = new T.PerspectiveCamera(38, 240 / 320, 0.1, 20);
    cam.position.set(0, 1.35, 3.5);
    cam.lookAt(0, 1.0, 0);
    const model = G.models.makePlayer(mySnap ? mySnap.c : '#4dabf7', myName || '我');
    model.plate.visible = false;
    G.models.setPlayerWeapon(model, 'sword');
    sc.add(model.group);
    shopPre = { r, sc, cam, model };
  }
  function renderShopPre(dt) {
    if (!shopPre || $('shop').classList.contains('hidden')) return;
    const eq = hoverEq || you.eq || {};
    const fxPreview = ['knife', 'sword', 'pistol', 'shotgun', 'mg', 'sniper', 'charge', 'railgun', 'hammer'];
    const previewWeapon = hoverWeapon || (shopTab === 'fx' ? fxPreview[Math.floor(perfNow / 1400) % fxPreview.length]
      : shopTab === 'weapon' ? 'pistol' : 'sword');
    G.models.setPlayerWeapon(shopPre.model, previewWeapon);
    G.models.applyCosmetics(shopPre.model, eq);
    G.models.animateCosmetics(shopPre.model, perfNow / 1000);
    G.models.applyWeaponFx(shopPre.model, eq.fx, perfNow / 1000);
    shopPre.model.group.rotation.y += dt * 0.9;
    shopPre.r.render(shopPre.sc, shopPre.cam);
  }
  function renderShop() {
    if (!defs) return;
    $('shopCoins').textContent = you.coins;
    const grid = $('shopGrid');
    grid.innerHTML = '';
    for (const item of defs.shop.filter(s => s.slot === shopTab)) {
      if (item.giftOnly && !you.owned.includes(item.id)) continue;
      if (item.loginOnly && !you.owned.includes(item.id)) continue;
      const isWeapon = item.slot === 'weapon';
      const isBuff = item.slot === 'buff';
      const isGift = !!item.giftOnly;
      const isLoginItem = !!item.loginOnly;
      const owned = !isWeapon && !isBuff && you.owned.includes(item.id);
      const equipped = !isWeapon && !isBuff && you.eq[item.slot] === item.id;
      const div = document.createElement('div');
      div.className = 'shop-item';
      const bdef = isBuff && defs.buffs ? defs.buffs[item.buffId] : null;
      const icon = isWeapon ? (WICON[item.weaponId] || '🔫')
        : isBuff ? (bdef?.icon || '✨')
        : (COS_ICON[item.id] || '🎁');
      const priceLine = isGift ? (item.desc || '彩蛋专属')
        : isLoginItem ? (item.desc || '登录专属')
        : `🪙 ${item.price}`;
      const keepHint = isWeapon ? '<div class="si-hint">死亡后可保留一次</div>'
        : isBuff ? `<div class="si-hint">${bdef ? `${bdef.desc} · ${bdef.dur}秒` : '限时增益'}</div>`
        : '';
      div.innerHTML = `<div class="si-preview">${icon}</div>
        <div class="si-name">${item.name}</div><div class="si-price">${priceLine}</div>${keepHint}`;
      const btn = document.createElement('button');
      if (isWeapon || isBuff) {
        btn.textContent = '购买';
        btn.disabled = you.coins < item.price;
        btn.onclick = () => send({ type: 'buy', id: item.id });
      } else if (equipped) { btn.textContent = '已装备 · 点击卸下'; btn.className = 'equipped'; btn.onclick = () => send({ type: 'equip', slot: item.slot, id: null }); }
      else if (owned) { btn.textContent = '装备'; btn.className = 'owned'; btn.onclick = () => send({ type: 'equip', slot: item.slot, id: item.id }); }
      else { btn.textContent = '购买'; btn.disabled = you.coins < item.price; btn.onclick = () => send({ type: 'buy', id: item.id }); }
      div.appendChild(btn);
      if (isWeapon) {
        div.addEventListener('mouseenter', () => { hoverWeapon = item.weaponId; });
        div.addEventListener('mouseleave', () => { hoverWeapon = null; });
      } else if (!isBuff) {
        div.addEventListener('mouseenter', () => { hoverEq = Object.assign({}, you.eq, { [item.slot]: item.id }); });
        div.addEventListener('mouseleave', () => { hoverEq = null; });
      }
      grid.appendChild(div);
    }
  }
  function toggleShop(open) {
    const el = $('shop');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    if (want) {
      initShopPre();
      renderShop(); shopMsg('', true);
      hoverEq = null; hoverWeapon = null;
      el.classList.remove('hidden');
      document.exitPointerLock && document.exitPointerLock();
    } else {
      el.classList.add('hidden');
      hoverEq = null;
      if (mode === 'play') requestLock();
    }
  }

  // ---------- 设置面板 ----------
  function refreshOpts() {
    $('optMusic').textContent = settings.music ? '开' : '关';
    $('optMusic').classList.toggle('off', !settings.music);
    $('optSfx').textContent = settings.sfx ? '开' : '关';
    $('optSfx').classList.toggle('off', !settings.sfx);
    $('optView').textContent = settings.view === 'tp' ? '第三人称' : '第一人称';
    $('optSens').value = Math.round(settings.sens * 100);
    const sensLbl = $('optSensLabel');
    if (sensLbl) sensLbl.textContent = TOUCH ? '📱 灵敏度' : '🖱️ 灵敏度';
    if ($('optGyro')) {
      $('optGyro').textContent = settings.gyro ? '开' : '关';
      $('optGyro').classList.toggle('off', !settings.gyro);
    }
    if ($('rowGyroSens')) $('rowGyroSens').classList.toggle('hidden', !settings.gyro);
    if ($('optGyroSens')) $('optGyroSens').value = Math.round(settings.gyroSens * 100);
    if ($('rowGyroInvert')) $('rowGyroInvert').classList.toggle('hidden', !settings.gyro);
    if ($('optGyroInvert')) {
      $('optGyroInvert').textContent = settings.gyroInvert ? '开' : '关';
      $('optGyroInvert').classList.toggle('off', !settings.gyroInvert);
    }
  }
  $('optMusic').onclick = () => {
    settings.music = !settings.music;
    localStorage.setItem('na_music', settings.music ? '1' : '0');
    G.audio.setMusic(settings.music);
    refreshOpts(); G.audio.ui();
  };
  $('optSfx').onclick = () => {
    settings.sfx = !settings.sfx;
    localStorage.setItem('na_sfx', settings.sfx ? '1' : '0');
    G.audio.setSfx(settings.sfx);
    refreshOpts(); G.audio.ui();
  };
  $('optView').onclick = () => { toggleView(); refreshOpts(); };
  function applySensFromSlider() {
    const v = Number($('optSens').value);
    settings.sens = Math.max(0.3, Math.min(2, (isFinite(v) ? v : 100) / 100));
    localStorage.setItem('na_sens', String(settings.sens));
  }
  $('optSens').oninput = applySensFromSlider;
  $('optSens').onchange = applySensFromSlider;
  function applyGyroSensFromSlider() {
    const v = Number($('optGyroSens') && $('optGyroSens').value);
    settings.gyroSens = Math.max(0.3, Math.min(2.5, (isFinite(v) ? v : 100) / 100));
    localStorage.setItem('na_gyro_sens', String(settings.gyroSens));
  }
  if ($('optGyroSens')) {
    $('optGyroSens').oninput = applyGyroSensFromSlider;
    $('optGyroSens').onchange = applyGyroSensFromSlider;
  }
  if ($('optGyroInvert')) {
    $('optGyroInvert').onclick = () => {
      settings.gyroInvert = !settings.gyroInvert;
      localStorage.setItem('na_gyro_invert', settings.gyroInvert ? '1' : '0');
      refreshOpts();
      G.audio.ui();
    };
  }

  // ---------- 陀螺仪瞄准（默认关；触屏生效） ----------
  // 横屏时「左右」多在 beta，「上下」常在 alpha（不是 gamma）。
  // 优先 DeviceMotion 角速度；没有有效角速度时再用 orientation 四元数差分。
  const HAS_GYRO_API = typeof DeviceOrientationEvent !== 'undefined';
  const HAS_MOTION_API = typeof DeviceMotionEvent !== 'undefined';
  const GYRO_NEEDS_PERM = HAS_GYRO_API && typeof DeviceOrientationEvent.requestPermission === 'function';
  const MOTION_NEEDS_PERM = HAS_MOTION_API && typeof DeviceMotionEvent.requestPermission === 'function';
  const GYRO_NEEDS_ANY_PERM = GYRO_NEEDS_PERM || MOTION_NEEDS_PERM;
  const GYRO_SUPPORTED = TOUCH && (HAS_GYRO_API || HAS_MOTION_API);
  const GYRO_DEG_K = (Math.PI / 180) * 1.25;
  const GYRO_RAD = Math.PI / 180;
  let gyroLastLook = null;
  let gyroBound = false;
  let gyroPermOk = !GYRO_NEEDS_ANY_PERM;
  let gyroMotionYawAt = 0;
  let gyroMotionPitchAt = 0;
  const gyroQ1 = new T.Quaternion();
  const gyroQe = new T.Quaternion();
  const gyroEuler = new T.Euler();
  const gyroZee = new T.Vector3(0, 0, 1);
  const gyroQOffset = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI / 2);

  function requestGyroPermissionFromGesture() {
    const reqs = [];
    if (GYRO_NEEDS_PERM) reqs.push(DeviceOrientationEvent.requestPermission());
    if (MOTION_NEEDS_PERM) reqs.push(DeviceMotionEvent.requestPermission());
    if (!reqs.length) {
      gyroPermOk = true;
      return Promise.resolve(true);
    }
    return Promise.all(reqs).then(states => {
      gyroPermOk = states.every(s => s === 'granted');
      return gyroPermOk;
    }).catch(() => {
      gyroPermOk = false;
      return false;
    });
  }
  function ensureGyroPermissionThen(fn) {
    if (!settings.gyro || !TOUCH || gyroPermOk || !GYRO_NEEDS_ANY_PERM) {
      fn();
      return;
    }
    requestGyroPermissionFromGesture().then(ok => {
      if (!ok) {
        settings.gyro = false;
        localStorage.setItem('na_gyro', '0');
        syncGyroListener();
        refreshOpts();
        notice('陀螺仪需要「动作与方向」权限，已自动关闭', false);
      }
      fn();
    });
  }
  function applyGyroSetting(on) {
    settings.gyro = on;
    localStorage.setItem('na_gyro', on ? '1' : '0');
    resetGyroBase();
    syncGyroListener();
    refreshOpts();
  }

  function touchOrientAngle() {
    if (screen.orientation && screen.orientation.angle != null) return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return innerWidth > innerHeight ? 90 : 0;
  }
  function wrapDeg(d) {
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }
  function resetGyroBase() {
    gyroLastLook = null;
    gyroMotionYawAt = 0;
    gyroMotionPitchAt = 0;
  }
  function gyroAllowed() {
    return settings.gyro && GYRO_SUPPORTED && mode !== 'menu' && canDriveCam()
      && $('shop').classList.contains('hidden') && $('pause').classList.contains('hidden')
      && $('lost').classList.contains('hidden');
  }
  function applyGyro(dYawDeg, dPitchDeg) {
    if (!isFinite(dYawDeg) || !isFinite(dPitchDeg)) return;
    if (Math.abs(dYawDeg) < 0.01 && Math.abs(dPitchDeg) < 0.01) return;
    if (Math.abs(dYawDeg) > 45 || Math.abs(dPitchDeg) > 45) return;
    const sens = settings.gyroSens * (me.zoom > 0.5 ? 0.4 : 1);
    const k = GYRO_DEG_K * sens * (settings.gyroInvert ? -1 : 1);
    me.yaw -= dYawDeg * k;
    me.pitch = Math.max(-1.53, Math.min(1.53, me.pitch - dPitchDeg * k));
  }
  // wx=beta(绕X) wy=gamma(绕Y) wz=alpha(绕Z)
  function mapDeviceToLook(wx, wy, wz) {
    const a = ((touchOrientAngle() % 360) + 360) % 360;
    // 横屏：beta≈上下，alpha/gamma≈左右
    const sideSrc = wz + wy;
    if (a === 90) return { yaw: -sideSrc, pitch: wx };
    if (a === 270) return { yaw: sideSrc, pitch: -wx };
    if (a === 0) return { yaw: -wy, pitch: wx };
    return { yaw: wy, pitch: -wx };
  }
  function orientationToLook(alpha, beta, gamma) {
    const screenAng = touchOrientAngle();
    gyroEuler.set(beta * GYRO_RAD, alpha * GYRO_RAD, -gamma * GYRO_RAD, 'YXZ');
    gyroQe.setFromEuler(gyroEuler);
    gyroQ1.setFromAxisAngle(gyroZee, -screenAng * GYRO_RAD);
    gyroQe.multiply(gyroQ1);
    gyroQe.multiply(gyroQOffset);
    gyroEuler.setFromQuaternion(gyroQe, 'YXZ');
    return { yaw: gyroEuler.y / GYRO_RAD, pitch: gyroEuler.x / GYRO_RAD };
  }
  function onDeviceMotion(e) {
    if (!gyroAllowed() || !e.rotationRate) return;
    const wx = Number(e.rotationRate.beta);
    const wy = Number(e.rotationRate.gamma);
    const wz = Number(e.rotationRate.alpha);
    if (![wx, wy, wz].some(v => isFinite(v))) return;
    const x = isFinite(wx) ? wx : 0;
    const y = isFinite(wy) ? wy : 0;
    const z = isFinite(wz) ? wz : 0;
    if (Math.abs(x) < 0.06 && Math.abs(y) < 0.06 && Math.abs(z) < 0.06) return;
    const dt = Math.max(0.004, Math.min(0.05, (Number(e.interval) || 16) / 1000));
    const m = mapDeviceToLook(x * dt, y * dt, z * dt);
    if (Math.abs(m.yaw) >= 0.01) gyroMotionYawAt = now();
    if (Math.abs(m.pitch) >= 0.01) gyroMotionPitchAt = now();
    applyGyro(m.yaw, m.pitch);
  }
  function onDeviceOrientation(e) {
    if (!gyroAllowed()) return;
    if (e.beta == null || e.gamma == null) return;
    const alpha = e.alpha == null ? 0 : e.alpha;
    const motionYaw = HAS_MOTION_API && now() - gyroMotionYawAt < 150;
    const motionPitch = HAS_MOTION_API && now() - gyroMotionPitchAt < 150;
    // 角速度左右+上下都在工作时，完全交给 motion
    if (motionYaw && motionPitch) return;

    if (!gyroLastLook || !gyroLastLook.raw) {
      const look = orientationToLook(alpha, e.beta, e.gamma);
      gyroLastLook = { raw: { alpha, beta: e.beta, gamma: e.gamma }, yaw: look.yaw, pitch: look.pitch };
      return;
    }
    const dBeta = wrapDeg(e.beta - gyroLastLook.raw.beta);
    const dGamma = wrapDeg(e.gamma - gyroLastLook.raw.gamma);
    const dAlpha = wrapDeg(alpha - gyroLastLook.raw.alpha);
    gyroLastLook.raw = { alpha, beta: e.beta, gamma: e.gamma };
    if (Math.abs(dAlpha) < 0.03 && Math.abs(dBeta) < 0.03 && Math.abs(dGamma) < 0.03) return;
    const m = mapDeviceToLook(dBeta, dGamma, dAlpha);
    // motion 只负责了左右时，这里只补上下，避免左右双计
    applyGyro(motionYaw ? 0 : m.yaw, motionPitch ? 0 : m.pitch);
  }
  function syncGyroListener() {
    if (!GYRO_SUPPORTED) return;
    const want = settings.gyro && gyroPermOk;
    if (want && !gyroBound) {
      if (HAS_MOTION_API) window.addEventListener('devicemotion', onDeviceMotion, true);
      if (HAS_GYRO_API) window.addEventListener('deviceorientation', onDeviceOrientation, true);
      gyroBound = true;
    } else if (!want && gyroBound) {
      window.removeEventListener('deviceorientation', onDeviceOrientation, true);
      window.removeEventListener('devicemotion', onDeviceMotion, true);
      gyroBound = false;
      resetGyroBase();
    }
  }
  if ($('optGyro')) {
    $('optGyro').onclick = () => {
      G.audio.ui();
      if (settings.gyro) {
        applyGyroSetting(false);
        return;
      }
      if (!TOUCH) {
        applyGyroSetting(true);
        return;
      }
      if (GYRO_NEEDS_ANY_PERM) {
        if (!window.isSecureContext) {
          G.audio.deny();
          notice('陀螺仪需要 HTTPS 或 localhost 安全连接', false);
          return;
        }
        requestGyroPermissionFromGesture().then(ok => {
          if (!ok) {
            G.audio.deny();
            notice('无法启用陀螺仪：请在系统弹窗中允许「动作与方向」', false);
            return;
          }
          applyGyroSetting(true);
        });
        return;
      }
      gyroPermOk = true;
      applyGyroSetting(true);
    };
  }
  addEventListener('orientationchange', () => setTimeout(resetGyroBase, 80));
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', () => setTimeout(resetGyroBase, 80));
  }
  function toggleView() {
    if (mode === 'spec') { specView = specView === 'tp' ? 'fp' : 'tp'; updateSpecBar(); return; }
    settings.view = settings.view === 'tp' ? 'fp' : 'tp';
    localStorage.setItem('na_view', settings.view);
    refreshOpts();
    G.audio.ui();
  }
  function openPause() {
    refreshOpts();
    resetGyroBase();
    $('pause').classList.remove('hidden');
    document.exitPointerLock && document.exitPointerLock();
  }
  function closePause() {
    applySensFromSlider();
    applyGyroSensFromSlider();
    resetGyroBase();
    $('pause').classList.add('hidden');
    ensureGyroPermissionThen(() => {
      syncGyroListener();
      if (mode !== 'menu') requestLock();
    });
  }

  // ---------- 指针锁定与输入 ----------
  function requestLock() {
    lockWanted = true;
    if (NOLOCK || TOUCH) return;   // 触屏没有指针锁定这回事，视角改由触摸拖拽驱动
    try { canvas.requestPointerLock && canvas.requestPointerLock(); } catch (_) {}
  }
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && lockWanted && (mode === 'play' || mode === 'spec')
      && $('shop').classList.contains('hidden') && $('pause').classList.contains('hidden') && !NOLOCK && !TOUCH) {
      openPause();
    }
  });
  canvas.addEventListener('click', () => {
    G.audio.init();
    if (!TOUCH && mode !== 'menu' && !document.pointerLockElement
      && $('pause').classList.contains('hidden') && $('shop').classList.contains('hidden')) requestLock();
  });
  $('btnResume').onclick = () => closePause();
  $('btnToMenu').onclick = () => { send({ type: 'leave' }); rejoinWanted = false; lockWanted = false; backToMenu(); };

  // 视角旋转：鼠标(movementX/Y)与触屏拖拽(帧间坐标差)最终都走这一个函数，共用 settings.sens
  function lookSensScale() {
    const base = TOUCH ? 0.0032 : 0.0022;
    return base * settings.sens * (me.zoom > 0.5 ? 0.4 : 1);
  }
  function applyLook(dx, dy) {
    if (mode === 'menu') return;
    const sens = lookSensScale();
    me.yaw -= dx * sens;
    me.pitch = Math.max(-1.53, Math.min(1.53, me.pitch - dy * sens));
    me.swayX = Math.max(-0.06, Math.min(0.06, me.swayX + dx * 0.0005));
    me.swayY = Math.max(-0.05, Math.min(0.05, me.swayY + dy * 0.0005));
  }
  document.addEventListener('mousemove', e => {
    if (TOUCH) return;   // 触屏端走 touch/pointer，避免部分浏览器合成 mousemove 干扰
    const locked = !!document.pointerLockElement || NOLOCK;
    if (!locked || mode === 'menu') return;
    applyLook(e.movementX, e.movementY);
  });
  document.addEventListener('mousedown', e => {
    if (mode === 'menu' || isTyping()) return;
    if (!$('shop').classList.contains('hidden') || !$('pause').classList.contains('hidden')
      || !$('lost').classList.contains('hidden')) return;
    if (e.button === 0) {
      mouseDown = true;
      if (mode === 'play' && me.active === 'nade') tryNadePrime();
    }
    if (e.button === 2) rmbDown = true;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) {
      if (me.nadeHolding || me.nadePrimeSent) tryNadeThrow();
      mouseDown = false;
    }
    if (e.button === 2) rmbDown = false;
  });
  document.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('blur', () => {
    if (me.nadeHolding || me.nadePrimeSent) tryNadeThrow();
    for (const k in keys) keys[k] = false; mouseDown = rmbDown = false;
    touch.joyId = touch.lookId = null; activeTouches.clear();
    fireTouch.right = fireTouch.left = false;
  });

  // ---------- 触屏：虚拟摇杆 + 视角拖拽（document 级监听，避免触控层挡住 canvas 收不到触摸） ----------
  function touchDriveAllowed() {
    if (touchEditMode) return false;
    return canDriveCam() && !isTyping() && $('shop').classList.contains('hidden')
      && $('pause').classList.contains('hidden') && $('lost').classList.contains('hidden');
  }
  function touchHitsUi(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    // 血条、聊天记录、击杀播报等只是信息，不挡左手移动；按钮和输入框仍独占触摸
    if (el.closest('#chatMsgs, #vitals, #topLeft, #killfeed, #notice, #bigNotice, #bossBar, #bossTimer, #protectHint, #statLine, #hud')) {
      if (!el.closest('#weaponPanel, .wslot, .tbtn, #interactHint, #chatInputRow, button, input')) return false;
    }
    return !!el.closest('#weaponPanel, .wslot, .tbtn, #interactHint, #chatInputRow, .overlay:not(.hidden), button, input, .panel-close, .spec-btn');
  }
  function joyZoneHit(x) {
    return x < innerWidth / 3;
  }
  function showJoyAt(x, y) {
    const base = $('joyBase');
    const r = (base.offsetWidth || 112) / 2;
    base.style.left = (x - r) + 'px';
    base.style.top = (y - r) + 'px';
    base.classList.add('show');
    $('joyStick').style.transform = 'translate(0px,0px)';
  }
  // 可自由驱动镜头：游戏中，或观战自由飞行。观战跟随时镜头锁定目标玩家，忽略摇杆/拖拽
  function canDriveCam() { return mode === 'play' || (mode === 'spec' && !isFollowing()); }
  function onTouchStart(e) {
    if (!TOUCH || !touchDriveAllowed()) return;
    for (const t of e.changedTouches) {
      if (touchHitsUi(t.clientX, t.clientY)) continue;
      if (touch.joyId === null && joyZoneHit(t.clientX, t.clientY)) {
        touch.joyId = t.identifier; touch.joyBaseX = t.clientX; touch.joyBaseY = t.clientY;
        touch.joyX = 0; touch.joyZ = 0;
        showJoyAt(t.clientX, t.clientY);
      } else if (touch.lookId === null && !joyZoneHit(t.clientX, t.clientY)) {
        touch.lookId = t.identifier;
        activeTouches.set(t.identifier, { lastX: t.clientX, lastY: t.clientY });
      }
    }
  }
  function onTouchMove(e) {
    if (!TOUCH) return;
    for (const t of e.changedTouches) {
      if (t.identifier === touch.joyId) {
        let dx = t.clientX - touch.joyBaseX, dy = t.clientY - touch.joyBaseY;
        const R = 52, dist = Math.hypot(dx, dy);
        if (dist > R) { dx = dx / dist * R; dy = dy / dist * R; }
        $('joyStick').style.transform = `translate(${dx}px,${dy}px)`;
        touch.joyX = dx / R; touch.joyZ = -dy / R;
      } else if (t.identifier === touch.lookId) {
        if (!touchDriveAllowed()) continue;
        const info = activeTouches.get(t.identifier);
        if (!info) continue;
        const dx = t.clientX - info.lastX, dy = t.clientY - info.lastY;
        info.lastX = t.clientX; info.lastY = t.clientY;
        applyLook(dx, dy);
      }
    }
  }
  function touchEndHandler(e) {
    if (!TOUCH) return;
    for (const t of e.changedTouches) {
      if (t.identifier === touch.joyId) {
        touch.joyId = null; touch.joyX = 0; touch.joyZ = 0;
        $('joyBase').classList.remove('show');
      } else if (t.identifier === touch.lookId) {
        touch.lookId = null; activeTouches.delete(t.identifier);
      }
    }
  }
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend', touchEndHandler, { passive: true });
  document.addEventListener('touchcancel', touchEndHandler, { passive: true });

  // 触屏按钮：Fire/Jump 需要"按住"语义走 touchstart/touchend；武器栏同理用 touchstart（多指按住摇杆/跳跃时 click 往往不触发）
  function touchActionAllowed() {
    if (touchEditMode) return false;
    return mode !== 'menu' && !isTyping() && $('shop').classList.contains('hidden')
      && $('pause').classList.contains('hidden') && $('lost').classList.contains('hidden');
  }
  function bindMobileTap(el, handler) {
    if (TOUCH) {
      el.addEventListener('touchstart', e => {
        e.preventDefault();
        e.stopPropagation();
        if (touchActionAllowed()) handler();
      }, { passive: false });
    } else {
      el.onclick = handler;
    }
  }
  // 左右开火键各自按住；松掉其中一个时，另一个还按着就继续开火
  const fireTouch = { right: false, left: false };
  function releaseFireTouch(which) {
    if (!fireTouch[which]) return;
    fireTouch[which] = false;
    if (fireTouch.right || fireTouch.left) return;
    if (me.nadeHolding || me.nadePrimeSent) tryNadeThrow();
    mouseDown = false;
  }
  function bindFireTouch(el, which) {
    if (!el) return;
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!touchActionAllowed()) return;
      fireTouch[which] = true;
      if (!mouseDown) {
        mouseDown = true;
        if (me.active === 'nade') tryNadePrime();
      }
    }, { passive: false });
    el.addEventListener('touchend', e => {
      e.preventDefault();
      releaseFireTouch(which);
    }, { passive: false });
    el.addEventListener('touchcancel', () => releaseFireTouch(which));
  }
  bindFireTouch($('tFire'), 'right');
  bindFireTouch($('tFireLeft'), 'left');
  $('tJump').addEventListener('touchstart', e => { e.preventDefault(); if (touchActionAllowed()) keys.Space = true; }, { passive: false });
  $('tJump').addEventListener('touchend', e => { e.preventDefault(); keys.Space = false; }, { passive: false });
  $('tJump').addEventListener('touchcancel', () => { keys.Space = false; });
  // 开镜必须用 touchstart：按住摇杆移动时 click 经常不触发，导致「边走边开镜」失效
  bindMobileTap($('tScope'), () => { rmbDown = !rmbDown; });
  bindMobileTap($('tReload'), () => {
    if (!mySnap || !mySnap.al || me.active !== 'gun' || !mySnap.gw) { G.audio.deny(); return; }
    const def = defs.weapons[mySnap.gw];
    if (!def || def.noReload) { G.audio.deny(); return; }
    cancelInspect();
    send({ type: 'reload' });
    tryLocalReload();
  });
  if ($('tInspect')) bindMobileTap($('tInspect'), () => tryInspect());
  // 观战自由飞行升降（按住语义）
  $('tUp').addEventListener('touchstart', e => { e.preventDefault(); keys.Space = true; }, { passive: false });
  $('tUp').addEventListener('touchend', e => { e.preventDefault(); keys.Space = false; }, { passive: false });
  $('tUp').addEventListener('touchcancel', () => { keys.Space = false; });
  $('tDown').addEventListener('touchstart', e => { e.preventDefault(); keys.KeyC = true; }, { passive: false });
  $('tDown').addEventListener('touchend', e => { e.preventDefault(); keys.KeyC = false; }, { passive: false });
  $('tDown').addEventListener('touchcancel', () => { keys.KeyC = false; });
  // 观战触屏按钮组
  $('specPrev').onclick = () => cycleSpec(-1);
  $('specNext').onclick = () => cycleSpec(1);
  $('specFollowBtn').onclick = () => setFollow(!isFollowing());
  $('specViewBtn').onclick = () => { specView = specView === 'tp' ? 'fp' : 'tp'; updateSpecBar(); };
  $('specJoinBtn').onclick = () => joinFromSpec();
  $('tMenu').onclick = () => { if (mode === 'play' || mode === 'spec') openPause(); };
  $('tBoard').onclick = () => { $('board').classList.toggle('hidden'); };
  $('tChat').onclick = () => { if (mode === 'play') openChat(); };
  $('boardClose').onclick = () => { $('board').classList.add('hidden'); };
  $('shopClose').onclick = () => toggleShop(false);
  function toggleAbout(open) {
    const el = $('about');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    el.classList.toggle('hidden', !want);
  }
  const ARSENAL_WPS = ['knife', 'sword', 'hammer', 'pistol', 'shotgun', 'mg', 'sniper', 'charge', 'railgun', 'nade', 'flash', 'smoke'];
  const ARSENAL_FALLBACK_NAME = {
    knife: '小刀', sword: '长刀', hammer: '铁锤', pistol: '手枪', shotgun: '散弹枪', mg: '机枪',
    sniper: '狙击枪', charge: '充能步枪', railgun: '电磁炮', nade: '手雷', flash: '闪光弹', smoke: '烟雾弹',
  };
  function arsenalName(id) {
    return (defs && defs.weapons[id] && defs.weapons[id].name) || ARSENAL_FALLBACK_NAME[id] || id;
  }
  function buildArsenalChips() {
    const box = $('arsenalNames');
    if (!box) return;
    box.innerHTML = '';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'arsenal-chip' + (!arsenalFocus ? ' active' : '');
    all.textContent = '全部';
    all.onclick = () => focusArsenal(null);
    box.appendChild(all);
    for (const id of ARSENAL_WPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'arsenal-chip' + (arsenalFocus === id ? ' active' : '');
      b.textContent = `${WICON[id] || '🔫'} ${arsenalName(id)}`;
      b.onclick = () => focusArsenal(id);
      box.appendChild(b);
    }
  }
  function focusArsenal(id) {
    arsenalFocus = id;
    arsenalFocusT = 0;
    buildArsenalChips();
  }
  function initArsenalPre() {
    if (arsenalPre) return;
    const cv = $('arsenalCv');
    const w = 720, h = 420;
    const r = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.setSize(w, h, false);
    r.outputEncoding = T.sRGBEncoding;
    const sc = new T.Scene();
    sc.add(new T.HemisphereLight(0xc8e4ff, 0x1a1828, 1.05));
    const dl = new T.DirectionalLight(0xffffff, 1.05);
    dl.position.set(2.5, 4, 3);
    sc.add(dl);
    const fill = new T.DirectionalLight(0x35e0ff, 0.35);
    fill.position.set(-3, 2, -2);
    sc.add(fill);
    const cam = new T.PerspectiveCamera(42, w / h, 0.1, 40);
    cam.position.set(0, 2.6, 7.2);
    cam.lookAt(0, 0.4, 0);

    const items = [];
    const cols = 4;
    const spacingX = 1.55;
    const spacingZ = 1.7;
    const rows = Math.ceil(ARSENAL_WPS.length / cols);
    ARSENAL_WPS.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const mesh = G.models.buildWeapon(id);
      const scale = (id === 'nade' || id === 'flash' || id === 'smoke') ? 2.6
        : (id === 'knife' || id === 'sword' || id === 'hammer') ? 1.35 : 1.55;
      mesh.scale.setScalar(scale);
      const x = (col - (cols - 1) / 2) * spacingX;
      const z = (row - (rows - 1) / 2) * spacingZ;
      mesh.position.set(x, 0.35, z);
      mesh.rotation.x = -0.12;
      sc.add(mesh);
      // 底座光环
      const pad = new T.Mesh(
        new T.CylinderGeometry(0.32, 0.36, 0.04, 20),
        new T.MeshStandardMaterial({ color: '#1a2434', emissive: '#0a3040', emissiveIntensity: 0.35, metalness: 0.4, roughness: 0.55 })
      );
      pad.position.set(x, 0.02, z);
      sc.add(pad);
      items.push({ id, mesh, home: { x, y: 0.35, z }, pad });
    });

    // 地面淡雾平面
    const floor = new T.Mesh(
      new T.CircleGeometry(6.5, 36),
      new T.MeshStandardMaterial({ color: '#0b1220', transparent: true, opacity: 0.65, metalness: 0.2, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    sc.add(floor);

    arsenalPre = { r, sc, cam, items, homeCam: { x: 0, y: 2.6, z: 7.2, lx: 0, ly: 0.4, lz: 0 } };
    buildArsenalChips();
  }
  function renderArsenalPre(dt) {
    if (!arsenalPre || $('arsenal').classList.contains('hidden')) return;
    arsenalFocusT += dt;
    for (const it of arsenalPre.items) {
      it.mesh.rotation.y += dt * (arsenalFocus && arsenalFocus !== it.id ? 0.35 : 1.15);
      const spotlight = !arsenalFocus || arsenalFocus === it.id;
      const targetY = spotlight ? it.home.y + (arsenalFocus === it.id ? 0.25 : 0) : it.home.y - 0.15;
      const targetScaleMul = spotlight ? (arsenalFocus === it.id ? 1.35 : 1) : 0.55;
      it.mesh.position.y += (targetY - it.mesh.position.y) * Math.min(1, dt * 5);
      const base = (it.id === 'nade' || it.id === 'flash' || it.id === 'smoke') ? 2.6
        : (it.id === 'knife' || it.id === 'sword' || it.id === 'hammer') ? 1.35 : 1.55;
      const s = base * targetScaleMul;
      const cur = it.mesh.scale.x;
      const ns = cur + (s - cur) * Math.min(1, dt * 5);
      it.mesh.scale.setScalar(ns);
      it.mesh.visible = true;
      if (it.pad) it.pad.material.emissiveIntensity = spotlight ? (arsenalFocus === it.id ? 0.9 : 0.35) : 0.08;
    }

    const cam = arsenalPre.cam;
    const home = arsenalPre.homeCam;
    let tx = home.x, ty = home.y, tz = home.z, lx = home.lx, ly = home.ly, lz = home.lz;
    if (arsenalFocus) {
      const it = arsenalPre.items.find(x => x.id === arsenalFocus);
      if (it) {
        tx = it.home.x * 0.35;
        ty = 1.35;
        tz = it.home.z + 2.6;
        lx = it.home.x;
        ly = 0.55;
        lz = it.home.z;
      }
    }
    cam.position.x += (tx - cam.position.x) * Math.min(1, dt * 3.2);
    cam.position.y += (ty - cam.position.y) * Math.min(1, dt * 3.2);
    cam.position.z += (tz - cam.position.z) * Math.min(1, dt * 3.2);
    cam.lookAt(lx, ly, lz);

    arsenalPre.r.render(arsenalPre.sc, arsenalPre.cam);
  }
  function toggleArsenal(open) {
    const el = $('arsenal');
    const want = open === undefined ? el.classList.contains('hidden') : open;
    if (want) {
      initArsenalPre();
      buildArsenalChips();
      toggleAbout(false);
    }
    el.classList.toggle('hidden', !want);
    if (!want) toggleAbout(true);
  }
  $('btnAbout').onclick = () => toggleAbout(true);
  $('aboutClose').onclick = () => toggleAbout(false);
  $('btnArsenal').onclick = () => toggleArsenal(true);
  $('arsenalClose').onclick = () => toggleArsenal(false);
  // 武器栏点按切换（桌面 click / 触屏 touchstart）；再点已激活的枪械栏 = 换弹
  bindMobileTap($('slotMelee'), () => switchSlot('melee'));
  bindMobileTap($('slotNade'), () => switchSlot('nade'));
  bindMobileTap($('slotGun'), () => {
    if (!mySnap || !mySnap.gw) return;
    if (me.active !== 'gun') switchSlot('gun');
    else if (!defs.weapons[mySnap.gw].noReload) { send({ type: 'reload' }); tryLocalReload(); }
  });
  $('interactHint').onclick = () => tryInteract();

  // 滚轮：战局中切武器 / 观战自由视角调速
  addEventListener('wheel', e => {
    if (isTyping() || !$('shop').classList.contains('hidden')) return;
    if (mode === 'play' && mySnap && mySnap.al) {
      cycleWeapon(e.deltaY > 0 ? 1 : -1);
    } else if (mode === 'spec' && !isFollowing()) {
      specSpeed = Math.max(0.3, Math.min(4, specSpeed * (e.deltaY > 0 ? 0.85 : 1.18)));
    }
  }, { passive: true });
  function cycleWeapon(dir) {
    if (!mySnap) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    if (zomb) return;
    const slots = ['melee'];
    if (mySnap.gw) slots.push('gun');
    if (mySnap.ng) slots.push('nade');
    if (slots.length < 2) return;
    let idx = slots.indexOf(me.active);
    if (idx < 0) idx = 0;
    switchSlot(slots[(idx + dir + slots.length) % slots.length]);
  }

  function isTyping() {
    const a = document.activeElement;
    return a === $('chatInput') || a === $('nameInput') || a === $('roomNameInput')
      || a === $('roomPassInput') || a === $('roomGateInput');
  }

  document.addEventListener('keydown', e => {
    if (e.code === 'Tab') { e.preventDefault(); if (mode !== 'menu' && !isTyping()) $('board').classList.remove('hidden'); return; }
    if (e.code === 'Escape') {
      if (!$('arsenal').classList.contains('hidden')) { toggleArsenal(false); return; }
      if (!$('about').classList.contains('hidden')) { toggleAbout(false); return; }
      if ($('roomGate') && !$('roomGate').classList.contains('hidden')) { closeRoomGate(); return; }
      if (!$('authPick').classList.contains('hidden')) { closeAuthPick(); return; }
      if (!$('loginPanel').classList.contains('hidden')) { toggleLoginPanel(false); return; }
      if (!$('wardrobe').classList.contains('hidden')) { toggleWardrobe(false); return; }
      if (!$('shop').classList.contains('hidden')) { toggleShop(false); return; }
      if (!$('pause').classList.contains('hidden')) { closePause(); return; }
      if (mode === 'play' || mode === 'spec') openPause();
      return;
    }
    if (isTyping()) return;
    keys[e.code] = true;
    if (e.code === 'Enter') {
      if (mode === 'spec') { joinFromSpec(); return; }
      if (mode === 'play') openChat();
      return;
    }
    if (e.code === 'KeyV' && mode !== 'menu') { toggleView(); return; }
    if (mode === 'play') {
      if (e.code === 'Digit1') switchSlot('melee');
      if (e.code === 'Digit2') switchSlot('gun');
      if (e.code === 'Digit3') switchSlot('nade');
      if (e.code === 'KeyR') { cancelInspect(); send({ type: 'reload' }); tryLocalReload(); }
      if (e.code === 'KeyT') { if (!e.repeat) tryInspect(); }
      if (e.code === 'KeyE') tryInteract();
    }
    if (mode === 'spec') {
      if (e.code === 'KeyF') setFollow(!isFollowing());
      if (e.code === 'ArrowLeft') cycleSpec(-1);
      if (e.code === 'ArrowRight') cycleSpec(1);
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Tab') { e.preventDefault(); $('board').classList.add('hidden'); return; }
    keys[e.code] = false;
  });

  function switchSlot(slot) {
    if (!mySnap) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    if (zomb && slot !== 'melee') { G.audio.deny(); return; }
    if (slot === 'gun' && !mySnap.gw) { G.audio.deny(); return; }
    if (slot === 'nade' && !mySnap.ng) { G.audio.deny(); return; }
    if (me.active === slot) return;
    cancelInspect();
    if (me.active === 'gun' && slot !== 'gun') {
      me.chargingUntil = 0;
      if (myId) G.fx.clearChargeBeam(myId);
    }
    me.active = slot; me.lastSwitch = now();
    send({ type: 'switch', slot });
    G.audio.ui();
  }
  function cancelInspect() {
    vmInspectT = INSPECT_DUR;
  }
  function tryInspect() {
    if (mode !== 'play' || !mySnap || !mySnap.al) return;
    if (effectiveView() !== 'fp') { G.audio.deny(); return; }
    if (me.zoom >= 0.5) return;
    if (me.reloadUntil > now()) return;
    if (vmInspectT < INSPECT_DUR) return;
    if (vmSwingT < 0.28 || vmThrowT < 0.3) return;
    if (me.cookLeft > 0 || me.nadeHolding) return;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    if (zomb) return;
    const held = me.active === 'gun' ? mySnap.gw
      : me.active === 'nade' ? (mySnap.ng || 'nade')
      : mySnap.mw;
    if (!held || held === 'fist') { G.audio.deny(); return; }
    vmInspectT = 0;
    G.audio.ui();
  }
  function tryLocalReload() {
    if (!mySnap || !mySnap.gw) return;
    const def = defs.weapons[mySnap.gw];
    if (def.noReload || me.ammoL >= def.mag || me.reloadUntil > now() || me.reserve <= 0) return;
    me.reloadUntil = now() + def.reload * 1000;
    me.reloadDur = def.reload * 1000;
    G.audio.reload();
  }
  function nearestMerchantDist() {
    const pts = defs.map.merchants || (defs.map.merchant ? [defs.map.merchant] : []);
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(me.pos.x - pts[i].x, me.pos.z - pts[i].z);
      if (d < best) best = d;
    }
    return best;
  }
  function tryInteract() {
    if (!defs) return;
    const md = nearestMerchantDist();
    if (md < defs.rules.merchantDist || !$('shop').classList.contains('hidden')) toggleShop();
  }

  // 聊天
  function syncGuestChatLock() {
    const guest = isGuest();
    const btn = $('tChat');
    if (btn) {
      btn.classList.toggle('guest-off', guest);
      btn.title = guest ? '游客无法发言' : '聊天';
    }
    if (guest) {
      $('chatInputRow').classList.add('hidden');
      if ($('chatInput')) $('chatInput').blur();
    }
  }
  function openChat() {
    if (isGuest()) {
      notice('游客无法发言');
      return;
    }
    $('chatInputRow').classList.remove('hidden');
    $('chatInput').focus();
  }
  function sendChatNow() {
    if (isGuest()) {
      $('chatInput').value = '';
      $('chatInputRow').classList.add('hidden');
      notice('游客无法发言');
      return;
    }
    const v = $('chatInput').value.trim();
    if (v) send({ type: 'chat', text: v });
    $('chatInput').value = '';
    $('chatInputRow').classList.add('hidden');
    $('chatInput').blur();
  }
  $('chatInput').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.code === 'Enter') sendChatNow();
    else if (e.code === 'Escape') { $('chatInputRow').classList.add('hidden'); $('chatInput').blur(); }
  });
  $('chatSendBtn').onclick = () => sendChatNow();
  // 移动端虚拟键盘会挡住底部聊天框，聚焦时临时上移（粗略估计键盘高度，非精确 visualViewport 适配）
  $('chatInput').addEventListener('focus', () => { if (TOUCH) document.body.classList.add('chat-focus'); });
  $('chatInput').addEventListener('blur', () => document.body.classList.remove('chat-focus'));

  // 菜单按钮
  $('nameInput').value = myName;
  updatePassHint();
  updateOauthUi();
  function joinMsg() {
    const roomId = selectedRoomId || 'official';
    const roomPassword = roomPassCache.get(roomId) || '';
    if (isGuest()) return { type: 'join', guest: true, roomId, roomPassword };
    return { type: 'join', name: myName, password: '', roomId, roomPassword };
  }
  function doJoinPlay() {
    roomGateMode = 'play';
    ensureGyroPermissionThen(() => send(joinMsg()));
  }
  function openRoomGate(text) {
    const hint = $('roomGateHint');
    if (hint) hint.textContent = roomGateMode === 'spec' ? '观战该房间需要密码' : '进入该房间需要密码';
    const msg = $('roomGateMsg');
    if (msg) msg.textContent = (text && text !== '该房间需要密码') ? text : '';
    $('roomGate').classList.remove('hidden');
    const input = $('roomGateInput');
    if (input) { input.value = ''; input.focus(); }
  }
  function closeRoomGate() {
    if ($('roomGate')) $('roomGate').classList.add('hidden');
  }
  function submitRoomGate() {
    const pass = ($('roomGateInput') && $('roomGateInput').value || '').trim();
    const msg = $('roomGateMsg');
    if (!pass) {
      if (msg) msg.textContent = '请输入房间密码';
      return;
    }
    const id = selectedRoomId || 'official';
    roomPassCache.set(id, pass);
    closeRoomGate();
    if (roomGateMode === 'spec') {
      G.audio.init();
      ensureGyroPermissionThen(() => send({ type: 'spectate', roomId: id, roomPassword: pass }));
      return;
    }
    doJoinPlay();
  }
  function enterGuestMode() {
    if (isOauthLoggedIn()) {
      $('menuErr').textContent = '已登录，请直接进入战斗';
      return;
    }
    guestMode = true;
    guestName = '';
    myName = '';
    if ($('nameInput')) {
      $('nameInput').value = '';
      $('nameInput').readOnly = true;
      $('nameInput').placeholder = '系统分配游客昵称，不可修改';
    }
    $('menuErr').textContent = '';
    updateOauthUi();
    updatePassHint();
    send({ type: 'guest_login' });
  }
  function exitGuest() {
    guestMode = false;
    guestName = '';
    myName = '';
    if ($('nameInput')) {
      $('nameInput').value = '';
      $('nameInput').placeholder = '登录后显示昵称（游客昵称由系统分配，不可修改）';
    }
    send({ type: 'guest_logout' });
    guestJoinQueued = false;
    updateOauthUi();
    updatePassHint();
    syncGuestChatLock();
    $('menuErr').textContent = '已退出游客';
  }
  $('btnPlay').onclick = () => {
    G.audio.init();
    if (isGuest()) {
      if (!guestName) {
        guestJoinQueued = true;
        $('menuErr').textContent = '正在分配游客昵称，请稍候';
        send({ type: 'guest_login' });
        return;
      }
      guestJoinQueued = false;
      $('menuErr').textContent = '';
      doJoinPlay();
      return;
    }
    if (!isOauthLoggedIn()) {
      highlightNeedOauth('请先登录或使用游客登录');
      return;
    }
    syncSiteName();
    if (!myName) {
      $('menuErr').textContent = '无法获取站点昵称，请重新登录';
      return;
    }
    $('menuErr').textContent = '';
    requireAuth(doJoinPlay);
  };
  function displayRoomName(r) {
    if (!r) return '官方大厅';
    if (r.official && (!r.name || r.name === '官厅')) return '官方大厅';
    return r.name || '未名房间';
  }
  function renderRooms(m) {
    roomCap = (m && m.cap) || 10;
    const list = (m && Array.isArray(m.rooms) && m.rooms.length)
      ? m.rooms
      : [{ id: 'official', name: '官方大厅', official: true, players: 0, spectators: 0, cap: roomCap, owner: '官方' }];
    roomList = list;
    if (!list.some(r => r.id === selectedRoomId)) selectedRoomId = 'official';
    let total = 0;
    const box = $('roomList');
    if (box) box.innerHTML = '';
    for (const r of list) {
      const players = r.players | 0;
      const humans = r.humans != null ? (r.humans | 0) : players;
      const specs = r.spectators | 0;
      const cap = r.cap || roomCap;
      total += players;
      if (!box) continue;
      const full = humans >= cap;
      const isSel = r.id === selectedRoomId;
      const pct = Math.min(100, Math.round((players / cap) * 100));
      const rName = displayRoomName(r);
      const card = document.createElement('div');
      card.className = 'room-row' + (r.official ? ' official' : ' custom') + (r.locked ? ' locked' : '') + (isSel ? ' selected' : '') + (full ? ' is-full' : '');
      card.innerHTML =
        '<div class="room-top">' +
          '<span class="room-badge"></span>' +
          '<span class="room-name"></span>' +
          '<span class="room-count"></span>' +
        '</div>' +
        '<div class="room-bar"><div class="room-bar-fill"></div></div>' +
        '<div class="room-bottom">' +
          '<span class="room-sub"></span>' +
          '<div class="room-ops">' +
            '<button type="button" class="room-enter"></button>' +
            '<button type="button" class="room-watch">👁️ 观战</button>' +
          '</div>' +
        '</div>';
      card.querySelector('.room-badge').textContent = r.official ? '官方' : (r.locked ? '加密' : '自建');
      card.querySelector('.room-name').textContent = rName;
      card.querySelector('.room-count').textContent = `👥 ${players} / ${cap}`;
      card.querySelector('.room-bar-fill').style.width = pct + '%';
      const ownerLabel = (!r.owner || r.owner === '官家') ? '系统常驻' : r.owner;
      card.querySelector('.room-sub').textContent =
        (r.official ? '常驻混战' : ('房主：' + ownerLabel)) +
        (r.locked ? ' · 需要密码' : '') +
        (specs > 0 ? ` · 👁️ ${specs} 观战` : '');
      const enter = card.querySelector('.room-enter');
      enter.textContent = full ? '已满' : (isSel ? '⚔️ 进入' : '进入');
      enter.disabled = full;
      enter.onclick = (ev) => { ev.stopPropagation(); enterRoom(r.id); };
      card.querySelector('.room-watch').onclick = (ev) => { ev.stopPropagation(); spectateRoom(r.id); };
      card.onclick = () => {
        selectedRoomId = r.id;
        renderRooms({ cap: roomCap, rooms: roomList });
      };
      box.appendChild(card);
    }
    if (box && list.filter(r => !r.official).length === 0) {
      const tip = document.createElement('div');
      tip.className = 'room-empty-tip';
      tip.innerHTML =
        '<div class="ret-ico" aria-hidden="true">🛰️</div>' +
        '<div class="ret-title">暂无玩家自建房间</div>' +
        '<div class="ret-sub">登录 NodeLoc / LinuxDo 账号后可在上方创建专属房间，与好友同场竞技</div>' +
        '<div class="ret-tags"><span>👥 10人上限</span><span>⚡ 即开即战</span><span>🔄 空房自动回收</span></div>';
      box.appendChild(tip);
    }
    if (hasServerRooms) {
      const online = $('menuOnline');
      if (online) online.textContent = String(total);
    }
    if ($('roomTotalBadge')) {
      $('roomTotalBadge').textContent = `${list.length} 房 · ${total} 人`;
    }
    const cur = list.find(r => r.id === selectedRoomId) || list[0];
    if ($('roomSelLabel') && cur) {
      $('roomSelLabel').textContent = '当前：' + displayRoomName(cur);
    }
    const play = $('btnPlay');
    if (play) {
      play.textContent = cur ? ('🎮 进入战斗 · ' + displayRoomName(cur)) : '🎮 进入战斗';
      const seated = cur && cur.humans != null ? (cur.humans | 0) : (cur ? (cur.players | 0) : 0);
      play.disabled = !!(cur && seated >= (cur.cap || roomCap));
    }
    const spec = $('btnSpec');
    if (spec) {
      spec.textContent = cur ? ('👁️ 观战模式 · ' + displayRoomName(cur)) : '👁️ 观战模式';
    }
  }
  function enterRoom(id) {
    selectedRoomId = id;
    renderRooms({ cap: roomCap, rooms: roomList });
    $('btnPlay').click();
  }
  function spectateRoom(id) {
    roomGateMode = 'spec';
    selectedRoomId = id;
    renderRooms({ cap: roomCap, rooms: roomList });
    G.audio.init();
    ensureGyroPermissionThen(() => send({
      type: 'spectate',
      roomId: id || 'official',
      roomPassword: roomPassCache.get(id || 'official') || '',
    }));
  }
  $('btnSpec').onclick = () => spectateRoom(selectedRoomId || 'official');
  $('btnDeathSpec').onclick = () => { send({ type: 'spectate' }); };
  $('btnSpecJoin').onclick = () => joinFromSpec();
  $('btnLogin').onclick = () => { G.audio.init(); toggleLoginPanel(true); };
  $('loginClose').onclick = () => toggleLoginPanel(false);
  $('btnClaimLogin').onclick = () => {
    const n = menuName();
    if (!n) { setLoginMsg('请先登录', false); return; }
    requireAuth(() => {
      myName = n;
      localStorage.setItem('na_name', n);
      send({ type: 'claim_login', name: n, password: '' });
    });
  };
  $('btnWardrobe').onclick = () => { G.audio.init(); toggleWardrobe(true); };
  $('wardrobeClose').onclick = () => toggleWardrobe(false);
  if ($('btnNodeLoc')) $('btnNodeLoc').onclick = () => { G.audio.init(); openAuthPick(); };
  if ($('btnPickNodeLoc')) $('btnPickNodeLoc').onclick = () => { G.audio.init(); closeAuthPick(); goNodeLocLogin(); };
  if ($('btnPickLinuxDo')) $('btnPickLinuxDo').onclick = () => { G.audio.init(); closeAuthPick(); goLinuxDoLogin(); };
  if ($('authPickClose')) $('authPickClose').onclick = () => closeAuthPick();
  if ($('btnGuest')) $('btnGuest').onclick = () => {
    G.audio.init();
    const msg = $('authPickMsg');
    if (msg) {
      msg.textContent = '后续会开放游客登录';
      msg.classList.remove('hidden');
    }
  };
  if ($('btnCreateRoom')) $('btnCreateRoom').onclick = () => {
    G.audio.init();
    const hint = $('roomCreateHint');
    if (!isOauthLoggedIn() || isGuest()) {
      if (hint) {
        hint.textContent = isGuest() ? '游客不可开房，请先退出游客并登录账号' : '请先登录账号再创建房间';
        hint.className = 'room-hint warn';
      }
      if (!isOauthLoggedIn() && !isGuest()) openAuthPick();
      return;
    }
    const name = ($('roomNameInput') && $('roomNameInput').value || '').trim();
    if (!name) {
      if (hint) {
        hint.textContent = '请先填写房间名（最多12字）';
        hint.className = 'room-hint warn';
      }
      if ($('roomNameInput')) $('roomNameInput').focus();
      return;
    }
    const usePass = !!($('roomPassToggle') && $('roomPassToggle').checked);
    const pass = usePass ? (($('roomPassInput') && $('roomPassInput').value || '').trim()) : '';
    if (usePass && !pass) {
      if (hint) {
        hint.textContent = '已勾选设置密码，请填写 1-16 位密码';
        hint.className = 'room-hint warn';
      }
      if ($('roomPassInput')) $('roomPassInput').focus();
      return;
    }
    if (hint) {
      hint.textContent = '正在创建房间…';
      hint.className = 'room-hint ok';
    }
    pendingRoomPass = pass;
    send({ type: 'create_room', name, password: pass });
  };
  if ($('roomPassToggle') && $('roomPassInput')) {
    $('roomPassToggle').addEventListener('change', () => {
      const on = $('roomPassToggle').checked;
      $('roomPassInput').classList.toggle('hidden', !on);
      if (on) $('roomPassInput').focus();
      else $('roomPassInput').value = '';
    });
  }
  if ($('roomNameInput')) {
    $('roomNameInput').addEventListener('keydown', e => {
      if (e.code === 'Enter' && $('btnCreateRoom')) $('btnCreateRoom').click();
      e.stopPropagation();
    });
  }
  if ($('roomPassInput')) {
    $('roomPassInput').addEventListener('keydown', e => {
      if (e.code === 'Enter' && $('btnCreateRoom')) $('btnCreateRoom').click();
      e.stopPropagation();
    });
  }
  if ($('roomGateClose')) $('roomGateClose').onclick = () => closeRoomGate();
  if ($('roomGateOk')) $('roomGateOk').onclick = () => submitRoomGate();
  if ($('roomGateInput')) {
    $('roomGateInput').addEventListener('keydown', e => {
      if (e.code === 'Enter') submitRoomGate();
      e.stopPropagation();
    });
  }
  renderRooms({ cap: roomCap, rooms: roomList });
  if ($('btnOauthLogout')) $('btnOauthLogout').onclick = () => {
    G.audio.init();
    if (isGuest()) exitGuest();
    else logoutOauth();
  };
  $('wardPrev').onclick = () => { if (wardPage > 0) { wardPage--; renderWardrobe(); } };
  $('wardNext').onclick = () => { wardPage++; renderWardrobe(); };
  $('nameInput').addEventListener('keydown', e => { if (e.code === 'Enter') $('btnPlay').click(); e.stopPropagation(); });
  function joinFromSpec() {
    if (isGuest()) {
      if (!guestName) { backToMenu(); $('menuErr').textContent = '请先游客登录'; return; }
      ensureGyroPermissionThen(() => send(joinMsg()));
      return;
    }
    if (!isOauthLoggedIn()) { backToMenu(); highlightNeedOauth('请先登录或使用游客登录'); return; }
    syncSiteName();
    requireAuth(() => {
      ensureGyroPermissionThen(() => send(joinMsg()));
    });
  }

  // ---------- 观战 ----------
  // 在场玩家（存活+暂时死亡都算——跟随一个人他死了也继续跟着看重生，不跳到别人）
  function specList() { return [...ents.values()].filter(e => e.cur); }
  function isFollowing() { return specFollowId != null && ents.has(specFollowId); }
  // 用稳定 id 取跟随目标：目标死亡仍返回（看重生），只有离场才回退 null（自由视角）
  function specTarget() { return specFollowId != null ? (ents.get(specFollowId) || null) : null; }
  function cycleSpec(d) {
    const list = specList();
    if (!list.length) { specFollowId = null; updateSpecBar(); updateTouchLayout(); return; }
    let idx = list.findIndex(e => e.id === specFollowId);
    if (idx < 0) idx = d > 0 ? -1 : 0;                       // 自由态/目标已离场：正向从头、反向从尾
    specFollowId = list[(idx + d + list.length) % list.length].id;
    updateSpecBar();
    updateTouchLayout();
  }
  function setFollow(on) {                                    // F键 / 跟随按钮 共用
    if (on) { const list = specList(); if (list.length) specFollowId = list[0].id; }
    else specFollowId = null;
    updateSpecBar();
    updateTouchLayout();
  }
  function updateSpecBar() {
    if (specFollowId != null && !ents.has(specFollowId)) specFollowId = null;   // 目标离场 → 回自由
    const e = specTarget();
    const following = !!e;
    if (!following) {
      $('specMode').textContent = '自由视角';
      $('specTarget').textContent = ents.size ? (TOUCH ? '点 跟随 或 ◀▶ 选择玩家' : '按 F 跟随玩家') : '暂无玩家在场';
    } else {
      $('specMode').textContent = `跟随视角 · ${specView === 'tp' ? '第三人称' : '第一人称'}`;
      const st = e.cur.al ? `❤️${e.cur.hp}` : '💀 阵亡·等待重生';
      $('specTarget').innerHTML = `<span style="color:${e.color}">${esc(e.name)}</span> · ${st}`;
    }
    // 触屏按钮态
    const fb = $('specFollowBtn');
    fb.textContent = following ? '自由' : '跟随';
    fb.classList.toggle('active', following);
    const noOne = specList().length === 0;
    $('specPrev').disabled = noOne;
    $('specNext').disabled = noOne;
    $('specViewBtn').disabled = !following;                   // 视角切换仅跟随时有意义
  }

  // ---------- 本地战斗 ----------
  function camDir() {
    return V3(0, 0, -1).applyEuler(new T.Euler(me.pitch, me.yaw, 0, 'YXZ'));
  }
  function eyePos() { return V3(me.pos.x, me.pos.y + defs.rules.eyeH, me.pos.z); }
  function effectiveView() { return me.zoom > 0.5 ? 'fp' : settings.view; }

  // 第三人称时准星沿「相机射线」，子弹却从眼睛平行射出 → 准星对上了子弹会偏一截。
  // 先用相机射线求准星落点，再换成眼睛指向该点的方向，保证所见即所射。
  function fireAimDir(origin, maxR) {
    const look = camDir();
    if (effectiveView() !== 'tp') return look;
    const cam = camera.position;
    const { end } = localRayEnd(V3(cam.x, cam.y, cam.z), look.clone(), maxR || 220);
    const aim = end.clone().sub(origin);
    if (aim.lengthSq() < 1e-8) return look;
    return aim.normalize();
  }

  // 跨端公平性：触屏精度天然低于鼠标，给触屏客户端一点"子弹磁吸"辅助瞄准（bullet magnetism）。
  // 只在本地把发送给服务器的开火方向朝最近目标中心柔性纠偏（≤35%），桌面端(TOUCH=false)完全不生效，
  // 服务器侧判定逻辑没有任何变化——不是服务器给触屏玩家开后门，只是客户端替手指的抖动兜个底。
  const AIM_ASSIST_CONE = Math.cos(7 * Math.PI / 180), AIM_ASSIST_RANGE = 55, AIM_ASSIST_BLEND = 0.35;
  function applyAimAssist(dir, origin) {
    if (!TOUCH) return dir;
    let bestDot = AIM_ASSIST_CONE, bestDir = null;
    for (const e of ents.values()) {
      if (!e.cur || !e.cur.al || e.cur.bf.some(b => b[0] === 'invis')) continue;
      if (inSmoke(e.disp.x, e.disp.y + 1.1, e.disp.z)) continue;   // 烟中目标不吸附
      const to = V3(e.disp.x, e.disp.y + 1.1, e.disp.z).sub(origin);
      const dist = to.length();
      if (dist < 0.5 || dist > AIM_ASSIST_RANGE) continue;
      to.normalize();
      const dot = to.dot(dir);
      if (dot > bestDot && !smokeBlocks(origin, to, dist)) { bestDot = dot; bestDir = to; }
    }
    if (bossEnt && bossEnt.cur && defs.bosses && defs.bosses[bossEnt.tp]) {
      const yc = (defs.bosses[bossEnt.tp].yc || 2) + (bossEnt.disp.y || 0);
      const to = V3(bossEnt.disp.x, yc, bossEnt.disp.z).sub(origin);
      const dist = to.length();
      if (dist >= 0.5 && dist <= AIM_ASSIST_RANGE) {
        to.normalize();
        const dot = to.dot(dir);
        if (dot > bestDot && !smokeBlocks(origin, to, dist)) { bestDot = dot; bestDir = to; }
      }
    }
    return bestDir ? dir.clone().lerp(bestDir, AIM_ASSIST_BLEND).normalize() : dir;
  }

  // 返回 {end, wall}：wall=true 表示这发子弹被静态几何挡住了（不是打中玩家/BOSS），
  // 用来在本地预测里立刻补一个墙面命中火花，不用等服务器广播的 shot fx 回来
  function localRayEnd(o, d, maxR) {
    let t = G.world.rayObstacles({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, maxR);
    const wallT = t;
    for (const e of ents.values()) {
      if (!e.cur || !e.cur.al) continue;
      for (const [oy, r] of [[0.95, 0.82], [1.55, 0.48]]) {
        const c = V3(e.disp.x, e.disp.y + oy, e.disp.z);
        const oc = o.clone().sub(c);
        const b = oc.dot(d);
        const disc = b * b - (oc.lengthSq() - r * r);
        if (disc > 0) { const tt = -b - Math.sqrt(disc); if (tt > 0 && tt < t) t = tt; }
      }
    }
    if (bossEnt && defs.bosses && defs.bosses[bossEnt.tp]) {
      const bi = defs.bosses[bossEnt.tp];
      const c = V3(bossEnt.disp.x, (bossEnt.disp.y || 0) + bi.yc, bossEnt.disp.z);
      const oc = o.clone().sub(c);
      const b = oc.dot(d);
      const disc = b * b - (oc.lengthSq() - bi.radius * bi.radius);
      if (disc > 0) { const tt = -b - Math.sqrt(disc); if (tt > 0 && tt < t) t = tt; }
    }
    return { end: o.clone().addScaledVector(d, t), wall: t >= wallT - 0.02 && wallT < maxR - 0.05 };
  }

  function updateLocalChargeBeam() {
    if (!mySnap || !myId) return;
    if (me.chargingUntil > now() && me.active === 'gun' && mySnap.gw === 'charge' && mySnap.al) {
      const def = defs.weapons.charge;
      const o = eyePos();
      const d = camDir();
      const { end } = localRayEnd(o, d, def.range);
      const mp = o.clone().addScaledVector(d, 0.9).addScaledVector(V3(Math.cos(me.yaw), 0, -Math.sin(me.yaw)), 0.14);
      mp.y -= 0.1;
      G.fx.setChargeBeam(myId, [mp.x, mp.y, mp.z], [end.x, end.y, end.z]);
    } else if (me.chargingUntil && me.chargingUntil <= now()) {
      // 等服务端 chargebang；超时则本地收束，避免光束卡死
      if (now() - me.chargingUntil > 400) {
        me.chargingUntil = 0;
        G.fx.clearChargeBeam(myId);
      }
    }
  }

  function combat(dt) {
    if (!mySnap || !mySnap.al || isTyping()) return;
    if (!$('shop').classList.contains('hidden') || !$('pause').classList.contains('hidden')) return;
    const t = now();
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    const wantZoom = rmbDown && me.active === 'gun' && gunHasZoom(mySnap.gw);
    me.zoom += ((wantZoom ? 1 : 0) - me.zoom) * Math.min(1, dt * 10);
    if (!mouseDown) { me.firedOnce = false; return; }
    if (me.active === 'melee') {
      const w = mySnap.mw;
      const cd = defs.weapons[w].cd * (zomb ? 0.5 : 1) * 1000;
      if (t - me.lastMelee >= cd) {
        me.lastMelee = t;
        const d = camDir();
        send({ type: 'melee', d: [d.x, d.y, d.z] });
        G.audio.melee(w);
        cancelInspect();
        vmSwingT = 0;
        if (myModel) myModel.attackT = 0;
      }
    } else if (me.active === 'gun' && mySnap.gw) {
      const def = defs.weapons[mySnap.gw];
      const cost = def.ammoCost || 1;
      if (!def.auto && me.firedOnce) return;
      if (me.reloadUntil > t) return;
      if (me.chargingUntil > t) return;
      if (!me.cheatOn && me.ammoL < cost) { if (!me.firedOnce) { G.audio.dryFire(); tryLocalReload(); me.firedOnce = true; } return; }
      if (t - me.lastShot < def.cd * 1000) return;
      me.lastShot = t; me.firedOnce = true;
      if (!me.cheatOn) me.ammoL -= cost;
      cancelInspect();
      const o = eyePos();
      const aim0 = fireAimDir(o, def.range);
      const mp = o.clone().addScaledVector(aim0, 0.9).addScaledVector(V3(Math.cos(me.yaw), 0, -Math.sin(me.yaw)), 0.14);
      mp.y -= 0.1;

      // 充能步枪：本地立刻进入充能态，服务端权威结算刮伤与崩击
      if (def.charge) {
        let d = applyAimAssist(aim0.clone(), o);
        send({ type: 'fire', o: [o.x, o.y, o.z], d: [d.x, d.y, d.z], rtt: pingMs });
        me.chargingUntil = t + (def.chargeMs || 1000);
        const { end } = localRayEnd(o, d, def.range);
        G.fx.setChargeBeam(myId, [mp.x, mp.y, mp.z], [end.x, end.y, end.z]);
        G.fx.muzzle(mp, 0xff7a1a);
        G.audio.chargeZap();
        vmKick = Math.min(1, vmKick + 0.35);
        me.pitch += 0.006;
        me.spread = Math.min(14, me.spread + 3);
        if (myModel) myModel.attackT = 0;
        if (!me.cheatOn && me.ammoL < cost) tryLocalReload();
        return;
      }

      const pellets = def.pellets || 1;
      const spreadMul = me.zoom > 0.5 ? 0 : def.spread * (me.moving ? 1.6 : 1);
      // 权威方向：准星瞄准方向（不带本地散射），避免「准星压人却因随机散射打空」
      const netD = applyAimAssist(aim0.clone(), o);
      send({ type: 'fire', o: [o.x, o.y, o.z], d: [netD.x, netD.y, netD.z], rtt: pingMs });
      for (let i = 0; i < pellets; i++) {
        let d = aim0.clone();
        d.x += (Math.random() - 0.5) * spreadMul * 2;
        d.y += (Math.random() - 0.5) * spreadMul * 2;
        d.z += (Math.random() - 0.5) * spreadMul * 2;
        d.normalize();
        const { end, wall } = localRayEnd(o, d, def.range);
        if (mySnap.gw === 'railgun') gunShotFx('railgun', [mp.x, mp.y, mp.z], [end.x, end.y, end.z], mp);
        else {
          G.fx.tracer([mp.x, mp.y, mp.z], [end.x, end.y, end.z], pellets > 1 ? '#ffc878' : '#ffe0a0');
          G.fx.muzzle(mp);
        }
        if (wall) G.fx.impactSpark([end.x, end.y, end.z], mySnap.gw === 'railgun' ? '#7df9ff' : '#ffe6a8');
      }
      G.audio.shot(mySnap.gw);
      if (mySnap.gw !== 'railgun') G.fx.dustPuff([mp.x, mp.y, mp.z], pellets > 1 ? 0.75 : 0.5, '#9aa4b0');
      if (mySnap.gw === 'railgun') {
        G.fx.punch(camDir(), 1.65);
        G.fx.shake(0.58);
        vmKick = Math.min(2.5, vmKick + 2.0);
        recoilPitch = Math.min(0.14, recoilPitch + 0.105);
        me.pitch += 0.016;
      } else {
        vmKick = Math.min(1, vmKick + (mySnap.gw === 'sniper' ? 1 : mySnap.gw === 'shotgun' ? 0.65 : 0.4));
        me.pitch += mySnap.gw === 'sniper' ? 0.02 : mySnap.gw === 'shotgun' ? 0.018 : mySnap.gw === 'mg' ? 0.004 : 0.009;
      }
      me.spread = Math.min(14, me.spread + (pellets > 1 ? 8 : 5));
      if (myModel) myModel.attackT = 0;
      if (!me.cheatOn && me.ammoL < cost) { tryLocalReload(); }
    } else if (me.active === 'nade' && mySnap.ng) {
      // 温雷逻辑在 updateNadeInput() 中处理（按住引信、松手投掷）
    }
  }

  function nadeInputBlocked() {
    return isTyping() || !$('shop').classList.contains('hidden') || !$('pause').classList.contains('hidden')
      || !$('lost').classList.contains('hidden');
  }

  function canNadeAction() {
    return mode === 'play' && mySnap && mySnap.al && me.active === 'nade' && mySnap.ng && !nadeInputBlocked();
  }

  function tryNadePrime() {
    if (!canNadeAction() || me.nadeHolding) return;
    const t = now();
    const def = defs.weapons[mySnap.ng];
    const nadeCdMs = (def ? def.cd : 2) * 1000;
    if (me.nadeLeft <= 0) { G.audio.dryFire(); return; }
    if (t - me.lastNade < nadeCdMs) return;
    send({ type: 'nade_prime' });
    me.nadeHolding = true;
    me.nadePrimeSent = true;
    me.lastNade = t;
    me.cookExpireAt = t + (def ? def.fuse : 4) * 1000;
    me.cookLeft = me.cookExpireAt - t;
    G.audio.throwNade();
  }

  function tryNadeThrow() {
    if (!me.nadeHolding && !me.nadePrimeSent) return;
    if (!mySnap || !mySnap.al) { me.nadeHolding = false; me.nadePrimeSent = false; return; }
    const d = camDir();
    const def = defs && mySnap.ng ? defs.weapons[mySnap.ng] : null;
    const fuseMs = (def ? def.fuse : 4) * 1000;
    const cookMs = Math.max(0, Math.min(fuseMs, Math.round(fuseMs - me.cookLeft)));
    send({ type: 'nade_throw', d: [d.x, d.y, d.z], cookMs });
    me.nadeHolding = false;
    me.nadePrimeSent = false;
    me.cookLeft = 0;
    me.cookExpireAt = 0;
    cancelInspect();
    vmThrowT = 0;
    if (myModel) myModel.attackT = 0;
  }

  // 移动输入轴：触屏摇杆优先（模拟量，支持半推半速），否则退回键盘（数字量，斜向已归一化不吃加速）
  // 桌面端行为与改造前逐字节一致：mag 恒为 1，方向归一化——这里只是把同一段逻辑抽成两端共用的函数
  function moveAxes() {
    if (touch.joyId !== null) {
      const L = Math.hypot(touch.joyX, touch.joyZ);
      return L > 1e-4 ? { ix: touch.joyX / L, iz: touch.joyZ / L, mag: Math.min(1, L) } : { ix: 0, iz: 0, mag: 0 };
    }
    let ix = 0, iz = 0;
    if (keys.KeyW) iz += 1; if (keys.KeyS) iz -= 1;
    if (keys.KeyA) ix -= 1; if (keys.KeyD) ix += 1;
    const L = Math.hypot(ix, iz);
    return L > 0 ? { ix: ix / L, iz: iz / L, mag: 1 } : { ix: 0, iz: 0, mag: 0 };
  }

  // Quake PM_Accelerate：沿 wishdir 补齐至多 wishSpeed 的投影速度
  function accelerate(vx, vz, wishX, wishZ, wishSpeed, accel, dt) {
    const current = vx * wishX + vz * wishZ;
    const add = wishSpeed - current;
    if (add <= 0) return [vx, vz];
    const acc = Math.min(add, accel * wishSpeed * dt);
    return [vx + acc * wishX, vz + acc * wishZ];
  }
  function applyFriction(vx, vz, friction, stopSpeed, dt) {
    const speed = Math.hypot(vx, vz);
    if (speed < 0.05) return [0, 0];
    const control = speed < stopSpeed ? stopSpeed : speed;
    const drop = control * friction * dt;
    const ns = Math.max(0, speed - drop);
    if (ns < 0.05) return [0, 0];
    const s = ns / speed;
    return [vx * s, vz * s];
  }

  // ---------- 本地移动 ----------
  function movement(dt) {
    if (!mySnap || !mySnap.al) { me.vx = me.vz = 0; return; }
    if (!$('pause').classList.contains('hidden')) { me.moving = false; me.vx = me.vz = 0; return; }
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    const hasSpeed = mySnap.bf.some(b => b[0] === 'speed');
    const hasJump = mySnap.bf.some(b => b[0] === 'jump');
    const R = defs.rules;
    let spd = R.baseSpeed * (me.cheatOn ? 3 : 1) * (1 + 0.1 * mySnap.bo) * (hasSpeed ? 1.6 : 1) * (zomb ? 1.35 : 1) * (me.zoom > 0.5 ? 0.55 : 1);
    const { ix, iz, mag } = moveAxes();
    const wantJump = !!(keys.Space && me.grounded);
    const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
    const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
    let wishX = fx * iz + rx * ix;
    let wishZ = fz * iz + rz * ix;
    const wishLen = Math.hypot(wishX, wishZ);
    let wishSpeed = 0;
    if (wishLen > 1e-6 && mag > 0.05) {
      wishX /= wishLen; wishZ /= wishLen;
      wishSpeed = spd * mag;
    } else {
      wishX = 0; wishZ = 0;
    }
    // 连跳：落地当帧按住空格则跳过摩擦，走空中加速以保留动量
    if (me.grounded && !wantJump) {
      [me.vx, me.vz] = applyFriction(me.vx, me.vz, R.friction, R.stopSpeed, dt);
      if (wishSpeed > 0) [me.vx, me.vz] = accelerate(me.vx, me.vz, wishX, wishZ, wishSpeed, R.groundAccel, dt);
    } else if (wishSpeed > 0) {
      // 裁剪 wish 的 accelerate：用于侧向蹭速（投影已超过 clip 时加不动）
      const airWish = Math.min(wishSpeed, R.airWishClip || 3.5);
      [me.vx, me.vz] = accelerate(me.vx, me.vz, wishX, wishZ, airWish, R.airAccel || 2.5, dt);
      // 空中转向：把水平速度朝 wishdir 扳（保速），否则 AD 几乎感觉不到变向
      const spd0 = Math.hypot(me.vx, me.vz);
      if (spd0 > 0.15) {
        const k = Math.min(1, (R.airControl || 6) * dt);
        me.vx += (wishX * spd0 - me.vx) * k;
        me.vz += (wishZ * spd0 - me.vz) * k;
        const spd1 = Math.hypot(me.vx, me.vz);
        if (spd1 > 1e-6) { const s = spd0 / spd1; me.vx *= s; me.vz *= s; }
      }
    }
    const maxSpd = spd * (R.bhopSpeedMul || 1.8);
    const hSpd = Math.hypot(me.vx, me.vz);
    if (hSpd > maxSpd && hSpd > 1e-6) {
      const s = maxSpd / hSpd;
      me.vx *= s; me.vz *= s;
    }
    const ox = me.pos.x, oz = me.pos.z;
    const dx = me.vx * dt, dz = me.vz * dt;
    if (Math.abs(dx) > 1e-8 || Math.abs(dz) > 1e-8) G.world.moveStep(me.pos, dx, dz);
    // 撞墙清对应轴速度，避免贴墙粘滞加速
    if (Math.abs((me.pos.x - ox) - dx) > 1e-5) me.vx = 0;
    if (Math.abs((me.pos.z - oz) - dz) > 1e-5) me.vz = 0;
    me.moving = mag > 0.05 || Math.hypot(me.vx, me.vz) > 0.4;
    const floor = G.world.floorAt(me.pos);
    if (wantJump) {
      me.vy = R.jumpVel * (hasJump ? 1.5 : 1);
      me.grounded = false;
    }
    me.vy -= R.gravity * dt;
    me.pos.y += me.vy * dt;
    if (me.pos.y <= floor) {
      // 落地反馈
      if (!me.grounded && me.fallV < -9) {
        G.audio.land();
        G.fx.dustPuff([me.pos.x, floor + 0.1, me.pos.z], 1.4, '#8a8f9a');
        vmKick = Math.min(1, vmKick + 0.5);
        G.fx.shake(0.12);
      }
      me.pos.y = floor; me.vy = 0; me.grounded = true;
    }
    else me.grounded = false;
    me.fallV = me.vy;
    if (me.moving && me.grounded) {
      me.stepT += dt;
      if (me.stepT > (hasSpeed || zomb ? 0.24 : 0.34)) {
        me.stepT = 0;
        G.audio.step();
        G.fx.dustPuff([me.pos.x, me.pos.y + 0.06, me.pos.z], 0.5, '#77808f');
      }
    }
    // 自动拾取
    const t = now();
    for (let i = 0; i < pickupMeshes.length; i++) {
      const pm = pickupMeshes[i];
      if (!pm.item || t - pm.lastTry < 500) continue;
      if (Math.hypot(pm.pt.x - me.pos.x, pm.pt.z - me.pos.z) < 2.3 && Math.abs(me.pos.y - (pm.pt.y || 0)) < 2) {
        pm.lastTry = t;
        send({ type: 'pickup', id: i });
      }
    }
    const md = nearestMerchantDist();
    $('interactHint').classList.toggle('hidden', !(md < defs.rules.merchantDist && $('shop').classList.contains('hidden')));
  }

  let moveSendT = 0;
  function netSync(dt) {
    moveSendT += dt;
    if (mode === 'play' && mySnap && mySnap.al && moveSendT > 0.066) {
      moveSendT = 0;
      send({ type: 'move', p: [me.pos.x, me.pos.y, me.pos.z], ya: me.yaw, pi: me.pitch, an: me.moving ? 1 : 0 });
    }
    if (now() - lastPingAt > 1000 && wsOk) {
      lastPingAt = now();
      send({ type: 'ping', t: lastPingAt, rtt: pingMs });
    }
  }

  // ---------- 远程实体渲染 ----------
  // 受击后仰位移：在网络同步位置之上叠加一个快速衰减的偏移，装饰性的，不进 e.disp 所以不会累积误差
  const FLINCH_DUR = 220;
  function flinchOffset(flinchAt) {
    if (!flinchAt) return 0;
    const k = 1 - (now() - flinchAt) / FLINCH_DUR;
    return k > 0 ? k * k : 0;
  }
  function renderEnts(dt) {
    const k = 1 - Math.exp(-dt * 14);
    const specFpTarget = mode === 'spec' && specView === 'fp' ? specTarget() : null;
    for (const e of ents.values()) {
      const s = e.cur;
      if (!s) continue;
      e.disp.x += (s.p[0] - e.disp.x) * k;
      e.disp.y += (s.p[1] - e.disp.y) * k;
      e.disp.z += (s.p[2] - e.disp.z) * k;
      let dy = s.ya - e.disp.ya;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.disp.ya += dy * k;
      if (e.disp.pi === undefined) e.disp.pi = s.pi;
      e.disp.pi += (s.pi - e.disp.pi) * k;   // pitch 也插值：观战第一人称需要俯仰跟手，之前漏维护导致视角割裂
      const m = e.model;
      m.group.position.set(e.disp.x, e.disp.y, e.disp.z);
      m.group.rotation.y = e.disp.ya;
      const fk = flinchOffset(e.flinchAt);
      if (fk > 0) {
        m.group.position.x += e.flinchDir.x * fk * 0.22;
        m.group.position.z += e.flinchDir.z * fk * 0.22;
        m.group.position.y += Math.sin(fk * Math.PI) * 0.05;
      } else e.flinchAt = 0;
      const hideForSpecFp = specFpTarget && specFpTarget.id === e.id;
      m.group.visible = !!s.al && !hideForSpecFp;
      if (!s.al) continue;
      const zomb = s.bf.some(b => b[0] === 'zombie');
      G.models.tintZombie(m, zomb);
      const heldWeapon = zomb ? null : (s.ac === 'gun' ? s.gw : s.ac === 'nade' ? (s.ng || 'nade') : s.mw);
      G.models.setPlayerWeapon(m, heldWeapon);
      G.models.animatePlayer(m, dt, !!s.an, s.ac, 1);
      G.models.applyCosmetics(m, s.eq);
      G.models.animateCosmetics(m, perfNow / 1000);
      G.models.applyWeaponFx(m, s.eq.fx || null, perfNow / 1000);
      const invis = s.bf.some(b => b[0] === 'invis');
      G.models.setOpacity(m, invis ? 0.12 : 1);
      if (s.pr) m.group.rotation.y += Math.sin(perfNow / 90) * 0.02;
      if (e.lastHp !== s.hp) { e.lastHp = s.hp; m.plate.userData.set(s.hp, 100); }
      m.plate.visible = !hideForSpecFp && !invis && !inSmoke(e.disp.x, e.disp.y + 1.2, e.disp.z);   // 烟雾里不透视名牌
    }
    // BOSS
    if (bossEnt && bossEnt.cur) {
      const b = bossEnt.cur;
      bossEnt.disp.x += (b.p[0] - bossEnt.disp.x) * k;
      bossEnt.disp.y += ((b.p[1] || 0) - (bossEnt.disp.y || 0)) * k;
      bossEnt.disp.z += (b.p[2] - bossEnt.disp.z) * k;
      let dy = b.ya - bossEnt.disp.ya;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      bossEnt.disp.ya += dy * k;
      const moving = Math.hypot(b.p[0] - bossEnt.disp.x, b.p[2] - bossEnt.disp.z) > 0.12;
      bossEnt.model.group.position.set(bossEnt.disp.x, bossEnt.disp.y || 0, bossEnt.disp.z);
      bossEnt.model.group.rotation.y = bossEnt.disp.ya;
      bossEnt.model.update(dt, moving);
      bossEnt.model.plate.userData.set(b.hp, b.mx);
      const bfk = flinchOffset(bossEnt.flinchAt) * 0.6;   // BOSS 个头太大，位移不明显，改用挤压表现挨打
      if (bfk > 0) {
        bossEnt.model.group.scale.set(1 - bfk * 0.05, 1 + bfk * 0.09, 1 - bfk * 0.05);
        // 名牌是 group 的子节点，反向抵消一下父级挤压，免得血条文字跟着变形
        bossEnt.model.plate.scale.set(3.2 / (1 - bfk * 0.05), 0.8 / (1 + bfk * 0.09), 1);
      } else {
        bossEnt.model.group.scale.set(1, 1, 1);
        bossEnt.model.plate.scale.set(3.2, 0.8, 1);
        bossEnt.flinchAt = 0;
      }
    }
    for (const e of handEnts.values()) {
      if (!e.target) continue;
      e.disp.x += (e.target.x - e.disp.x) * k;
      e.disp.y += (e.target.y - e.disp.y) * k;
      e.disp.z += (e.target.z - e.disp.z) * k;
      let dy = e.target.ya - e.disp.ya;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.disp.ya += dy * k;
      e.model.group.position.set(e.disp.x, e.disp.y, e.disp.z);
      e.model.group.rotation.y = e.disp.ya;
      e.model.group.rotation.x = Math.sin(perfNow / 120 + e.id) * 0.25;
      // 虚空裂缝钉在背后角点；触须从裂缝连到掌心
      if (bossEnt && bossEnt.tp === 'amiya') {
        const ac = (defs.bosses && defs.bosses.amiya) || {};
        const yaw = bossEnt.disp.ya || 0;
        const bx = Math.sin(yaw), bz = Math.cos(yaw);
        const lx = -Math.cos(yaw), lz = Math.sin(yaw);
        const backOff = ac.handAnchorBack != null ? ac.handAnchorBack : (ac.radius || 1) * 1.35 + 0.55;
        const sideOff = ac.handAnchorSide != null ? ac.handAnchorSide : (ac.radius || 1) * 1.3 + 0.5;
        const elevOff = ac.handAnchorElev != null ? ac.handAnchorElev : (ac.yc || 1.5) * 0.85;
        const midY = (bossEnt.disp.y || 0) + (ac.handAnchorMidY != null ? ac.handAnchorMidY : (ac.yc || 1.5) * 1.1);
        const side = e.anchorSide == null ? 1 : e.anchorSide;
        const elev = e.anchorElev == null ? 1 : e.anchorElev;
        const ox = bossEnt.disp.x + bx * backOff + lx * side * sideOff;
        const oy = midY + elev * elevOff;
        const oz = bossEnt.disp.z + bz * backOff + lz * side * sideOff;
        if (e.rift) {
          const pulse = 1.05 + Math.sin(perfNow / 100 + e.id) * 0.1;
          e.rift.group.visible = true;
          e.rift.group.position.set(ox, oy, oz);
          e.rift.group.rotation.y = yaw;
          e.rift.group.rotation.z = side * 0.2;
          e.rift.group.rotation.x = elev * 0.14;
          e.rift.group.scale.setScalar(pulse);
          if (e.rift.glowM) e.rift.glowM.opacity = 0.65 + Math.sin(perfNow / 65 + e.id) * 0.22;
          if (e.rift.inkM) e.rift.inkM.opacity = 0.4 + Math.sin(perfNow / 50 + e.id) * 0.18;
        }
        if (e.tether) {
          const hx = e.disp.x, hy = e.disp.y, hz = e.disp.z;
          const dx = hx - ox, dyb = hy - oy, dz = hz - oz;
          const len = Math.hypot(dx, dyb, dz) || 0.01;
          e.tether.mesh.visible = true;
          e.tether.mesh.position.set((ox + hx) * 0.5, (oy + hy) * 0.5, (oz + hz) * 0.5);
          e.tether.mesh.scale.set(1, len, 1);
          e.tether.mesh.quaternion.setFromUnitVectors(
            V3(0, 1, 0),
            V3(dx / len, dyb / len, dz / len)
          );
          e.tether.mat.opacity = 0.28 + Math.sin(perfNow / 90 + e.id) * 0.08;
        }
      } else {
        if (e.tether) e.tether.mesh.visible = false;
        if (e.rift) e.rift.group.visible = false;
      }
    }
    if (shadowMesh && shadowMesh.g.visible) shadowMesh.g.rotation.y += dt * 0.8;
    if (ckptMesh && ckptMesh.visible) ckptMesh.rotation.y += dt * 1.4;
    // 拾取物漂浮 + 光环脉动
    for (const pm of pickupMeshes) {
      if (!pm.mesh) continue;
      pm.mesh.rotation.y += dt * 1.2;
      pm.mesh.position.y = (pm.pt.y || 0) + Math.sin(perfNow / 600 + pm.pt.id) * 0.12;
      const ring = pm.mesh.children[pm.mesh.children.length - 1];
      if (ring) ring.scale.setScalar(1 + Math.sin(perfNow / 300 + pm.pt.id) * 0.1);
    }
    for (let i = 0; i < merchants.length; i++) {
      const gem = merchants[i].userData && merchants[i].userData.gem;
      if (gem) gem.rotation.y += dt * 2;
    }
  }

  // 第三人称下渲染自己的角色
  function renderSelf(dt) {
    const show = mode === 'play' && mySnap && mySnap.al && effectiveView() === 'tp';
    if (!show) { if (myModel) myModel.group.visible = false; return; }
    if (!myModel) {
      myModel = G.models.makePlayer(mySnap.c, myName);
      myModel.plate.visible = false;
      scene.add(myModel.group);
    }
    myModel.group.visible = true;
    myModel.group.position.copy(me.pos);
    myModel.group.rotation.y = me.yaw;
    const mfk = flinchOffset(myModel.flinchAt);
    if (mfk > 0) {
      myModel.group.position.x += myModel.flinchDir.x * mfk * 0.22;
      myModel.group.position.z += myModel.flinchDir.z * mfk * 0.22;
      myModel.group.position.y += Math.sin(mfk * Math.PI) * 0.05;
    } else myModel.flinchAt = 0;
    const zomb = mySnap.bf.some(b => b[0] === 'zombie');
    G.models.tintZombie(myModel, zomb);
    const held = zomb ? null : (me.active === 'gun' ? mySnap.gw : me.active === 'nade' ? (mySnap.ng || 'nade') : mySnap.mw);
    G.models.setPlayerWeapon(myModel, held);
    G.models.animatePlayer(myModel, dt, me.moving, me.active, 1);
    G.models.applyCosmetics(myModel, mySnap.eq);
    G.models.animateCosmetics(myModel, perfNow / 1000);
    G.models.applyWeaponFx(myModel, mySnap.eq.fx || null, perfNow / 1000);
    const invis = mySnap.bf.some(b => b[0] === 'invis');
    G.models.setOpacity(myModel, invis ? 0.35 : 1);
    myModel.plate.visible = false;
  }

  // ---------- 视角模型动画 ----------
  function renderViewModel(dt) {
    if (!vm) return;
    const inPlay = mode === 'play' && mySnap && mySnap.al;
    const specEnt = mode === 'spec' && specView === 'fp' ? specTarget() : null;
    const inSpecFp = !!(specEnt && specEnt.cur && specEnt.cur.al);
    vm.group.visible = (inPlay && me.zoom < 0.5 && effectiveView() === 'fp') || inSpecFp;

    if (inPlay) {
      const zomb = mySnap.bf.some(b => b[0] === 'zombie');
      const held = me.active === 'gun' ? mySnap.gw : me.active === 'nade' ? (mySnap.ng || 'nade') : mySnap.mw;
      G.models.setViewWeapon(vm, held, zomb && me.active === 'melee');
      G.models.applyWeaponFx({ weaponMesh: vm.weaponMesh }, mySnap.eq.fx || null, perfNow / 1000);
      vmSwingT += dt; vmThrowT += dt; vmInspectT += dt;
      // 开镜 / 换弹时打断检视
      if (me.zoom >= 0.5 || me.reloadUntil > now()) cancelInspect();
      // 重踢先慢收、后半段加快，枪口抬高后明显回落到准心
      const kickDecay = vmKick > 1.1 ? 4.2 : 6.5;
      vmKick = Math.max(0, vmKick - dt * kickDecay);
      recoilPitch *= Math.exp(-dt * 11);
      if (recoilPitch < 0.0004) recoilPitch = 0;
      me.swayX *= Math.exp(-dt * 8);
      me.swayY *= Math.exp(-dt * 8);
      const bob = me.moving && me.grounded ? Math.sin(perfNow / 90) * 0.014 : Math.sin(perfNow / 700) * 0.004;
      const inspecting = vmInspectT < INSPECT_DUR;
      let insp = null;
      if (inspecting) {
        const t = Math.max(0, Math.min(1, vmInspectT / INSPECT_DUR));
        const easeIn = Math.min(1, t / 0.12);
        const easeOut = t > 0.82 ? Math.max(0, 1 - (t - 0.82) / 0.18) : 1;
        const amp = easeIn * easeOut;
        const mid = Math.max(0, Math.min(1, (t - 0.08) / 0.72));
        insp = {
          amp,
          mid,
          posX: 0.11 * amp,
          posY: 0.07 * amp,
          posZ: -0.05 * amp,
          gRotX: -0.12 * amp,
          gRotY: 0.42 * amp,
          gRotZ: -0.1 * amp,
          armX: -0.5 * amp,
          armY: 0.55 * amp,
          armZ: -0.22 * amp,
          wX: Math.sin(mid * Math.PI * 2) * 0.5 * amp,
          wY: mid * Math.PI * 2.1 * amp,
          wZ: Math.sin(mid * Math.PI) * 0.65 * amp,
        };
      }
      vm.group.position.set(
        0.02 - me.swayX * 0.4 + (insp ? insp.posX : 0),
        -0.02 + bob - me.swayY * 0.3 + (insp ? insp.posY : 0),
        vmKick * 0.08 + (insp ? insp.posZ : 0)
      );
      vm.group.rotation.set(
        vmKick * 0.2 - me.swayY * 0.6 + (insp ? insp.gRotX : 0),
        -me.swayX * 0.8 + (insp ? insp.gRotY : 0),
        insp ? insp.gRotZ : 0
      );
      const cooking = me.cookLeft > 0;
      if (cooking) {
        const pulse = 0.06 * Math.sin(perfNow / 80);
        vm.armR.rotation.x = -1.05 + pulse;
        vm.armR.rotation.y = 0;
        vm.armR.rotation.z = 0.08;
      } else if (vmSwingT < 0.28) {
        const kk = vmSwingT / 0.28;
        vm.armR.rotation.x = -1.6 * Math.sin(kk * Math.PI);
        vm.armR.rotation.y = 0;
        vm.armR.rotation.z = -0.5 * Math.sin(kk * Math.PI);
      } else if (vmThrowT < 0.3) {
        const kk = vmThrowT / 0.3;
        vm.armR.rotation.x = -1.2 * Math.sin(kk * Math.PI);
        vm.armR.rotation.y = 0;
        vm.armR.rotation.z = 0;
      } else if (insp) {
        vm.armR.rotation.x = insp.armX;
        vm.armR.rotation.y = insp.armY;
        vm.armR.rotation.z = insp.armZ;
      } else {
        vm.armR.rotation.x = 0; vm.armR.rotation.y = 0; vm.armR.rotation.z = 0;
      }
      if (vm.weaponMesh) {
        if (me.reloadUntil > now()) {
          const rem = (me.reloadUntil - now()) / me.reloadDur;
          vm.weaponMesh.rotation.set(Math.sin(rem * Math.PI) * 0.9, 0, 0);
        } else if (insp) {
          vm.weaponMesh.rotation.set(insp.wX, insp.wY, insp.wZ);
        } else {
          vm.weaponMesh.rotation.set(0, 0, 0);
        }
      }
      return;
    }

    if (!inSpecFp) return;
    const s = specEnt.cur;
    const zomb = s.bf.some(b => b[0] === 'zombie');
    const held = s.ac === 'gun' ? s.gw : s.ac === 'nade' ? (s.ng || 'nade') : s.mw;
    G.models.setViewWeapon(vm, held, zomb && s.ac === 'melee');
    G.models.applyWeaponFx({ weaponMesh: vm.weaponMesh }, s.eq.fx || null, perfNow / 1000);
    const attackT = specEnt.model.attackT;
    const attackDur = specEnt.model.attackDur || 0.3;
    const attackK = attackT < attackDur ? 1 - attackT / attackDur : 0;
    const bob = s.an ? Math.sin(perfNow / 90) * 0.014 : Math.sin(perfNow / 700) * 0.004;
    const gunKick = s.ac === 'gun' ? attackK : 0;
    vm.group.position.set(0.02, -0.02 + bob, gunKick * 0.055);
    vm.group.rotation.set(gunKick * 0.11, 0, 0);
    if (s.ac === 'melee' && attackK > 0) {
      const kk = 1 - attackK;
      vm.armR.rotation.x = -1.6 * Math.sin(kk * Math.PI);
      vm.armR.rotation.z = -0.5 * Math.sin(kk * Math.PI);
    } else if (s.ac === 'nade' && attackK > 0) {
      const kk = 1 - attackK;
      vm.armR.rotation.x = -1.2 * Math.sin(kk * Math.PI);
      vm.armR.rotation.z = 0;
    } else {
      vm.armR.rotation.x = 0; vm.armR.rotation.z = 0;
    }
    if (s.rl > 0 && s.gw && vm.weaponMesh) {
      const def = defs.weapons[s.gw];
      const dur = def ? def.reload * 1000 : 1000;
      const rem = Math.max(0, Math.min(1, s.rl / dur));
      vm.weaponMesh.rotation.x = Math.sin(rem * Math.PI) * 0.9;
    } else if (vm.weaponMesh) vm.weaponMesh.rotation.x = 0;
  }

  // ---------- HUD 每帧 ----------
  function hudFrame() {
    if (TOUCH) {
      const showScope = mode === 'play' && mySnap && mySnap.al && gunHasZoom(mySnap.gw) && me.active === 'gun';
      $('tScope').classList.toggle('hidden', !showScope && !touchEditMode);
      if (!showScope && rmbDown) rmbDown = false;          // 切走狙击枪自动收镜
      $('tScope').classList.toggle('on', showScope && rmbDown);
      const leftFire = $('tFireLeft');
      if (leftFire) {
        const ads = showScope && rmbDown;
        const showLeft = touchEditMode || ads;
        if (!showLeft && fireTouch.left) releaseFireTouch('left');
        leftFire.classList.toggle('hidden', !showLeft);
        leftFire.classList.toggle('on', !!(ads && fireTouch.left));
      }
      const canReload = mode === 'play' && mySnap && mySnap.al && me.active === 'gun' && mySnap.gw
        && defs && defs.weapons[mySnap.gw] && !defs.weapons[mySnap.gw].noReload;
      $('tReload').classList.toggle('hidden', !canReload);
      $('tReload').classList.toggle('on', !!(canReload && me.reloadUntil > now()));
      if ($('tInspect')) {
        const canInspect = mode === 'play' && mySnap && mySnap.al && effectiveView() === 'fp' && me.zoom < 0.5;
        $('tInspect').classList.toggle('hidden', !canInspect);
        $('tInspect').classList.toggle('on', !!(canInspect && vmInspectT < INSPECT_DUR));
      }
    }
    // 闪光弹白屏：前 18% 时长保持全白（完全看不见），之后随时间淡出
    const blindRemain = blindUntil - now();
    if (mode === 'play' && blindRemain > 0) {
      const k = blindRemain / blindTotal, hold = 0.18;
      const op = k > (1 - hold) ? 1 : Math.max(0, k) / (1 - hold);
      $('flashWhite').style.opacity = Math.pow(Math.max(0, Math.min(1, op)), 0.7);
    } else {
      $('flashWhite').style.opacity = 0;
    }
    if (mode !== 'play' || !mySnap) return;
    me.spread = Math.max(0, me.spread - 0.6);
    const sp = me.spread + (me.moving ? 4 : 0);
    $('crosshair').style.setProperty('--sp', sp + 'px');
    $('crosshair').style.display = (mySnap.al && me.zoom < 0.5 && $('shop').classList.contains('hidden')) ? '' : 'none';
    $('scope').classList.toggle('hidden', me.zoom < 0.5);
    const rl = me.reloadUntil - now();
    const rb = $('reloadBar');
    if (rl > 0 && mySnap.gw) {
      rb.classList.remove('hidden');
      $('reloadFill').style.width = (100 - rl / me.reloadDur * 100) + '%';
    } else rb.classList.add('hidden');
    const cb = $('cookRing');
    if (me.cookLeft > 0 && me.active === 'nade' && mySnap.ng && me.zoom < 0.5) {
      const fuseMs = (defs.weapons[mySnap.ng] ? defs.weapons[mySnap.ng].fuse : 4) * 1000;
      const pct = Math.max(0, Math.min(1, me.cookLeft / fuseMs));
      const sec = (me.cookLeft / 1000).toFixed(1);
      cb.classList.remove('hidden');
      cb.classList.toggle('urgent', me.cookLeft < fuseMs * 0.25);
      $('cookRingFg').style.strokeDashoffset = String(COOK_RING_LEN * (1 - pct));
      $('cookRingText').textContent = sec;
    } else {
      cb.classList.add('hidden');
      cb.classList.remove('urgent');
    }
    if (!mySnap.al) {
      $('deathCount').textContent = mySnap.dd > 0 ? `${(mySnap.dd / 1000).toFixed(1)}s 后重生` : '即将重生…';
    }
    if (me.active === 'nade') updateHud();
    // 低血量心跳
    if (mySnap.al && mySnap.hp <= 25 && perfNow - lastBeatAt > 950) {
      lastBeatAt = perfNow;
      G.audio.heartbeat();
    }
  }

  // ---------- 菜单背景：本地演示，不接收对局快照 ----------
  const MENU_GUNS = ['pistol', 'mg', 'shotgun', 'sniper', 'sword', 'railgun'];
  const MENU_COLORS = ['#ff6b6b', '#4dabf7', '#69db7c', '#ffd43b', '#da77f2', '#63e6e2'];
  const MENU_PICKS = {
    wep: ['pistol', 'shotgun', 'mg', 'sniper', 'sword', 'nade', 'flash', 'smoke'],
    equip: ['health', 'armor', 'boots'],
    buff: ['speed', 'rage', 'invis', 'jump', 'shield'],
  };
  let menuBots = [];
  let menuDemoOn = false;
  let menuDayAt = 0;

  function clearLiveActors() {
    for (const e of ents.values()) scene.remove(e.model.group);
    ents.clear();
    if (bossEnt) { scene.remove(bossEnt.model.group); bossEnt = null; }
    const bossBar = $('bossBar');
    if (bossBar) bossBar.classList.add('hidden');
    const bossTimer = $('bossTimer');
    if (bossTimer) bossTimer.classList.add('hidden');
    for (const e of handEnts.values()) {
      scene.remove(e.model.group);
      if (e.tether) scene.remove(e.tether.mesh);
      if (e.rift) scene.remove(e.rift.group);
    }
    handEnts.clear();
    if (ckptMesh) ckptMesh.visible = false;
    if (shadowMesh) shadowMesh.g.visible = false;
    for (const e of projMeshes) scene.remove(e.g);
    projMeshes.length = 0;
    for (const e of nadeMeshes) scene.remove(e.g);
    nadeMeshes.length = 0;
    activeSmokes.length = 0;
    G.audio.setIntensity(0);
  }
  function fillDemoPickups() {
    const pts = defs.map.pickups || [];
    for (let i = 0; i < pickupMeshes.length; i++) {
      const pm = pickupMeshes[i];
      const cat = (pts[i] && pts[i].cat) || 'wep';
      const pool = MENU_PICKS[cat] || MENU_PICKS.wep;
      const item = pool[i % pool.length];
      if (!defs.weapons[item] && !defs.equips[item] && !defs.buffs[item]) continue;
      if (pm.item === item && pm.mesh) continue;
      if (pm.mesh) { scene.remove(pm.mesh); pm.mesh = null; }
      pm.item = item;
      pm.mesh = G.models.makePickup(item, defs);
      pm.mesh.position.set(pm.pt.x, pm.pt.y || 0, pm.pt.z);
      scene.add(pm.mesh);
    }
  }
  function startMenuDemo() {
    if (!worldBuilt || !defs || mode !== 'menu' || menuDemoOn) return;
    clearLiveActors();
    const phase = dayAt ? ((dayBase + (performance.now() - dayAt) / dayMs) % 1) : 0.38;
    menuDayAt = performance.now() - phase * dayMs;
    const spawns = (defs.map.spawns && defs.map.spawns.length) ? defs.map.spawns : [[0, 24], [24, 0], [-24, 0], [0, -24]];
    const count = Math.min(TOUCH ? 4 : 6, spawns.length);
    for (let i = 0; i < count; i++) {
      const sp = spawns[(i * 2) % spawns.length];
      const gun = MENU_GUNS[i % MENU_GUNS.length];
      const model = G.models.makePlayer(MENU_COLORS[i % MENU_COLORS.length], '');
      model.plate.visible = false;
      G.models.setPlayerWeapon(model, gun);
      scene.add(model.group);
      const bot = {
        model, gun,
        pos: { x: sp[0], y: 0, z: sp[1] },
        yaw: Math.random() * Math.PI * 2,
        tx: sp[0], tz: sp[1],
        think: 0.3 + Math.random() * 1.2,
        shot: 0.6 + Math.random() * 1.8,
        stuck: 0,
        moving: false,
      };
      bot.pos.y = G.world.floorAt(bot.pos);
      model.group.position.set(bot.pos.x, bot.pos.y, bot.pos.z);
      model.group.rotation.y = bot.yaw;
      menuBots.push(bot);
    }
    fillDemoPickups();
    if (defs.map.barrels) G.world.setBarrels(defs.map.barrels.map(() => 1));
    menuDemoOn = true;
  }
  function stopMenuDemo() {
    if (!menuDemoOn && !menuBots.length) return;
    if (menuDemoOn && menuDayAt) {
      dayBase = ((performance.now() - menuDayAt) / dayMs) % 1;
      dayAt = performance.now();
    }
    menuDemoOn = false;
    for (const b of menuBots) scene.remove(b.model.group);
    menuBots = [];
  }
  function nearestDemoFoe(b) {
    let best = null, bestD = 46;
    for (const o of menuBots) {
      if (o === b) continue;
      const d = Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z);
      if (d < bestD) { best = o; bestD = d; }
    }
    return best;
  }
  function tickMenuDemo(dt) {
    if (!menuDemoOn) return;
    const speed = (defs.rules && defs.rules.baseSpeed) || 6.2;
    const eyeH = (defs.rules && defs.rules.eyeH) || 1.55;
    const spawns = defs.map.spawns || [];
    for (const b of menuBots) {
      b.think -= dt;
      if (b.think <= 0 && spawns.length) {
        const sp = spawns[Math.floor(Math.random() * spawns.length)];
        b.tx = sp[0] + (Math.random() - 0.5) * 5;
        b.tz = sp[1] + (Math.random() - 0.5) * 5;
        b.think = 3.2 + Math.random() * 4.5;
        b.stuck = 0;
      }
      const dx = b.tx - b.pos.x, dz = b.tz - b.pos.z;
      const dist = Math.hypot(dx, dz);
      b.moving = dist > 0.85;
      if (b.moving) {
        const ox = b.pos.x, oz = b.pos.z;
        const step = speed * dt;
        G.world.moveStep(b.pos, dx / dist * step, dz / dist * step);
        if (Math.hypot(b.pos.x - ox, b.pos.z - oz) < step * 0.22) {
          b.stuck += dt;
          if (b.stuck > 0.7) b.think = 0;
        } else b.stuck = 0;
        b.yaw = Math.atan2(-dx, -dz);
      }
      b.pos.y = G.world.floorAt(b.pos);
      const slot = (defs.weapons[b.gun] && defs.weapons[b.gun].slot) || 'gun';
      b.shot -= dt;
      if (b.shot <= 0) {
        const foe = nearestDemoFoe(b);
        if (foe) {
          const eye = { x: b.pos.x, y: b.pos.y + eyeH, z: b.pos.z };
          const aim = { x: foe.pos.x, y: foe.pos.y + 1.15, z: foe.pos.z };
          const dir = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z };
          const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
          dir.x /= len; dir.y /= len; dir.z /= len;
          if (slot === 'melee') {
            if (len < 3.3) {
              b.yaw = Math.atan2(-dir.x, -dir.z);
              b.model.attackT = 0;
              b.shot = 0.75;
            } else b.shot = 0.35;
          } else {
            b.yaw = Math.atan2(-dir.x, -dir.z);
            const hitT = G.world.rayObstacles(eye, dir, len + 0.2);
            const endDist = Math.max(0.5, Math.min(len, hitT - 0.12));
            const origin = [eye.x + dir.x * 0.55, eye.y - 0.12, eye.z + dir.z * 0.55];
            const end = [eye.x + dir.x * endDist, eye.y + dir.y * endDist, eye.z + dir.z * endDist];
            if (b.gun === 'railgun') {
              G.fx.railBeam(origin, end);
              G.fx.muzzle(V3(origin[0], origin[1], origin[2]), 0x7df9ff);
              b.shot = 1.7 + Math.random() * 0.6;
            } else if (b.gun === 'shotgun') {
              for (let p = 0; p < 4; p++) {
                const s = 0.07 * len;
                G.fx.tracer(origin, [end[0] + (Math.random() - 0.5) * s, end[1] + (Math.random() - 0.5) * s * 0.45, end[2] + (Math.random() - 0.5) * s], '#ffc878');
              }
              G.fx.muzzle(V3(origin[0], origin[1], origin[2]));
              b.shot = 1.05 + Math.random() * 0.35;
            } else {
              G.fx.tracer(origin, end, '#ffe0a0');
              G.fx.muzzle(V3(origin[0], origin[1], origin[2]));
              b.shot = b.gun === 'mg' ? 0.2 : (b.gun === 'sniper' ? 1.45 : 0.48);
            }
            G.fx.impactSpark(end, b.gun === 'railgun' ? '#7df9ff' : '#ffe6a8');
            b.model.attackT = 0;
          }
        } else b.shot = 0.4;
      }
      b.model.group.position.set(b.pos.x, b.pos.y, b.pos.z);
      let dyaw = b.yaw - b.model.group.rotation.y;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      b.model.group.rotation.y += dyaw * Math.min(1, dt * 8);
      G.models.animatePlayer(b.model, dt, b.moving, slot, 1);
    }
  }

  // ---------- 相机 ----------
  const TP_DIST = 3.4;
  function updateCamera(dt) {
    const hasSpeed = mode === 'play' && mySnap && mySnap.bf.some(b => b[0] === 'speed');
    const targetFov = BASE_FOV - me.zoom * 51 + (hasSpeed && me.moving ? 6 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
    if (mode === 'play' && mySnap) {
      if (mySnap.al) {
        if (effectiveView() === 'tp') {
          // 第三人称：肩后视角 + 遮挡收缩
          const eye = eyePos();
          const vd = camDir();
          const right = V3(Math.cos(me.yaw), 0, -Math.sin(me.yaw));
          const desired = eye.clone().addScaledVector(vd, -TP_DIST).addScaledVector(right, 0.55).add(V3(0, 0.3, 0));
          const dir = desired.clone().sub(eye);
          const len = dir.length() || 1;
          dir.normalize();
          const t = G.world.rayObstacles({ x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, len + 0.3);
          const d = Math.max(0.6, Math.min(len, t - 0.25));
          camera.position.copy(eye).addScaledVector(dir, d);
          if (camera.position.y < 0.3) camera.position.y = 0.3;
          camera.rotation.set(me.pitch + recoilPitch, me.yaw, 0);
        } else {
          camera.position.set(me.pos.x, me.pos.y + defs.rules.eyeH, me.pos.z);
          camera.rotation.set(me.pitch + recoilPitch, me.yaw, 0);
        }
      } else {
        const dp = V3(me.pos.x, me.pos.y + 7, me.pos.z + 5);
        camera.position.lerp(dp, Math.min(1, dt * 3));
        camera.lookAt(me.pos.x, 0.5, me.pos.z);
      }
    } else if (mode === 'spec') {
      const e = specTarget();
      if (e) {
        const pi = e.disp.pi !== undefined ? e.disp.pi : e.cur.pi;   // pitch/yaw 同源（都用插值值），消除两轴不同步
        const eye = V3(e.disp.x, e.disp.y + defs.rules.eyeH, e.disp.z);
        if (specView === 'tp') {
          const q = new T.Quaternion().setFromEuler(new T.Euler(pi, e.disp.ya, 0, 'YXZ'));
          const vd = V3(0, 0, -1).applyQuaternion(q);
          const desired = eye.clone().addScaledVector(vd, -3.8).add(V3(0, 0.5, 0));
          const dir = desired.clone().sub(eye);
          const len = dir.length() || 1;
          dir.normalize();
          const t = G.world.rayObstacles({ x: eye.x, y: eye.y, z: eye.z }, { x: dir.x, y: dir.y, z: dir.z }, len + 0.3);
          const d = Math.max(0.8, Math.min(len, t - 0.25));
          const camPos = eye.clone().addScaledVector(dir, d);
          if (camPos.y < 0.3) camPos.y = 0.3;
          camera.position.lerp(camPos, Math.min(1, dt * 10));
          camera.quaternion.slerp(q, Math.min(1, dt * 8));   // 第三人称保留平滑（镜头跟随需要缓冲）
        } else {
          // 第一人称：直接复刻目标玩家的真实视角——位置和朝向都直接 set（e.disp 已含网络插值），
          // 不再叠加 position.lerp / quaternion.slerp，跟手感与玩家自己的第一人称一致
          camera.position.copy(eye);
          camera.rotation.set(pi, e.disp.ya, 0);
        }
      } else {
        let spd = 14 * specSpeed * (keys.ShiftLeft ? 2.2 : 1);
        const d = camDir();
        const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
        const { ix, iz, mag } = moveAxes();
        if (mag > 0.05) {
          specFree.pos.addScaledVector(d, iz * spd * mag * dt);
          specFree.pos.x += rx * ix * spd * mag * dt;
          specFree.pos.z += rz * ix * spd * mag * dt;
        }
        if (keys.Space) specFree.pos.y += spd * dt;
        if (keys.KeyC) specFree.pos.y -= spd * dt;
        specFree.pos.y = Math.max(0.5, Math.min(60, specFree.pos.y));
        camera.position.copy(specFree.pos);
        camera.rotation.set(me.pitch, me.yaw, 0);
      }
      // 每 500ms 刷新观战条（含跟随目标离场后回退自由的处理），跟随/自由两态都覆盖
      if (Math.floor(perfNow / 500) !== Math.floor((perfNow - dt * 1000) / 500)) updateSpecBar();
    } else if (mode === 'menu' && worldBuilt) {
      const a = perfNow / 9000;
      camera.position.set(Math.cos(a) * 38, 16, Math.sin(a) * 38);
      camera.lookAt(0, 1, 0);
    }
    const sh = G.fx.getShake();
    if (sh) { camera.position.x += sh.x; camera.position.y += sh.y; camera.position.z += sh.z; }
    const kk = G.fx.getKick();
    if (kk) { camera.position.x += kk.x; camera.position.y += kk.y; camera.position.z += kk.z; }
  }

  // ---------- 主循环（后台标签页降级为 10Hz 定时器，防止逻辑停摆） ----------
  let perfNow = performance.now(), lastFrame = performance.now();
  let fpsCnt = 0, fpsAt = performance.now();
  let lowFpsStreak = 0;
  let loopGen = 0;
  function schedule() {
    // 世代令牌：可见性切换时旧的 rAF 回调可能永远挂起或迟到，令牌保证单链推进
    const gen = ++loopGen;
    if (document.hidden) setTimeout(() => { if (gen === loopGen) loop(); }, 100);
    else requestAnimationFrame(() => { if (gen === loopGen) loop(); });
  }
  // 看门狗：主循环停摆超过 600ms（如 rAF 在后台被冻结）就重新拉起
  setInterval(() => {
    if (performance.now() - lastFrame > 600) loop();
  }, 400);
  function loop() {
    schedule();
    perfNow = performance.now();
    if (canvas.width !== Math.floor(innerWidth * renderer.getPixelRatio()) && innerWidth > 0) {
      resizeViewport();
    }
    const dt = Math.min(0.05, (perfNow - lastFrame) / 1000);
    lastFrame = perfNow;
    if (!worldBuilt) {
      renderArsenalPre(dt);
      return;
    }
    if (mode === 'play') {
      movement(dt);
      if (me.cookExpireAt > 0) me.cookLeft = Math.max(0, me.cookExpireAt - now());
      combat(dt);
      updateLocalChargeBeam();
    }
    netSync(dt);
    // 菜单用本地昼夜；进房后才跟服务器
    if (mode === 'menu') {
      if (!menuDemoOn) startMenuDemo();
      tickMenuDemo(dt);
      const dayT = ((perfNow - menuDayAt) / dayMs) % 1;
      G.world.setDay(dayT, scene);
    } else {
      const dayT = (dayBase + (perfNow - dayAt) / dayMs) % 1;
      G.world.setDay(dayT, scene);
    }
    G.world.updateAmbient(dt);
    renderMovingProjectiles(dt);
    renderEnts(dt);
    renderSelf(dt);
    renderViewModel(dt);
    renderShopPre(dt);
    renderWardPre(dt);
    renderArsenalPre(dt);
    hudFrame();
    updateCamera(dt);
    G.fx.update(dt);
    renderSceneFrame();
    fpsCnt++;
    if (perfNow - fpsAt > 1000) {
      $('fpsNum').textContent = fpsCnt + ' FPS';
      $('pingNum').textContent = pingMs + ' ms';
      const di = G.world.dayInfo();
      $('dayChip').textContent = `${di.icon} ${di.phase}`;
      // 运行时画质自动降级：持续低帧率就砍掉阴影这类纯观感开销（绝不动视距/雾距，公平性红线）
      if (TOUCH && fpsCnt < 40 && renderer.shadowMap.enabled) {
        if (++lowFpsStreak >= 4) {
          renderer.shadowMap.enabled = false;
          renderer.setPixelRatio(Math.min(1, renderer.getPixelRatio()));
          lowFpsStreak = 0;
        }
      } else lowFpsStreak = 0;
      fpsCnt = 0; fpsAt = perfNow;
    }
  }

  // ---------- 启动 ----------
  function renderSceneFrame() {
    const oldMask = camera.layers.mask;
    camera.layers.set(0);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    if (vm && vm.group.visible) {
      const bg = scene.background;
      scene.background = null;
      renderer.autoClear = false;
      renderer.clearDepth();
      camera.layers.set(VIEW_LAYER);
      renderer.render(scene, camera);
      scene.background = bg;
    }
    renderer.autoClear = true;
    camera.layers.mask = oldMask;
  }

  window.__na = {
    renderer, scene, camera, TOUCH, quality,
    ui: { toggleShop, openPause, toggleView, get shopPre() { return shopPre; } },
    touch, applyLook, moveAxes,
  };   // 调试句柄（截帧/诊断用）
  if (settings.gyro && TOUCH && GYRO_NEEDS_ANY_PERM) gyroPermOk = false;
  initTouchLayoutEditor();
  refreshOpts();
  syncGyroListener();
  updatePassHint();
  updateOauthUi();
  // OAuth 回调参数
  if (qs.get('oauth_error')) {
    $('menuErr').textContent = qs.get('oauth_error');
    highlightNeedOauth(qs.get('oauth_error'));
  }
  if (qs.get('oauth') === '1') {
    const label = qs.get('provider') === 'linuxdo' ? 'LinuxDo' : 'NodeLoc';
    $('menuErr').textContent = label + ' 登录成功';
  }
  if (qs.get('name') && qs.get('oauth') === '1') {
    $('nameInput').value = qs.get('name');
    myName = qs.get('name');
    localStorage.setItem('na_name', myName);
  }
  setupNativeOauthReturn();
  if (!IS_NATIVE_APP) {
    fetch('/api/oauth/me', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => applyOauthState(d))
      .catch(() => { /* WS 也会推送 oauth 状态 */ });
  } else if (oauthToken) {
    fetch(NATIVE_GAME_ORIGIN + '/api/oauth/me', {
      headers: { Authorization: 'Bearer ' + oauthToken },
    })
      .then(r => r.json())
      .then(d => applyOauthState(d))
      .catch(() => { /* WS 也会推送 oauth 状态 */ });
  }
  connect();
  loop();
  // 预加载外部武器 GLB；加载完成后刷新已装备/展示的对应武器
  G.models.preloadAssets(id => {
    if (!id) return;
    if (vm && vm.cur && String(vm.cur).startsWith(id)) vm.cur = null;
    if (myModel && myModel.curWeapon === id) {
      myModel.curWeapon = null;
      G.models.setPlayerWeapon(myModel, id);
    }
    for (const e of ents.values()) {
      if (e.model && e.model.curWeapon === id) e.model.curWeapon = null;
    }
    for (const pm of pickupMeshes) {
      if (pm.item === id && pm.mesh && defs) {
        scene.remove(pm.mesh);
        pm.mesh = G.models.makePickup(id, defs);
        scene.add(pm.mesh);
        pm.mesh.position.set(pm.pt.x, pm.pt.y || 0, pm.pt.z);
      }
    }
    if (arsenalPre) {
      for (const it of arsenalPre.items) {
        if (it.id !== id) continue;
        const parent = it.mesh.parent;
        const { x, y, z } = it.mesh.position;
        const rotY = it.mesh.rotation.y;
        const sc = it.mesh.scale.x;
        if (parent) parent.remove(it.mesh);
        it.mesh = G.models.buildWeapon(id);
        it.mesh.position.set(x, y, z);
        it.mesh.rotation.set(-0.12, rotY, 0);
        it.mesh.scale.setScalar(sc);
        if (parent) parent.add(it.mesh);
      }
    }
  });
  if (qs.get('auto') === '1') {
    const tryJoin = setInterval(() => {
      if (wsOk && defs && isOauthLoggedIn()) { clearInterval(tryJoin); $('btnPlay').click(); }
    }, 300);
  }
})();
