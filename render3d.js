'use strict';
/**
 * 3D 渲染层（Three.js，本地 vendor 引入，无 CDN 依赖）
 * 只负责“画”：场景、灯光、角色、道具、特效。
 * 战斗数值与命中判定仍由既有逻辑/服务器负责，本文件不参与任何伤害计算。
 *
 * 暴露 window.RockFight3D = { ready, init, resize, render, setCharacters }
 */
(function () {
  const S = 0.1;                    // 游戏坐标 → 世界坐标比例（960 → 96）
  const DEPTH = 0.17;               // 纵深轴单独放大，让上下走位在画面上看得清楚
  const FLOOR_GAME = 425;           // 与 2D 版一致的“地面”基准

  let renderer = null, scene = null, camera = null, canvasEl = null;
  let selfRig = null, oppRig = null;
  let itemMeshes = new Map();
  let fxRings = [], fxParticles = [];
  let lastTime = 0, ready = false;
  let crowd = null, smoke = [];
  let chars = null;

  const THREE = window.THREE;
  if (!THREE) { console.warn('[3D] Three.js 未加载，保持 2D 模式'); return; }

  const lam = (color, extra) => new THREE.MeshLambertMaterial(Object.assign({ color }, extra || {}));

  /**
   * 建角色。style 用来区分两人：
   *   白云峰：中长发蓬乱过肩、方框眼镜、偏瘦高、手里拎酒瓶
   *   管啸天：短乱发齐刘海、圆框眼镜、偏圆矮、米色抓绒
   */
  function makeFighter(colors, style) {
    const st = style || {};
    const group = new THREE.Group();
    const parts = {};
    const skin = 0xd8a583;
    const tall = st.height || 1;
    const headY = 14.5 * tall;

    // 腿 / 鞋 / 腰带
    const legGeo = new THREE.BoxGeometry(1.5, 6.0 * tall, 1.7);
    parts.legL = new THREE.Mesh(legGeo, lam(0x2c2c31)); parts.legL.position.set(-0.95, 3.0 * tall, 0);
    parts.legR = new THREE.Mesh(legGeo, lam(0x24242a)); parts.legR.position.set(0.95, 3.0 * tall, 0);

    const shoeGeo = new THREE.BoxGeometry(1.9, 0.7, 2.5);
    parts.shoeL = new THREE.Mesh(shoeGeo, lam(0xdad6cd)); parts.shoeL.position.set(-0.95, 0.35, 0.35);
    parts.shoeR = new THREE.Mesh(shoeGeo, lam(0xcecac1)); parts.shoeR.position.set(0.95, 0.35, 0.35);

    parts.belt = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 2.3), lam(0x1b1b1e));
    parts.belt.position.set(0, 6.1 * tall, 0);

    // 躯干 / 领口 / 肩
    const torsoW = st.build === 'round' ? 3.9 : 3.1;
    const torsoD = st.build === 'round' ? 2.8 : 2.2;
    parts.torso = new THREE.Mesh(new THREE.BoxGeometry(torsoW, 6.0 * tall, torsoD), lam(colors.coat));
    parts.torso.position.set(0, 9.2 * tall, 0);

    parts.collar = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 0.78, 1.2, torsoD + 0.12), lam(colors.shirt));
    parts.collar.position.set(0, 12.05 * tall, 0);

    parts.shoulders = new THREE.Mesh(new THREE.BoxGeometry(torsoW + 1.0, 1.3, torsoD + 0.1), lam(colors.coat));
    parts.shoulders.position.set(0, 11.9 * tall, 0);

    parts.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.9, 12), lam(skin));
    parts.neck.position.set(0, 12.8 * tall, 0);

    // 手臂 / 拳头
    const armX = torsoW / 2 + 0.72;
    parts.armL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 5.0, 1.4), lam(colors.coat));
    parts.armL.position.set(-armX, 9.2 * tall, 0);
    parts.armR = new THREE.Mesh(new THREE.BoxGeometry(1.2, 5.0, 1.4), lam(colors.coat));
    parts.armR.position.set(armX, 9.2 * tall, 0);
    parts.fist = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), lam(skin));
    parts.fist.position.set(armX, 6.6 * tall, 0.3);
    parts.fist.userData.base = { x: armX, y: 6.6 * tall };

    // 头与五官（面朝 +X）
    parts.head = new THREE.Mesh(new THREE.SphereGeometry(st.build === 'round' ? 2.15 : 2.0, 22, 18), lam(skin));
    parts.head.position.set(0, headY, 0);

    const faceX = st.build === 'round' ? 2.0 : 1.86;
    const eyeMat = lam(0x19191b);
    parts.eyeA = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.4, 0.5), eyeMat);
    parts.eyeA.position.set(faceX, headY + 0.3, 0.72);
    parts.eyeB = parts.eyeA.clone(); parts.eyeB.position.z = -0.72;
    parts.browA = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.62), lam(colors.hair));
    parts.browA.position.set(faceX, headY + 0.95, 0.72);
    parts.browB = parts.browA.clone(); parts.browB.position.z = -0.72;
    parts.mouth = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.85), lam(0x8d5a52));
    parts.mouth.position.set(faceX - 0.12, headY - 0.8, 0);

    // 头发
    if (st.hair === 'long') {
      // 白云峰：蓬乱过肩长发（后脑长发 + 两侧发帘 + 额前碎发）
      const cap = new THREE.Mesh(new THREE.SphereGeometry(2.25, 24, 18), lam(colors.hair));
      cap.position.set(-0.15, headY + 0.4, 0); cap.scale.set(1.05, 1.02, 1.15);

      const backTop = new THREE.Mesh(new THREE.BoxGeometry(2.2, 4.4, 3.9), lam(colors.hair));
      backTop.position.set(-1.5, headY - 2.1, 0);

      const backLow = new THREE.Mesh(new THREE.BoxGeometry(1.9, 3.4, 3.5), lam(colors.hair));
      backLow.position.set(-1.35, headY - 4.6, 0);

      const strandL = new THREE.Mesh(new THREE.BoxGeometry(1.0, 4.8, 1.0), lam(colors.hair));
      strandL.position.set(0.35, headY - 2.5, 1.78);
      const strandR = strandL.clone(); strandR.position.z = -1.78;

      const fringe = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.5, 2.95), lam(colors.hair));
      fringe.position.set(1.5, headY + 1.62, 0);

      const tuft = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.4), lam(colors.hair));
      tuft.position.set(-0.6, headY + 2.2, 0.9);

      parts.hair = cap;
      parts.hairExtra = [backTop, backLow, strandL, strandR, fringe, tuft];
    } else {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(2.16, 22, 18), lam(colors.hair));
      cap.position.set(-0.1, headY + 0.4, 0); cap.scale.set(1.03, 0.96, 1.07);
      const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.3, 3.15), lam(colors.hair));
      fringe.position.set(1.35, headY + 1.55, 0);
      const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.05, 0.7), lam(colors.hair));
      sideL.position.set(-0.25, headY + 0.2, 1.72);
      const sideR = sideL.clone(); sideR.position.z = -1.72;
      parts.hair = cap;
      parts.hairExtra = [fringe, sideL, sideR];
    }

    // 眼镜
    if (st.glasses === 'rect') {
      const frameMat = lam(0x16161a);
      const lensMat = new THREE.MeshLambertMaterial({ color: 0x2b3136, transparent: true, opacity: 0.45 });
      const lensA = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.82, 1.15), lensMat);
      lensA.position.set(faceX + 0.1, headY + 0.3, 0.72);
      const lensB = lensA.clone(); lensB.position.z = -0.72;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 2.9), frameMat);
      frame.position.set(faceX + 0.1, headY + 0.82, 0);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.8), frameMat);
      bridge.position.set(faceX + 0.1, headY + 0.3, 0);
      parts.glasses = frame;
      parts.glassesExtra = [lensA, lensB, bridge];
    } else {
      const frameMat = lam(0x2c2c30);
      const ringGeo = new THREE.TorusGeometry(0.56, 0.085, 8, 20);
      const ringA = new THREE.Mesh(ringGeo, frameMat);
      ringA.rotation.y = Math.PI / 2; ringA.position.set(faceX + 0.1, headY + 0.3, 0.62);
      const ringB = ringA.clone(); ringB.position.z = -0.62;
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.7), frameMat);
      bridge.position.set(faceX + 0.1, headY + 0.3, 0);
      parts.glasses = ringA;
      parts.glassesExtra = [ringB, bridge];
    }

    // 白云峰手里那瓶酒（设定图里他一直拎着）
    if (st.holdsBottle) {
      const bottle = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.3, 14), lam(0x3f6b3a));
      body.position.y = 1.15;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.38, 1.0, 12), lam(0x35602f));
      neck.position.y = 2.75;
      const label = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.7, 14), lam(0xe8e2cf));
      label.position.y = 1.2;
      bottle.add(body, neck, label);
      bottle.position.set(-armX - 1.0, 4.6 * tall, 0.25);
      parts.bottle = bottle;
    }

    Object.values(parts).forEach((m) => { if (m && m.isObject3D) group.add(m); });
    (parts.hairExtra || []).forEach((m) => group.add(m));
    (parts.glassesExtra || []).forEach((m) => group.add(m));

    // 假阴影（比实时阴影便宜得多）
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.5, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38 }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    group.add(shadow);
    parts.shadow = shadow;

    group.userData.parts = parts;
    group.userData.style = st;
    return group;
  }

  function buildScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f11);
    scene.fog = new THREE.Fog(0x0a0f11, 90, 190);

    camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 400);
    camera.position.set(48, 18.5, 50);
    camera.lookAt(48, 9.6, 0);

    scene.add(new THREE.AmbientLight(0x4a5460, 0.9));

    const key = new THREE.DirectionalLight(0xffd9c0, 0.75);
    key.position.set(20, 45, 40); scene.add(key);

    // 舞台灯（红 / 紫），与 2D 版配色一致
    const spotA = new THREE.PointLight(0xed493b, 1.7, 150); spotA.position.set(14, 34, 14); scene.add(spotA);
    const spotB = new THREE.PointLight(0xb45ae8, 1.5, 150); spotB.position.set(48, 36, 6); scene.add(spotB);
    const spotC = new THREE.PointLight(0xed493b, 1.6, 150); spotC.position.set(82, 34, 14); scene.add(spotC);

    // 地面
    const floor = new THREE.Mesh(new THREE.BoxGeometry(96, 1, 46), lam(0x2a2622));
    floor.position.set(48, -0.5, 0); scene.add(floor);

    // 地面网格：提供景深参照，让上下（纵深）走位一眼可见
    const grid = new THREE.GridHelper(96, 24, 0x6f7f86, 0x39464c);
    grid.position.set(48, 0.03, 0);
    scene.add(grid);

    // 纵深两端标线：明确“上下”可走的范围
    [-130 * 0.115, 130 * 0.115].forEach((z) => {
      const line = new THREE.Mesh(new THREE.BoxGeometry(96, 0.12, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xed493b, transparent: true, opacity: 0.55 }));
      line.position.set(48, 0.06, z); scene.add(line);
    });

    const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(96, 46),
      new THREE.MeshBasicMaterial({ color: 0x3b3040, transparent: true, opacity: 0.35 }));
    floorGlow.rotation.x = -Math.PI / 2; floorGlow.position.set(48, 0.01, 0); scene.add(floorGlow);

    // 后墙
    const wall = new THREE.Mesh(new THREE.BoxGeometry(96, 34, 1), lam(0x191426));
    wall.position.set(48, 17, -20); scene.add(wall);

    // 横幅
    const banner = new THREE.Mesh(new THREE.BoxGeometry(34, 6.4, 1.2), lam(0xed493b));
    banner.position.set(48, 22, -19); scene.add(banner);
    const bannerDark = new THREE.Mesh(new THREE.BoxGeometry(30, 4.4, 0.6), lam(0x1a1220));
    bannerDark.position.set(48, 22, -18.2); scene.add(bannerDark);

    // 音箱
    [-1, 1].forEach((side) => {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(8, 19, 8), lam(0x111318));
      cab.position.set(48 + side * 39, 9.5, -12); scene.add(cab);
      for (let i = 0; i < 3; i += 1) {
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.8, 18), lam(0x2b2d33));
        cone.rotation.x = Math.PI / 2;
        cone.position.set(48 + side * 39, 5 + i * 6, -7.8);
        scene.add(cone);
      }
    });

    // 观众（远处一排排人头）
    crowd = new THREE.Group();
    for (let row = 0; row < 3; row += 1) {
      for (let i = 0; i < 26; i += 1) {
        const head = new THREE.Mesh(new THREE.SphereGeometry(1.05, 10, 8), lam(0x1b1a20));
        head.position.set(4 + i * 3.5 + row * 1.4, 3 + row * 2.6, -26 - row * 3);
        crowd.add(head);
      }
    }
    scene.add(crowd);

    // 舞台烟雾
    smoke = [];
    for (let i = 0; i < 7; i += 1) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(6 + i * 0.6, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xc8b9d0, transparent: true, opacity: 0.055 }));
      puff.position.set(10 + i * 12, 8 + (i % 3) * 3, -6 - (i % 4) * 2);
      scene.add(puff); smoke.push(puff);
    }

    const ground = new THREE.Mesh(new THREE.BoxGeometry(96, 0.4, 60), lam(0x14161a));
    ground.position.set(48, -1.0, 6); scene.add(ground);
  }

  function init(canvas) {
    if (renderer) return true;
    canvasEl = canvas;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
    } catch (err) {
      console.warn('[3D] WebGL 初始化失败，保持 2D 模式：', err);
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    buildScene();
    selfRig = makeFighter({ coat: 0x8b8b8f, shirt: 0x2b2b2e, hair: 0x1d1a19 },
      { hair: 'long', build: 'slim', glasses: 'rect', height: 1.04, holdsBottle: true });
    oppRig = makeFighter({ coat: 0xe0d5bd, shirt: 0xc6c6c2, hair: 0x1b1b1d },
      { hair: 'short', build: 'round', glasses: 'round', height: 0.95 });
    scene.add(selfRig); scene.add(oppRig);
    resize();
    ready = true;
    return true;
  }

  function applyCharacters(colors) {
    if (!colors || !scene) return;
    const rebuild = (rig, c) => {
      if (!rig || !c) return;
      const parts = rig.userData.parts;
      parts.torso.material.color.set(c.coat);
      parts.shoulders.material.color.set(c.coat);
      parts.armL.material.color.set(c.coat);
      parts.armR.material.color.set(c.coat);
      parts.collar.material.color.set(c.shirt);
      parts.hair.material.color.set(c.hair);
      parts.browA.material.color.set(c.hair);
      parts.browB.material.color.set(c.hair);
      (parts.hairExtra || []).forEach((m) => m.material.color.set(c.hair));
    };
    rebuild(selfRig, colors.self);
    rebuild(oppRig, colors.opp);
  }

  function resize() {
    if (!renderer || !canvasEl) return;
    const w = canvasEl.clientWidth || 960;
    const h = canvasEl.clientHeight || 540;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function spawnRing(x, y, color) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.6, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    ring.position.set(x * S, y * S, 1.5);
    ring.lookAt(camera.position);
    scene.add(ring);
    fxRings.push({ mesh: ring, life: 0.42, max: 0.42 });
  }

  function spawnBurst(x, y, color, amount) {
    for (let i = 0; i < amount; i += 1) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.28 + Math.random() * 0.3, 8, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
      p.position.set(x * S, y * S, 1.2);
      scene.add(p);
      fxParticles.push({
        mesh: p, life: 0.5 + Math.random() * 0.4, max: 0.9,
        vx: (Math.random() - 0.5) * 26, vy: 6 + Math.random() * 16, vz: (Math.random() - 0.5) * 8
      });
    }
  }

  function poseFighter(rig, f, dt, mirror) {
    const parts = rig.userData.parts;

    // 位置：游戏坐标 → 世界坐标；z 为纵深（画面上的上/下），y 为跳跃高度
    const height = Math.max(0, (FLOOR_GAME - (f.y === undefined ? FLOOR_GAME : f.y))) * S;
    rig.position.set(f.x * S, height, (f.z || 0) * DEPTH);
    // 侧视格斗：左方面朝 +X，右方面朝 -X
    rig.rotation.y = (mirror ? Math.PI : 0) + (f.facing < 0 && !mirror ? Math.PI : 0);

    // 倒地
    if (f.stumbled || f.down) {
      rig.rotation.z = THREE.MathUtils.lerp(rig.rotation.z, -1.15, 0.2);
      rig.position.y = Math.max(0.3, height);
    } else {
      rig.rotation.z = THREE.MathUtils.lerp(rig.rotation.z, 0, 0.2);
    }

    // 待机呼吸 / 移动摆动 / 受击后仰 / 醉酒摇晃
    const drunkSway = (f.drunk || 0) / 100 * 0.34;
    const t = f.t || 0;
    rig.rotation.z += Math.sin(t * 3) * 0.012 + Math.sin(t * 1.3) * drunkSway + (f.drunk || 0) / 100 * 0.1;
    rig.position.y += Math.sin(t * 4) * 0.16 * (f.moving ? 0.4 : 1);
    if (f.hitStun > 0) rig.rotation.z += 0.16;

    // 手脚（侧视为 XY 平面，绕 Z 轴摆动）
    const swing = f.moving ? Math.sin(t * 12) * 0.5 : Math.sin(t * 3) * 0.08;
    parts.legL.rotation.z = swing; parts.legR.rotation.z = -swing;
    parts.armL.rotation.z = swing * 0.7;
    // 攻击：前摇抬臂 → 命中前伸 → 收回
    let punch = 0;
    if (f.attack) {
      const p = f.attack.progress === undefined ? 0.5 : f.attack.progress;
      punch = p < 0.35 ? -0.7 : p < 0.75 ? 1.15 : 0.35;
      if (p >= 0.4 && !f.attack.seen) {
        f.attack.seen = true;
        spawnRing(f.x + (f.facing > 0 ? 5 : -5), FLOOR_GAME - 118, f.attack.color || 0xff4e83);
        spawnBurst(f.x + (f.facing > 0 ? 6 : -6), FLOOR_GAME - 118, f.attack.color || 0xff4e83, 14);
      }
    }
    parts.armR.rotation.z = THREE.MathUtils.lerp(parts.armR.rotation.z, -punch, 0.35);
    const fistBase = parts.fist.userData.base || { x: 2.35, y: 6.5 };
    parts.fist.position.x = fistBase.x + punch * 1.7;
    parts.fist.position.y = fistBase.y + punch * 1.0;
    parts.shadow.scale.setScalar((f.stumbled ? 1.3 : 1) * (1 + (f.z || 0) / 130 * 0.3));
    parts.shadow.material.opacity = Math.max(0.14, 0.4 - (f.z || 0) / 130 * 0.14);
  }

  function syncItems(items) {
    const alive = new Set();
    (items || []).forEach((item) => {
      alive.add(item.id);
      let mesh = itemMeshes.get(item.id);
      if (!mesh) {
        mesh = new THREE.Group();
        // 地面光圈：让道具在暗色舞台上更显眼
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 26),
          new THREE.MeshBasicMaterial({ color: item.kind === 'beer' ? 0xf0c24b : 0xfff3b0, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08;
        mesh.add(ring);
        if (item.kind === 'beer') {
          const body = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 4.4, 16), lam(0x6b4423));
          body.position.y = 2.2;
          const top = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.15, 0.9, 16), lam(0x5a3a1f));
          top.position.y = 4.85;
          const label = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.5, 16), lam(0xe9dfc8));
          label.position.y = 2.4;
          const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.28, 16), lam(0xf0c24b));
          cap.position.y = 5.35;
          mesh.add(body, top, label, cap);
        } else {
          const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.7, 2.8, 16), lam(0xc9a227));
          glass.position.y = 1.4;
          const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.25, 16), lam(0xfff3b0));
          rim.position.y = 2.8;
          mesh.add(glass, rim);
        }
        mesh.position.set(item.x * S, 0.2, (item.z || 0) * DEPTH);
        scene.add(mesh);
        itemMeshes.set(item.id, mesh);
      }
      mesh.position.x = item.x * S;
      mesh.position.z = (item.z || 0) * DEPTH;
      mesh.rotation.y += 0.012;      // 轻微旋转，容易被注意到
    });
    itemMeshes.forEach((mesh, id) => {
      if (!alive.has(id)) { scene.remove(mesh); itemMeshes.delete(id); }
    });
  }

  function stepFx(dt) {
    for (let i = fxRings.length - 1; i >= 0; i -= 1) {
      const r = fxRings[i]; r.life -= dt;
      const k = 1 - r.life / r.max;
      r.mesh.scale.setScalar(1 + k * 5);
      r.mesh.material.opacity = Math.max(0, 0.9 - k);
      if (r.life <= 0) { scene.remove(r.mesh); fxRings.splice(i, 1); }
    }
    for (let i = fxParticles.length - 1; i >= 0; i -= 1) {
      const p = fxParticles[i]; p.life -= dt;
      p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
      p.vy -= 34 * dt;
      p.mesh.material.opacity = Math.max(0, p.life / p.max);
      if (p.life <= 0) { scene.remove(p.mesh); fxParticles.splice(i, 1); }
    }
  }

  function render(state, dtHint) {
    if (!ready) return false;
    const dt = dtHint || 0.016;
    state.t = (state.t || 0) + dt;

    if (state.characters) applyCharacters(state.characters);

    const build = (f, isSelf) => ({
      x: f.x, y: f.y, z: f.z, facing: f.facing, drunk: f.drunk, hitStun: f.hitStun,
      stumbling: f.stumbled, attack: f.attack ? {
        progress: f.attack.progress, color: f.attack.color,
        seen: (isSelf ? selfRig : oppRig).userData.attackSeen
      } : null,
      moving: !!f.moving, t: state.t + (isSelf ? 0 : 1.7),
      stumbled: !!f.stumbled
    });

    const rigSelf = build(state.self, true);
    const rigOpp = build(state.opp, false);
    poseFighter(selfRig, rigSelf, dt, false);
    poseFighter(oppRig, rigOpp, dt, true);
    selfRig.userData.attackSeen = rigSelf.attack ? true : false;
    oppRig.userData.attackSeen = rigOpp.attack ? true : false;

    syncItems(state.items);
    stepFx(dt);

    // 烟雾缓慢飘动
    smoke.forEach((puff, i) => { puff.position.x += Math.sin(state.t * 0.3 + i) * 0.02; });

    // 受击/大招震动
    const shake = state.shake || 0;
    camera.position.x = 48 + (Math.random() - 0.5) * shake * 0.12;
    camera.position.y = 18.5 + (Math.random() - 0.5) * shake * 0.12;
    camera.lookAt(48, 9.6, 0);

    renderer.render(scene, camera);
    return true;
  }

  window.RockFight3D = {
    init, resize, render, applyCharacters,
    get ready() { return ready; },
    // 调试：把两个角色投影到屏幕坐标，用来验证上下（纵深）走位在画面上确实位移
    project() {
      if (!renderer || !selfRig) return null;
      const out = {};
      const v = new THREE.Vector3();
      [['self', selfRig], ['opp', oppRig]].forEach(([key, rig]) => {
        v.setFromMatrixPosition(rig.matrixWorld);
        v.project(camera);
        out[key] = {
          worldZ: Number(rig.position.z.toFixed(2)),
          screenY: Number(((1 - (v.y + 1) / 2) * renderer.domElement.height).toFixed(1)),
          screenX: Number(((v.x + 1) / 2 * renderer.domElement.width).toFixed(1))
        };
      });
      return out;
    },
    // 渲染统计：用于验证确实在出帧（calls=绘制调用数，triangles=三角面数）
    info() {
      if (!renderer) return null;
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        size: renderer.domElement.width + 'x' + renderer.domElement.height
      };
    }
  };
})();
