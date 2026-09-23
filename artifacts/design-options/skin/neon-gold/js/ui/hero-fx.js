/* BNB Agent Chain · 首屏金色粒子网格
   纯 canvas，无库、无网络请求。只画在 #heroFx 上，数据表里不放任何动画。
   规则：离开视口就停、prefers-reduced-motion 就不画、只用 requestAnimationFrame。 */
(function (root) {
  'use strict';

  var doc = root.document;
  function boot() {
    var cv = doc.getElementById('heroFx');
    if (!cv || !cv.getContext) return;
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cv.style.display = 'none';
      return;
    }
    var ctx = cv.getContext('2d');
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var W = 0, H = 0, pts = [], raf = 0, visible = true;

    function size() {
      var r = cv.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      /* 密度跟面积走，宽屏也不会变成一锅粥 */
      var n = Math.max(18, Math.min(64, Math.round(W * H / 16000)));
      pts = [];
      for (var i = 0; i < n; i++) {
        pts.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.18,
          vy: (Math.random() - 0.5) * 0.18,
          r: 0.8 + Math.random() * 1.7,
          a: 0.25 + Math.random() * 0.5
        });
      }
    }

    var LINK = 132;
    function frame() {
      raf = 0;
      if (!visible) return;
      ctx.clearRect(0, 0, W, H);

      var i, j, p, q, dx, dy, d2, al;
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      }
      /* 连线先画，点压在上面 */
      ctx.lineWidth = 1;
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        for (j = i + 1; j < pts.length; j++) {
          q = pts[j];
          dx = p.x - q.x; dy = p.y - q.y; d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          al = (1 - Math.sqrt(d2) / LINK) * 0.16;
          ctx.strokeStyle = 'rgba(240,185,11,' + al.toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        ctx.fillStyle = 'rgba(252,213,53,' + p.a.toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      tick();
    }
    function tick() { if (!raf && visible) raf = root.requestAnimationFrame(frame); }

    size();
    tick();

    var rt;
    root.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(size, 160);
    });
    doc.addEventListener('visibilitychange', function () {
      visible = !doc.hidden && visible !== 'off';
      if (!doc.hidden) { visible = true; tick(); } else { visible = false; }
    });
    if (root.IntersectionObserver) {
      new root.IntersectionObserver(function (es) {
        visible = es[0].isIntersecting && !doc.hidden;
        if (visible) tick();
      }, { threshold: 0 }).observe(cv);
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
