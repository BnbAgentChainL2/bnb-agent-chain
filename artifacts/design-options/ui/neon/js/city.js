/* city.js — 航拍霓虹城：agent 是一束光，落地就变成一栋楼（= 一个被部署的合约）
   两层 canvas：#cityGrid 画街道与已建成的楼（只在有新楼/改尺寸时重画）
                #cityFx  画移动的光与落地涟漪（每帧用 destination-out 淡出，做拖尾） */
(function () {
  'use strict';

  var gridCv = document.getElementById('cityGrid');
  var fxCv   = document.getElementById('cityFx');
  if (!gridCv || !fxCv) return;

  var g  = gridCv.getContext('2d');
  var fx = fxCv.getContext('2d');
  var stCv = document.createElement('canvas');
  var st = stCv.getContext('2d');

  var W = 0, H = 0, DPR = 1, CELL = 78, ROT = -0.14;
  var cx = 0, cy = 0, LX = 0, LY = 0, NX = 0, NY = 0;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var COLORS = ['#2FE6FF','#2FE6FF','#2FE6FF','#7FD4FF','#3D7BFF','#3D7BFF','#FF3D9A','#FF3D9A','#FFC24B'];
  var buildings = [], movers = [], rings = [], ambient = [], taken = {};
  var MAXB = 340, gate = { x: 0, y: 0 }, seeding = false;

  /* ---------------- 尺寸 ---------------- */
  function size() {
    var r = gridCv.getBoundingClientRect();
    W = Math.max(320, Math.round(r.width));
    H = Math.max(320, Math.round(r.height));
    DPR = Math.min(window.devicePixelRatio || 1, W < 700 ? 1.5 : 2);
    [gridCv, fxCv, stCv].forEach(function (c) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    });
    CELL = W < 700 ? 52 : (W < 1100 ? 66 : 76);
    cx = W * 0.52; cy = H * 0.56;
    LX = (W * 0.62 + H * 0.36) * 1.12;
    LY = (H * 0.62 + W * 0.30) * 1.12;
    NX = Math.ceil(LX / CELL); NY = Math.ceil(LY / CELL);
    gate.x = -Math.min(NX, Math.ceil((W * 0.56) / CELL)) * CELL; gate.y = 0;
  }

  function cam(c) { c.setTransform(DPR, 0, 0, DPR, 0, 0); c.translate(cx, cy); c.rotate(ROT); }

  /* ---------------- 街道 + 建筑 ---------------- */
  function drawStreets() {
    var i, j, p;
    st.setTransform(1,0,0,1,0,0);
    st.clearRect(0,0,stCv.width,stCv.height);
    cam(st);
    /* 街区底面：深浅不一的地块，让城市有肌理 */
    for (i = -NX; i < NX; i++) {
      for (j = -NY; j < NY; j++) {
        var s = Math.abs(Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
        if (s < .34) continue;
        st.fillStyle = s > .82 ? 'rgba(18,32,62,.55)' : 'rgba(11,20,40,.5)';
        st.fillRect(i * CELL + 2, j * CELL + 2, CELL - 4, CELL - 4);
      }
    }
    for (i = -NX; i <= NX; i++) {
      p = i * CELL;
      var major = (i % 4 === 0);
      st.strokeStyle = major ? 'rgba(47,230,255,.30)' : 'rgba(110,160,235,.14)';
      st.lineWidth = major ? 1.6 : 1;
      st.beginPath(); st.moveTo(p, -NY * CELL); st.lineTo(p, NY * CELL); st.stroke();
    }
    for (i = -NY; i <= NY; i++) {
      p = i * CELL;
      var maj = (i % 4 === 0);
      st.strokeStyle = maj ? 'rgba(61,123,255,.30)' : 'rgba(110,160,235,.13)';
      st.lineWidth = maj ? 1.6 : 1;
      st.beginPath(); st.moveTo(-NX * CELL, p); st.lineTo(NX * CELL, p); st.stroke();
    }
    /* 桥门：光从这里进来 */
    st.save();
    st.translate(gate.x, gate.y);
    st.strokeStyle = 'rgba(255,61,154,.55)'; st.lineWidth = 2;
    st.shadowColor = '#FF3D9A'; st.shadowBlur = 18;
    st.beginPath(); st.arc(0, 0, 26, -Math.PI / 2.1, Math.PI / 2.1); st.stroke();
    st.beginPath(); st.arc(0, 0, 14, -Math.PI / 2.1, Math.PI / 2.1); st.stroke();
    st.restore();
  }

  function drawBuilding(b) {
    var x = b.x, y = b.y, w = b.w, h = b.h, ex = b.ex, ey = b.ey, i, t;

    /* 地面投影 */
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath();
    g.moveTo(x + ex * .2, y + h + ey * .2);
    g.lineTo(x + ex * 1.15, y + h + ey * 1.15);
    g.lineTo(x + w + ex * 1.15, y + h + ey * 1.15);
    g.lineTo(x + w + ex * .2, y + h + ey * .2);
    g.closePath(); g.fill();

    /* 两个侧墙：明显的挤出，楼才是楼 */
    var sg = g.createLinearGradient(x, y + h, x + ex, y + h + ey);
    sg.addColorStop(0, 'rgba(26,44,84,.99)');
    sg.addColorStop(1, 'rgba(5,9,20,.99)');
    g.fillStyle = sg;
    g.beginPath();
    g.moveTo(x, y + h); g.lineTo(x + ex, y + h + ey);
    g.lineTo(x + w + ex, y + h + ey); g.lineTo(x + w, y + h); g.closePath(); g.fill();

    var sg2 = g.createLinearGradient(x + w, y, x + w + ex, y + ey);
    sg2.addColorStop(0, 'rgba(17,30,60,.99)');
    sg2.addColorStop(1, 'rgba(4,7,16,.99)');
    g.fillStyle = sg2;
    g.beginPath();
    g.moveTo(x + w, y); g.lineTo(x + w + ex, y + ey);
    g.lineTo(x + w + ex, y + h + ey); g.lineTo(x + w, y + h); g.closePath(); g.fill();

    /* 侧墙窗光 */
    g.fillStyle = b.col; g.globalAlpha = .2;
    for (i = 1; i <= 4; i++) {
      t = i / 5;
      g.fillRect(x + w * t - .7, y + h + ey * .3, 1.4, Math.max(1.2, ey * .32));
      g.fillRect(x + w + ex * .3, y + h * t - .7, Math.max(1.2, ex * .32), 1.4);
    }
    g.globalAlpha = 1;

    /* 轮廓 */
    g.strokeStyle = 'rgba(110,165,240,.28)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y + h); g.lineTo(x + ex, y + h + ey);
    g.lineTo(x + w + ex, y + h + ey); g.lineTo(x + w + ex, y + ey);
    g.stroke();

    /* 楼顶 */
    var gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, 'rgba(30,52,96,.99)');
    gr.addColorStop(1, 'rgba(12,21,43,.99)');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
    g.strokeStyle = b.col;
    g.globalAlpha = .16; g.lineWidth = 4;
    g.strokeRect(x + .8, y + .8, w - 1.6, h - 1.6);
    g.globalAlpha = .95; g.lineWidth = 1.3;
    g.strokeRect(x + .8, y + .8, w - 1.6, h - 1.6);
    g.globalAlpha = 1;

    /* 屋顶灯 */
    g.fillStyle = b.col; g.globalAlpha = .85;
    for (i = 0; i < b.lights.length; i++) {
      var L = b.lights[i];
      g.fillRect(x + L[0] * w, y + L[1] * h, 2.6, 2.6);
    }
    if (b.beacon) {
      g.globalAlpha = .22; g.fillStyle = b.col;
      g.beginPath(); g.arc(x + w / 2, y + h / 2, 5.5, 0, 6.2832); g.fill();
      g.globalAlpha = 1; g.fillStyle = '#FFF2F8';
      g.beginPath(); g.arc(x + w / 2, y + h / 2, 1.9, 0, 6.2832); g.fill();
    }
    g.globalAlpha = 1;
  }

  function redrawGrid() {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, gridCv.width, gridCv.height);
    g.drawImage(stCv, 0, 0);
    cam(g);
    var order = buildings.slice().sort(function (a, b2) { return (a.x + a.y) - (b2.x + b2.y); });
    for (var i = 0; i < order.length; i++) drawBuilding(order[i]);
  }

  /* ---------------- 建筑生成 ---------------- */
  function freeCell() {
    for (var t = 0; t < 40; t++) {
      var ix = ((Math.random() * (NX * 2 - 2)) | 0) - NX + 1;
      var iy = ((Math.random() * (NY * 2 - 2)) | 0) - NY + 1;
      /* 偏向画面右侧（左边被文案盖住） */
      if (ix * CELL < -W * 0.24 && Math.random() < 0.45) continue;
      var k = ix + ':' + iy;
      if (!taken[k]) return { ix: ix, iy: iy, k: k };
    }
    return null;
  }

  function addBuilding(cellObj, col) {
    if (!cellObj) return null;
    taken[cellObj.k] = 1;
    var pad = CELL * (0.13 + Math.random() * 0.12);
    if (Math.random() < .26) pad = CELL * (0.26 + Math.random() * 0.08);
    var wide = 1;
    if (Math.random() < .22 && !taken[(cellObj.ix + 1) + ':' + cellObj.iy]) {
      wide = 2; taken[(cellObj.ix + 1) + ':' + cellObj.iy] = 1;
    }
    var tower = Math.random() < .26;
    var hgt = tower ? (34 + Math.random() * 30) : (8 + Math.random() * 20);
    var lights = [];
    for (var i = 0; i < 3 + ((Math.random() * 5) | 0); i++) lights.push([0.12 + Math.random() * 0.74, 0.12 + Math.random() * 0.74]);
    var b = {
      x: cellObj.ix * CELL + pad,
      y: cellObj.iy * CELL + pad,
      w: CELL * wide - pad * 2,
      h: CELL - pad * 2,
      ex: hgt * 0.70, ey: hgt * 0.52,
      col: col || COLORS[(Math.random() * COLORS.length) | 0],
      lights: lights,
      beacon: Math.random() < .3,
      keys: wide === 2 ? [cellObj.k, (cellObj.ix + 1) + ':' + cellObj.iy] : [cellObj.k]
    };
    buildings.push(b);
    if (buildings.length > MAXB) {
      var old = buildings.shift();
      for (var kk = 0; kk < old.keys.length; kk++) delete taken[old.keys[kk]];
    }
    if (!seeding) redrawGrid();
    return b;
  }

  /* ---------------- 光束（进场的 agent） ---------------- */
  function makeMover() {
    var target = freeCell();
    if (!target) return;
    var col = COLORS[(Math.random() * COLORS.length) | 0];
    var rowI = ((Math.random() * (NY * 1.4)) | 0) - ((NY * 0.7) | 0);
    var rowY = rowI * CELL;
    var tx = target.ix * CELL + CELL / 2;
    var ty = target.iy * CELL + CELL / 2;
    var midX = tx - CELL * (1 + ((Math.random() * 3) | 0));
    movers.push({
      x: gate.x, y: gate.y,
      path: [
        { x: gate.x + CELL * 2, y: gate.y },
        { x: gate.x + CELL * 2, y: rowY },
        { x: midX, y: rowY },
        { x: midX, y: ty },
        { x: tx, y: ty }
      ],
      i: 0,
      sp: 210 + Math.random() * 230,
      col: col,
      pts: [{ x: gate.x, y: gate.y }],
      target: target
    });
  }

  function makeAmbient() {
    var ix = ((Math.random() * NX * 2) | 0) - NX;
    var iy = ((Math.random() * NY * 2) | 0) - NY;
    var horiz = Math.random() < .5;
    ambient.push({
      x: ix * CELL, y: iy * CELL,
      vx: horiz ? (Math.random() < .5 ? -1 : 1) * (26 + Math.random() * 46) : 0,
      vy: horiz ? 0 : (Math.random() < .5 ? -1 : 1) * (26 + Math.random() * 46),
      col: Math.random() < .3 ? '#FF3D9A' : '#2FE6FF',
      a: .25 + Math.random() * .4
    });
  }

  /* ---------------- 主循环 ---------------- */
  var last = 0, acc = 0, nextSpawn = 500, running = false, visible = true;

  function step(dt) {
    var i, m;
    for (i = movers.length - 1; i >= 0; i--) {
      m = movers[i];
      var p = m.path[m.i];
      var dx = p.x - m.x, dy = p.y - m.y;
      var d = Math.hypot(dx, dy);
      var mv = m.sp * dt;
      if (d <= mv) {
        m.x = p.x; m.y = p.y; m.i++;
        if (m.i >= m.path.length) {
          addBuilding(m.target, m.col);
          rings.push({ x: m.x, y: m.y, r: 3, col: m.col, a: 1 });
          movers.splice(i, 1);
          continue;
        }
      } else {
        m.x += dx / d * mv; m.y += dy / d * mv;
      }
      m.pts.push({ x: m.x, y: m.y });
      if (m.pts.length > 18) m.pts.shift();
    }
    for (i = rings.length - 1; i >= 0; i--) {
      var R = rings[i];
      R.r += 62 * dt; R.a -= 1.25 * dt;
      if (R.a <= 0) rings.splice(i, 1);
    }
    for (i = 0; i < ambient.length; i++) {
      var A = ambient[i];
      A.x += A.vx * dt; A.y += A.vy * dt;
      if (A.x < -NX * CELL || A.x > NX * CELL || A.y < -NY * CELL || A.y > NY * CELL) {
        ambient.splice(i, 1); i--; makeAmbient();
      }
    }
  }

  function paint() {
    fx.setTransform(DPR, 0, 0, DPR, 0, 0);
    fx.globalCompositeOperation = 'destination-out';
    fx.fillStyle = 'rgba(0,0,0,.105)';
    fx.fillRect(0, 0, W, H);
    fx.globalCompositeOperation = 'lighter';
    fx.save(); cam(fx);

    var i;
    for (i = 0; i < ambient.length; i++) {
      var A = ambient[i];
      fx.globalAlpha = A.a; fx.fillStyle = A.col;
      fx.fillRect(A.x - 1.2, A.y - 1.2, 2.4, 2.4);
    }
    for (i = 0; i < movers.length; i++) {
      var m = movers[i], j, P = m.pts;
      fx.strokeStyle = m.col; fx.lineCap = 'round';
      for (j = 1; j < P.length; j++) {
        fx.globalAlpha = (j / P.length) * .75;
        fx.lineWidth = .6 + (j / P.length) * 2.6;
        fx.beginPath(); fx.moveTo(P[j - 1].x, P[j - 1].y); fx.lineTo(P[j].x, P[j].y); fx.stroke();
      }
      fx.globalAlpha = 1; fx.fillStyle = m.col;
      fx.shadowColor = m.col; fx.shadowBlur = 16;
      fx.beginPath(); fx.arc(m.x, m.y, 2.8, 0, 6.2832); fx.fill();
      fx.shadowBlur = 0;
    }
    for (i = 0; i < rings.length; i++) {
      var R = rings[i];
      fx.globalAlpha = Math.max(0, R.a) * .85;
      fx.strokeStyle = R.col; fx.lineWidth = 1.6;
      fx.beginPath(); fx.arc(R.x, R.y, R.r, 0, 6.2832); fx.stroke();
    }
    fx.globalAlpha = 1;
    fx.restore();
    fx.globalCompositeOperation = 'source-over';
  }

  function loop(t) {
    if (!running) return;
    if (!last) last = t;
    var dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    acc += dt * 1000;
    if (acc > nextSpawn) { acc = 0; nextSpawn = 420 + Math.random() * 900; makeMover(); }
    step(dt);
    paint();
    requestAnimationFrame(loop);
  }

  function start() {
    if (running || reduced || !visible) return;
    running = true; last = 0; requestAnimationFrame(loop);
  }
  function stop() { running = false; }

  /* ---------------- 初始化 ---------------- */
  function seed() {
    buildings.length = 0; movers.length = 0; rings.length = 0; ambient.length = 0; taken = {};
    drawStreets();
    var n = W < 700 ? 120 : 300, i;
    seeding = true;
    for (i = 0; i < n; i++) addBuilding(freeCell(), null);
    seeding = false;
    for (i = 0; i < (W < 700 ? 16 : 34); i++) makeAmbient();
    redrawGrid();
    if (!reduced) { for (i = 0; i < 9; i++) makeMover(); }
  }

  function init() {
    size(); seed();
    if (reduced) { paint(); return; }
    start();
  }

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { var was = running; stop(); size(); seed(); if (was || !reduced) start(); }, 220);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      if (visible) start(); else stop();
    }, { rootMargin: '120px' });
    io.observe(gridCv);
  }

  init();
})();
