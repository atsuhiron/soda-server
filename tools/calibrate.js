#!/usr/bin/env node
// 物理パラメータの校正用: 決まった注ぎ方を自動で実行し、タイム・こぼれ・泡の高さを表にする。
//   node tools/calibrate.js              … 全シナリオ
//   node tools/calibrate.js cola         … 条件名で絞り込み
//   CAL='{"plumeCoef":0.4}' node tools/calibrate.js   … 校正パラメータを一時的に上書き
'use strict';
const { runPour } = require('./autoplayer.js');

const CAL_OVERRIDE = process.env.CAL ? JSON.parse(process.env.CAL) : {};

const POURS = {
  'dump (直立・全開)': { q: 1 },
  'upright 60mL/s': { q: 60e-6 },
  'upright 35mL/s': { q: 35e-6 },
  'wall45 70mL/s': { q: 70e-6, tilt: 0.8, straightenFrom: 0.45, straightenTo: 0.9 },
  'wall45 全開': { q: 1, tilt: 0.8, straightenFrom: 0.45, straightenTo: 0.9 },
  'high mouth 8cm 60mL/s': { q: 60e-6, mouth: 0.08 },
};
const CONDITIONS = {
  'cola 5℃': { drink: 'cola' },
  'cola 25℃': { drink: 'cola', liquidTemp: 25 },
  'cola 冷えたグラス': { drink: 'cola', glassTemp: 3 },
  'cola 温かいグラス': { drink: 'cola', glassTemp: 40 },
  'cola 氷3個': { drink: 'cola', ice: 3 },
  'cola プラカップ': { drink: 'cola', glass: 'plastic' },
  'soda 5℃': { drink: 'soda' },
  'beer 5℃ ビアグラス': { drink: 'beer', glass: 'pilsner' },
  'champagne 8℃ フルート': { drink: 'champagne', glass: 'flute', liquidTemp: 8 },
};

const filter = process.argv[2];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('条件', 22) + pad('注ぎ方', 24) + pad('状態', 9) + pad('タイム', 8) + pad('こぼれmL', 10) + pad('泡最大mm', 10) + '記録');
for (const [cname, cs] of Object.entries(CONDITIONS)) {
  if (filter && !cname.includes(filter)) continue;
  for (const [pname, po] of Object.entries(POURS)) {
    const t0 = Date.now();
    const r = runPour(cs, po, { calibration: CAL_OVERRIDE });
    console.log(
      pad(cname, 22) + pad(pname, 24) + pad(r.state, 9) + pad(r.time.toFixed(2), 8) + pad(r.spill.toFixed(1), 10) +
        pad(r.foamMax.toFixed(1), 10) + (Number.isFinite(r.record) ? r.record.toFixed(2) : '-') + `  (${Date.now() - t0}ms)`,
    );
  }
}
