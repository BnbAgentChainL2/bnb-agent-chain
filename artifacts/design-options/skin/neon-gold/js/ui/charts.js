/* BNB Agent Chain · 可视层 · 手绘 SVG 图表（没有图表库，没有网络请求）
   数据全部来自 window.BACVM。没有数据源的图表**不画假曲线**，画一块占位说明。 */
(function (root) {
  'use strict';

  var UI = root.BACUI;
  if (!UI || !UI.util) {
    if (root.console) root.console.error('[BACUI] charts.js 需要先加载 js/ui/util.js');
    return;
  }
  if (UI.charts) return;

  var esc = UI.esc;

  function fmtShort(v) {
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    if (v >= 10) return String(Math.round(v));
    if (v >= 1) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }

  /** 没有数据时的占位：说清楚为什么没有，不画任何图形。 */
  function placeholder(el, text) {
    if (!el) return;
    var h = +el.getAttribute('data-h') || 110;
    el.innerHTML = '<div class="chart-none" style="height:' + h + 'px">' + esc(text) + '</div>';
  }

  /** o: {type:'bar'|'line'|'area', data:[], labels:[], unit, label, tone, padL, bare, zero, alt} */
  function drawChart(el, o) {
    if (!el) return;
    if (!o || !o.data || !o.data.length) { placeholder(el, o && o.none ? o.none : UI.TEXT.PRE); return; }
    var w = el.clientWidth;
    if (!w || w < 40) return;
    var h = +el.getAttribute('data-h') || 110;
    var pl = o.padL === undefined ? 30 : o.padL, pr = 6, pt = 8, pb = 15;
    var iw = w - pl - pr, ih = h - pt - pb;
    var data = o.data, n = data.length;
    var max = Math.max.apply(null, data), min = o.zero === false ? Math.min.apply(null, data) : 0;
    if (max === min) max = min + 1;
    max = max * 1.06;
    var X = function (i) { return pl + (n === 1 ? iw / 2 : iw * i / (n - 1)); };
    var Y = function (v) { return pt + ih - ih * (v - min) / (max - min); };
    var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" role="img" aria-label="' + esc(o.label || '图表') + '">';

    if (!o.bare) {
      for (var g = 0; g <= 2; g++) {
        var gv = min + (max - min) * g / 2, gy = Y(gv);
        s += '<line class="c-grid" x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pr) + '" y2="' + gy.toFixed(1) + '"/>';
        s += '<text class="c-lbl r" x="' + (pl - 5) + '" y="' + (gy + 3).toFixed(1) + '">' + fmtShort(gv) + '</text>';
      }
    }
    s += '<line class="c-axis" x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (w - pr) + '" y2="' + (pt + ih) + '"/>';

    if (o.type === 'bar') {
      var bw = Math.max(1.5, iw / n - (n > 80 ? 0.6 : 2));
      for (var i = 0; i < n; i++) {
        var bx = pl + iw * i / n + (iw / n - bw) / 2;
        var by = Y(data[i]), bh = Math.max(1, pt + ih - by);
        s += '<rect class="c-bar' + (i === n - 1 ? ' hi' : (o.alt ? ' alt' : '')) + '" x="' + bx.toFixed(1) +
          '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"><title>' +
          esc((o.labels ? o.labels[i] + ' · ' : '') + fmtShort(data[i]) + (o.unit || '')) + '</title></rect>';
      }
    } else {
      var pts = data.map(function (v, i2) { return X(i2).toFixed(1) + ',' + Y(v).toFixed(1); });
      var d = 'M' + pts.join(' L');
      if (o.type === 'area') {
        s += '<path class="c-area' + (o.tone === 'amb' ? ' amb' : '') + '" d="' + d + ' L' +
          X(n - 1).toFixed(1) + ',' + (pt + ih) + ' L' + X(0).toFixed(1) + ',' + (pt + ih) + ' Z"/>';
      }
      s += '<path class="c-line' + (o.tone ? ' ' + o.tone : '') + '" d="' + d + '"/>';
      s += '<circle class="c-dot" cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(data[n - 1]).toFixed(1) + '" r="2.4"/>';
      for (var k = 0; k < n; k++) {
        s += '<rect x="' + (X(k) - iw / n / 2).toFixed(1) + '" y="' + pt + '" width="' + (iw / n).toFixed(1) +
          '" height="' + ih + '" fill="transparent"><title>' +
          esc((o.labels ? o.labels[k] + ' · ' : '') + fmtShort(data[k]) + (o.unit || '')) + '</title></rect>';
      }
    }
    if (o.labels && !o.bare) {
      s += '<text class="c-lbl" x="' + pl + '" y="' + (h - 3) + '">' + esc(o.labels[0]) + '</text>';
      s += '<text class="c-lbl" x="' + (pl + iw / 2) + '" y="' + (h - 3) + '" text-anchor="middle">' +
        esc(o.labels[Math.floor(n / 2)]) + '</text>';
      s += '<text class="c-lbl r" x="' + (w - pr) + '" y="' + (h - 3) + '">' + esc(o.labels[n - 1]) + '</text>';
    }
    el.innerHTML = s + '</svg>';
  }

  /** 堆叠柱：series 从下往上叠，对应决策 #17 的三条分账去向。 */
  function drawStacked(el, o) {
    if (!el) return;
    if (!o || !o.series || !o.series.length || !o.series[0].data.length) {
      placeholder(el, o && o.none ? o.none : UI.TEXT.PRE);
      return;
    }
    var w = el.clientWidth; if (!w || w < 40) return;
    var h = +el.getAttribute('data-h') || 110;
    var pl = 34, pr = 6, pt = 8, pb = 15;
    var iw = w - pl - pr, ih = h - pt - pb;
    var n = o.series[0].data.length, totals = [], i, k;
    for (i = 0; i < n; i++) {
      var t = 0;
      for (k = 0; k < o.series.length; k++) t += o.series[k].data[i];
      totals.push(t);
    }
    var max = Math.max.apply(null, totals) * 1.08 || 1;
    var s = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" role="img" aria-label="' + esc(o.label || '图表') + '">';
    for (var g = 0; g <= 2; g++) {
      var gv = max * g / 2, gy = pt + ih - ih * g / 2;
      s += '<line class="c-grid" x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pr) + '" y2="' + gy.toFixed(1) + '"/>';
      s += '<text class="c-lbl r" x="' + (pl - 5) + '" y="' + (gy + 3).toFixed(1) + '">' + fmtShort(gv) + '</text>';
    }
    s += '<line class="c-axis" x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (w - pr) + '" y2="' + (pt + ih) + '"/>';
    var bw = Math.max(1.5, iw / n - 2);
    for (i = 0; i < n; i++) {
      var bx = pl + iw * i / n + (iw / n - bw) / 2, base = pt + ih;
      var tip = (o.labels ? o.labels[i] + ' · ' : '') + '合计 ' + totals[i].toFixed(4) + (o.unit || '');
      for (k = 0; k < o.series.length; k++) {
        var v = o.series[k].data[i];
        tip += '　' + o.series[k].name + ' ' + v.toFixed(4);
        if (v <= 0) continue;
        var bh = ih * v / max;
        base -= bh;
        s += '<rect class="c-bar ' + o.series[k].cls + '" x="' + bx.toFixed(1) + '" y="' + base.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"><title>' + esc(tip) + '</title></rect>';
      }
    }
    if (o.labels) {
      s += '<text class="c-lbl" x="' + pl + '" y="' + (h - 3) + '">' + esc(o.labels[0]) + '</text>';
      s += '<text class="c-lbl" x="' + (pl + iw / 2) + '" y="' + (h - 3) + '" text-anchor="middle">' +
        esc(o.labels[Math.floor(n / 2)]) + '</text>';
      s += '<text class="c-lbl r" x="' + (w - pr) + '" y="' + (h - 3) + '">' + esc(o.labels[n - 1]) + '</text>';
    }
    el.innerHTML = s + '</svg>';
  }

  UI.charts = {
    draw: drawChart,
    stacked: drawStacked,
    placeholder: placeholder,
    fmtShort: fmtShort
  };
})(typeof window !== 'undefined' ? window : globalThis);
