// 程序化模型工厂：玩家 / BOSS / 商人 / 武器 / 拾取物 / 外观装饰（部分枪械可选用外部 GLB）
window.G = window.G || {};
G.models = (function () {
  const T = THREE;

  // ---------- 外部武器资源（Meshy GLB）----------
  // Meshy 模型长轴多为 X：-X 枪口 / +X 握把侧；游戏约定枪口朝 -Z
  const WEAPON_GLB = {
    pistol: {
      url: 'models/pistol.glb',
      scale: 0.24,
      offset: { x: 0, y: -0.02, z: -0.08 },
      rotY: -Math.PI / 2,
    },
  };
  const glbRoots = Object.create(null);

  function std(color, opt) {
    return new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.75, metalness: 0.15 }, opt || {}));
  }
  function box(w, h, d, mat) { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.castShadow = true; return m; }
  function cyl(rt, rb, h, mat, seg) { const m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 12), mat); m.castShadow = true; return m; }
  function cylZ(rt, rb, h, mat, seg, openEnded) {
    const m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 12, 1, !!openEnded), mat);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    return m;
  }
  function muzzleRing(r, mat) {
    const m = new T.Mesh(new T.TorusGeometry(r, r * 0.18, 8, 18), mat);
    m.castShadow = true;
    return m;
  }
  function sph(r, mat, seg) { const m = new T.Mesh(new T.SphereGeometry(r, seg || 12, seg || 10), mat); m.castShadow = true; return m; }
  function cone(r, h, mat, seg) { const m = new T.Mesh(new T.ConeGeometry(r, h, seg || 10), mat); m.castShadow = true; return m; }

  // ---------- 脸部纹理（共享） ----------
  let faceTex = null;
  function getFaceTex() {
    if (faceTex) return faceTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#e8b98a'; x.fillRect(0, 0, 64, 64);
    x.fillStyle = '#222'; x.fillRect(14, 24, 10, 12); x.fillRect(40, 24, 10, 12);   // 眼睛
    x.fillStyle = '#fff'; x.fillRect(16, 26, 4, 4); x.fillRect(42, 26, 4, 4);
    x.fillStyle = '#b3805a'; x.fillRect(24, 44, 16, 4);                              // 嘴
    faceTex = new T.CanvasTexture(c);
    return faceTex;
  }

  // ---------- 文字精灵 ----------
  function textSprite(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, c);
    const tex = new T.CanvasTexture(c);
    const spr = new T.Sprite(new T.SpriteMaterial({ map: tex, depthWrite: false }));
    spr.userData.canvas = c; spr.userData.ctx = ctx; spr.userData.tex = tex;
    return spr;
  }
  function drawNameplate(ctx, c, name, color, hp, maxHp) {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 6;
    ctx.fillStyle = color; ctx.fillText(name, c.width / 2, 20);
    ctx.shadowBlur = 0;
    const bw = 150, bx = (c.width - bw) / 2, by = 40;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(bx - 1, by - 1, bw + 2, 10);
    const r = Math.max(0, hp / maxHp);
    ctx.fillStyle = r > 0.4 ? '#4dff88' : '#ff5544';
    ctx.fillRect(bx, by, bw * r, 8);
  }
  function makeNameplate(name, color) {
    const spr = textSprite(256, 64, (ctx, c) => drawNameplate(ctx, c, name, color, 100, 100));
    spr.scale.set(2.2, 0.55, 1);
    spr.userData.set = (hp, maxHp) => {
      drawNameplate(spr.userData.ctx, spr.userData.canvas, name, color, hp, maxHp);
      spr.userData.tex.needsUpdate = true;
    };
    return spr;
  }

  // ---------- 玩家 ----------
  function makePlayer(color, name) {
    const g = new T.Group();
    const mats = [];
    const track = m => { mats.push(m); return m; };
    const cBody = track(std(color));
    const cDark = track(std(new T.Color(color).multiplyScalar(0.55).getHex()));
    const cSkin = track(std('#e8b98a'));

    const legL = box(0.22, 0.7, 0.24, cDark); legL.geometry.translate(0, -0.35, 0); legL.position.set(-0.16, 0.7, 0);
    const legR = legL.clone(); legR.position.x = 0.16;
    const body = box(0.68, 0.62, 0.38, cBody); body.position.y = 1.0;
    const belt = box(0.7, 0.08, 0.4, cDark); belt.position.y = 0.72;
    const faceMat = track(new T.MeshStandardMaterial({ map: getFaceTex(), roughness: 0.8 }));
    const headMats = [cSkin, cSkin, cSkin, cSkin, cSkin, faceMat]; // -Z 为脸
    const head = new T.Mesh(new T.BoxGeometry(0.42, 0.4, 0.42), headMats); head.castShadow = true;
    head.position.y = 1.53;
    const armGeo = new T.BoxGeometry(0.17, 0.62, 0.2); armGeo.translate(0, -0.28, 0);
    const armL = new T.Mesh(armGeo, cSkin); armL.castShadow = true; armL.position.set(-0.43, 1.28, 0);
    const armR = new T.Mesh(armGeo.clone(), cSkin); armR.castShadow = true; armR.position.set(0.43, 1.28, 0);

    // 外观锚点
    const hatA = new T.Group(); hatA.position.set(0, 1.75, 0);
    const faceA = new T.Group(); faceA.position.set(0, 1.56, -0.23);
    const backA = new T.Group(); backA.position.set(0, 1.15, 0.24);
    const weaponA = new T.Group(); weaponA.position.set(0, -0.55, -0.1); armR.add(weaponA);

    g.add(legL, legR, body, belt, head, armL, armR, hatA, faceA, backA);
    const plate = makeNameplate(name, color); plate.position.y = 2.25; g.add(plate);

    const model = {
      group: g, legL, legR, armL, armR, head, body, plate, hatA, faceA, backA, weaponA,
      mats, cosMats: [], walkT: 0, attackT: 9, attackDur: 0.3, weaponMesh: null, curWeapon: null,
      baseColor: color, zombified: false,
    };
    g.userData.model = model;
    return model;
  }

  function animatePlayer(m, dt, moving, activeSlot, speedMul) {
    m.walkT += dt * (moving ? 9 * (speedMul || 1) : 0);
    m.attackT += dt;
    const sw = moving ? Math.sin(m.walkT) * 0.55 : 0;
    m.legL.rotation.x = sw; m.legR.rotation.x = -sw;
    // 手臂姿态：持枪 = 前平举；近战攻击 = 挥砍；丧尸 = 双爪前伸
    let armBase = moving ? -Math.sin(m.walkT) * 0.3 : 0;
    if (m.zombified) {
      m.armL.rotation.x = 1.35 + Math.sin(m.walkT * 0.7) * 0.1;
      m.armR.rotation.x = 1.35 - Math.sin(m.walkT * 0.7) * 0.1;
    } else if (activeSlot === 'gun') {
      m.armR.rotation.x = 1.45;
      m.armL.rotation.x = 1.1;
    } else {
      m.armL.rotation.x = -armBase;
      m.armR.rotation.x = armBase;
    }
    if (m.attackT < m.attackDur) {
      const k = m.attackT / m.attackDur;
      m.armR.rotation.x = 2.1 - k * 2.1;   // 快速下劈（朝面朝方向）
    }
  }

  function setPlayerWeapon(m, wp) {
    if (m.curWeapon === wp) return;
    m.curWeapon = wp;
    if (m.weaponMesh) {
      clearPlasmaArcs(m.weaponMesh);
      m.weaponA.remove(m.weaponMesh);
      m.weaponMesh = null;
    }
    if (wp && wp !== 'fist') {
      m.weaponMesh = buildWeapon(wp);
      m.weaponMesh.rotation.x = -Math.PI / 2 * 0.9;   // 与持枪臂 +X 前举姿态对齐，枪管朝面朝方向
      m.weaponA.add(m.weaponMesh);
    }
  }

  function setOpacity(m, a) {
    const all = m.mats.concat(m.cosMats);
    for (const mat of all) {
      mat.transparent = a < 0.99;
      mat.opacity = a;
      mat.depthWrite = a >= 0.5;
    }
    m.plate.visible = a > 0.5;
  }

  function tintZombie(m, on) {
    if (m.zombified === on) return;
    m.zombified = on;
    const c = on ? '#5dbb46' : m.baseColor;
    m.mats[0].color.set(on ? '#4a8f38' : m.baseColor);
    m.mats[2].color.set(on ? '#7bd45f' : '#e8b98a');
  }

  // ---------- 外观装饰 ----------
  function buildCosmetic(id) {
    const g = new T.Group();
    const add = (...ms) => { ms.forEach(x => g.add(x)); return g; };

    // 双侧羽翼：left/right 组带 wingSide，供 animateCosmetics 拍打
    function buildFlappingWings(opts) {
      const root = new T.Group();
      root.userData.cosAnim = 'wings';
      const layers = opts.layers || 4;
      const baseZ = opts.baseZ != null ? opts.baseZ : 0.42;
      const flapAmp = opts.flapAmp != null ? opts.flapAmp : 0.3;
      for (const side of [-1, 1]) {
        const wing = new T.Group();
        wing.userData.wingSide = side;
        wing.userData.baseZ = baseZ;
        wing.userData.flapAmp = flapAmp;
        wing.rotation.z = side * baseZ;
        for (let i = 0; i < layers; i++) {
          const w = (opts.w0 || 0.55) - i * (opts.dw || 0.07);
          const h = opts.h || 0.18;
          const mat = typeof opts.mat === 'function' ? opts.mat(i, side) : opts.mat;
          const f = new T.Mesh(new T.PlaneGeometry(w, h), mat);
          f.castShadow = true;
          f.position.set(side * (0.22 + i * (opts.spread || 0.14)), 0.12 - i * (opts.drop || 0.14), 0.04 + i * 0.02);
          f.rotation.z = side * (0.15 + i * 0.12);
          f.rotation.y = side * 0.15;
          wing.add(f);
          if (opts.tipMat) {
            const tip = new T.Mesh(new T.PlaneGeometry(w * 0.35, h * 0.55), opts.tipMat);
            tip.position.set(side * (w * 0.32), -h * 0.15, 0.01);
            tip.rotation.z = side * 0.2;
            wing.add(tip);
          }
        }
        root.add(wing);
      }
      return root;
    }

    switch (id) {
      case 'hat_cowboy': {
        const m = std('#8a5a2b');
        const brim = cyl(0.36, 0.36, 0.045, m); const top = cyl(0.19, 0.21, 0.24, m); top.position.y = 0.13;
        return add(brim, top);
      }
      case 'hat_beret': {
        const b = sph(0.26, std('#3f7d3a')); b.scale.y = 0.45; b.position.set(0.04, 0.06, 0);
        return add(b);
      }
      case 'hat_horns': {
        const m = std('#a03030', { emissive: '#5c0f0f', emissiveIntensity: 0.6 });
        const h1 = cone(0.07, 0.3, m); h1.position.set(-0.17, 0.12, 0); h1.rotation.z = 0.5;
        const h2 = h1.clone(); h2.position.x = 0.17; h2.rotation.z = -0.5;
        return add(h1, h2);
      }
      case 'hat_crown': {
        const m = std('#ffd23c', { metalness: 0.85, roughness: 0.3, emissive: '#8a6a00', emissiveIntensity: 0.35 });
        const base = cyl(0.24, 0.26, 0.14, m); base.position.y = 0.07;
        g.add(base);
        for (let i = 0; i < 5; i++) {
          const s = cone(0.05, 0.14, m);
          const a = i / 5 * Math.PI * 2;
          s.position.set(Math.cos(a) * 0.22, 0.19, Math.sin(a) * 0.22);
          g.add(s);
        }
        return g;
      }
      case 'hat_halo': {
        const ring = new T.Mesh(
          new T.TorusGeometry(0.28, 0.035, 10, 28),
          std('#ffe566', { metalness: 0.7, roughness: 0.25, emissive: '#ffb000', emissiveIntensity: 0.9 })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.32;
        ring.userData.cosAnim = 'spin';
        ring.userData.spinSpeed = 1.8;
        const core = sph(0.06, std('#fff6c8', { emissive: '#ffd23c', emissiveIntensity: 1.4 }));
        core.position.y = 0.32;
        core.userData.cosAnim = 'pulse';
        core.userData.baseEmi = 1.2;
        return add(ring, core);
      }
      case 'face_shades': {
        const b = box(0.4, 0.1, 0.05, std('#111', { roughness: 0.2, metalness: 0.6 }));
        return add(b);
      }
      case 'face_visor': {
        const b = box(0.44, 0.15, 0.06, std('#0b2733', { emissive: '#35e0ff', emissiveIntensity: 1.4, roughness: 0.2 }));
        return add(b);
      }
      case 'face_oni': {
        const base = box(0.3, 0.26, 0.12, std('#8a1a1a', { metalness: 0.25 }));
        base.position.set(0, -0.02, -0.17);
        const hornL = cone(0.045, 0.16, std('#f0e6d0')); hornL.position.set(-0.1, 0.14, -0.18); hornL.rotation.z = 0.35;
        const hornR = hornL.clone(); hornR.position.x = 0.1; hornR.rotation.z = -0.35;
        const eyeL = box(0.07, 0.035, 0.03, std('#1a0505', { emissive: '#ff3030', emissiveIntensity: 1.5 }));
        eyeL.position.set(-0.08, 0.03, -0.23); eyeL.userData.cosAnim = 'pulse'; eyeL.userData.baseEmi = 1.3;
        const eyeR = eyeL.clone(); eyeR.position.x = 0.08;
        eyeR.userData.cosAnim = 'pulse'; eyeR.userData.baseEmi = 1.3;
        return add(base, hornL, hornR, eyeL, eyeR);
      }
      case 'face_kitsune': {
        // 白狐面：流线狐面 + 尖耳 + 朱红纹路 + 金瞳脉冲
        const porcelain = std('#f4efe6', { metalness: 0.15, roughness: 0.45 });
        const mask = box(0.32, 0.28, 0.1, porcelain);
        mask.position.set(0, -0.01, -0.17);
        const snout = box(0.14, 0.1, 0.12, porcelain);
        snout.position.set(0, -0.08, -0.24);
        const earL = cone(0.07, 0.2, std('#f4efe6', { emissive: '#ff6b6b', emissiveIntensity: 0.15 }));
        earL.position.set(-0.14, 0.18, -0.14); earL.rotation.z = 0.45; earL.rotation.x = -0.2;
        const earR = earL.clone(); earR.position.x = 0.14; earR.rotation.z = -0.45;
        const mark = box(0.04, 0.16, 0.02, std('#c41e3a', { emissive: '#ff2040', emissiveIntensity: 0.7 }));
        mark.position.set(0, 0.04, -0.23);
        mark.userData.cosAnim = 'pulse'; mark.userData.baseEmi = 0.55;
        const eyeL = box(0.08, 0.03, 0.025, std('#1a1208', { emissive: '#ffc14a', emissiveIntensity: 1.4 }));
        eyeL.position.set(-0.08, 0.04, -0.225);
        eyeL.userData.cosAnim = 'pulse'; eyeL.userData.baseEmi = 1.2;
        const eyeR = eyeL.clone(); eyeR.position.x = 0.08;
        eyeR.userData.cosAnim = 'pulse'; eyeR.userData.baseEmi = 1.2;
        const whiskL = box(0.12, 0.012, 0.012, std('#c41e3a', { emissive: '#ff4060', emissiveIntensity: 0.5 }));
        whiskL.position.set(-0.16, -0.04, -0.22); whiskL.rotation.z = 0.2;
        const whiskR = whiskL.clone(); whiskR.position.x = 0.16; whiskR.rotation.z = -0.2;
        return add(mask, snout, earL, earR, mark, eyeL, eyeR, whiskL, whiskR);
      }
      case 'face_holo': {
        // 全息面纱：半透青蓝面板 + 扫描光带 + 侧边能量条
        const veil = box(0.38, 0.3, 0.04, std('#06202c', {
          emissive: '#35e0ff', emissiveIntensity: 0.55, transparent: true, opacity: 0.55, metalness: 0.6, roughness: 0.2,
        }));
        veil.position.set(0, 0.0, -0.2);
        const scan = box(0.34, 0.035, 0.02, std('#021018', {
          emissive: '#7df9ff', emissiveIntensity: 1.8, transparent: true, opacity: 0.95,
        }));
        scan.position.set(0, 0.08, -0.225);
        scan.userData.cosAnim = 'scan';
        scan.userData.scanMin = -0.1;
        scan.userData.scanMax = 0.12;
        scan.userData.scanSpeed = 2.4;
        const barL = box(0.03, 0.26, 0.03, std('#041820', { emissive: '#35e0ff', emissiveIntensity: 1.1 }));
        barL.position.set(-0.2, 0.0, -0.2);
        barL.userData.cosAnim = 'pulse'; barL.userData.baseEmi = 0.9;
        const barR = barL.clone(); barR.position.x = 0.2;
        barR.userData.cosAnim = 'pulse'; barR.userData.baseEmi = 0.9;
        const brow = box(0.36, 0.04, 0.035, std('#0a3040', { emissive: '#35e0ff', emissiveIntensity: 0.8, metalness: 0.7 }));
        brow.position.set(0, 0.14, -0.21);
        return add(veil, scan, barL, barR, brow);
      }
      case 'back_cape': {
        const m = std('#b01e3c', { side: T.DoubleSide });
        const p = new T.Mesh(new T.PlaneGeometry(0.62, 0.95), m); p.castShadow = true;
        p.position.set(0, -0.35, 0.03); p.rotation.x = 0.12;
        p.userData.cosAnim = 'sway'; p.userData.baseX = 0.12;
        return add(p);
      }
      case 'back_jet': {
        const m = std('#777c85', { metalness: 0.7, roughness: 0.35 });
        const fm = std('#331a05', { emissive: '#ff7a1a', emissiveIntensity: 1.6 });
        const t1 = cyl(0.09, 0.09, 0.42, m); t1.position.set(-0.11, -0.1, 0.06);
        const t2 = t1.clone(); t2.position.x = 0.11;
        const f1 = cone(0.06, 0.12, fm); f1.rotation.x = Math.PI; f1.position.set(-0.11, -0.36, 0.06);
        f1.userData.cosAnim = 'flame'; f1.userData.phase = 0;
        const f2 = f1.clone(); f2.position.x = 0.11;
        f2.userData.cosAnim = 'flame'; f2.userData.phase = 1.7;
        return add(t1, t2, f1, f2);
      }
      case 'back_wings': {
        return buildFlappingWings({
          layers: 4, baseZ: 0.4, flapAmp: 0.26, w0: 0.58, h: 0.17,
          mat: (i) => std(i % 2 ? '#eef3ff' : '#d7e4ff', {
            emissive: '#9ec0ff', emissiveIntensity: 0.45 + i * 0.08, side: T.DoubleSide,
          }),
          tipMat: std('#ffffff', { emissive: '#cfe0ff', emissiveIntensity: 0.9, side: T.DoubleSide, transparent: true, opacity: 0.85 }),
        });
      }
      case 'back_phoenix': {
        return buildFlappingWings({
          layers: 5, baseZ: 0.48, flapAmp: 0.34, w0: 0.62, h: 0.16, spread: 0.15, drop: 0.12,
          mat: (i) => std(i < 2 ? '#ff6a1a' : '#ff3030', {
            emissive: i < 2 ? '#ff9a3a' : '#ff4020', emissiveIntensity: 0.85 + i * 0.1, side: T.DoubleSide,
          }),
          tipMat: std('#fff0a0', { emissive: '#ffcc33', emissiveIntensity: 1.6, side: T.DoubleSide, transparent: true, opacity: 0.9 }),
        });
      }
      case 'back_dragon': {
        const root = buildFlappingWings({
          layers: 4, baseZ: 0.5, flapAmp: 0.22, w0: 0.52, h: 0.14, spread: 0.13,
          mat: (i) => std(i % 2 ? '#2a1538' : '#4a2060', {
            emissive: '#7b2fff', emissiveIntensity: 0.35 + i * 0.08, side: T.DoubleSide, metalness: 0.4, roughness: 0.35,
          }),
        });
        // 骨刺
        for (const side of [-1, 1]) {
          const spike = cone(0.04, 0.22, std('#c9b8ff', { emissive: '#6a3dff', emissiveIntensity: 0.7 }));
          spike.position.set(side * 0.18, 0.28, 0.06);
          spike.rotation.z = side * -0.4;
          spike.rotation.x = -0.3;
          root.add(spike);
        }
        return root;
      }
      case 'back_void': {
        const root = buildFlappingWings({
          layers: 3, baseZ: 0.38, flapAmp: 0.2, w0: 0.5, h: 0.2,
          mat: () => std('#0a0614', {
            emissive: '#5a2dff', emissiveIntensity: 0.55, side: T.DoubleSide, transparent: true, opacity: 0.82,
          }),
          tipMat: std('#1a0a30', { emissive: '#b46bff', emissiveIntensity: 1.2, side: T.DoubleSide, transparent: true, opacity: 0.7 }),
        });
        for (let i = 0; i < 3; i++) {
          const orb = sph(0.045, std('#120822', { emissive: '#b46bff', emissiveIntensity: 1.5 }));
          orb.userData.cosAnim = 'orbit';
          orb.userData.orbitR = 0.32 + i * 0.06;
          orb.userData.orbitSp = 1.6 + i * 0.4;
          orb.userData.orbitPh = i * 2.1;
          orb.userData.orbitY = 0.1 + i * 0.05;
          root.add(orb);
        }
        return root;
      }
      case 'back_solar': {
        // 日曜法环：背后竖直圆盘旋转（面朝前后），非球体
        const root = new T.Group();
        root.position.set(0, 0.08, 0.18);
        const pivot = new T.Group();
        pivot.userData.cosAnim = 'spin';
        pivot.userData.spinSpeed = 1.25;
        pivot.userData.spinAxis = 'z';
        const discMat = std('#ffb84a', {
          metalness: 0.75, roughness: 0.28, emissive: '#ff8a00', emissiveIntensity: 0.75,
          side: T.DoubleSide,
        });
        const disc = new T.Mesh(new T.CircleGeometry(0.52, 48), discMat);
        disc.castShadow = true;
        const rim = new T.Mesh(
          new T.RingGeometry(0.42, 0.55, 48),
          std('#ffe29a', { metalness: 0.8, roughness: 0.2, emissive: '#ffd23c', emissiveIntensity: 1.1, side: T.DoubleSide })
        );
        const rim2 = new T.Mesh(
          new T.RingGeometry(0.22, 0.3, 40),
          std('#ff9a2a', { metalness: 0.7, roughness: 0.25, emissive: '#ffcc44', emissiveIntensity: 1.0, side: T.DoubleSide })
        );
        // 圆盘刻度条幅
        for (let i = 0; i < 8; i++) {
          const spoke = box(0.04, 0.5, 0.012, std('#ffd27a', {
            emissive: '#ffb000', emissiveIntensity: 0.8, side: T.DoubleSide,
          }));
          spoke.rotation.z = i * Math.PI / 4;
          spoke.position.z = 0.008;
          pivot.add(spoke);
        }
        pivot.add(disc, rim, rim2);
        // 反向慢转外环
        const outerPivot = new T.Group();
        outerPivot.userData.cosAnim = 'spin';
        outerPivot.userData.spinSpeed = -0.7;
        outerPivot.userData.spinAxis = 'z';
        const outerRing = new T.Mesh(
          new T.RingGeometry(0.56, 0.62, 48),
          std('#ffcc66', { metalness: 0.85, roughness: 0.2, emissive: '#ff9500', emissiveIntensity: 0.95, side: T.DoubleSide })
        );
        outerPivot.add(outerRing);
        root.add(pivot, outerPivot);
        return root;
      }
      case 'back_aether': {
        // 以太星环：背后青紫双层圆盘对转
        const root = new T.Group();
        root.position.set(0, 0.1, 0.18);
        const pivotA = new T.Group();
        pivotA.userData.cosAnim = 'spin';
        pivotA.userData.spinSpeed = 1.0;
        pivotA.userData.spinAxis = 'z';
        const discA = new T.Mesh(
          new T.CircleGeometry(0.48, 48),
          std('#152238', {
            metalness: 0.55, roughness: 0.3, emissive: '#35e0ff', emissiveIntensity: 0.55,
            transparent: true, opacity: 0.55, side: T.DoubleSide,
          })
        );
        const ringA = new T.Mesh(
          new T.RingGeometry(0.38, 0.5, 48),
          std('#1a3048', { metalness: 0.6, roughness: 0.25, emissive: '#35e0ff', emissiveIntensity: 1.05, side: T.DoubleSide })
        );
        for (let i = 0; i < 6; i++) {
          const blade = box(0.035, 0.42, 0.01, std('#35e0ff', {
            emissive: '#7df9ff', emissiveIntensity: 1.1, transparent: true, opacity: 0.85, side: T.DoubleSide,
          }));
          blade.rotation.z = i * Math.PI / 3;
          blade.position.z = 0.01;
          pivotA.add(blade);
        }
        pivotA.add(discA, ringA);

        const pivotB = new T.Group();
        pivotB.userData.cosAnim = 'spin';
        pivotB.userData.spinSpeed = -1.55;
        pivotB.userData.spinAxis = 'z';
        pivotB.position.z = 0.025;
        const ringB = new T.Mesh(
          new T.RingGeometry(0.26, 0.36, 40),
          std('#2a1040', { metalness: 0.5, roughness: 0.3, emissive: '#b46bff', emissiveIntensity: 1.15, side: T.DoubleSide })
        );
        const ringC = new T.Mesh(
          new T.RingGeometry(0.52, 0.58, 48),
          std('#241038', { metalness: 0.55, roughness: 0.28, emissive: '#c07bff', emissiveIntensity: 0.95, side: T.DoubleSide })
        );
        pivotB.add(ringB, ringC);
        root.add(pivotA, pivotB);
        return root;
      }
      case 'login_cap': {
        const m = std('#2a6f9e', { emissive: '#1a3a55', emissiveIntensity: 0.35 });
        const brim = cyl(0.3, 0.3, 0.035, m); brim.position.y = 0.02;
        const top = cyl(0.17, 0.19, 0.16, m); top.position.y = 0.11;
        const bill = box(0.22, 0.03, 0.14, std('#1e4f72')); bill.position.set(0, 0.02, -0.2);
        return add(brim, top, bill);
      }
      case 'login_goggles': {
        const frame = box(0.42, 0.12, 0.06, std('#222830', { metalness: 0.5 }));
        const lens = box(0.36, 0.08, 0.04, std('#163044', { emissive: '#35e0ff', emissiveIntensity: 1.1 }));
        lens.position.z = 0.02;
        return add(frame, lens);
      }
      case 'login_scarf': {
        const m = std('#ff4d9d', { emissive: '#802048', emissiveIntensity: 0.55, side: T.DoubleSide });
        const p = new T.Mesh(new T.PlaneGeometry(0.55, 0.7), m); p.castShadow = true;
        p.position.set(0, -0.28, 0.04); p.rotation.x = 0.18;
        p.userData.cosAnim = 'sway'; p.userData.baseX = 0.18;
        return add(p);
      }
      case 'login_helm': {
        const m = std('#5a6570', { metalness: 0.75, roughness: 0.3 });
        const dome = sph(0.27, m); dome.scale.y = 0.72; dome.position.y = 0.08;
        const visor = box(0.34, 0.08, 0.08, std('#111820', { emissive: '#35e0ff', emissiveIntensity: 0.7 }));
        visor.position.set(0, 0.02, -0.18);
        return add(dome, visor);
      }
      case 'login_mask': {
        const m = std('#1a1a22', { metalness: 0.4 });
        const base = box(0.28, 0.2, 0.1, m); base.position.set(0, -0.02, -0.16);
        const glow = box(0.2, 0.04, 0.04, std('#120818', { emissive: '#ff4d9d', emissiveIntensity: 1.2 }));
        glow.position.set(0, 0.02, -0.2);
        glow.userData.cosAnim = 'pulse'; glow.userData.baseEmi = 1.0;
        return add(base, glow);
      }
      case 'login_pack': {
        const m = std('#3d4a38', { metalness: 0.35 });
        const body = box(0.36, 0.42, 0.18, m); body.position.set(0, -0.12, 0.12);
        const strap = box(0.08, 0.5, 0.04, std('#2a3228')); strap.position.set(0, -0.05, 0.02);
        return add(body, strap);
      }
      case 'trophy_dev': {
        // 开发者奖杯背饰：杯身 + 双耳 + 柱座，挂在背后
        const gold = std('#ffd23c', { metalness: 0.9, roughness: 0.28, emissive: '#8a6a00', emissiveIntensity: 0.45 });
        const darkGold = std('#c9a227', { metalness: 0.85, roughness: 0.35, emissive: '#5a4200', emissiveIntensity: 0.25 });
        const root = new T.Group();
        root.position.set(0, -0.02, 0.14);
        root.userData.cosAnim = 'spin';
        root.userData.spinSpeed = 0.55;
        root.userData.spinAxis = 'y';

        const cup = cyl(0.11, 0.08, 0.16, gold, 16); cup.position.y = 0.22;
        const rim = cyl(0.125, 0.12, 0.03, gold, 16); rim.position.y = 0.31;
        const stem = cyl(0.035, 0.045, 0.12, darkGold, 10); stem.position.y = 0.08;
        const knob = sph(0.05, gold, 10); knob.position.y = 0.14;
        const base = cyl(0.14, 0.16, 0.045, darkGold, 14); base.position.y = -0.01;
        const plate = cyl(0.11, 0.11, 0.02, gold, 14); plate.position.y = 0.02;
        root.add(cup, rim, stem, knob, base, plate);

        for (const side of [-1, 1]) {
          // 半环默认在 XY 面；只绕 Z 转向，保证左右都是正对的 C 形耳（开向杯身）
          const ear = new T.Mesh(
            new T.TorusGeometry(0.065, 0.016, 8, 18, Math.PI * 1.2),
            gold
          );
          ear.castShadow = true;
          ear.position.set(side * 0.125, 0.22, 0);
          ear.rotation.z = -side * (Math.PI / 2);
          root.add(ear);
        }

        const gem = sph(0.035, std('#35e0ff', { emissive: '#1ab8ff', emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.2 }), 10);
        gem.position.y = 0.36;
        gem.userData.cosAnim = 'pulse';
        gem.userData.baseEmi = 1.2;
        root.add(gem);

        return add(root);
      }
    }
    return g;
  }

  // ---------- 武器光效（枪身保持原色，环绕粒子/电弧/晶片等） ----------
  function inheritWeaponLayers(mesh, root) {
    let layerMask = null;
    mesh.traverse(o => { if (layerMask == null && o.layers) layerMask = o.layers.mask; });
    if (layerMask != null) root.traverse(o => { o.layers.mask = layerMask; });
  }

  function clearWeaponVfx(mesh) {
    const pack = mesh && mesh.userData && mesh.userData.weaponVfx;
    if (!pack) return;
    mesh.remove(pack.root);
    pack.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    mesh.userData.weaponVfx = null;
  }
  // 兼容旧调用名
  function clearPlasmaArcs(mesh) { clearWeaponVfx(mesh); }

  function makeLineArc(seg, color) {
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(seg * 3), 3));
    const mat = new T.LineBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending,
    });
    const line = new T.Line(geo, mat);
    line.frustumCulled = false;
    return line;
  }

  function ensureWeaponVfx(mesh, type) {
    const cur = mesh.userData.weaponVfx;
    if (cur && cur.type === type) return cur;
    clearWeaponVfx(mesh);

    const root = new T.Group();
    root.name = 'weaponVfx';
    const parts = [];

    if (type === 'fx_plasma') {
      for (let i = 0; i < 8; i++) {
        const line = makeLineArc(7, 0x7df9ff);
        line.userData.seed = Math.random() * 40 + i * 3.1;
        root.add(line);
        parts.push(line);
      }
    } else if (type === 'fx_ice') {
      for (let i = 0; i < 7; i++) {
        const crystal = new T.Mesh(
          new T.OctahedronGeometry(0.035, 0),
          std('#b8f0ff', { emissive: '#57d4ff', emissiveIntensity: 1.2, transparent: true, opacity: 0.9, metalness: 0.4, roughness: 0.2 })
        );
        crystal.userData.seed = i * 2.7 + Math.random();
        crystal.castShadow = false;
        root.add(crystal);
        parts.push(crystal);
      }
      for (let i = 0; i < 3; i++) {
        const mist = makeLineArc(5, 0xa8e8ff);
        mist.userData.seed = 10 + i * 4;
        mist.userData.kind = 'mist';
        root.add(mist);
        parts.push(mist);
      }
    } else if (type === 'fx_gold') {
      for (let i = 0; i < 10; i++) {
        const spark = new T.Mesh(
          new T.SphereGeometry(0.018, 6, 6),
          std('#ffd23c', { emissive: '#ffb000', emissiveIntensity: 1.6, transparent: true, opacity: 0.95 })
        );
        spark.userData.seed = i * 1.9 + Math.random() * 2;
        spark.castShadow = false;
        root.add(spark);
        parts.push(spark);
      }
    } else if (type === 'fx_rainbow') {
      for (let i = 0; i < 6; i++) {
        const orb = new T.Mesh(
          new T.SphereGeometry(0.028, 8, 8),
          std('#ffffff', { emissive: '#ffffff', emissiveIntensity: 1.4, transparent: true, opacity: 0.9 })
        );
        orb.userData.seed = i;
        orb.userData.hue = i / 6;
        orb.castShadow = false;
        root.add(orb);
        parts.push(orb);
      }
      for (let i = 0; i < 2; i++) {
        const ribbon = makeLineArc(8, 0xffffff);
        ribbon.userData.seed = 20 + i * 5;
        ribbon.userData.kind = 'ribbon';
        root.add(ribbon);
        parts.push(ribbon);
      }
    } else if (type === 'login_aura') {
      const ring = new T.Mesh(
        new T.TorusGeometry(0.16, 0.012, 8, 24),
        std('#2a1040', { emissive: '#b46bff', emissiveIntensity: 1.2, transparent: true, opacity: 0.85 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.userData.kind = 'auraRing';
      root.add(ring);
      parts.push(ring);
      for (let i = 0; i < 5; i++) {
        const mote = new T.Mesh(
          new T.SphereGeometry(0.02, 6, 6),
          std('#1a0828', { emissive: '#c07bff', emissiveIntensity: 1.5, transparent: true, opacity: 0.9 })
        );
        mote.userData.seed = i * 2.2;
        root.add(mote);
        parts.push(mote);
      }
    } else {
      return null;
    }

    mesh.add(root);
    inheritWeaponLayers(mesh, root);
    mesh.userData.weaponVfx = { type, root, parts };
    return mesh.userData.weaponVfx;
  }

  function updateWeaponVfx(mesh, type, time) {
    const pack = ensureWeaponVfx(mesh, type);
    if (!pack) return;
    const parts = pack.parts;

    if (type === 'fx_plasma') {
      for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        const seed = line.userData.seed;
        const t0 = time * 16 + seed;
        const blink = Math.sin(t0 * 2.6) + Math.sin(t0 * 5.1 + seed) * 0.5;
        line.visible = blink > -0.55;
        if (!line.visible) continue;
        const zBase = -0.05 - (i % 4) * 0.12 - Math.sin(t0 * 0.7) * 0.04;
        const len = 0.08 + Math.abs(Math.sin(t0 * 1.8 + seed)) * 0.32;
        const r = 0.045 + Math.abs(Math.sin(t0 * 2.4 + i)) * 0.13;
        const ang = t0 * 0.9 + i * 0.9;
        const attr = line.geometry.attributes.position;
        const seg = attr.count;
        for (let k = 0; k < seg; k++) {
          const u = k / (seg - 1);
          const z = zBase - len * u;
          const twist = ang + u * 2.2 + Math.sin(t0 * 3 + k) * 0.8;
          const jitter = Math.sin(t0 * 7 + k * 3.7 + seed) * r * 0.55;
          const rr = r * (0.55 + u * 0.7);
          attr.setXYZ(k, Math.cos(twist) * rr + jitter, Math.sin(twist) * rr * 0.75 + Math.cos(t0 * 4 + k) * r * 0.25, z);
        }
        attr.needsUpdate = true;
        line.geometry.computeBoundingSphere();
        line.material.color.setHSL(0.48 + Math.sin(t0 * 1.3) * 0.1, 0.95, 0.62);
        line.material.opacity = 0.4 + Math.abs(Math.sin(t0 * 3.2)) * 0.55;
      }
      return;
    }

    if (type === 'fx_ice') {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const seed = p.userData.seed;
        const t0 = time * 2.2 + seed;
        if (p.userData.kind === 'mist') {
          const attr = p.geometry.attributes.position;
          const seg = attr.count;
          const z0 = -0.15 - (i % 3) * 0.1;
          for (let k = 0; k < seg; k++) {
            const u = k / (seg - 1);
            const ang = t0 + u * 3;
            const rr = 0.06 + Math.sin(t0 * 2 + k) * 0.03;
            attr.setXYZ(k, Math.cos(ang) * rr, 0.04 + Math.sin(t0 + k) * 0.03, z0 - u * 0.25);
          }
          attr.needsUpdate = true;
          p.material.opacity = 0.25 + Math.abs(Math.sin(t0 * 2)) * 0.35;
          continue;
        }
        // 晶片环绕枪管飘浮、缓慢自旋
        const ang = t0 * 1.3 + seed;
        const r = 0.09 + Math.sin(t0 * 1.7) * 0.035;
        p.position.set(Math.cos(ang) * r, Math.sin(ang * 1.3) * 0.07, -0.1 - (seed % 5) * 0.08 + Math.sin(t0) * 0.03);
        p.rotation.set(t0 * 1.5, t0 * 2.1, t0 * 0.8);
        const s = 0.7 + Math.abs(Math.sin(t0 * 3)) * 0.55;
        p.scale.setScalar(s);
        p.material.emissiveIntensity = 0.8 + Math.sin(t0 * 4) * 0.5;
        p.material.opacity = 0.55 + Math.abs(Math.sin(t0 * 2.5)) * 0.4;
      }
      return;
    }

    if (type === 'fx_gold') {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const seed = p.userData.seed;
        const cycle = (time * 1.8 + seed) % 1;
        // 沿枪管上升的火花，到头重置
        const z = -0.05 - cycle * 0.55;
        const ang = seed * 2.1 + time * 3;
        const r = 0.05 + Math.sin(seed + time * 5) * 0.04;
        p.position.set(Math.cos(ang) * r, Math.sin(ang) * r * 0.7 + cycle * 0.06, z);
        const pop = cycle < 0.15 || cycle > 0.85 ? 1.4 : 0.7;
        p.scale.setScalar(pop * (0.6 + Math.sin(time * 12 + seed) * 0.3));
        p.visible = cycle > 0.02 && cycle < 0.95;
        p.material.emissiveIntensity = 1.2 + Math.sin(time * 10 + seed) * 0.6;
        p.material.opacity = 0.5 + (1 - cycle) * 0.45;
      }
      return;
    }

    if (type === 'fx_rainbow') {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const seed = p.userData.seed;
        if (p.userData.kind === 'ribbon') {
          const attr = p.geometry.attributes.position;
          const seg = attr.count;
          const baseHue = (time * 0.2 + seed * 0.1) % 1;
          for (let k = 0; k < seg; k++) {
            const u = k / (seg - 1);
            const ang = time * 2.5 + seed + u * 4;
            const rr = 0.1 + Math.sin(time * 3 + u * 5) * 0.04;
            attr.setXYZ(k, Math.cos(ang) * rr, Math.sin(ang * 0.8) * 0.08, -0.08 - u * 0.45);
          }
          attr.needsUpdate = true;
          p.material.color.setHSL((baseHue + 0.15) % 1, 0.9, 0.6);
          p.material.opacity = 0.45 + Math.sin(time * 4) * 0.2;
          continue;
        }
        const ang = time * 2.2 + seed * 1.05;
        const r = 0.11 + Math.sin(time * 2 + seed) * 0.03;
        p.position.set(Math.cos(ang) * r, Math.sin(ang * 1.2) * 0.08, -0.15 - Math.sin(seed + time) * 0.12);
        const hue = (p.userData.hue + time * 0.25) % 1;
        p.material.color.setHSL(hue, 0.9, 0.55);
        p.material.emissive.setHSL(hue, 0.95, 0.45);
        p.material.emissiveIntensity = 1.2 + Math.sin(time * 6 + seed) * 0.4;
        p.scale.setScalar(0.8 + Math.sin(time * 5 + seed) * 0.35);
      }
      return;
    }

    if (type === 'login_aura') {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.userData.kind === 'auraRing') {
          p.position.set(0, 0.02, -0.25);
          p.rotation.z = time * 2.2;
          p.scale.setScalar(0.9 + Math.sin(time * 3) * 0.15);
          p.material.emissiveIntensity = 1.0 + Math.sin(time * 4) * 0.5;
          continue;
        }
        const seed = p.userData.seed;
        const ang = time * 1.8 + seed;
        const r = 0.1 + Math.sin(time * 2 + seed) * 0.03;
        p.position.set(Math.cos(ang) * r, 0.03 + Math.sin(time * 3 + seed) * 0.05, -0.12 - Math.abs(Math.sin(ang)) * 0.2);
        p.material.emissiveIntensity = 1.1 + Math.sin(time * 5 + seed) * 0.5;
        p.scale.setScalar(0.7 + Math.abs(Math.sin(time * 4 + seed)) * 0.5);
      }
    }
  }

  function applyWeaponFx(model, fxId, time) {
    const mesh = model.weaponMesh || (model.viewWeapon || null);
    if (!mesh || !mesh.userData.fxMats) return;

    // 所有光效：枪身不染色，只播环绕特效
    for (const mat of mesh.userData.fxMats) {
      mat.emissive.set(0x000000);
      mat.emissiveIntensity = 0;
    }

    const fxTypes = { fx_plasma: 1, fx_ice: 1, fx_gold: 1, fx_rainbow: 1, login_aura: 1 };
    if (fxId && fxTypes[fxId]) {
      updateWeaponVfx(mesh, fxId, time);
      return;
    }
    clearWeaponVfx(mesh);
  }

  function applyCosmetics(model, eq) {
    const key = (eq.head || '') + '|' + (eq.face || '') + '|' + (eq.back || '');
    if (model._cosKey === key) return;
    model._cosKey = key;
    for (const a of [model.hatA, model.faceA, model.backA]) while (a.children.length) a.remove(a.children[0]);
    model.cosMats = [];
    const collect = grp => grp.traverse(o => { if (o.material) model.cosMats.push(o.material); });
    if (eq.head) { const c = buildCosmetic(eq.head); model.hatA.add(c); collect(c); }
    if (eq.face) { const c = buildCosmetic(eq.face); model.faceA.add(c); collect(c); }
    if (eq.back) { const c = buildCosmetic(eq.back); model.backA.add(c); collect(c); }
  }

  function animateCosmetics(model, time) {
    if (!model) return;
    const flap = Math.sin(time * 3.8);
    for (const a of [model.hatA, model.faceA, model.backA]) {
      if (!a) continue;
      a.traverse(o => {
        if (o.userData.wingSide) {
          const s = o.userData.wingSide;
          const amp = o.userData.flapAmp || 0.28;
          const base = o.userData.baseZ || 0.4;
          o.rotation.z = s * (base + flap * amp);
          o.rotation.y = s * flap * 0.1;
        }
        if (o.userData.cosAnim === 'flame' && o.material) {
          const ph = o.userData.phase || 0;
          o.material.emissiveIntensity = 1.15 + Math.sin(time * 14 + ph) * 0.75;
          const sy = 0.85 + Math.sin(time * 11 + ph) * 0.3;
          o.scale.set(1, sy, 1);
        }
        if (o.userData.cosAnim === 'sway') {
          o.rotation.x = (o.userData.baseX || 0.12) + Math.sin(time * 2.2) * 0.1;
          o.rotation.z = Math.sin(time * 1.7) * 0.06;
        }
        if (o.userData.cosAnim === 'spin') {
          const sp = o.userData.spinSpeed || 1.5;
          const axis = o.userData.spinAxis || 'y';
          if (axis === 'z') o.rotation.z = time * sp;
          else if (axis === 'x') o.rotation.x = time * sp;
          else o.rotation.y = time * sp;
        }
        if (o.userData.cosAnim === 'pulse' && o.material) {
          o.material.emissiveIntensity = (o.userData.baseEmi || 0.8) + Math.sin(time * 4.5) * 0.55;
        }
        if (o.userData.cosAnim === 'scan') {
          const minY = o.userData.scanMin != null ? o.userData.scanMin : -0.1;
          const maxY = o.userData.scanMax != null ? o.userData.scanMax : 0.12;
          const sp = o.userData.scanSpeed || 2.2;
          const t = (Math.sin(time * sp) + 1) * 0.5;
          o.position.y = minY + (maxY - minY) * t;
          if (o.material) o.material.emissiveIntensity = 1.2 + Math.sin(time * sp * 2) * 0.6;
        }
        if (o.userData.cosAnim === 'orbit') {
          const r = o.userData.orbitR || 0.35;
          const sp = o.userData.orbitSp || 2;
          const ph = o.userData.orbitPh || 0;
          o.position.x = Math.cos(time * sp + ph) * r;
          o.position.z = Math.sin(time * sp + ph) * r * 0.45;
          o.position.y = (o.userData.orbitY || 0.12) + Math.sin(time * sp * 1.4 + ph) * 0.07;
        }
        if (o.userData.cosAnim === 'ringOrbit') {
          const r = o.userData.ringR || 0.45;
          const sp = o.userData.ringSp || 1.2;
          const ph = o.userData.ringPh || 0;
          const tilt = o.userData.ringTilt || 0;
          const a = time * sp + ph;
          o.position.x = Math.cos(a) * r;
          o.position.y = Math.sin(a) * r * Math.cos(tilt);
          o.position.z = Math.sin(a) * r * Math.sin(tilt) * 0.35;
          if (o.material && o.material.emissive) {
            o.material.emissiveIntensity = 1.1 + Math.sin(time * 5 + ph) * 0.45;
          }
        }
      });
    }
  }

  // ---------- 外部 GLB ----------
  function prepareWeaponGltf(scene, cfg) {
    const root = new T.Group();
    const inner = scene;
    inner.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m) continue;
        if (m.map) m.map.encoding = T.sRGBEncoding;
        if (m.emissiveMap) m.emissiveMap.encoding = T.sRGBEncoding;
        m.needsUpdate = true;
      }
    });
    // -X(枪口) → -Z；握把侧 → +Z
    inner.rotation.set(0, cfg.rotY != null ? cfg.rotY : -Math.PI / 2, 0);
    inner.scale.setScalar(cfg.scale);
    const off = cfg.offset || { x: 0, y: 0, z: 0 };
    inner.position.set(off.x, off.y, off.z);
    root.add(inner);
    return root;
  }

  function buildWeaponFromGlb(wp) {
    const root = glbRoots[wp];
    if (!root) return null;
    const g = root.clone(true);
    const fxMats = [];
    g.traverse(o => {
      if (!o.isMesh || !o.material) return;
      if (Array.isArray(o.material)) {
        o.material = o.material.map(m => {
          const c = m.clone();
          fxMats.push(c);
          return c;
        });
      } else {
        o.material = o.material.clone();
        fxMats.push(o.material);
      }
    });
    g.userData.fxMats = fxMats;
    g.userData.fromGlb = true;
    return g;
  }

  function loadOneWeaponGlb(wp, cfg) {
    return new Promise(resolve => {
      if (glbRoots[wp]) { resolve(wp); return; }
      if (typeof T.GLTFLoader !== 'function') {
        console.warn('[models] GLTFLoader 未加载，' + wp + ' 使用程序化模型');
        resolve(null);
        return;
      }
      const loader = new T.GLTFLoader();
      loader.load(
        cfg.url,
        gltf => {
          glbRoots[wp] = prepareWeaponGltf(gltf.scene, cfg);
          resolve(wp);
        },
        undefined,
        err => {
          console.warn('[models] ' + wp + ' GLB 加载失败，回退程序化模型', err);
          resolve(null);
        }
      );
    });
  }

  function preloadAssets(onItem) {
    const entries = Object.keys(WEAPON_GLB).map(wp => ({ wp, cfg: WEAPON_GLB[wp] }));
    return Promise.all(entries.map(({ wp, cfg }) =>
      loadOneWeaponGlb(wp, cfg).then(id => {
        if (id && onItem) onItem(id);
        return id;
      })
    ));
  }

  function hasGlbWeapon(wp) {
    return !!glbRoots[wp];
  }

  // ---------- 武器 ----------
  function buildWeapon(wp) {
    const glb = buildWeaponFromGlb(wp);
    if (glb) return glb;
    const g = new T.Group();
    const metal = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
    const dark = std('#2e3238', { metalness: 0.6, roughness: 0.4 });
    const wood = std('#7a4f28');
    const fxMats = [];
    switch (wp) {
      case 'knife': {
        const blade = box(0.045, 0.02, 0.3, metal); blade.position.z = -0.18;
        const hilt = box(0.05, 0.05, 0.12, dark); hilt.position.z = 0.03;
        g.add(blade, hilt); fxMats.push(metal);
        break;
      }
      case 'sword': {
        const blade = box(0.07, 0.025, 0.8, metal); blade.position.z = -0.45;
        const guard = box(0.2, 0.03, 0.05, std('#c9a227', { metalness: 0.8 }));
        const hilt = box(0.05, 0.05, 0.18, dark); hilt.position.z = 0.1;
        g.add(blade, guard, hilt); fxMats.push(metal);
        break;
      }
      case 'hammer': {
        const handle = cylZ(0.035, 0.035, 0.65, wood); handle.position.z = -0.1;
        const headMat = std('#2e3238', { metalness: 0.6, roughness: 0.4 });
        const head = box(0.18, 0.18, 0.3, headMat); head.position.z = -0.42;
        g.add(handle, head); fxMats.push(headMat);
        break;
      }
      case 'pistol': {
        // USP-S 纯黑消音手枪
        const black = std('#141618', { metalness: 0.55, roughness: 0.42 });
        const matte = std('#1a1c20', { metalness: 0.4, roughness: 0.55 });
        const charcoal = std('#2a2e34', { metalness: 0.5, roughness: 0.48 });
        const steel = std('#4a5058', { metalness: 0.7, roughness: 0.38 });

        // —— 套筒（滑膛）——
        const slide = box(0.072, 0.055, 0.26, matte); slide.position.set(0, 0.045, -0.14);
        const slideTop = box(0.055, 0.012, 0.24, black); slideTop.position.set(0, 0.078, -0.14);
        const serrations = [];
        for (let i = 0; i < 5; i++) {
          const sL = box(0.01, 0.04, 0.012, black); sL.position.set(-0.038, 0.045, -0.02 - i * 0.018);
          const sR = box(0.01, 0.04, 0.012, black); sR.position.set(0.038, 0.045, -0.02 - i * 0.018);
          serrations.push(sL, sR);
        }
        const markBg = box(0.004, 0.02, 0.06, charcoal); markBg.position.set(0.038, 0.04, -0.12);
        const markLine = box(0.005, 0.006, 0.04, steel); markLine.position.set(0.039, 0.04, -0.12);

        // —— 机架 / 下机匣 ——
        const frame = box(0.068, 0.06, 0.2, matte); frame.position.set(0, -0.01, -0.08);
        const dustCover = box(0.05, 0.03, 0.1, black); dustCover.position.set(0, 0.01, -0.22);

        // —— 握把 ——
        const grip = box(0.055, 0.13, 0.08, matte); grip.position.set(0, -0.1, 0.04); grip.rotation.x = 0.22;
        const gripRidges = [];
        for (let i = 0; i < 6; i++) {
          const ridge = box(0.058, 0.01, 0.07, black);
          ridge.position.set(0, -0.055 - i * 0.018, 0.045);
          ridge.rotation.x = 0.22;
          gripRidges.push(ridge);
        }
        const backstrap = box(0.04, 0.12, 0.02, charcoal); backstrap.position.set(0, -0.09, 0.09); backstrap.rotation.x = 0.22;
        const magBase = box(0.05, 0.02, 0.07, black); magBase.position.set(0, -0.17, 0.03);

        // —— 扳机 ——
        const triggerGuard = box(0.04, 0.045, 0.07, charcoal); triggerGuard.position.set(0, -0.04, -0.02);
        const trigger = box(0.018, 0.035, 0.02, black); trigger.position.set(0, -0.03, -0.03);

        // —— 准星 ——
        const rearSight = box(0.04, 0.018, 0.02, black); rearSight.position.set(0, 0.09, -0.02);
        const rearNotchL = box(0.008, 0.016, 0.01, charcoal); rearNotchL.position.set(-0.012, 0.1, -0.02);
        const rearNotchR = box(0.008, 0.016, 0.01, charcoal); rearNotchR.position.set(0.012, 0.1, -0.02);
        const frontSight = box(0.01, 0.02, 0.012, black); frontSight.position.set(0, 0.095, -0.26);

        // —— 长消音器 ——
        const suppressor = cylZ(0.028, 0.028, 0.28, matte, 14); suppressor.position.set(0, 0.035, -0.42);
        const suppNose = cylZ(0.026, 0.022, 0.04, black, 14); suppNose.position.set(0, 0.035, -0.58);
        const suppTip = cylZ(0.02, 0.018, 0.03, charcoal, 12); suppTip.position.set(0, 0.035, -0.615);
        const suppRingF = cylZ(0.03, 0.03, 0.018, charcoal, 12); suppRingF.position.set(0, 0.035, -0.3);
        const suppRingM = cylZ(0.0305, 0.0305, 0.012, black, 12); suppRingM.position.set(0, 0.035, -0.4);
        const suppRingB = cylZ(0.03, 0.03, 0.018, charcoal, 12); suppRingB.position.set(0, 0.035, -0.52);
        const barrelStub = cylZ(0.014, 0.014, 0.06, steel, 10); barrelStub.position.set(0, 0.035, -0.28);

        g.add(
          slide, slideTop, ...serrations, markBg, markLine,
          frame, dustCover,
          grip, ...gripRidges, backstrap, magBase,
          triggerGuard, trigger,
          rearSight, rearNotchL, rearNotchR, frontSight,
          suppressor, suppNose, suppTip, suppRingF, suppRingM, suppRingB, barrelStub
        );
        fxMats.push(matte, black);
        break;
      }
      case 'mg': {
        // M249 风格轻机枪：白机匣 + 黑弹袋 + 弹链 + 脚架；整体缩小 30%
        const black = std('#1a1c20', { metalness: 0.45, roughness: 0.55 });
        const matte = std('#121418', { metalness: 0.35, roughness: 0.65 });
        const white = std('#e8ecef', { metalness: 0.25, roughness: 0.55 });
        const whiteDark = std('#c5ccd3', { metalness: 0.3, roughness: 0.5 });
        const steel = std('#6a727c', { metalness: 0.75, roughness: 0.35 });
        const brass = std('#c9a227', { metalness: 0.7, roughness: 0.35 });
        const hazardR = std('#e03030', { metalness: 0.2, roughness: 0.6 });
        const hazardW = std('#f2f4f6', { metalness: 0.15, roughness: 0.55 });

        // —— 枪管 + 消焰器 ——
        const barrel = cylZ(0.018, 0.018, 0.48, matte, 12, true); barrel.position.set(0, 0.04, -0.72);
        const gasBlock = box(0.04, 0.04, 0.06, black); gasBlock.position.set(0, 0.04, -0.52);
        const flash = cylZ(0.028, 0.022, 0.07, steel, 12); flash.position.set(0, 0.04, -0.98);
        const flashRing = muzzleRing(0.03, steel); flashRing.position.set(0, 0.04, -1.02);
        // 消焰器周向小孔（用短柱暗示）
        const vents = [];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const v = box(0.01, 0.01, 0.025, black);
          v.position.set(Math.cos(a) * 0.024, 0.04 + Math.sin(a) * 0.024, -0.98);
          vents.push(v);
        }
        // 准星
        const frontSightBase = box(0.025, 0.02, 0.04, black); frontSightBase.position.set(0, 0.07, -0.55);
        const frontSight = box(0.012, 0.045, 0.012, black); frontSight.position.set(0, 0.1, -0.55);

        // —— 护木 + 脚架 ——
        const handguard = box(0.09, 0.07, 0.2, black); handguard.position.set(0, 0.01, -0.4);
        const handguardLow = box(0.075, 0.035, 0.16, matte); handguardLow.position.set(0, -0.04, -0.38);
        const bipodMount = box(0.04, 0.03, 0.05, black); bipodMount.position.set(0, -0.07, -0.36);
        const bipodL = box(0.016, 0.016, 0.16, black); bipodL.position.set(-0.035, -0.1, -0.42); bipodL.rotation.x = 0.55; bipodL.rotation.z = 0.15;
        const bipodR = box(0.016, 0.016, 0.16, black); bipodR.position.set(0.035, -0.1, -0.42); bipodR.rotation.x = 0.55; bipodR.rotation.z = -0.15;
        const bipodFootL = box(0.03, 0.012, 0.04, steel); bipodFootL.position.set(-0.05, -0.155, -0.48);
        const bipodFootR = box(0.03, 0.012, 0.04, steel); bipodFootR.position.set(0.05, -0.155, -0.48);

        // —— 机匣：前黑 + 中段白面板 ——
        const recvFront = box(0.1, 0.12, 0.16, black); recvFront.position.set(0, 0.03, -0.22);
        const recvBody = box(0.105, 0.125, 0.28, white); recvBody.position.set(0, 0.035, 0.0);
        const recvTop = box(0.09, 0.035, 0.26, whiteDark); recvTop.position.set(0, 0.11, 0.0);
        // 白色面板横纹
        const lines = [];
        for (let i = 0; i < 7; i++) {
          const line = box(0.108, 0.008, 0.012, whiteDark);
          line.position.set(0, 0.08 - i * 0.018, 0.02);
          lines.push(line);
        }
        // 红白警示斜条（右侧面板）
        const haz = [];
        for (let i = 0; i < 4; i++) {
          const stripe = box(0.012, 0.05, 0.014, i % 2 ? hazardR : hazardW);
          stripe.position.set(0.055, 0.04, -0.02 + i * 0.022);
          stripe.rotation.x = 0.5;
          haz.push(stripe);
        }
        // 供弹口盖
        const feedCover = box(0.08, 0.04, 0.12, white); feedCover.position.set(0.02, 0.12, -0.06);
        const feedLip = box(0.06, 0.025, 0.04, black); feedLip.position.set(0.06, 0.1, -0.06);

        // —— 弹链（黄铜弹头从弹袋进入机匣右侧）——
        const belt = [];
        for (let i = 0; i < 8; i++) {
          const t = i / 7;
          const round = cylZ(0.01, 0.012, 0.035, brass, 8);
          round.position.set(0.08 + t * 0.02, 0.02 - t * 0.08, -0.04 + Math.sin(t * 1.2) * 0.02);
          round.rotation.z = 0.4 + t * 0.5;
          belt.push(round);
          const link = box(0.008, 0.008, 0.02, steel);
          link.position.set(0.075 + t * 0.02, 0.015 - t * 0.08, -0.04);
          belt.push(link);
        }

        // —— 黑色布制弹袋（鼓包软包）——
        const pouch = box(0.14, 0.12, 0.16, matte); pouch.position.set(0.02, -0.12, -0.02);
        const pouchRound = box(0.15, 0.1, 0.14, black); pouchRound.position.set(0.02, -0.14, -0.02);
        const pouchTop = box(0.12, 0.03, 0.14, black); pouchTop.position.set(0.02, -0.05, -0.02);
        const pouchStrap = box(0.04, 0.08, 0.02, steel); pouchStrap.position.set(0.02, -0.02, 0.06);

        // —— 握把 / 扳机 ——
        const grip = box(0.045, 0.12, 0.055, black); grip.position.set(0, -0.1, 0.14); grip.rotation.x = 0.25;
        const triggerGuard = box(0.038, 0.045, 0.06, matte); triggerGuard.position.set(0, -0.04, 0.1);
        const trigger = box(0.016, 0.03, 0.02, steel); trigger.position.set(0, -0.035, 0.08);

        // —— 后准星 ——
        const rearSightBase = box(0.035, 0.025, 0.05, black); rearSightBase.position.set(0, 0.12, 0.14);
        const rearSightL = box(0.01, 0.035, 0.01, black); rearSightL.position.set(-0.015, 0.145, 0.14);
        const rearSightR = box(0.01, 0.035, 0.01, black); rearSightR.position.set(0.015, 0.145, 0.14);

        // —— 骨架枪托 ——
        const stockTube = box(0.03, 0.03, 0.22, black); stockTube.position.set(0, 0.04, 0.28);
        const stockLower = box(0.025, 0.025, 0.18, matte); stockLower.position.set(0, -0.02, 0.26);
        const stockBrace = box(0.02, 0.08, 0.02, steel); stockBrace.position.set(0, 0.01, 0.22);
        const stockBrace2 = box(0.02, 0.08, 0.02, steel); stockBrace2.position.set(0, 0.01, 0.32);
        const butt = box(0.07, 0.14, 0.035, black); butt.position.set(0, 0.01, 0.4);
        const buttPad = box(0.075, 0.145, 0.015, matte); buttPad.position.set(0, 0.01, 0.425);

        g.add(
          barrel, gasBlock, flash, flashRing, ...vents, frontSightBase, frontSight,
          handguard, handguardLow, bipodMount, bipodL, bipodR, bipodFootL, bipodFootR,
          recvFront, recvBody, recvTop, ...lines, ...haz, feedCover, feedLip,
          ...belt, pouch, pouchRound, pouchTop, pouchStrap,
          grip, triggerGuard, trigger,
          rearSightBase, rearSightL, rearSightR,
          stockTube, stockLower, stockBrace, stockBrace2, butt, buttPad
        );
        // 左右镜像：供弹侧 / 弹链翻到持枪手外侧（画面右侧）
        for (const c of g.children) {
          c.position.x *= -1;
          c.rotation.y *= -1;
          c.rotation.z *= -1;
        }
        fxMats.push(white, brass, steel);
        const mgInner = new T.Group();
        mgInner.scale.setScalar(0.7);
        while (g.children.length) mgInner.add(g.children[0]);
        g.add(mgInner);
        break;
      }
      case 'shotgun': {
        // Mossberg 500 泵动散弹：通体哑光黑 + 抛壳窗银栓 + 长弹仓 + 肋纹泵木
        const black = std('#121416', { metalness: 0.35, roughness: 0.62 });
        const matte = std('#1a1c1e', { metalness: 0.28, roughness: 0.7 });
        const polymer = std('#222528', { metalness: 0.12, roughness: 0.82 });
        const polymerDark = std('#181a1c', { metalness: 0.1, roughness: 0.85 });
        const chrome = std('#d0d6dc', { metalness: 0.92, roughness: 0.18 });
        const bead = std('#c8ccd0', { metalness: 0.85, roughness: 0.25 });

        // —— 长枪管（几乎通到枪口）——
        const barrel = cylZ(0.026, 0.025, 0.72, matte, 14, true); barrel.position.set(0, 0.055, -0.52);
        const barrelMuzzle = cylZ(0.028, 0.026, 0.03, black, 12); barrelMuzzle.position.set(0, 0.055, -0.895);
        // 珠准星
        const beadSight = sph(0.008, bead, 8); beadSight.position.set(0, 0.078, -0.88);

        // —— 长弹仓管（几乎与枪管等长）——
        const magTube = cylZ(0.02, 0.02, 0.68, matte, 12, true); magTube.position.set(0, 0.005, -0.5);
        const magCap = cylZ(0.024, 0.022, 0.035, black, 12); magCap.position.set(0, 0.005, -0.86);
        // 枪口附近弹仓箍
        const barrelBand = box(0.055, 0.055, 0.025, black); barrelBand.position.set(0, 0.03, -0.82);

        // —— 黑色肋纹泵动护木 ——
        const pump = box(0.1, 0.085, 0.2, polymer); pump.position.set(0, 0.015, -0.28);
        const pumpUnder = box(0.085, 0.03, 0.18, polymerDark); pumpUnder.position.set(0, -0.035, -0.28);
        const pumpRibs = [];
        for (let i = 0; i < 11; i++) {
          const rib = box(0.104, 0.078, 0.01, polymerDark);
          rib.position.set(0, 0.015, -0.37 + i * 0.017);
          pumpRibs.push(rib);
        }
        const pumpCapF = box(0.105, 0.09, 0.018, black); pumpCapF.position.set(0, 0.015, -0.39);
        const pumpCapB = box(0.105, 0.09, 0.018, black); pumpCapB.position.set(0, 0.015, -0.17);
        // 泵木两侧导轨槽
        const pumpRailL = box(0.012, 0.04, 0.22, black); pumpRailL.position.set(-0.055, 0.03, -0.28);
        const pumpRailR = box(0.012, 0.04, 0.22, black); pumpRailR.position.set(0.055, 0.03, -0.28);

        // —— 机匣 ——
        const receiver = box(0.09, 0.11, 0.24, matte); receiver.position.set(0, 0.03, 0.0);
        const receiverTop = box(0.07, 0.025, 0.22, black); receiverTop.position.set(0, 0.095, 0.0);
        const receiverLow = box(0.075, 0.035, 0.2, black); receiverLow.position.set(0, -0.04, 0.0);
        // 顶置保险（Mossberg 特色）
        const tangSafety = box(0.035, 0.012, 0.04, polymer); tangSafety.position.set(0, 0.112, 0.08);
        // 抛壳窗 + 银色枪机（右侧）
        const ejectPort = box(0.014, 0.048, 0.085, black); ejectPort.position.set(0.048, 0.045, -0.02);
        const bolt = box(0.022, 0.038, 0.07, chrome); bolt.position.set(0.04, 0.045, -0.02);
        const boltFace = box(0.006, 0.03, 0.05, std('#e8ecef', { metalness: 0.95, roughness: 0.12 }));
        boltFace.position.set(0.052, 0.045, -0.02);

        // —— 扳机护圈（圆润）——
        const triggerGuard = box(0.038, 0.048, 0.08, black); triggerGuard.position.set(0, -0.055, 0.06);
        const triggerGuardCurve = cylZ(0.028, 0.028, 0.02, black, 10); triggerGuardCurve.position.set(0, -0.07, 0.06);
        const trigger = box(0.014, 0.038, 0.018, polymerDark); trigger.position.set(0, -0.045, 0.05);

        // —— 半手枪式一体枪托 ——
        const grip = box(0.05, 0.11, 0.07, polymer); grip.position.set(0, -0.09, 0.12); grip.rotation.x = 0.32;
        const gripCurve = box(0.048, 0.06, 0.05, polymerDark); gripCurve.position.set(0, -0.04, 0.1); gripCurve.rotation.x = 0.15;
        const stock = box(0.08, 0.11, 0.28, polymer); stock.position.set(0, 0.015, 0.3);
        const stockUpper = box(0.065, 0.04, 0.24, polymerDark); stockUpper.position.set(0, 0.08, 0.3);
        const stockWrist = box(0.06, 0.06, 0.08, polymer); stockWrist.position.set(0, 0.02, 0.16);
        // 枪托侧面微凹
        const stockInsetL = box(0.01, 0.07, 0.16, black); stockInsetL.position.set(-0.042, 0.02, 0.3);
        const stockInsetR = box(0.01, 0.07, 0.16, black); stockInsetR.position.set(0.042, 0.02, 0.3);
        // 厚橡胶脚垫
        const butt = box(0.09, 0.135, 0.045, black); butt.position.set(0, 0.01, 0.46);
        const buttPad = box(0.095, 0.14, 0.022, polymerDark); buttPad.position.set(0, 0.01, 0.49);
        const buttRibs = [];
        for (let i = 0; i < 4; i++) {
          const br = box(0.098, 0.018, 0.012, black);
          br.position.set(0, -0.04 + i * 0.03, 0.505);
          buttRibs.push(br);
        }

        g.add(
          barrel, barrelMuzzle, beadSight,
          magTube, magCap, barrelBand,
          pump, pumpUnder, ...pumpRibs, pumpCapF, pumpCapB, pumpRailL, pumpRailR,
          receiver, receiverTop, receiverLow, tangSafety, ejectPort, bolt, boltFace,
          triggerGuard, triggerGuardCurve, trigger,
          grip, gripCurve, stock, stockUpper, stockWrist, stockInsetL, stockInsetR,
          butt, buttPad, ...buttRibs
        );
        fxMats.push(chrome, matte, polymer);
        const shotgunInner = new T.Group();
        shotgunInner.scale.setScalar(0.7);
        while (g.children.length) shotgunInner.add(g.children[0]);
        g.add(shotgunInner);
        break;
      }
      case 'sniper': {
        // 工业桁架狙击：三槽枪口 + X 护木 + 方框 X 枪托；瞄准镜参考电磁炮
        const steel = std('#6a7888', { metalness: 0.72, roughness: 0.35 });
        const steelLite = std('#8fa0b0', { metalness: 0.78, roughness: 0.3 });
        const bodyMat = std('#4a5866', { metalness: 0.55, roughness: 0.45 });
        const bodyDark = std('#2e3844', { metalness: 0.5, roughness: 0.5 });
        const black = std('#14181e', { metalness: 0.55, roughness: 0.42 });
        const charcoal = std('#222830', { metalness: 0.5, roughness: 0.48 });
        const accent = std('#35e0ff', { emissive: '#1ab8e0', emissiveIntensity: 1.15, metalness: 0.3 });
        const amber = std('#ff9a3c', { emissive: '#c45a10', emissiveIntensity: 0.55, metalness: 0.35 });

        // —— 三槽矩形枪口制退器 ——
        const muzzleBlock = box(0.07, 0.07, 0.1, steel); muzzleBlock.position.set(0, 0.02, -1.22);
        const muzzleCap = box(0.075, 0.075, 0.02, steelLite); muzzleCap.position.set(0, 0.02, -1.28);
        const slotMats = [];
        for (let i = 0; i < 3; i++) {
          const slot = box(0.078, 0.014, 0.055, black);
          slot.position.set(0, 0.02 + (i - 1) * 0.022, -1.22);
          slotMats.push(slot);
        }
        const boreTip = box(0.028, 0.028, 0.04, charcoal); boreTip.position.set(0, 0.02, -1.3);

        // —— 细长枪管 ——
        const barrel = box(0.032, 0.032, 0.42, steel); barrel.position.set(0, 0.02, -0.94);
        const barrelCollar = box(0.05, 0.05, 0.03, steelLite); barrelCollar.position.set(0, 0.02, -0.72);

        // —— 桁架护木（三角 / X 镂空）——
        const forendFrameT = box(0.09, 0.018, 0.32, bodyMat); forendFrameT.position.set(0, 0.08, -0.52);
        const forendFrameB = box(0.09, 0.018, 0.32, bodyMat); forendFrameB.position.set(0, -0.04, -0.52);
        const forendFrameF = box(0.09, 0.12, 0.02, bodyDark); forendFrameF.position.set(0, 0.02, -0.68);
        const forendFrameR = box(0.09, 0.12, 0.02, bodyDark); forendFrameR.position.set(0, 0.02, -0.36);
        // 侧面 X 桁架（两侧各一组）
        const truss = [];
        for (const sx of [-1, 1]) {
          const rail = box(0.014, 0.1, 0.3, charcoal); rail.position.set(sx * 0.048, 0.02, -0.52);
          truss.push(rail);
          for (let i = 0; i < 3; i++) {
            const zx = -0.64 + i * 0.1;
            const d1 = box(0.012, 0.012, 0.12, steelLite);
            d1.position.set(sx * 0.052, 0.02, zx + 0.04);
            d1.rotation.x = 0.7;
            const d2 = box(0.012, 0.012, 0.12, steelLite);
            d2.position.set(sx * 0.052, 0.02, zx + 0.04);
            d2.rotation.x = -0.7;
            truss.push(d1, d2);
          }
        }
        const forendUnder = box(0.07, 0.03, 0.22, black); forendUnder.position.set(0, -0.07, -0.48);

        // —— 机匣 + 竖直散热肋 ——
        const receiver = box(0.1, 0.13, 0.34, bodyMat); receiver.position.set(0, 0.03, -0.1);
        const receiverTop = box(0.08, 0.035, 0.32, bodyDark); receiverTop.position.set(0, 0.11, -0.1);
        const receiverLow = box(0.085, 0.04, 0.26, charcoal); receiverLow.position.set(0, -0.06, -0.08);
        const ribs = [];
        for (let i = 0; i < 6; i++) {
          const rib = box(0.105, 0.09, 0.012, black);
          rib.position.set(0, 0.04, -0.22 + i * 0.04);
          ribs.push(rib);
        }
        // 顶轨 Picatinny
        const topRail = box(0.04, 0.018, 0.5, black); topRail.position.set(0, 0.135, -0.12);
        const railTeeth = [];
        for (let i = 0; i < 10; i++) {
          const tooth = box(0.042, 0.01, 0.014, charcoal);
          tooth.position.set(0, 0.148, 0.1 - i * 0.045);
          railTeeth.push(tooth);
        }

        // —— 下方大型弹匣 / 电源块 ——
        const mag = box(0.08, 0.14, 0.14, bodyDark); mag.position.set(0, -0.14, -0.08);
        const magLip = box(0.085, 0.02, 0.15, black); magLip.position.set(0, -0.07, -0.08);
        const magStripe = box(0.082, 0.02, 0.12, accent); magStripe.position.set(0, -0.16, -0.08);
        const magBolt1 = box(0.02, 0.02, 0.02, steelLite); magBolt1.position.set(0.03, -0.2, -0.08);
        const magBolt2 = box(0.02, 0.02, 0.02, steelLite); magBolt2.position.set(-0.03, -0.2, -0.08);

        // —— 瞄准镜（参考电磁炮：粗物镜 + 发光环）——
        const scopeMountF = box(0.038, 0.028, 0.045, black); scopeMountF.position.set(0, 0.165, -0.16);
        const scopeMountR = box(0.038, 0.028, 0.045, black); scopeMountR.position.set(0, 0.165, 0.02);
        const scopeBody = cylZ(0.04, 0.04, 0.22, black, 12); scopeBody.position.set(0, 0.21, -0.06);
        const scopeObj = cylZ(0.05, 0.046, 0.065, charcoal, 12); scopeObj.position.set(0, 0.21, -0.185);
        const scopeEye = cylZ(0.032, 0.036, 0.05, charcoal, 12); scopeEye.position.set(0, 0.21, 0.08);
        const scopeLensF = muzzleRing(0.05, steelLite); scopeLensF.position.set(0, 0.21, -0.22);
        const scopeLensR = muzzleRing(0.034, steelLite); scopeLensR.position.set(0, 0.21, 0.108);
        const scopeRing = muzzleRing(0.04, accent); scopeRing.position.set(0, 0.21, 0.04);
        const scopeBand = box(0.082, 0.012, 0.012, accent); scopeBand.position.set(0, 0.21, 0.04);

        // —— 握把 / 扳机 ——
        const grip = box(0.048, 0.13, 0.06, black); grip.position.set(0, -0.12, 0.1); grip.rotation.x = 0.28;
        const triggerGuard = box(0.04, 0.05, 0.08, charcoal); triggerGuard.position.set(0, -0.05, 0.04);
        const trigger = box(0.018, 0.035, 0.022, steel); trigger.position.set(0, -0.04, 0.01);

        // —— 方框 X 枪托 ——
        const stockBridge = box(0.08, 0.1, 0.08, bodyMat); stockBridge.position.set(0, 0.02, 0.16);
        const stockUpper = box(0.07, 0.025, 0.22, bodyDark); stockUpper.position.set(0, 0.1, 0.28);
        const stockLower = box(0.07, 0.025, 0.22, bodyDark); stockLower.position.set(0, -0.05, 0.28);
        const stockFront = box(0.07, 0.15, 0.025, charcoal); stockFront.position.set(0, 0.025, 0.18);
        const stockBack = box(0.075, 0.16, 0.03, charcoal); stockBack.position.set(0, 0.025, 0.4);
        // X 交叉支撑
        const x1 = box(0.02, 0.02, 0.22, steelLite); x1.position.set(0, 0.025, 0.29); x1.rotation.x = 0.55;
        const x2 = box(0.02, 0.02, 0.22, steelLite); x2.position.set(0, 0.025, 0.29); x2.rotation.x = -0.55;
        const xSideL = box(0.012, 0.12, 0.012, steel); xSideL.position.set(-0.04, 0.025, 0.29);
        const xSideR = box(0.012, 0.12, 0.012, steel); xSideR.position.set(0.04, 0.025, 0.29);
        // 脚垫 + 铆钉
        const butt = box(0.085, 0.175, 0.04, black); butt.position.set(0, 0.025, 0.44);
        const buttPad = box(0.09, 0.18, 0.018, charcoal); buttPad.position.set(0, 0.025, 0.47);
        const bolts = [];
        for (const [bx, by] of [[-0.025, 0.07], [0.025, 0.07], [-0.025, -0.02], [0.025, -0.02]]) {
          const bolt = box(0.016, 0.016, 0.012, amber);
          bolt.position.set(bx, by, 0.48);
          bolts.push(bolt);
        }

        g.add(
          muzzleBlock, muzzleCap, ...slotMats, boreTip,
          barrel, barrelCollar,
          forendFrameT, forendFrameB, forendFrameF, forendFrameR, ...truss, forendUnder,
          receiver, receiverTop, receiverLow, ...ribs, topRail, ...railTeeth,
          mag, magLip, magStripe, magBolt1, magBolt2,
          scopeMountF, scopeMountR, scopeBody, scopeObj, scopeEye,
          scopeLensF, scopeLensR, scopeRing, scopeBand,
          grip, triggerGuard, trigger,
          stockBridge, stockUpper, stockLower, stockFront, stockBack,
          x1, x2, xSideL, xSideR, butt, buttPad, ...bolts
        );
        fxMats.push(accent, steel, amber);
        const sniperInner = new T.Group();
        sniperInner.scale.setScalar(0.7);
        while (g.children.length) sniperInner.add(g.children[0]);
        g.add(sniperInner);
        break;
      }
      case 'railgun': {
        // 沙漠迷彩体素电磁狙击（对照参考：分叉加速口 / 长管 / 侧挂银电容 / 绿环镜）
        function voxelMat(baseHex, opt) {
          const c = document.createElement('canvas'); c.width = c.height = 16;
          const x = c.getContext('2d');
          const r = parseInt(baseHex.slice(1, 3), 16);
          const g0 = parseInt(baseHex.slice(3, 5), 16);
          const b = parseInt(baseHex.slice(5, 7), 16);
          for (let py = 0; py < 16; py++) {
            for (let px = 0; px < 16; px++) {
              const n = ((px * 7 + py * 13) % 5) - 2;
              const rr = Math.max(0, Math.min(255, r + n * 6));
              const gg = Math.max(0, Math.min(255, g0 + n * 5));
              const bb = Math.max(0, Math.min(255, b + n * 4));
              x.fillStyle = `rgb(${rr},${gg},${bb})`;
              x.fillRect(px, py, 1, 1);
            }
          }
          const tex = new T.CanvasTexture(c);
          tex.magFilter = T.NearestFilter;
          tex.minFilter = T.NearestFilter;
          tex.wrapS = tex.wrapT = T.RepeatWrapping;
          tex.repeat.set(2, 2);
          return new T.MeshStandardMaterial(Object.assign({
            map: tex, color: '#ffffff', roughness: 0.78, metalness: 0.2,
          }, opt || {}));
        }
        const tan = voxelMat('#cbb892', { metalness: 0.18, roughness: 0.74 });
        const tanDark = voxelMat('#a8926a', { metalness: 0.22, roughness: 0.7 });
        const tanDeep = voxelMat('#8f7a52', { metalness: 0.25, roughness: 0.68 });
        const black = std('#1a1c20', { metalness: 0.55, roughness: 0.42 });
        const charcoal = std('#2a2e34', { metalness: 0.5, roughness: 0.48 });
        const slate = std('#3a4048', { metalness: 0.62, roughness: 0.4 });
        const silver = voxelMat('#b8bec8', { metalness: 0.72, roughness: 0.32 });
        const silverLite = voxelMat('#d4d8de', { metalness: 0.65, roughness: 0.35 });
        const green = std('#7dff4a', { emissive: '#3cff18', emissiveIntensity: 1.2, metalness: 0.2 });

        // —— 分叉加速口：上下叉 + 侧视三角尖（中空弹道）——
        const muzzleHub = box(0.11, 0.11, 0.08, tan); muzzleHub.position.set(0, 0.02, -1.16);
        const prongT = box(0.1, 0.038, 0.18, tan); prongT.position.set(0, 0.055, -1.28);
        const prongB = box(0.1, 0.038, 0.18, tan); prongB.position.set(0, -0.015, -1.28);
        const tipT = box(0.08, 0.032, 0.08, tanDark); tipT.position.set(0, 0.052, -1.4);
        const tipB = box(0.08, 0.032, 0.08, tanDark); tipB.position.set(0, -0.012, -1.4);
        const tipPoint = box(0.055, 0.055, 0.045, tanDeep); tipPoint.position.set(0, 0.02, -1.455);
        const cutT = box(0.055, 0.018, 0.05, black); cutT.position.set(0, 0.07, -1.3);
        const cutB = box(0.055, 0.018, 0.05, black); cutB.position.set(0, -0.03, -1.3);
        const cutSide = box(0.014, 0.055, 0.06, black); cutSide.position.set(0.055, 0.02, -1.3);
        const bore = box(0.06, 0.028, 0.2, charcoal); bore.position.set(0, 0.02, -1.28);

        // —— 细长深灰六角枪管 ——
        const barrel = box(0.036, 0.036, 0.48, slate); barrel.position.set(0, 0.02, -0.88);
        const barrelFlatT = box(0.026, 0.01, 0.46, charcoal); barrelFlatT.position.set(0, 0.04, -0.88);
        const barrelFlatB = box(0.026, 0.01, 0.46, charcoal); barrelFlatB.position.set(0, 0.0, -0.88);
        const barrelFlatL = box(0.01, 0.026, 0.46, charcoal); barrelFlatL.position.set(-0.02, 0.02, -0.88);
        const barrelFlatR = box(0.01, 0.026, 0.46, charcoal); barrelFlatR.position.set(0.02, 0.02, -0.88);
        const collar = box(0.06, 0.06, 0.04, silver); collar.position.set(0, 0.02, -0.62);
        const collarRing = box(0.065, 0.065, 0.012, silverLite); collarRing.position.set(0, 0.02, -0.6);

        // —— 粗护木（六角截面感）——
        const forend = box(0.14, 0.15, 0.3, tan); forend.position.set(0, 0.02, -0.42);
        const forendBevelT = box(0.1, 0.03, 0.28, tanDark); forendBevelT.position.set(0, 0.105, -0.42);
        const forendBevelL = box(0.02, 0.1, 0.28, tanDeep); forendBevelL.position.set(-0.075, 0.02, -0.42);
        const forendBevelR = box(0.02, 0.1, 0.28, tanDeep); forendBevelR.position.set(0.075, 0.02, -0.42);
        const forendUnder = box(0.11, 0.045, 0.24, black); forendUnder.position.set(0, -0.075, -0.4);
        const vents = [];
        for (let i = 0; i < 5; i++) {
          const vz = -0.54 + i * 0.05;
          const vL = box(0.014, 0.06, 0.026, black); vL.position.set(-0.078, 0.035, vz);
          const vR = box(0.014, 0.06, 0.026, black); vR.position.set(0.078, 0.035, vz);
          const vT = box(0.05, 0.012, 0.022, black); vT.position.set(0, 0.12, vz);
          vents.push(vL, vR, vT);
        }
        // 下挂银黑电容筒
        const underCap = cylZ(0.03, 0.03, 0.15, silver, 10); underCap.position.set(0, -0.12, -0.38);
        const underBandF = cylZ(0.034, 0.034, 0.022, black, 10); underBandF.position.set(0, -0.12, -0.445);
        const underBandM = cylZ(0.034, 0.034, 0.018, charcoal, 10); underBandM.position.set(0, -0.12, -0.38);
        const underBandB = cylZ(0.034, 0.034, 0.022, black, 10); underBandB.position.set(0, -0.12, -0.315);
        const underMount = box(0.045, 0.035, 0.1, charcoal); underMount.position.set(0, -0.09, -0.38);

        // —— 机匣 ——
        const receiver = box(0.125, 0.155, 0.38, tan); receiver.position.set(0, 0.03, -0.06);
        const receiverTop = box(0.095, 0.04, 0.36, tanDark); receiverTop.position.set(0, 0.125, -0.06);
        const receiverLow = box(0.105, 0.05, 0.3, charcoal); receiverLow.position.set(0, -0.07, -0.03);
        const cheek = box(0.022, 0.09, 0.2, tanDeep); cheek.position.set(-0.072, 0.04, 0.0);
        const mechBlock = box(0.04, 0.07, 0.1, black); mechBlock.position.set(0.055, 0.05, -0.18);
        const topRail = box(0.042, 0.02, 0.44, black); topRail.position.set(0, 0.15, -0.1);
        for (let i = 0; i < 9; i++) {
          const tooth = box(0.044, 0.01, 0.015, slate);
          tooth.position.set(0, 0.163, 0.08 - i * 0.045);
          g.add(tooth);
        }

        // —— 提把（镜前黑色 U 形）——
        const handleBase = box(0.038, 0.018, 0.09, black); handleBase.position.set(0, 0.165, -0.28);
        const handleL = box(0.014, 0.075, 0.028, black); handleL.position.set(-0.022, 0.205, -0.28);
        const handleR = box(0.014, 0.075, 0.028, black); handleR.position.set(0.022, 0.205, -0.28);
        const handleTop = box(0.058, 0.014, 0.032, black); handleTop.position.set(0, 0.245, -0.28);

        // —— 大型狙击镜 + 荧光绿环 ——
        const scopeMountF = box(0.04, 0.03, 0.05, black); scopeMountF.position.set(0, 0.18, -0.14);
        const scopeMountR = box(0.04, 0.03, 0.05, black); scopeMountR.position.set(0, 0.18, 0.04);
        const scopeBody = cylZ(0.044, 0.044, 0.24, black, 12); scopeBody.position.set(0, 0.225, -0.04);
        const scopeObj = cylZ(0.052, 0.048, 0.07, charcoal, 12); scopeObj.position.set(0, 0.225, -0.175);
        const scopeEye = cylZ(0.034, 0.038, 0.055, charcoal, 12); scopeEye.position.set(0, 0.225, 0.11);
        const scopeLensF = muzzleRing(0.052, slate); scopeLensF.position.set(0, 0.225, -0.21);
        const scopeLensR = muzzleRing(0.036, slate); scopeLensR.position.set(0, 0.225, 0.14);
        const scopeGreen = muzzleRing(0.042, green); scopeGreen.position.set(0, 0.225, 0.055);
        const scopeGreenBand = box(0.086, 0.014, 0.014, green); scopeGreenBand.position.set(0, 0.225, 0.055);

        // —— 右侧超大银电容弹匣 ——
        const cellBase = box(0.065, 0.11, 0.17, black); cellBase.position.set(0.1, -0.015, 0.04);
        const cell = box(0.1, 0.13, 0.2, silver); cell.position.set(0.155, 0.025, 0.04);
        const cellTop = box(0.095, 0.016, 0.19, silverLite); cellTop.position.set(0.155, 0.095, 0.04);
        const cellCapF = box(0.022, 0.11, 0.18, charcoal); cellCapF.position.set(0.21, 0.02, 0.04);
        const cellCapB = box(0.022, 0.11, 0.18, charcoal); cellCapB.position.set(0.1, 0.02, 0.04);
        const cellDots = [];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 5; c++) {
            const dot = box(0.01, 0.006, 0.01, charcoal);
            dot.position.set(0.125 + r * 0.028, 0.105, -0.035 + c * 0.035);
            cellDots.push(dot);
          }
        }
        const cellMark1 = box(0.008, 0.018, 0.018, silverLite); cellMark1.position.set(0.215, 0.055, 0.0);
        const cellMark2 = box(0.008, 0.018, 0.018, silverLite); cellMark2.position.set(0.215, 0.055, 0.06);

        // —— 枪托 + 波纹脚垫 ——
        const stock = box(0.115, 0.145, 0.24, tan); stock.position.set(0, 0.02, 0.26);
        const stockUpper = box(0.095, 0.05, 0.2, tanDark); stockUpper.position.set(0, 0.115, 0.24);
        const stockBridge = box(0.085, 0.035, 0.12, charcoal); stockBridge.position.set(0, 0.105, 0.14);
        const stockCable = box(0.04, 0.04, 0.16, black); stockCable.position.set(0.045, -0.015, 0.2);
        const stockCable2 = box(0.028, 0.028, 0.1, slate); stockCable2.position.set(-0.04, -0.02, 0.18);
        const stockLower = box(0.095, 0.04, 0.18, black); stockLower.position.set(0, -0.07, 0.22);
        const buttCore = box(0.125, 0.17, 0.045, charcoal); buttCore.position.set(0, 0.01, 0.4);
        const ribs = [];
        for (let i = 0; i < 6; i++) {
          const rib = box(0.13, 0.016, 0.03, black);
          rib.position.set(0, -0.055 + i * 0.028, 0.435);
          ribs.push(rib);
        }

        // —— 握把 / 扳机 ——
        const grip = box(0.052, 0.135, 0.065, black); grip.position.set(0, -0.125, 0.1); grip.rotation.x = 0.22;
        const triggerGuard = box(0.042, 0.048, 0.075, charcoal); triggerGuard.position.set(0, -0.055, 0.035);
        const trigger = box(0.02, 0.035, 0.025, slate); trigger.position.set(0, -0.045, 0.0);

        g.add(
          muzzleHub, prongT, prongB, tipT, tipB, tipPoint, cutT, cutB, cutSide, bore,
          barrel, barrelFlatT, barrelFlatB, barrelFlatL, barrelFlatR, collar, collarRing,
          forend, forendBevelT, forendBevelL, forendBevelR, forendUnder, ...vents,
          underCap, underBandF, underBandM, underBandB, underMount,
          receiver, receiverTop, receiverLow, cheek, mechBlock, topRail,
          handleBase, handleL, handleR, handleTop,
          scopeMountF, scopeMountR, scopeBody, scopeObj, scopeEye,
          scopeLensF, scopeLensR, scopeGreen, scopeGreenBand,
          cellBase, cell, cellTop, cellCapF, cellCapB, ...cellDots, cellMark1, cellMark2,
          stock, stockUpper, stockBridge, stockCable, stockCable2, stockLower, buttCore, ...ribs,
          grip, triggerGuard, trigger
        );
        // 左右镜像：银电容弹匣翻到枪身右侧（持枪手外侧）
        for (const c of g.children) {
          c.position.x *= -1;
          c.rotation.y *= -1;
          c.rotation.z *= -1;
        }
        fxMats.push(green, silver, tan);
        // 内层缩放：避免 makePickup / 军火库 setScalar 覆盖导致缩小失效
        const railInner = new T.Group();
        railInner.scale.setScalar(0.7);
        while (g.children.length) railInner.add(g.children[0]);
        g.add(railInner);
        break;
      }
      case 'charge': {
        // Titanfall / Apex Defender Charge Rifle：橄榄机体 + 橙迷彩枪托 + 四叉枪口 + 侧挂电池筒
        const olive = std('#5a6b3e', { metalness: 0.35, roughness: 0.62 });
        const oliveDark = std('#3f4a2e', { metalness: 0.4, roughness: 0.58 });
        const camo = std('#c45a1a', { metalness: 0.25, roughness: 0.7 });
        const camoDark = std('#8a3a10', { metalness: 0.3, roughness: 0.65 });
        const black = std('#1a1c1e', { metalness: 0.55, roughness: 0.45 });
        const metal = std('#8a9098', { metalness: 0.82, roughness: 0.28 });
        const cellMat = std('#e8ecef', { metalness: 0.55, roughness: 0.35 });
        const haz = std('#1a1a1a', { metalness: 0.5, roughness: 0.4 });
        const hazStripe = std('#e8b84a', { metalness: 0.4, roughness: 0.45, emissive: '#8a6000', emissiveIntensity: 0.4 });
        const glowCore = std('#ff9a3c', { emissive: '#ff6a00', emissiveIntensity: 1.2, metalness: 0.3 });
        const sightRed = std('#ff3030', { emissive: '#ff1010', emissiveIntensity: 1.6 });

        const receiver = box(0.13, 0.15, 0.38, olive); receiver.position.set(0, 0.02, -0.02);
        const receiverTop = box(0.11, 0.06, 0.36, oliveDark); receiverTop.position.set(0, 0.12, -0.04);
        const stockBody = box(0.12, 0.16, 0.28, camo); stockBody.position.set(0, 0.02, 0.28);
        const stockPanel = box(0.02, 0.12, 0.2, camoDark); stockPanel.position.set(0.07, 0.03, 0.28);
        const stockPanelL = box(0.02, 0.12, 0.2, camoDark); stockPanelL.position.set(-0.07, 0.03, 0.28);
        const butt = box(0.13, 0.18, 0.05, black); butt.position.set(0, 0.0, 0.44);
        const stockBridge = box(0.1, 0.04, 0.14, oliveDark); stockBridge.position.set(0, 0.12, 0.22);
        const stockLower = box(0.09, 0.04, 0.16, black); stockLower.position.set(0, -0.08, 0.18);
        const grip = box(0.05, 0.14, 0.07, black); grip.position.set(0, -0.1, 0.08); grip.rotation.x = 0.22;
        const triggerGuard = box(0.04, 0.05, 0.08, black); triggerGuard.position.set(0, -0.04, 0.02);

        const forend = box(0.12, 0.13, 0.22, olive); forend.position.set(0, 0.02, -0.32);
        const forendUnder = box(0.1, 0.05, 0.18, black); forendUnder.position.set(0, -0.06, -0.3);
        const foregrip = box(0.045, 0.1, 0.07, black); foregrip.position.set(0, -0.12, -0.28); foregrip.rotation.x = -0.55;

        const prongT = box(0.055, 0.028, 0.28, metal); prongT.position.set(0, 0.09, -0.58);
        const prongB = box(0.055, 0.028, 0.28, metal); prongB.position.set(0, -0.05, -0.58);
        const prongL = box(0.028, 0.05, 0.2, metal); prongL.position.set(-0.07, 0.02, -0.54);
        const prongR = box(0.028, 0.05, 0.2, metal); prongR.position.set(0.07, 0.02, -0.54);
        const warnT = box(0.03, 0.012, 0.04, cellMat); warnT.position.set(0, 0.11, -0.5);
        const warnB = box(0.03, 0.012, 0.04, cellMat); warnB.position.set(0, -0.07, -0.5);
        const coreOuter = cylZ(0.038, 0.042, 0.22, haz, 12, true); coreOuter.position.set(0, 0.02, -0.52);
        const stripe1 = box(0.01, 0.07, 0.18, hazStripe); stripe1.position.set(0.035, 0.02, -0.52); stripe1.rotation.z = 0.4;
        const stripe2 = box(0.01, 0.07, 0.18, hazStripe); stripe2.position.set(-0.035, 0.02, -0.52); stripe2.rotation.z = -0.4;
        const tipCore = cylZ(0.022, 0.016, 0.08, glowCore, 12); tipCore.position.set(0, 0.02, -0.66);
        const tipRing = muzzleRing(0.045, glowCore); tipRing.position.set(0, 0.02, -0.7);

        // 双侧弹鼓电池组（左右对称）
        const drums = [];
        for (const side of [-1, 1]) {
          const sx = side * 0.1;
          const rack = box(0.06, 0.17, 0.24, black); rack.position.set(sx, 0.02, -0.08);
          const cap = box(0.065, 0.035, 0.26, oliveDark); cap.position.set(sx, 0.13, -0.08);
          const base = box(0.065, 0.03, 0.26, oliveDark); base.position.set(sx, -0.08, -0.08);
          drums.push(rack, cap, base);
          for (let i = 0; i < 5; i++) {
            // 粗圆柱弹鼓单元
            const drum = cyl(0.028, 0.028, 0.14, cellMat);
            drum.position.set(side * 0.122, 0.02, -0.19 + i * 0.048);
            drums.push(drum);
            // 外圈金属箍，更像弹鼓
            const hoop = cyl(0.032, 0.032, 0.02, metal);
            hoop.position.set(side * 0.122, 0.02, -0.19 + i * 0.048);
            drums.push(hoop);
          }
        }

        const rail = box(0.04, 0.025, 0.42, black); rail.position.set(0, 0.16, -0.08);
        for (let i = 0; i < 7; i++) {
          const tooth = box(0.042, 0.012, 0.018, metal);
          tooth.position.set(0, 0.175, 0.1 - i * 0.055);
          g.add(tooth);
        }
        const opticBase = box(0.05, 0.03, 0.08, black); opticBase.position.set(0, 0.19, 0.06);
        const optic = box(0.06, 0.04, 0.07, black); optic.position.set(0, 0.23, 0.06);
        const opticLens = box(0.045, 0.03, 0.01, sightRed); opticLens.position.set(0, 0.23, 0.025);
        const logo = box(0.008, 0.05, 0.07, black); logo.position.set(0.078, 0.05, 0.28);

        g.add(
          receiver, receiverTop, stockBody, stockPanel, stockPanelL, butt, stockBridge, stockLower,
          grip, triggerGuard, forend, forendUnder, foregrip,
          prongT, prongB, prongL, prongR, warnT, warnB,
          coreOuter, stripe1, stripe2, tipCore, tipRing,
          ...drums,
          rail, opticBase, optic, opticLens, logo
        );
        fxMats.push(glowCore, hazStripe, sightRed, camo);
        const chargeInner = new T.Group();
        chargeInner.scale.setScalar(0.7);
        while (g.children.length) chargeInner.add(g.children[0]);
        g.add(chargeInner);
        break;
      }
      case 'nade': {
        const b = sph(0.09, std('#3c5232', { roughness: 0.5 }));
        const topMat = std('#9aa4b0', { metalness: 0.8, roughness: 0.3 });
        const top = cyl(0.03, 0.03, 0.05, topMat); top.position.y = 0.1;
        g.add(b, top); fxMats.push(topMat);
        break;
      }
      case 'flash': {   // 闪光弹：银色小罐 + 白色发光环
        const bodyMat = std('#c8ccd4', { metalness: 0.75, roughness: 0.25 });
        const body = cyl(0.05, 0.05, 0.16, bodyMat);
        const band = cyl(0.053, 0.053, 0.035, new T.MeshStandardMaterial({ color: '#ffffff', emissive: '#dfeaff', emissiveIntensity: 0.8 }));
        band.position.y = 0.03;
        const top = cyl(0.028, 0.028, 0.04, std('#2e3238', { metalness: 0.6 })); top.position.y = 0.1;
        g.add(body, band, top); fxMats.push(bodyMat);
        break;
      }
      case 'smoke': {   // 烟雾弹：灰罐 + 黄色警示环
        const bodyMat = std('#5a626e', { roughness: 0.55 });
        const body = cyl(0.06, 0.06, 0.2, bodyMat);
        const band = cyl(0.063, 0.063, 0.04, std('#ffd23c', { emissive: '#7a5f00', emissiveIntensity: 0.4 }));
        band.position.y = 0.04;
        const top = cyl(0.03, 0.03, 0.04, std('#2e3238', { metalness: 0.6 })); top.position.y = 0.12;
        g.add(body, band, top); fxMats.push(bodyMat);
        break;
      }
    }
    g.userData.fxMats = fxMats;
    return g;
  }

  // ---------- 拾取物 ----------
  function makePickup(item, defs) {
    const g = new T.Group();
    if (defs.weapons[item]) {
      const w = buildWeapon(item);
      w.scale.setScalar(1.5);
      w.position.y = 0.75;
      g.add(w);
      g.userData.glow = '#35e0ff';
    } else if (defs.equips[item]) {
      if (item === 'health') {
        const b = box(0.5, 0.34, 0.5, std('#f2f5f7'));
        b.position.y = 0.7;
        const c1 = box(0.3, 0.09, 0.06, std('#e33', { emissive: '#e33', emissiveIntensity: 0.5 })); c1.position.set(0, 0.7, -0.26);
        const c2 = box(0.09, 0.3, 0.06, c1.material); c2.position.set(0, 0.7, -0.26);
        g.add(b, c1, c2); g.userData.glow = '#6dff9a';
      } else if (item === 'armor') {
        const b = box(0.44, 0.5, 0.2, std('#2f6fb2', { emissive: '#1a4a80', emissiveIntensity: 0.5, metalness: 0.5 }));
        b.position.y = 0.75;
        g.add(b); g.userData.glow = '#4d9fff';
      } else {
        const m = std('#d9822b', { emissive: '#8a4a10', emissiveIntensity: 0.5 });
        const b1 = box(0.16, 0.2, 0.34, m); b1.position.set(-0.12, 0.6, 0);
        const b2 = b1.clone(); b2.position.x = 0.12;
        g.add(b1, b2); g.userData.glow = '#ffa94d';
      }
    } else if (defs.buffs[item]) {
      const col = defs.buffs[item].color;
      const orb = sph(0.26, new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.1, roughness: 0.3 }));
      orb.position.y = 0.85;
      const ring = new T.Mesh(new T.TorusGeometry(0.38, 0.03, 8, 24),
        new T.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }));
      ring.position.y = 0.85; ring.rotation.x = Math.PI / 2;
      g.add(orb, ring); g.userData.glow = col;
    }
    // 底座光环
    const base = new T.Mesh(new T.RingGeometry(0.45, 0.6, 24),
      new T.MeshBasicMaterial({ color: g.userData.glow || '#35e0ff', transparent: true, opacity: 0.5, side: T.DoubleSide }));
    base.rotation.x = -Math.PI / 2; base.position.y = 0.03;
    g.add(base);
    return g;
  }

  // ---------- BOSS（五种特色类型） ----------
  function finishBoss(g, name, color, plateY, light) {
    const plate = makeNameplate('👹 ' + name, '#ff9c5c');
    plate.position.y = plateY; plate.scale.set(3.2, 0.8, 1);
    g.add(plate);
    const pl = new T.PointLight(color, 0.9, 10); pl.position.y = plateY * 0.5; g.add(pl);
    const mats = [];
    g.traverse(o => { if (o.material && o !== plate) mats.push(o.material); });
    return { plate, mats };
  }
  function setBossOpacity(m, a) {
    for (const mat of m.mats) {
      if (mat.userData && mat.userData.baseOpacity != null) {
        mat.transparent = a < 0.99 || mat.userData.baseOpacity < 0.99;
        mat.opacity = mat.userData.baseOpacity * a;
      } else {
        mat.transparent = a < 0.99; mat.opacity = a;
      }
      mat.depthWrite = a >= 0.5;
    }
    m.plate.visible = a > 0.5;
  }

  function makeBoss(type, name, color) {
    const g = new T.Group();
    let model;
    if (type === 'assassin') {
      // 暗影刺客：修长身形 + 双刃 + 破斗篷
      const dark = std('#1c1730', { roughness: 0.6 });
      const glow = new T.MeshStandardMaterial({ color: '#12081f', emissive: color, emissiveIntensity: 1.6 });
      const legGeo = new T.BoxGeometry(0.18, 0.85, 0.2); legGeo.translate(0, -0.42, 0);
      const legL = new T.Mesh(legGeo, dark); legL.castShadow = true; legL.position.set(-0.15, 0.85, 0);
      const legR = new T.Mesh(legGeo.clone(), dark); legR.castShadow = true; legR.position.x = 0.15; legR.position.y = 0.85;
      const body = box(0.55, 0.85, 0.32, dark); body.position.y = 1.3;
      const strap = box(0.58, 0.1, 0.35, glow); strap.position.y = 1.45; strap.rotation.z = 0.5;
      const hood = cone(0.3, 0.55, dark); hood.position.y = 2.0;
      const face = sph(0.18, std('#0a0714'), 8); face.position.set(0, 1.86, -0.12);
      const eyeM = new T.MeshStandardMaterial({ color: '#000', emissive: color, emissiveIntensity: 2.5 });
      const e1 = sph(0.035, eyeM, 6); e1.position.set(-0.07, 1.88, -0.26);
      const e2 = e1.clone(); e2.position.x = 0.07;
      const armGeo = new T.BoxGeometry(0.14, 0.7, 0.16); armGeo.translate(0, -0.32, 0);
      const armL = new T.Mesh(armGeo, dark); armL.castShadow = true; armL.position.set(-0.38, 1.62, 0);
      const armR = new T.Mesh(armGeo.clone(), dark); armR.castShadow = true; armR.position.set(0.38, 1.62, 0);
      for (const arm of [armL, armR]) {
        const blade = box(0.03, 0.5, 0.09, glow); blade.position.set(0, -0.75, -0.05);
        arm.add(blade);
      }
      const cape = new T.Mesh(new T.PlaneGeometry(0.6, 1.1), std('#241b3d', { side: T.DoubleSide }));
      cape.position.set(0, 1.2, 0.2); cape.rotation.x = 0.15;
      g.add(legL, legR, body, strap, hood, face, e1, e2, armL, armR, cape);
      const fin = finishBoss(g, name, color, 2.75);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 11 : 1.5);
        model.slamT += dt;
        const sw = Math.sin(model.walkT) * 0.7;
        legL.rotation.x = sw; legR.rotation.x = -sw;
        if (model.slamT < 0.3) {           // 疾斩：前倾突刺
          const k = Math.sin(model.slamT / 0.3 * Math.PI);
          armL.rotation.x = -2 * k; armR.rotation.x = -2 * k;
          g.rotation.x = 0.25 * k;
        } else {
          g.rotation.x = 0;
          armL.rotation.x = -0.5 + Math.sin(model.walkT) * 0.3;
          armR.rotation.x = -0.5 - Math.sin(model.walkT) * 0.3;
        }
      };
    } else if (type === 'warmachine') {
      // 钢铁暴君：重装机体 + 双管机炮
      const metal = std('#4a525e', { metalness: 0.7, roughness: 0.35 });
      const darkM = std('#2b3038', { metalness: 0.6, roughness: 0.45 });
      const redGlow = new T.MeshStandardMaterial({ color: '#1a0505', emissive: '#ff2e2e', emissiveIntensity: 2 });
      const trackL = box(1.0, 0.85, 2.0, darkM); trackL.position.set(-0.75, 0.45, 0);
      const trackR = trackL.clone(); trackR.position.x = 0.75;
      const torso = box(2.5, 1.4, 1.6, metal); torso.position.y = 1.9;
      const visor = box(1.8, 0.2, 0.06, redGlow); visor.position.set(0, 2.2, -0.82);
      const shoulderL = box(0.7, 0.5, 0.9, darkM); shoulderL.position.set(-1.6, 2.45, 0);
      const shoulderR = shoulderL.clone(); shoulderR.position.x = 1.6;
      const gunL = new T.Group(); gunL.position.set(-1.6, 2.1, 0);
      const gunR = new T.Group(); gunR.position.set(1.6, 2.1, 0);
      for (const gun of [gunL, gunR]) {
        const barrel = cyl(0.13, 0.15, 1.5, darkM); barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.9;
        const muzzle = cyl(0.17, 0.17, 0.16, redGlow); muzzle.rotation.x = Math.PI / 2; muzzle.position.z = -1.62;
        gun.add(barrel, muzzle);
      }
      const antenna = cyl(0.02, 0.02, 0.9, darkM); antenna.position.set(0.8, 3.1, 0.4);
      const tip = sph(0.06, redGlow, 6); tip.position.set(0.8, 3.55, 0.4);
      const pipeL = cyl(0.09, 0.09, 0.5, darkM); pipeL.position.set(-0.5, 2.8, 0.75);
      const pipeR = pipeL.clone(); pipeR.position.x = 0.5;
      const pipeFm = new T.MeshStandardMaterial({ color: '#331a05', emissive: '#ff7a1a', emissiveIntensity: 1.4 });
      const pf1 = cyl(0.07, 0.02, 0.12, pipeFm); pf1.position.set(-0.5, 3.08, 0.75);
      const pf2 = pf1.clone(); pf2.position.x = 0.5;
      g.add(trackL, trackR, torso, visor, shoulderL, shoulderR, gunL, gunR, antenna, tip, pipeL, pipeR, pf1, pf2);
      const fin = finishBoss(g, name, color, 4.3);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 5 : 1);
        model.slamT += dt;
        torso.position.y = 1.9 + Math.sin(model.walkT) * 0.03;
        if (model.slamT < 0.6) {           // 开火后座
          const k = Math.sin(model.slamT / 0.6 * Math.PI);
          gunL.position.z = k * 0.18; gunR.position.z = k * 0.18;
        } else { gunL.position.z = 0; gunR.position.z = 0; }
      };
    } else if (type === 'lich') {
      // 虚空巫妖：悬浮法袍 + 骷髅王冠 + 法杖
      const robeM = std('#2a1f4a', { roughness: 0.7 });
      const boneM = std('#d8d2c4', { roughness: 0.5 });
      const glowM = new T.MeshStandardMaterial({ color: '#12081f', emissive: color, emissiveIntensity: 2 });
      const body = new T.Group();                       // 悬浮体（整体上下浮动）
      const robe = cone(0.85, 2.1, robeM); robe.position.y = 1.05; body.add(robe);
      const trim = cyl(0.87, 0.87, 0.1, glowM); trim.position.y = 0.12; body.add(trim);
      const skull = box(0.46, 0.42, 0.44, boneM); skull.position.y = 2.35; body.add(skull);
      const jaw = box(0.34, 0.12, 0.3, boneM); jaw.position.set(0, 2.1, -0.04); body.add(jaw);
      const eyeM2 = new T.MeshStandardMaterial({ color: '#000', emissive: color, emissiveIntensity: 3 });
      const e1 = box(0.09, 0.1, 0.04, eyeM2); e1.position.set(-0.1, 2.38, -0.23); body.add(e1);
      const e2 = e1.clone(); e2.position.x = 0.1; body.add(e2);
      const crownM = std('#ffd23c', { metalness: 0.85, roughness: 0.3, emissive: '#7a5a00', emissiveIntensity: 0.4 });
      const crown = cyl(0.26, 0.28, 0.12, crownM); crown.position.y = 2.6; body.add(crown);
      for (let i = 0; i < 4; i++) {
        const spike = cone(0.05, 0.16, crownM);
        const a = i / 4 * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.24, 2.72, Math.sin(a) * 0.24);
        body.add(spike);
      }
      const shL = sph(0.22, robeM, 8); shL.position.set(-0.55, 1.95, 0); body.add(shL);
      const shR = shL.clone(); shR.position.x = 0.55; body.add(shR);
      const armR = new T.Group(); armR.position.set(0.62, 1.85, 0); body.add(armR);
      const staff = cyl(0.035, 0.035, 1.7, std('#3a2a1a')); staff.rotation.x = 0.25; staff.position.set(0, -0.2, -0.25); armR.add(staff);
      const orb = sph(0.15, glowM, 10); orb.position.set(0, 0.68, -0.46); armR.add(orb);
      g.add(body);
      const fin = finishBoss(g, name, color, 3.3);
      model = Object.assign({ group: g, walkT: 0, slamT: 9, body }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * 1.6;
        model.slamT += dt;
        body.position.y = 0.42 + Math.sin(model.walkT) * 0.16;   // 悬浮
        body.rotation.z = Math.sin(model.walkT * 0.7) * 0.05;
        if (model.slamT < 0.5) {           // 施法：法杖高举
          const k = Math.sin(model.slamT / 0.5 * Math.PI);
          armR.rotation.x = -1.6 * k;
        } else armR.rotation.x = -0.2;
        orb.rotation.y += dt * 3;
      };
    } else if (type === 'amiya') {
      // 嫉妒魔女：粉黑魔女轮廓 — 裙裾/面纱/泪痕眼/影角冠/背后碎镜环，面向前进方向（不整身自旋）
      const col = color || '#ff8fb8';
      const ink = std('#140810', { roughness: 0.82, metalness: 0.08 });
      const inkSoft = new T.MeshStandardMaterial({
        color: '#1c0c14', emissive: '#4a1830', emissiveIntensity: 0.45, roughness: 0.72,
        transparent: true, opacity: 0.9, side: T.DoubleSide,
      });
      inkSoft.userData.baseOpacity = 0.9;
      const veilM = new T.MeshStandardMaterial({
        color: '#1a0a12', emissive: col, emissiveIntensity: 0.28, roughness: 0.65,
        transparent: true, opacity: 0.78, side: T.DoubleSide,
      });
      veilM.userData.baseOpacity = 0.78;
      const glow = new T.MeshStandardMaterial({ color: '#1a050c', emissive: col, emissiveIntensity: 2.4 });
      const pale = std('#e8d0d6', { roughness: 0.55 });
      const shardM = new T.MeshStandardMaterial({
        color: '#2a1520', emissive: col, emissiveIntensity: 1.15, metalness: 0.45, roughness: 0.28,
        transparent: true, opacity: 0.88, side: T.DoubleSide,
      });
      shardM.userData.baseOpacity = 0.88;
      const pageM = new T.MeshStandardMaterial({
        color: '#f5e8ec', emissive: col, emissiveIntensity: 0.28, roughness: 0.5, side: T.DoubleSide,
      });
      const ringM = new T.MeshStandardMaterial({
        color: '#1a050c', emissive: col, emissiveIntensity: 1.6, transparent: true, opacity: 0.7,
      });
      ringM.userData.baseOpacity = 0.7;

      const root = new T.Group();

      // 裙裾：收窄轮廓，避免大圆锥抢戏
      const dress = new T.Group();
      const skirt = cone(0.92, 1.5, inkSoft, 14); skirt.position.y = 0.75;
      const petticoat = cone(0.52, 1.05, ink, 12); petticoat.position.y = 1.02;
      const flare = new T.Mesh(new T.ConeGeometry(1.02, 0.38, 16, 1, true), inkSoft);
      flare.position.y = 0.16; flare.rotation.x = Math.PI; flare.castShadow = true;
      const waist = cyl(0.2, 0.3, 0.5, ink, 10); waist.position.y = 1.52;
      dress.add(skirt, petticoat, flare, waist);

      // 躯干 + 心核（小粉核，不再用整面粉镜挡脸）
      const torso = box(0.46, 0.68, 0.26, ink); torso.position.y = 2.0;
      const heart = sph(0.11, glow, 8); heart.position.set(0, 1.96, -0.13);
      const collar = cyl(0.26, 0.2, 0.1, glow, 10); collar.position.y = 2.32;

      // 头 / 兜帽 / 泪痕眼 / 后披面纱
      const headG = new T.Group(); headG.position.y = 2.5;
      const head = sph(0.21, pale, 10);
      const hood = cone(0.3, 0.4, ink, 10); hood.position.y = 0.26; hood.rotation.x = 0.12;
      const eyeL = box(0.075, 0.032, 0.035, glow); eyeL.position.set(-0.065, 0.035, -0.19);
      const eyeR = eyeL.clone(); eyeR.position.x = 0.065;
      const tearL = box(0.022, 0.16, 0.022, glow); tearL.position.set(-0.065, -0.1, -0.18);
      const tearR = tearL.clone(); tearR.position.x = 0.065;
      const veil = new T.Mesh(new T.PlaneGeometry(0.65, 1.15), veilM);
      veil.position.set(0, -0.32, 0.2); veil.rotation.x = 0.22;
      headG.add(head, hood, eyeL, eyeR, tearL, tearR, veil);

      // 影角冠（实心锥，替代细环线）
      const crown = new T.Group(); crown.position.y = 2.78;
      const hornL = cone(0.065, 0.4, glow, 6); hornL.position.set(-0.15, 0.16, 0); hornL.rotation.z = 0.52;
      const hornR = cone(0.065, 0.4, glow, 6); hornR.position.set(0.15, 0.16, 0); hornR.rotation.z = -0.52;
      const gem = sph(0.055, glow, 6); gem.position.y = 0.04;
      crown.add(hornL, hornR, gem);

      // 手臂 + 影爪
      const armGeo = new T.BoxGeometry(0.11, 0.72, 0.13); armGeo.translate(0, -0.34, 0);
      const armL = new T.Mesh(armGeo, ink); armL.castShadow = true; armL.position.set(-0.36, 2.2, 0);
      const armR = new T.Mesh(armGeo.clone(), ink); armR.castShadow = true; armR.position.set(0.36, 2.2, 0);
      const clawL = cone(0.07, 0.2, glow, 5); clawL.rotation.x = Math.PI; clawL.position.y = -0.74; armL.add(clawL);
      const clawR = clawL.clone(); armR.add(clawR);

      // 背后碎镜环（小片、身后，不挡正面识别）
      const halo = new T.Group(); halo.position.set(0, 2.35, 0.32);
      const shardMeshes = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const sh = new T.Mesh(new T.PlaneGeometry(0.16 + (i % 3) * 0.04, 0.24 + (i % 2) * 0.06), shardM);
        sh.position.set(Math.cos(a) * 0.52, Math.sin(a) * 0.42, 0);
        sh.rotation.z = a + 0.35; sh.rotation.y = 0.25;
        halo.add(sh); shardMeshes.push(sh);
      }

      // 侧翼环绕书页（缩小）
      const pages = new T.Group(); pages.position.y = 1.85;
      const pageMeshes = [];
      for (let i = 0; i < 5; i++) {
        const pg = new T.Mesh(new T.PlaneGeometry(0.26, 0.36), pageM.clone());
        const a = (i / 5) * Math.PI * 2;
        pg.userData.baseA = a;
        pg.position.set(Math.cos(a) * 0.9, Math.sin(a * 1.5) * 0.16, Math.sin(a) * 0.9);
        pages.add(pg); pageMeshes.push(pg);
      }

      // 裙底影触须
      const tendrils = [];
      for (let i = 0; i < 4; i++) {
        const td = new T.Group();
        const baseA = (i / 4) * Math.PI * 2 + 0.5;
        td.position.set(Math.cos(baseA) * 0.38, 0.32, Math.sin(baseA) * 0.38);
        const segs = [];
        for (let s = 0; s < 4; s++) {
          const seg = box(0.075 - s * 0.01, 0.075 - s * 0.01, 0.3, i % 2 ? glow : ink);
          seg.position.set(0, 0, -0.14 - s * 0.26);
          td.add(seg); segs.push(seg);
        }
        tendrils.push({ g: td, segs, phase: i * 1.1 });
        root.add(td);
      }

      const ring = new T.Mesh(new T.TorusGeometry(0.68, 0.035, 6, 24), ringM);
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.05;

      root.add(dress, torso, heart, collar, headG, crown, armL, armR, halo, pages, ring);
      g.add(root);
      const fin = finishBoss(g, name, col, 3.4);
      model = Object.assign({
        group: g, walkT: 0, slamT: 9, root, pages, halo, tendrils, heart, pageMeshes, armL, armR, headG,
      }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 2.6 : 1.4);
        model.slamT += dt;
        const t = model.walkT;
        // 悬浮 + 轻晃，身体不自旋（朝向交给服务端 yaw）
        root.position.y = 0.26 + Math.sin(t) * 0.11;
        root.rotation.z = Math.sin(t * 0.55) * 0.035;
        pages.rotation.y -= dt * 0.7;
        halo.rotation.z += dt * 0.5;
        for (const pg of pageMeshes) {
          const a = pg.userData.baseA;
          pg.rotation.y = -pages.rotation.y + a + Math.PI;
          pg.rotation.z = Math.sin(t * 2 + a) * 0.22;
          pg.position.y = Math.sin(t * 1.4 + a) * 0.16;
        }
        for (const sh of shardMeshes) {
          sh.rotation.x = Math.sin(t * 1.7 + sh.position.x * 4) * 0.12;
        }
        const beat = 1 + Math.sin(t * 3) * 0.1;
        heart.scale.setScalar(beat);
        headG.rotation.y = Math.sin(t * 0.45) * 0.07;
        for (const td of tendrils) {
          td.g.rotation.y = Math.sin(t * 2.4 + td.phase) * 0.38;
          td.g.rotation.x = 0.5 + Math.sin(t * 1.9 + td.phase) * 0.18;
          td.segs.forEach((seg, si) => {
            seg.rotation.x = Math.sin(t * 3.2 + td.phase + si) * 0.28;
          });
        }
        if (model.slamT < 0.55) {
          const k = Math.sin(model.slamT / 0.55 * Math.PI);
          armL.rotation.x = -1.85 * k;
          armR.rotation.x = -1.85 * k;
          heart.scale.setScalar(1 + k * 0.55);
          root.rotation.x = 0.1 * k;
        } else {
          armL.rotation.x = -0.32 + Math.sin(t) * 0.1;
          armR.rotation.x = -0.32 - Math.sin(t) * 0.1;
          root.rotation.x = 0;
        }
      };
    } else {
      // 熔岩魔像（默认）
      const rock = std('#3a3f4a', { roughness: 0.9 });
      const lava = std('#331005', { emissive: '#ff5a1a', emissiveIntensity: 1.6 });
      const legGeo = new T.BoxGeometry(0.7, 1.3, 0.8); legGeo.translate(0, -0.65, 0);
      const legL = new T.Mesh(legGeo, rock); legL.castShadow = true; legL.position.set(-0.55, 1.5, 0);
      const legR = new T.Mesh(legGeo.clone(), rock); legR.castShadow = true; legR.position.set(0.55, 1.5, 0);
      const torso = box(2.1, 1.7, 1.3, rock); torso.position.y = 2.4;
      const crack1 = box(1.5, 0.12, 1.34, lava); crack1.position.y = 2.5;
      const crack2 = box(2.14, 0.1, 0.9, lava); crack2.position.y = 2.15;
      const armGeo = new T.BoxGeometry(0.55, 1.6, 0.6); armGeo.translate(0, -0.7, 0);
      const armL = new T.Mesh(armGeo, rock); armL.castShadow = true; armL.position.set(-1.35, 3.1, 0);
      const armR = new T.Mesh(armGeo.clone(), rock); armR.castShadow = true; armR.position.set(1.35, 3.1, 0);
      const fistL = sph(0.42, rock); fistL.position.y = -1.5; armL.add(fistL);
      const fistR = fistL.clone(); armR.add(fistR);
      const head = box(0.8, 0.7, 0.75, rock); head.position.y = 3.6;
      const eyeM = new T.MeshStandardMaterial({ color: '#000', emissive: '#ffb01a', emissiveIntensity: 2.5 });
      const eyeL = sph(0.09, eyeM, 8); eyeL.position.set(-0.2, 3.65, -0.39);
      const eyeR = eyeL.clone(); eyeR.position.x = 0.2;
      const hornM = std('#20242c');
      const hornL = cone(0.14, 0.55, hornM); hornL.position.set(-0.35, 4.1, 0); hornL.rotation.z = 0.4;
      const hornR = hornL.clone(); hornR.position.x = 0.35; hornR.rotation.z = -0.4;
      g.add(legL, legR, torso, crack1, crack2, armL, armR, head, eyeL, eyeR, hornL, hornR);
      const fin = finishBoss(g, name, color || '#ff6a1a', 4.9);
      model = Object.assign({ group: g, walkT: 0, slamT: 9 }, fin);
      model.update = (dt, moving) => {
        model.walkT += dt * (moving ? 4 : 0.6);
        model.slamT += dt;
        const sw = Math.sin(model.walkT) * 0.4;
        legL.rotation.x = sw; legR.rotation.x = -sw;
        if (model.slamT < 0.5) {
          const k = model.slamT / 0.5;
          const a = k < 0.4 ? -2.4 * (k / 0.4) : -2.4 + 2.4 * ((k - 0.4) / 0.6);
          armL.rotation.x = a; armR.rotation.x = a;
        } else {
          armL.rotation.x = Math.sin(model.walkT) * 0.25;
          armR.rotation.x = -Math.sin(model.walkT) * 0.25;
        }
      };
    }
    return model;
  }

  function makeUnseenHand() {
    // 紫色影爪：半透明，从 BOSS 伸出后由客户端画触须连接
    const g = new T.Group();
    const mat = new T.MeshStandardMaterial({
      color: '#1a0a28', emissive: '#9b5cff', emissiveIntensity: 1.55,
      transparent: true, opacity: 0.38, depthWrite: false,
    });
    const tip = new T.MeshStandardMaterial({
      color: '#120820', emissive: '#c49bff', emissiveIntensity: 2.2,
      transparent: true, opacity: 0.5, depthWrite: false,
    });
    const palm = box(0.38, 0.14, 0.42, mat); palm.position.set(0, 0.08, 0.05);
    const wrist = box(0.22, 0.12, 0.55, mat); wrist.position.set(0, 0.06, 0.45);
    g.add(palm, wrist);
    for (let i = 0; i < 4; i++) {
      const claw = new T.Group();
      claw.position.set(-0.14 + i * 0.095, 0.1, -0.22);
      const knuckle = box(0.07, 0.07, 0.22, mat); knuckle.position.z = -0.08;
      const nail = cone(0.05, 0.28, tip); nail.rotation.x = Math.PI / 2; nail.position.z = -0.32;
      claw.add(knuckle, nail);
      g.add(claw);
    }
    const thumb = cone(0.055, 0.26, tip); thumb.rotation.set(0.4, 0.9, 0.2); thumb.position.set(-0.26, 0.08, 0.05);
    g.add(thumb);
    return { group: g, mats: [mat, tip] };
  }

  function makeHandTether() {
    const mat = new T.MeshBasicMaterial({
      color: '#9b5cff', transparent: true, opacity: 0.42, depthWrite: false,
    });
    const mesh = new T.Mesh(new T.CylinderGeometry(0.07, 0.12, 1, 8, 1, true), mat);
    mesh.frustumCulled = false;
    return { mesh, mat };
  }

  function makeVoidRift() {
    // 虚空裂缝：交叉裂口 + 紫辉边缘，多角度可见，钉在伸出点
    const g = new T.Group();
    const voidM = new T.MeshBasicMaterial({
      color: '#05000c', transparent: true, opacity: 0.96, side: T.DoubleSide, depthWrite: false,
    });
    const glowM = new T.MeshBasicMaterial({
      color: '#c49bff', transparent: true, opacity: 0.85, side: T.DoubleSide, depthWrite: false,
      blending: T.AdditiveBlending,
    });
    const inkM = new T.MeshBasicMaterial({
      color: '#7b4dff', transparent: true, opacity: 0.55, side: T.DoubleSide, depthWrite: false,
      blending: T.AdditiveBlending,
    });
    // 两片交叉裂口，正面/侧面都能看见
    const tearA = new T.Mesh(new T.PlaneGeometry(0.28, 1.35), voidM);
    const glowA = new T.Mesh(new T.PlaneGeometry(0.55, 1.55), glowM);
    glowA.position.z = -0.03;
    const tearB = new T.Mesh(new T.PlaneGeometry(0.22, 1.15), voidM.clone());
    tearB.rotation.y = Math.PI / 2;
    const glowB = new T.Mesh(new T.PlaneGeometry(0.42, 1.35), glowM.clone());
    glowB.rotation.y = Math.PI / 2;
    glowB.position.x = -0.03;
    const core = new T.Mesh(new T.PlaneGeometry(0.12, 0.9), inkM);
    core.position.z = 0.02;
    g.add(glowA, tearA, glowB, tearB, core);
    const cracks = [];
    for (let i = 0; i < 7; i++) {
      const c = new T.Mesh(
        new T.PlaneGeometry(0.05 + (i % 2) * 0.03, 0.28 + (i % 3) * 0.12),
        glowM.clone()
      );
      const sx = (i % 2 ? 1 : -1) * (0.08 + (i % 3) * 0.07);
      c.position.set(sx, (i - 3) * 0.14, 0.03);
      c.rotation.z = sx * 1.6 + (i % 3) * 0.25;
      g.add(c);
      cracks.push(c);
    }
    for (let i = 0; i < 5; i++) {
      const shard = new T.Mesh(new T.PlaneGeometry(0.12, 0.18), voidM.clone());
      const a = (i / 5) * Math.PI * 2 + 0.3;
      shard.position.set(Math.cos(a) * 0.36, Math.sin(a) * 0.48, 0.05);
      shard.rotation.z = a + 0.4;
      g.add(shard);
    }
    g.scale.setScalar(1.15);
    g.frustumCulled = false;
    g.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 3; } });
    return { group: g, voidM, glowM, inkM, cracks };
  }

  // ---------- 可摧毁油桶 ----------
  function makeBarrel(r, h) {
    const g = new T.Group();
    const body = cyl(r, r, h, std('#b03a2e', { roughness: 0.55, metalness: 0.3 }), 14);
    body.position.y = h / 2;
    const band = cyl(r + 0.02, r + 0.02, 0.12, std('#d8d8d8', { metalness: 0.6 }), 14);
    band.position.y = h * 0.6;
    const lid = cyl(r * 0.92, r * 0.92, 0.06, std('#7a2a20', { roughness: 0.5 }), 14);
    lid.position.y = h + 0.02;
    // 警示条纹
    const hc = document.createElement('canvas'); hc.width = 64; hc.height = 16;
    const hx = hc.getContext('2d');
    for (let i = 0; i < 10; i++) { hx.fillStyle = i % 2 ? '#111' : '#ffb02e'; hx.beginPath(); hx.moveTo(i * 8 - 4, 16); hx.lineTo(i * 8 + 4, 0); hx.lineTo(i * 8 + 12, 0); hx.lineTo(i * 8 + 4, 16); hx.fill(); }
    const hTex = new T.CanvasTexture(hc); hTex.wrapS = T.RepeatWrapping; hTex.repeat.set(3, 1);
    const hazard = new T.Mesh(new T.CylinderGeometry(r + 0.015, r + 0.015, 0.22, 14, 1, true),
      new T.MeshStandardMaterial({ map: hTex, roughness: 0.6 }));
    hazard.position.y = h * 0.32;
    g.add(body, band, lid, hazard);
    return g;
  }

  // ---------- 神秘商人 ----------
  function makeMerchant() {
    const g = new T.Group();
    // 摊位
    const woodM = std('#6b4a26', { roughness: 0.85 });
    const counter = box(3, 1, 1, woodM); counter.position.set(0, 0.5, -1);
    for (const [px, pz] of [[-1.5, -1.6], [1.5, -1.6], [-1.5, 0.6], [1.5, 0.6]]) {
      const post = cyl(0.07, 0.07, 2.6, woodM); post.position.set(px, 1.3, pz); g.add(post);
    }
    // 条纹雨棚
    const awnC = document.createElement('canvas'); awnC.width = 128; awnC.height = 32;
    const ax = awnC.getContext('2d');
    for (let i = 0; i < 8; i++) { ax.fillStyle = i % 2 ? '#7b2d8b' : '#e8d44d'; ax.fillRect(i * 16, 0, 16, 32); }
    const awning = new T.Mesh(new T.BoxGeometry(3.6, 0.08, 2.6),
      new T.MeshStandardMaterial({ map: new T.CanvasTexture(awnC) }));
    awning.castShadow = true; awning.position.set(0, 2.65, -0.5); awning.rotation.x = -0.12;
    // 商人（斗篷法师）
    const robeM = std('#4a2a6b', { roughness: 0.7 });
    const robe = cone(0.55, 1.5, robeM); robe.position.set(0, 0.75, -1.8);
    const hood = sph(0.3, robeM); hood.position.set(0, 1.62, -1.8);
    const eyeM2 = new T.MeshStandardMaterial({ color: '#000', emissive: '#c76bff', emissiveIntensity: 2.2 });
    const e1 = sph(0.045, eyeM2, 8); e1.position.set(-0.09, 1.64, -1.55);
    const e2 = e1.clone(); e2.position.x = 0.09;
    // 台面商品
    const gem = new T.Mesh(new T.OctahedronGeometry ? new T.OctahedronGeometry(0.16) : new T.SphereGeometry(0.16, 8, 8),
      new T.MeshStandardMaterial({ color: '#b26bff', emissive: '#7b2dff', emissiveIntensity: 1.2 }));
    gem.position.set(-0.7, 1.2, -1);
    const potion = cyl(0.09, 0.12, 0.28, std('#2bbf8a', { emissive: '#128a5a', emissiveIntensity: 0.8 })); potion.position.set(0.6, 1.15, -1);
    const lamp = new T.PointLight('#d9a9ff', 1.1, 10); lamp.position.set(0, 2.2, -1);
    g.add(counter, awning, robe, hood, e1, e2, gem, potion, lamp);
    // 招牌
    const sign = textSprite(256, 80, (ctx, c) => {
      ctx.font = 'bold 44px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#c76bff'; ctx.shadowBlur = 16;
      ctx.fillStyle = '#e8ccff'; ctx.fillText('神秘商店', 128, 40);
    });
    sign.scale.set(3.4, 1.05, 1); sign.position.set(0, 3.4, -0.5);
    g.add(sign);
    g.userData.gem = gem;
    return g;
  }

  // ---------- 第一人称视角模型 ----------
  function makeViewModel() {
    const g = new T.Group();
    const skin = std('#e8b98a');
    const sleeve = std('#3a4a5c');
    const armR = new T.Group();
    const ra = box(0.045, 0.045, 0.13, sleeve); ra.position.z = 0.055;
    const rh = box(0.055, 0.05, 0.06, skin); rh.position.z = -0.04;
    armR.add(ra, rh);
    armR.position.set(0.17, -0.16, -0.42);
    const armL = armR.clone();
    armL.position.set(-0.17, -0.16, -0.42);
    const weaponA = new T.Group(); weaponA.position.set(0, 0.035, -0.08); armR.add(weaponA);
    g.add(armR, armL);
    g.traverse(o => { o.castShadow = false; o.receiveShadow = false; if (o.material) { o.material.depthTest = true; o.material.depthWrite = true; } });
    return { group: g, armR, armL, weaponA, weaponMesh: null, cur: null };
  }
  function setViewWeapon(vm, wp, zombified) {
    const key = (wp || 'fist') + (zombified ? '_z' : '');
    if (vm.cur === key) return;
    vm.cur = key;
    if (vm.weaponMesh) {
      clearPlasmaArcs(vm.weaponMesh);
      vm.weaponA.remove(vm.weaponMesh);
      vm.weaponMesh = null;
    }
    vm.armL.visible = (wp === 'fist' || !wp || zombified);
    if (zombified) {
      const claws = new T.Group();
      const cm = std('#7bd45f', { emissive: '#2b8a1a', emissiveIntensity: 0.6 });
      for (let i = -1; i <= 1; i++) {
        const c = cone(0.02, 0.14, cm); c.rotation.x = -Math.PI / 2; c.position.set(i * 0.04, 0, -0.16);
        claws.add(c);
      }
      vm.weaponMesh = claws;
    } else if (wp && wp !== 'fist') {
      vm.weaponMesh = buildWeapon(wp);
    }
    if (vm.weaponMesh) {
      const layerMask = vm.group.layers.mask;
      vm.weaponMesh.traverse(o => {
        o.layers.mask = layerMask;
        o.castShadow = false;
        o.receiveShadow = false;
        if (o.material) { o.material.depthTest = true; o.material.depthWrite = true; }
      });
      vm.weaponA.add(vm.weaponMesh);
    }
  }

  return {
    makePlayer, animatePlayer, setPlayerWeapon, setOpacity, tintZombie,
    applyCosmetics, animateCosmetics, applyWeaponFx, buildWeapon, makePickup, makeBoss, setBossOpacity, makeUnseenHand, makeHandTether, makeVoidRift,
    makeBarrel, makeMerchant, makeViewModel, setViewWeapon, makeNameplate, textSprite, std,
    preloadAssets, hasGlbWeapon,
  };
})();
