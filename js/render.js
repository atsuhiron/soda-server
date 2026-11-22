/*
 * Soda Server — シーン描画(Canvas 2D)
 * 物理エンジン(SodaPhysics.Simulation)の状態をそのまま絵にする。物理量は一切書き換えない。
 */
(function () {
  'use strict';
  const P = window.SodaPhysics;
  const TAU = Math.PI * 2;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

  // y ≤ Y(below = true)または y ≥ Y の側だけ残す多角形クリップ
  function clipY(poly, Y, below) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ina = below ? a.y <= Y : a.y >= Y;
      const inb = below ? b.y <= Y : b.y >= Y;
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = (Y - a.y) / (b.y - a.y);
        out.push({ x: a.x + (b.x - a.x) * t, y: Y });
      }
    }
    return out;
  }

  class SceneRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = 1;
      this.W = 1;
      this.H = 1;
      this.drips = [];
      this.splashes = [];
      this.puddle = 0;
      this.puddleFoam = 0;
      this.time = 0;
      this.patternKey = '';
      this.theme = {};
      this.readTheme();
    }

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
      this.theme = {
        wallTop: v('--scene-top', '#f4efe6'),
        wallBottom: v('--scene-bottom', '#e7dece'),
        tableTop: v('--table-top', '#c39a6b'),
        tableFront: v('--table-front', '#8f6643'),
        ink: v('--text-secondary', '#52514e'),
        tile: v('--scene-tile', 'rgba(0,0,0,0.035)'),
      };
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
    }

    // 世界座標 [m] → 画面座標 [px]
    fit(sim) {
      const xmin = -0.13;
      const xmax = 0.27;
      const ymin = sim.tableY - 0.025;
      const ymax = 0.3;
      this.s = Math.min(this.W / (xmax - xmin), this.H / (ymax - ymin));
      this.ox = this.W / 2 - (this.s * (xmin + xmax)) / 2;
      this.oy = this.H / 2 + (this.s * (ymin + ymax)) / 2;
    }
    X(x) {
      return this.ox + x * this.s;
    }
    Y(y) {
      return this.oy - y * this.s;
    }
    // ローカル座標系(原点 O, 単位ベクトル eu, ez、単位 m)で描くための変換
    frame(O, eu, ez) {
      const s = this.s * this.dpr;
      const d = this.dpr;
      this.ctx.setTransform(s * eu.x, -s * eu.y, s * ez.x, -s * ez.y, d * (this.ox + this.s * O.x), d * (this.oy - this.s * O.y));
    }
    screen() {
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    path(pts) {
      const c = this.ctx;
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = this.X(pts[i].x);
        const y = this.Y(pts[i].y);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
    }

    ensureFoamPattern(drink) {
      const key = drink.name;
      if (this.patternKey === key && this.foamPattern) return;
      const size = 160;
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const g = cv.getContext('2d');
      const fc = drink.foam;
      g.fillStyle = rgba(fc, 1);
      g.fillRect(0, 0, size, size);
      const rng = P.mulberry32(42);
      const coarse = drink.life < 3 ? 2.2 : drink.life > 60 ? 0.6 : 1.1; // 炭酸水は粗い泡、ビールはきめ細かい
      const shade = mix(fc, [120, 110, 100], 0.35);
      for (let i = 0; i < 260; i++) {
        const r = (1.2 + rng() * rng() * 7) * coarse;
        const x = rng() * size;
        const y = rng() * size;
        for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
          g.beginPath();
          g.arc(x + dx, y + dy, r, 0, TAU);
          g.strokeStyle = rgba(shade, 0.45);
          g.lineWidth = 0.8;
          g.stroke();
          g.beginPath();
          g.arc(x + dx - r * 0.3, y + dy - r * 0.3, r * 0.28, 0, TAU);
          g.fillStyle = 'rgba(255,255,255,0.7)';
          g.fill();
        }
      }
      this.foamPattern = this.ctx.createPattern(cv, 'repeat');
      this.patternKey = key;
    }

    render(game, dt) {
      const sim = game.sim;
      const c = this.ctx;
      this.time += dt;
      this.fit(sim);
      this.screen();
      c.clearRect(0, 0, this.W, this.H);
      this.drawBackground(sim);
      this.consumeSpill(sim, dt);
      this.drawPuddle(sim);
      this.drawGlassBody(sim);
      this.drawContents(sim);
      this.drawStream(sim);
      this.drawIce(sim);
      this.drawGlassFront(sim);
      this.drawBottle(sim);
      this.drawParticles(sim, dt);
      this.screen();
    }

    drawBackground(sim) {
      const c = this.ctx;
      const t = this.theme;
      const ty = this.Y(sim.tableY);
      const g = c.createLinearGradient(0, 0, 0, ty);
      g.addColorStop(0, t.wallTop);
      g.addColorStop(1, t.wallBottom);
      c.fillStyle = g;
      c.fillRect(0, 0, this.W, ty);
      // タイル目地
      c.strokeStyle = t.tile;
      c.lineWidth = 1;
      const step = Math.max(28, this.s * 0.05);
      c.beginPath();
      for (let y = ty - step; y > 0; y -= step) {
        c.moveTo(0, y);
        c.lineTo(this.W, y);
      }
      for (let x = (this.X(0) % step) - step; x < this.W; x += step) {
        c.moveTo(x, 0);
        c.lineTo(x, ty);
      }
      c.stroke();
      // テーブル
      const depth = Math.max(10, this.s * 0.018);
      c.fillStyle = t.tableTop;
      c.fillRect(0, ty, this.W, depth);
      const g2 = c.createLinearGradient(0, ty + depth, 0, this.H);
      g2.addColorStop(0, t.tableFront);
      g2.addColorStop(1, 'rgba(0,0,0,0.25)');
      c.fillStyle = g2;
      c.fillRect(0, ty + depth, this.W, this.H - ty - depth);
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(0, ty, this.W, 1.5);
    }

    // こぼれた量を描画用の滴に変える(物理側の spillFx を読んで 0 に戻す)
    consumeSpill(sim, dt) {
      const fx = sim.spillFx;
      const total = fx.foam + fx.liquid;
      if (total > 0) {
        const n = Math.min(12, Math.ceil(total * 1e6 * 1.5));
        const rim = sim.rimR;
        for (let i = 0; i < n; i++) {
          this.drips.push({
            x: rim.x + 0.002 + Math.random() * 0.002,
            y: rim.y - Math.random() * 0.003,
            vx: 0.02 + Math.random() * 0.05,
            vy: -0.02 - Math.random() * 0.05,
            r: fx.foam > fx.liquid ? 0.0025 + Math.random() * 0.002 : 0.0014 + Math.random() * 0.001,
            foam: fx.foam > fx.liquid,
            stick: 0.25 + Math.random() * 0.35,
          });
        }
        this.puddle += fx.liquid;
        this.puddleFoam += fx.foam * 0.3;
        this.puddleX = rim.x + 0.01;
        fx.foam = 0;
        fx.liquid = 0;
      }
      if (this.drips.length > 300) this.drips.splice(0, this.drips.length - 300);
      this.puddleFoam *= Math.exp(-dt / Math.max(0.5, sim.foamLife));
    }

    drawPuddle(sim) {
      const vol = this.puddle; // 流れ出た液の合計(描画用)
      if (vol <= 1e-7 && this.puddleFoam <= 1e-7) return;
      const c = this.ctx;
      const d = sim.drink;
      const w = Math.min(0.2, 0.012 + Math.sqrt(vol) * 0.9);
      const x = this.X(Math.max(-0.1, Math.min(0.2, this.puddleX || 0.05)));
      const y = this.Y(sim.tableY) + 2;
      c.beginPath();
      c.ellipse(x, y, w * this.s, Math.max(2, w * this.s * 0.12), 0, 0, TAU);
      c.fillStyle = rgba(d.color, Math.min(0.85, 0.35 + d.alpha * 0.5));
      c.fill();
      if (this.puddleFoam > 1e-7) {
        c.beginPath();
        c.ellipse(x, y - 1, w * this.s * 0.6, Math.max(1.5, w * this.s * 0.07), 0, 0, TAU);
        c.fillStyle = rgba(d.foam, Math.min(0.9, this.puddleFoam * 2e5));
        c.fill();
      }
    }

    glassFrame(sim) {
      return { O: { x: sim.gOx, y: sim.gOy }, eu: { x: sim.gc, y: -sim.gs }, ez: { x: sim.gs, y: sim.gc } };
    }

    drawGlassBody(sim) {
      const c = this.ctx;
      const gd = sim.glassDef;
      // 脚(フルート)
      if (gd.stem) {
        const f = this.glassFrame(sim);
        this.frame(f.O, f.eu, f.ez);
        c.fillStyle = 'rgba(214,232,242,0.55)';
        c.strokeStyle = 'rgba(110,135,155,0.55)';
        c.lineWidth = 1 / this.s;
        c.beginPath();
        c.moveTo(-0.0032, -gd.base);
        c.lineTo(-0.0026, -gd.base - gd.stem);
        c.lineTo(0.0026, -gd.base - gd.stem);
        c.lineTo(0.0032, -gd.base);
        c.closePath();
        c.fill();
        c.stroke();
        c.beginPath();
        c.ellipse(0, -gd.base - gd.stem - 0.002, gd.foot, 0.0028, 0, 0, TAU);
        c.fill();
        c.stroke();
        this.screen();
      }
      this.path(sim.outer);
      c.fillStyle = 'rgba(226,240,248,0.28)';
      c.fill();
    }

    drawContents(sim) {
      const c = this.ctx;
      const d = sim.drink;
      const inner = sim.inner;
      if (sim.VL + sim.Vfl > 2e-8) {
        // 液体
        const liq = clipY(inner, sim.yL1, true);
        if (liq.length > 2) {
          this.path(liq);
          const top = this.Y(sim.yL1);
          const bot = this.Y(Math.min(...liq.map((p) => p.y)));
          const g = c.createLinearGradient(0, top, 0, bot);
          g.addColorStop(0, rgba(mix(d.color, [255, 255, 255], 0.12), d.alpha * 0.9));
          g.addColorStop(1, rgba(mix(d.color, [0, 0, 0], 0.15), Math.min(1, d.alpha * 1.1)));
          c.fillStyle = g;
          c.fill();
          // 気泡
          c.save();
          this.path(liq);
          c.clip();
          this.drawBubbles(sim);
          c.restore();
        }
        // 泡層
        const foamTop = sim.yL2 + sim.dome;
        if (foamTop - sim.yL1 > 1e-4) this.drawFoam(sim, inner);
      }
    }

    drawBubbles(sim) {
      const c = this.ctx;
      const Pp = sim.parcels;
      const dark = sim.drink.alpha > 0.7;
      const s = this.s;
      const front = new Path2D();
      const back = new Path2D();
      for (let i = 0; i < Pp.n; i++) {
        const x = this.X(Pp.x[i]);
        const y = this.Y(Pp.y[i]);
        const r = Math.min(5, Pp.R[i] * s * 1.7 + 0.55);
        const kind = Pp.kind[i];
        const seed = Pp.seed[i];
        const target = kind === P.KIND_WALL && seed < 0 ? back : front;
        if (kind === P.KIND_AIR || kind === P.KIND_SEED) {
          // 1 パーセル = 多数の気泡。数に応じて小さな塊として描く
          const k = Math.min(kind === P.KIND_AIR ? 6 : 4, 1 + Math.floor(Math.log10(Pp.N[i] + 1)));
          for (let j = 0; j < k; j++) {
            const a = (seed * 9.7 + j * 2.399) * TAU;
            const rr = j === 0 ? 0 : (2 + j * 2.2) * (kind === P.KIND_AIR ? 1.2 : 2.2);
            const bx = x + Math.cos(a) * rr;
            const by = y + Math.sin(a) * rr * 0.8;
            target.moveTo(bx + r, by);
            target.arc(bx, by, r, 0, TAU);
          }
        } else {
          target.moveTo(x + r, y);
          target.arc(x, y, r, 0, TAU);
        }
      }
      c.fillStyle = dark ? 'rgba(255,240,225,0.28)' : 'rgba(255,255,255,0.45)';
      c.fill(back);
      c.fillStyle = dark ? 'rgba(255,244,232,0.62)' : 'rgba(255,255,255,0.85)';
      c.strokeStyle = dark ? 'rgba(255,255,255,0.25)' : 'rgba(90,120,140,0.45)';
      c.lineWidth = 0.6;
      c.fill(front);
      c.stroke(front);
    }

    drawFoam(sim, inner) {
      const c = this.ctx;
      const d = sim.drink;
      let poly = clipY(inner, sim.yL1, false);
      poly = clipY(poly, sim.yL2, true);
      if (poly.length < 3) return;
      // 多角形を辿り、上端の辺(y = yL2)だけをドーム状の盛り上がり + 細かな凹凸に置き換える
      c.save();
      c.beginPath();
      const domePx = sim.dome * this.s;
      const isTop = (p) => Math.abs(p.y - sim.yL2) < 1e-7;
      c.moveTo(this.X(poly[0].x), this.Y(poly[0].y));
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (isTop(a) && isTop(b)) {
          const xa = this.X(a.x);
          const xb = this.X(b.x);
          const y = this.Y(sim.yL2);
          const n = Math.max(6, Math.floor(Math.abs(xb - xa) / 5));
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            const x = xa + (xb - xa) * t;
            const ripple = k < n ? Math.sin(x * 0.45 + this.time * 0.9) * 0.8 + 0.8 : 0;
            c.lineTo(x, y - Math.sin(t * Math.PI) * domePx * 2 - ripple);
          }
        } else {
          c.lineTo(this.X(b.x), this.Y(b.y));
        }
      }
      c.closePath();
      this.ensureFoamPattern(d);
      const m = new DOMMatrix([1, 0, 0, 1, this.X(sim.gOx), this.Y(sim.gOy) + this.time * 2]);
      this.foamPattern.setTransform(m);
      c.fillStyle = this.foamPattern;
      c.fill();
      // 下ほど液を含んで飲み物の色に近い(湿った泡 → 乾いた泡)
      const wet = sim.Vfl / Math.max(1e-12, sim.foamVolume());
      const yb = this.Y(sim.yL1);
      const yt = this.Y(sim.yL2 + sim.dome);
      const g = c.createLinearGradient(0, yb, 0, yt);
      g.addColorStop(0, rgba(d.color, Math.min(0.75, 0.25 + wet * 1.8) * Math.min(1, d.alpha + 0.2)));
      g.addColorStop(Math.min(0.9, 0.25 + wet * 2), rgba(d.color, 0));
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = rgba(mix(d.foam, [140, 130, 120], 0.3), 0.5);
      c.lineWidth = 1;
      c.stroke();
      c.restore();
    }

    drawStream(sim) {
      const c = this.ctx;
      const d = sim.drink;
      const pk = sim.packets;
      if (!pk.length) return;
      const col = rgba(mix(d.color, [255, 255, 255], 0.06), Math.min(0.95, d.alpha + 0.15));
      c.lineCap = 'round';
      c.lineJoin = 'round';
      // 空中の液柱: 連続して出た小包どうしを結ぶ
      for (let i = 1; i < pk.length; i++) {
        const a = pk[i - 1];
        const b = pk[i];
        if (a.mode !== b.mode || Math.abs(a.age - b.age) > 0.02) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 0.02) continue;
        let w;
        if (b.mode === 0) {
          const v = Math.max(0.1, Math.hypot(b.vx, b.vy));
          w = Math.sqrt((4 * b.Q) / (Math.PI * v)) * this.s * (b.glug > 0.5 ? 1.12 : 1);
        } else if (b.mode === 1) {
          w = Math.max(2, Math.sqrt(b.Q) * 0.4 * this.s);
        } else continue;
        c.strokeStyle = col;
        c.lineWidth = Math.max(1.2, w);
        c.beginPath();
        c.moveTo(this.X(a.x), this.Y(a.y));
        c.lineTo(this.X(b.x), this.Y(b.y));
        c.stroke();
      }
      // つや
      c.strokeStyle = 'rgba(255,255,255,0.32)';
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < pk.length; i++) {
        const a = pk[i - 1];
        const b = pk[i];
        if (a.mode !== 0 || b.mode !== 0 || Math.abs(a.age - b.age) > 0.02) continue;
        c.moveTo(this.X(a.x) - 1, this.Y(a.y));
        c.lineTo(this.X(b.x) - 1, this.Y(b.y));
      }
      c.stroke();
      // こぼれた滴
      c.fillStyle = col;
      for (const p of pk) {
        if (p.mode !== 2) continue;
        c.beginPath();
        c.arc(this.X(p.x), this.Y(p.y), 1.8, 0, TAU);
        c.fill();
      }
      // 突入点のしぶき(見た目だけ)
      const im = sim.impact;
      if (im && sim.t - im.t < 0.05 && im.v > 0.9 && !im.attached && Math.random() < 0.6) {
        const n = Math.min(3, Math.floor((im.v - 0.8) * 3) + 1);
        for (let i = 0; i < n; i++) {
          this.splashes.push({ x: im.x, y: sim.yL2 + 0.001, vx: (Math.random() - 0.5) * 0.25, vy: 0.2 + Math.random() * im.v * 0.3, life: 0.5 });
        }
      }
    }

    drawIce(sim) {
      const c = this.ctx;
      for (const cb of sim.ice) {
        const h = cb.a / 2;
        this.frame({ x: cb.x, y: cb.y }, { x: Math.cos(cb.ang), y: Math.sin(cb.ang) }, { x: -Math.sin(cb.ang), y: Math.cos(cb.ang) });
        const r = cb.a * 0.18;
        c.beginPath();
        c.moveTo(-h + r, -h);
        c.arcTo(h, -h, h, h, r);
        c.arcTo(h, h, -h, h, r);
        c.arcTo(-h, h, -h, -h, r);
        c.arcTo(-h, -h, h, -h, r);
        c.closePath();
        c.fillStyle = 'rgba(236,248,255,0.5)';
        c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.85)';
        c.lineWidth = 1.2 / this.s;
        c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.45)';
        c.fillRect(-h * 0.6, h * 0.25, h * 0.9, h * 0.22);
        this.screen();
      }
    }

    drawGlassFront(sim) {
      const c = this.ctx;
      const g = sim.glass;
      this.path(sim.outer);
      c.strokeStyle = 'rgba(105,130,150,0.75)';
      c.lineWidth = 1.4;
      c.stroke();
      this.path(sim.inner);
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = 1;
      c.stroke();
      // ハイライトと目標線(グラスに印刷された線として描く)
      const f = this.glassFrame(sim);
      this.frame(f.O, f.eu, f.ez);
      const H = g.H;
      c.fillStyle = 'rgba(255,255,255,0.32)';
      c.beginPath();
      c.moveTo(-g.radiusAt(H * 0.1) * 0.78, H * 0.1);
      c.lineTo(-g.radiusAt(H * 0.92) * 0.74, H * 0.92);
      c.lineTo(-g.radiusAt(H * 0.92) * 0.6, H * 0.92);
      c.lineTo(-g.radiusAt(H * 0.1) * 0.66, H * 0.1);
      c.closePath();
      c.fill();
      const zt = g.solveLevel(sim.targetVolume, 1, 0);
      const rt = g.radiusAt(zt) + sim.glassDef.wall;
      c.strokeStyle = 'rgba(214,72,60,0.85)';
      c.lineWidth = 1.6 / this.s;
      c.setLineDash([4 / this.s, 3 / this.s]);
      c.beginPath();
      c.moveTo(-rt, zt);
      c.lineTo(rt, zt);
      c.stroke();
      c.setLineDash([]);
      this.screen();
      const lp = sim.toWorld(-(rt + 0.004), zt);
      c.fillStyle = 'rgba(190,58,48,0.95)';
      c.font = '600 11px system-ui, sans-serif';
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.fillText('目標', this.X(lp.x), this.Y(lp.y));
    }

    drawBottle(sim) {
      const c = this.ctx;
      const phi = sim.phi;
      const O = { x: sim.bottleOx, y: sim.bottleOy };
      const eu = { x: Math.cos(phi), y: Math.sin(phi) };
      const ez = { x: -Math.sin(phi), y: Math.cos(phi) };
      const prof = P.BOTTLE.profile;
      const t = 0.0009;
      const outline = (off) => {
        c.beginPath();
        for (let k = 0; k < prof.length; k++) c.lineTo(prof[k][1] + off, prof[k][0]);
        for (let k = prof.length - 1; k >= 0; k--) c.lineTo(-(prof[k][1] + off), prof[k][0]);
        c.closePath();
      };
      this.frame(O, eu, ez);
      const lw = 1 / this.s;
      // 本体
      outline(t);
      c.fillStyle = 'rgba(225,238,244,0.35)';
      c.fill();
      // 中身(水平な液面で切る)
      if (sim.Vb > 1e-8 && sim.bottleLevel > -0.5) {
        c.save();
        outline(0);
        c.clip();
        this.screen();
        const yb = this.Y(sim.bottleOy + sim.bottleLevel);
        c.fillStyle = rgba(sim.drink.color, Math.min(0.95, sim.drink.alpha + 0.1));
        c.fillRect(0, yb, this.W, this.H);
        c.restore();
        this.frame(O, eu, ez);
      }
      // ラベル
      c.fillStyle = 'rgba(240,246,244,0.92)';
      c.fillRect(-0.0325, 0.05, 0.065, 0.06);
      c.fillStyle = 'rgba(20,130,140,0.9)';
      c.fillRect(-0.0325, 0.072, 0.065, 0.016);
      c.save();
      c.translate(0, 0.08);
      c.rotate(-Math.PI / 2);
      c.scale(1, -1);
      c.fillStyle = 'rgba(255,255,255,0.95)';
      c.font = `700 ${0.011}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('SODA', 0, 0);
      c.restore();
      // 輪郭・口
      outline(t);
      c.strokeStyle = 'rgba(95,125,145,0.8)';
      c.lineWidth = 1.2 * lw;
      c.stroke();
      c.fillStyle = 'rgba(200,215,225,0.9)';
      c.fillRect(-0.0165, 0.1855, 0.033, 0.0022);
      c.strokeRect(-0.0165, 0.1855, 0.033, 0.0022);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillRect(-0.026, 0.012, 0.005, 0.13);
      this.screen();
    }

    drawParticles(sim, dt) {
      const c = this.ctx;
      const d = sim.drink;
      const tableY = sim.tableY;
      // 縁からあふれた滴: 外壁を伝い、テーブルに落ちる
      let w = 0;
      for (const p of this.drips) {
        if (p.stick > 0) {
          p.stick -= dt;
          p.y -= 0.06 * dt;
          p.x += 0.008 * dt;
        } else {
          p.vy -= 9.81 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        if (p.y < tableY) continue;
        this.drips[w++] = p;
        c.beginPath();
        c.arc(this.X(p.x), this.Y(p.y), Math.max(1.2, p.r * this.s), 0, TAU);
        c.fillStyle = p.foam ? rgba(d.foam, 0.92) : rgba(d.color, Math.min(0.95, d.alpha + 0.2));
        c.fill();
      }
      this.drips.length = w;
      // しぶき
      w = 0;
      for (const p of this.splashes) {
        p.life -= dt;
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // 見た目だけのしぶきなので、グラスの外へ飛んだもの(=こぼれに見えるもの)は消す
        if (p.life <= 0 || p.y < sim.yL1 || !sim.insideInner(p.x, p.y)) continue;
        this.splashes[w++] = p;
        c.beginPath();
        c.arc(this.X(p.x), this.Y(p.y), 1.4, 0, TAU);
        c.fillStyle = rgba(mix(d.color, [255, 255, 255], 0.3), Math.min(0.9, d.alpha + 0.2));
        c.fill();
      }
      this.splashes.length = Math.min(w, 120);
    }

    resetFx() {
      this.drips.length = 0;
      this.splashes.length = 0;
      this.puddle = 0;
      this.puddleFoam = 0;
    }
  }

  window.SceneRenderer = SceneRenderer;
})();
