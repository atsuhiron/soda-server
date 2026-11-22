'use strict';
// 決まった注ぎ方を自動で行うプレイヤー(校正スクリプトとテストで共有)
const P = require('../js/physics.js');

// opt: { q: 目標流量 [m³/s](1 以上で全開), tilt: 最初のグラスの傾き [rad],
//        straightenFrom / straightenTo: グラスを起こし始める/起こし終える液量比, mouth: 注ぎ口の高さ [m] }
function makePlayer(opt) {
  let offset = 0.05;
  return (sim) => {
    const fill = sim.VL / sim.targetVolume;
    let glassTilt = 0;
    if (opt.tilt) {
      const k = Math.min(1, Math.max(0, (fill - opt.straightenFrom) / (opt.straightenTo - opt.straightenFrom)));
      glassTilt = opt.tilt * (1 - k);
    }
    if (opt.q >= 1) offset = 0.6;
    else offset += (1 / 60) * 0.8 * ((opt.q - sim.Q) / opt.q);
    offset = Math.min(0.9, Math.max(-0.15, offset));
    return { bottleTilt: sim.onsetTilt() + offset, glassTilt, mouthHeight: opt.mouth || 0.015 };
  };
}

function runPour(settings, opt, extra) {
  const g = new P.Game(settings, extra);
  const player = makePlayer(opt);
  let t = 0;
  while (t < 40 && g.state !== 'done' && g.state !== 'failed') {
    g.update(1 / 60, player(g.sim));
    t += 1 / 60;
  }
  const s = g.sim;
  return {
    game: g,
    state: g.state,
    time: g.finishTime != null ? g.finishTime : g.time,
    spill: s.spilledLiquid * 1e6,
    foamMax: g.foamMax * 1000,
    record: g.result && g.result.ok ? g.result.record : NaN,
  };
}

module.exports = { makePlayer, runPour };
