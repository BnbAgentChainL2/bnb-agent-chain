/* Decorative signals only. No RPC, network requests, or chain-state bindings. */
(function () {
  'use strict';

  var hero = document.querySelector('.hero');
  if (!hero) return;

  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var visible = !('IntersectionObserver' in window);

  function sync() {
    var allowed = !motion.matches;
    hero.dataset.signals = allowed && visible && !document.hidden ? 'running' : 'paused';
  }

  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      sync();
    }).observe(hero);
  }

  sync();
}());
