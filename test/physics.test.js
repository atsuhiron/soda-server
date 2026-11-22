'use strict';
// 物理エンジンの単体テスト:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics.js');
const { runPour } = require('../tools/autoplayer.js');

const close = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);

test('円柱: 体積と液面高さ', () => {
  const v = new P.Vessel([[0, 0.03], [0.1, 0.03]], 50);
  close(v.volume, Math.PI * 0.03 ** 2 * 0.1, 1e-9, '体積');
  close(v.solveLevel(1e-4, 1, 0), 1e-4 / (Math.PI * 0.03 ** 2), 1e-6, '直立の液面');
});

test('円錐台の体積は解析解と一致する', () => {
  const [r1, r2, H] = [0.03, 0.036, 0.11];
  const v = new P.Vessel([[0, r1], [H, r2]], 64);
  close(v.volume, (Math.PI * H * (r1 * r1 + r1 * r2 + r2 * r2)) / 3, 1e-9, '体積');
});

test('傾けた円柱の容量は πR²(H − R tanθ)', () => {
  const [R, H] = [0.03, 0.12];
  const v = new P.Vessel([[0, R], [H, R]], 80);
  for (const deg of [10, 30, 45]) {
    const th = (deg * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    close(v.volumeArea(H * c - R * s, c, s), Math.PI * R * R * (H - R * Math.tan(th)), 1e-6, `${deg}°`);
  }
});

test('体積 → 液面高さ → 体積 が元に戻る(任意の傾き、ボトルの倒立含む)', () => {
  const sim = new P.Simulation({});
  for (const vessel of [sim.glass, sim.bottle]) {
    for (const deg of [0, 20, 55, 90, 120, 165]) {
      const th = (deg * Math.PI) / 180;
      for (const frac of [0.05, 0.4, 0.9]) {
        const V = vessel.volume * frac;
        const L = vessel.solveLevel(V, Math.cos(th), Math.sin(th));
        close(vessel.volumeArea(L, Math.cos(th), Math.sin(th)), V, 1e-6, `${deg}° ${frac}`);
      }
    }
  }
});

test('溶解度と過飽和度は報告書 §1 の値に一致する', () => {
  close(P.solubilityGL(5), 2.9, 1e-9, '5℃');
  close(P.solubilityGL(25), 1.5, 1e-9, '25℃');
  const cola = 7; // g/L
  close(cola / P.solubilityGL(5) - 1, 1.4, 0.02, '5℃ のコーラ S');
  close(cola / P.solubilityGL(25) - 1, 3.7, 0.02, '25℃ のコーラ S');
});

test('気泡の終端速度は報告書 §5.1 の表の目安どおり', () => {
  const table = [[50e-6, 0.0014], [100e-6, 0.005], [0.5e-3, 0.07], [1e-3, 0.1], [3e-3, 0.25]];
  for (const [d, u] of table) close(P.terminalVelocity(d, 998, 1.0e-3, 0.072), u, 0.3, `${d * 1000} mm`);
});

test('ボトル: 満杯なら 60〜80° で出始め、減るほど深く傾ける必要がある', () => {
  const sim = new P.Simulation({});
  const full = (sim.onsetTilt() * 180) / Math.PI;
  assert.ok(full > 55 && full < 85, `満杯: ${full}`);
  sim.Vb = 150e-6;
  assert.ok((sim.onsetTilt() * 180) / Math.PI > full + 20, '残り 150 mL');
});

test('注いでいる間も CO₂ と液量が保存される', () => {
  const r = runPour({ drink: 'cola', ice: 2 }, { q: 1, tilt: 0.6, straightenFrom: 0.3, straightenTo: 0.8 });
  const s = r.game.sim;
  const b = s.co2Budget();
  const sum = b.bottle + b.flight + b.dissolved + b.bubbles + b.foam + b.escaped + b.spilled;
  close(sum, b.total0, 1e-9, 'CO₂');
  let flight = 0;
  for (const p of s.packets) if (p.mode !== 2) flight += p.dV;
  close(s.VL + s.Vfl + s.spilledLiquid + flight + s.Vb, P.BOTTLE.volume, 1e-9, '液量');
});

test('壁を伝わせると、まっすぐ注ぐより泡が少ない(§8)', () => {
  const upright = runPour({}, { q: 70e-6 });
  const wall = runPour({}, { q: 70e-6, tilt: 0.8, straightenFrom: 0.45, straightenTo: 0.9 });
  assert.ok(wall.foamMax < upright.foamMax * 0.8, `${wall.foamMax} vs ${upright.foamMax}`);
});

test('高い位置から注ぐほど泡が多い(突入速度 √2gH)', () => {
  const low = runPour({}, { q: 50e-6, mouth: 0.01 });
  const high = runPour({}, { q: 50e-6, mouth: 0.05 });
  assert.ok(high.foamMax > low.foamMax * 1.15, `${high.foamMax} vs ${low.foamMax}`);
});

test('液温が高いほど泡が多い(§3.1)', () => {
  const cold = runPour({ liquidTemp: 3 }, { q: 60e-6 });
  const warm = runPour({ liquidTemp: 25 }, { q: 60e-6 });
  assert.ok(warm.foamMax > cold.foamMax * 1.3, `${warm.foamMax} vs ${cold.foamMax}`);
});

test('氷を入れると泡が増える(§2.2)', () => {
  const none = runPour({}, { q: 60e-6 });
  const ice = runPour({ ice: 3 }, { q: 60e-6 });
  assert.ok(ice.spill + ice.foamMax > none.spill + none.foamMax, `${ice.foamMax}+${ice.spill} vs ${none.foamMax}+${none.spill}`);
});

test('泡の寿命: 炭酸水の泡はすぐ消え、ビールの泡は残る(§6.3)', () => {
  const left = {};
  for (const drink of ['soda', 'beer']) {
    const r = runPour({ drink, glass: 'pilsner' }, { q: 70e-6 });
    const g = r.game;
    for (let k = 0; k < 60 * 5; k++) g.update(1 / 60, { bottleTilt: 0, glassTilt: 0 });
    left[drink] = g.sim.foamThickness();
  }
  assert.ok(left.soda < 0.0015, `炭酸水 ${left.soda}`);
  assert.ok(left.beer > 0.005, `ビール ${left.beer}`);
});

test('ゲーム: 目標量に届けば記録が出て、ボトルが空なら失敗', () => {
  const ok = runPour({}, { q: 60e-6 });
  assert.equal(ok.state, 'done');
  assert.ok(ok.time > 3 && ok.time < 9, `タイム ${ok.time}`);
  close(ok.record, ok.time + ok.game.result.spill * P.PENALTY_PER_ML, 1e-9, '記録');
  close(ok.game.result.spill, ok.spill, 1e-6, '終了後にこぼれは増えない');
  const fail = runPour({ targetPct: 98 }, { q: 1, mouth: 0.15 });
  assert.equal(fail.state, 'failed');
});

test('水(練習用): CO₂ がなく、まっすぐ全開で注いでもあふれない', () => {
  const water = runPour({ drink: 'water' }, { q: 1 });
  const cola = runPour({ drink: 'cola' }, { q: 1 });
  assert.equal(water.state, 'done');
  assert.equal(water.game.sim.co2Budget().total0, 0);
  assert.ok(Number.isFinite(water.record), `記録 ${water.record}`);
  assert.ok(water.spill < 1, `水のこぼれ ${water.spill}`);
  assert.ok(water.foamMax < cola.foamMax / 3, `泡 水 ${water.foamMax} / コーラ ${cola.foamMax}`);
});
