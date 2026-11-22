/*
 * Soda Server — 記録グラフ(グラスの中身・流量)と CO₂ 収支バー
 * 体積と流量は単位が違うので 2 軸にはせず、時間軸をそろえた 2 枚の小さなグラフに分ける。
 */
(function () {
  'use strict';

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  class LineChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts; // { series: [{key, label, color, area}], refs: [{key, label, dash}], yMax, unit }
      this.hoverT = null;
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
    }
    layout(tMax) {
      const padL = 40;
      const padR = 44;
      const padT = 8;
      const padB = 20;
      this.box = { x0: padL, x1: this.W - padR, y0: padT, y1: this.H - padB };
      this.tMax = tMax;
    }
    tx(t) {
      return this.box.x0 + ((this.box.x1 - this.box.x0) * t) / this.tMax;
    }
    ty(v) {
      return this.box.y1 - ((this.box.y1 - this.box.y0) * v) / this.opts.yMax;
    }
    draw(hist, tMax, colors) {
      const c = this.ctx;
      const o = this.opts;
      this.layout(tMax);
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.W, this.H);
      const b = this.box;
      // 目盛り(控えめ)
      c.font = '11px system-ui, sans-serif';
      c.fillStyle = colors.muted;
      c.strokeStyle = colors.grid;
      c.lineWidth = 1;
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      const ys = niceStep(o.yMax, 3);
      for (let v = 0; v <= o.yMax + 1e-9; v += ys) {
        const y = Math.round(this.ty(v)) + 0.5;
        c.beginPath();
        c.moveTo(b.x0, y);
        c.lineTo(b.x1, y);
        c.stroke();
        c.fillText(String(Math.round(v)), b.x0 - 6, y);
      }
      c.textAlign = 'center';
      c.textBaseline = 'top';
      const xs = niceStep(tMax, 6);
      for (let t = 0; t <= tMax + 1e-9; t += xs) c.fillText(`${Math.round(t)}s`, this.tx(t), b.y1 + 5);
      if (!hist.length) return;
      // 基準線(縁の容量・目標)
      for (const r of o.refs || []) {
        c.strokeStyle = colors.ref;
        c.lineWidth = 1.5;
        c.setLineDash(r.dash);
        c.beginPath();
        hist.forEach((h, i) => {
          const x = this.tx(h.t);
          const y = this.ty(r.get(h));
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        });
        c.stroke();
        c.setLineDash([]);
      }
      // 系列
      for (const s of o.series) {
        const col = colors[s.color];
        if (s.area) {
          c.beginPath();
          c.moveTo(this.tx(hist[0].t), this.ty(0));
          hist.forEach((h) => c.lineTo(this.tx(h.t), this.ty(s.get(h))));
          c.lineTo(this.tx(hist[hist.length - 1].t), this.ty(0));
          c.closePath();
          c.globalAlpha = 0.18;
          c.fillStyle = col;
          c.fill();
          c.globalAlpha = 1;
        }
        c.strokeStyle = col;
        c.lineWidth = 2;
        c.lineJoin = 'round';
        c.beginPath();
        hist.forEach((h, i) => {
          const x = this.tx(h.t);
          const y = this.ty(s.get(h));
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        });
        c.stroke();
      }
      // 右端の直接ラベル(文字はインク色、横の短い線が系列を示す)
      const last = hist[hist.length - 1];
      const labels = [];
      for (const s of o.series) labels.push({ y: this.ty(s.get(last)), text: s.label, color: colors[s.color], dash: null });
      for (const r of o.refs || []) labels.push({ y: this.ty(r.get(last)), text: r.label, color: colors.ref, dash: r.dash });
      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 12);
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      for (const l of labels) {
        const x = this.tx(last.t) + 4;
        c.strokeStyle = l.color;
        c.lineWidth = 2;
        c.setLineDash(l.dash || []);
        c.beginPath();
        c.moveTo(x, l.y);
        c.lineTo(x + 7, l.y);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = colors.text;
        c.fillText(l.text, x + 10, l.y);
      }
      // ホバーの十字線
      if (this.hoverT != null) {
        const x = Math.round(this.tx(this.hoverT)) + 0.5;
        c.strokeStyle = colors.muted;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, b.y0);
        c.lineTo(x, b.y1);
        c.stroke();
        const h = nearest(hist, this.hoverT);
        for (const s of o.series) {
          c.beginPath();
          c.arc(this.tx(h.t), this.ty(s.get(h)), 4, 0, Math.PI * 2);
          c.fillStyle = colors[s.color];
          c.fill();
          c.lineWidth = 2;
          c.strokeStyle = colors.surface;
          c.stroke();
        }
      }
    }
    timeAt(clientX) {
      const r = this.canvas.getBoundingClientRect();
      const x = clientX - r.left;
      if (!this.box) return null;
      const t = ((x - this.box.x0) / (this.box.x1 - this.box.x0)) * this.tMax;
      return t < 0 ? 0 : t;
    }
  }

  function nearest(hist, t) {
    let lo = 0;
    let hi = hist.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (hist[m].t < t) lo = m;
      else hi = m;
    }
    return Math.abs(hist[lo].t - t) < Math.abs(hist[hi].t - t) ? hist[lo] : hist[hi];
  }

  class HistoryCharts {
    constructor(volCanvas, flowCanvas, tooltip) {
      const ml = (k) => (h) => h[k] * 1e6;
      this.vol = new LineChart(volCanvas, {
        series: [
          { key: 'liquid', label: '液体', color: 's1', get: ml('liquid') },
          { key: 'total', label: '液体+泡', color: 's2', get: ml('total') },
        ],
        refs: [{ label: '縁', dash: [5, 4], get: ml('cap') }],
        yMax: 400,
      });
      this.flow = new LineChart(flowCanvas, {
        series: [{ key: 'q', label: '流量', color: 's3', area: true, get: ml('q') }],
        refs: [],
        yMax: 150,
      });
      this.tooltip = tooltip;
      this.hist = [];
      this.target = 0;
      const move = (chart) => (e) => {
        const t = chart.timeAt(e.clientX);
        if (!this.hist.length || t == null) return;
        this.vol.hoverT = this.flow.hoverT = Math.min(t, this.hist[this.hist.length - 1].t);
        this.showTip(e);
      };
      const leave = () => {
        this.vol.hoverT = this.flow.hoverT = null;
        tooltip.hidden = true;
      };
      for (const ch of [this.vol, this.flow]) {
        ch.canvas.addEventListener('pointermove', move(ch));
        ch.canvas.addEventListener('pointerleave', leave);
      }
    }
    colors() {
      return {
        s1: css('--series-1', '#2a78d6'),
        s2: css('--series-2', '#eb6834'),
        s3: css('--series-3', '#1baf7a'),
        grid: css('--grid', 'rgba(0,0,0,0.08)'),
        muted: css('--text-muted', '#8a8984'),
        text: css('--text-secondary', '#52514e'),
        ref: css('--text-secondary', '#52514e'),
        surface: css('--surface-1', '#fcfcfb'),
      };
    }
    resize() {
      this.vol.resize();
      this.flow.resize();
    }
    showTip(e) {
      const h = nearest(this.hist, this.vol.hoverT);
      const tip = this.tooltip;
      tip.innerHTML =
        `<div class="tip-t">${h.t.toFixed(2)} 秒</div>` +
        `<div><span class="key s1"></span>液体 <b>${(h.liquid * 1e6).toFixed(0)} mL</b></div>` +
        `<div><span class="key s2"></span>液体+泡 <b>${(h.total * 1e6).toFixed(0)} mL</b></div>` +
        `<div><span class="key ref"></span>縁まで <b>${(h.cap * 1e6).toFixed(0)} mL</b></div>` +
        `<div><span class="key s3"></span>流量 <b>${(h.q * 1e6).toFixed(0)} mL/s</b></div>` +
        `<div>こぼれ <b>${(h.spill * 1e6).toFixed(1)} mL</b></div>`;
      tip.hidden = false;
      const host = tip.offsetParent || document.body;
      const r = host.getBoundingClientRect();
      let x = e.clientX - r.left + 14;
      if (x + tip.offsetWidth > r.width) x = e.clientX - r.left - tip.offsetWidth - 14;
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY - r.top - 10}px`;
    }
    draw(game) {
      const hist = game.history;
      this.hist = hist;
      const sim = game.sim;
      const tEnd = hist.length ? hist[hist.length - 1].t : 0;
      const tMax = Math.max(8, Math.ceil((tEnd + 0.5) / 2) * 2);
      this.vol.opts.yMax = Math.ceil((sim.glass.volume * 1e6 * 1.08) / 50) * 50;
      const colors = this.colors();
      this.vol.draw(hist, tMax, colors);
      // 目標量の水平線
      const c = this.vol.ctx;
      const y = Math.round(this.vol.ty(sim.targetVolume * 1e6)) + 0.5;
      c.strokeStyle = colors.ref;
      c.setLineDash([2, 3]);
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(this.vol.box.x0, y);
      c.lineTo(this.vol.box.x1, y);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = colors.text;
      c.textAlign = 'left';
      c.textBaseline = 'bottom';
      c.font = '11px system-ui, sans-serif';
      c.fillText('目標', this.vol.box.x0 + 4, y - 2);
      this.flow.draw(hist, tMax, colors);
    }
  }

  // CO₂ 収支(ボトルから出た分の内訳)
  class BudgetBar {
    constructor(barEl, legendEl) {
      this.bar = barEl;
      this.legend = legendEl;
      this.parts = [
        { key: 'dissolved', label: '溶けたまま', cls: 's1' },
        { key: 'bubbles', label: '液中の気泡', cls: 's2' },
        { key: 'foam', label: '泡の中', cls: 's3' },
        { key: 'escaped', label: '大気へ', cls: 's4' },
        { key: 'spilled', label: 'こぼれ', cls: 's5' },
      ];
      this.bar.innerHTML = this.parts.map((p) => `<span class="seg ${p.cls}" data-k="${p.key}"></span>`).join('');
      this.legend.innerHTML = this.parts
        .map((p) => `<li><span class="key ${p.cls}"></span>${p.label} <b data-k="${p.key}">0</b></li>`)
        .join('');
    }
    update(b) {
      const M = 44.01e3; // mol → mg
      const vals = {
        dissolved: b.dissolved + b.flight,
        bubbles: b.bubbles,
        foam: b.foam,
        escaped: b.escaped,
        spilled: b.spilled,
      };
      const total = Object.values(vals).reduce((a, v) => a + Math.max(0, v), 0);
      for (const p of this.parts) {
        const v = Math.max(0, vals[p.key]);
        const seg = this.bar.querySelector(`[data-k="${p.key}"]`);
        seg.style.flexGrow = total > 0 ? String(v / total) : '0';
        seg.style.display = v > 0 && total > 0 ? '' : 'none';
        this.legend.querySelector(`b[data-k="${p.key}"]`).textContent =
          total > 0 ? `${(v * M).toFixed(v * M < 10 ? 1 : 0)} mg (${((100 * v) / total).toFixed(0)}%)` : '—';
      }
    }
  }

  window.HistoryCharts = HistoryCharts;
  window.BudgetBar = BudgetBar;
})();
