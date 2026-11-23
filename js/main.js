/*
 * Soda Server — 画面の組み立てと入力
 * マウス/タッチを押している間だけボトルとグラスを持つ:
 *   上下 → ボトルの傾き(液が口に届く角度を基準に、上ほど深く傾ける)
 *   左右 → グラスの傾き(右ほどボトル側へ。壁を伝わせられる)
 *   ホイール → 注ぎ口の高さ
 */
(function () {
  'use strict';
  const P = window.SodaPhysics;
  const $ = (id) => document.getElementById(id);
  const clamp = P.clamp;

  // ---------- 保存(このブラウザだけ) ----------
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        /* 保存できない環境では記録を残さない */
      }
    },
  };
  const BEST_KEY = 'soda-server.best.v1';
  const RECENT_KEY = 'soda-server.recent.v1';

  // ---------- 設定フォーム ----------
  const fillSelect = (el, obj) => {
    el.innerHTML = Object.entries(obj)
      .map(([k, v]) => `<option value="${k}">${v.name}</option>`)
      .join('');
  };
  fillSelect($('drink'), P.DRINKS);
  fillSelect($('glass'), P.GLASSES);
  fillSelect($('surface'), P.SURFACES);
  // 記録が 1 件もないブラウザ(初めて遊ぶ人)は、操作の練習用の水から始める
  const firstVisit = !Object.keys(store.get(BEST_KEY, {})).length && !store.get(RECENT_KEY, []).length;
  $('drink').value = firstVisit ? 'water' : P.DEFAULT_SETTINGS.drink;
  $('glass').value = P.DEFAULT_SETTINGS.glass;
  $('surface').value = P.DEFAULT_SETTINGS.surface;

  // 対数スライダー(0〜100 → min〜max)
  const logMap = (min, max) => ({
    to: (v) => min * Math.pow(max / min, v / 100),
    from: (x) => (100 * Math.log(x / min)) / Math.log(max / min),
  });
  const LIFE = logMap(0.5, 300);
  const SITES = logMap(0.3, 300);

  function presetAdvanced() {
    const d = P.DRINKS[$('drink').value];
    const gdef = P.GLASSES[$('glass').value];
    const mat = P.MATERIALS[gdef.material];
    $('gv').value = d.gv;
    $('foamLife').value = LIFE.from(d.life);
    $('sites').value = SITES.from(P.SURFACES[$('surface').value].sites * mat.siteFactor);
    $('entrain').value = 1;
  }

  function readSettings() {
    return {
      drink: $('drink').value,
      liquidTemp: +$('liquidTemp').value,
      glass: $('glass').value,
      glassTemp: +$('glassTemp').value,
      surface: $('surface').value,
      ice: +$('ice').value,
      targetPct: +$('targetPct').value,
      gv: +(+$('gv').value).toFixed(1),
      foamLife: +LIFE.to(+$('foamLife').value).toPrecision(2),
      siteDensity: +SITES.to(+$('sites').value).toPrecision(2),
      entrain: +$('entrain').value,
    };
  }

  function updateOutputs(s, sim) {
    $('liquidTempOut').textContent = `${s.liquidTemp} ℃`;
    $('glassTempOut').textContent = `${s.glassTemp} ℃`;
    $('iceOut').textContent = s.ice ? `${s.ice} 個` : 'なし';
    $('targetOut').textContent = `${s.targetPct}%(${Math.round(sim.targetVolume * 1e6)} mL)`;
    $('gvOut').textContent = `${s.gv.toFixed(1)} GV`;
    $('foamLifeOut').textContent = `${s.foamLife} 秒`;
    $('sitesOut').textContent = `${s.siteDensity} 個/cm²`;
    $('entrainOut').textContent = `× ${s.entrain.toFixed(2)}`;
    const ceq = P.solubilityGL(s.liquidTemp) * sim.drink.salt;
    const cl = s.gv * P.GV_GL;
    // 説明を左、数値を右に並べる
    const row = (name, value) => `<div class="row"><span>${name}</span><span>${value}</span></div>`;
    const gas =
      s.gv > 0
        ? row('溶解CO₂ / 飽和溶解CO₂', `(<b>${cl.toFixed(1)}</b> g/L) / (<b>${ceq.toFixed(2)}</b> g/L)`) +
          row('過飽和度 S', `<b>${(cl / ceq - 1).toFixed(2)}</b>`)
        : row('溶解CO₂', '<b>なし</b>');
    $('facts').innerHTML =
      row('グラス容量', `<b>${Math.round(sim.glass.volume * 1e6)}</b> mL`) +
      row('目標', `<b>${Math.round(sim.targetVolume * 1e6)}</b> mL`) +
      gas +
      row('泡の寿命', `<b>${s.foamLife}</b> 秒`) +
      row('核生成サイト', `<b>${s.siteDensity}</b> 個/cm²`);
    $('tutorial').hidden = !sim.drink.tutorial;
  }

  // ---------- ゲーム本体 ----------
  presetAdvanced();
  let settings = readSettings();
  const game = new P.Game(settings);
  const renderer = new window.SceneRenderer($('scene'));
  const charts = new window.HistoryCharts($('chartVol'), $('chartFlow'), $('chartTip'));
  const budget = new window.BudgetBar($('budgetBar'), $('budgetLegend'));
  updateOutputs(settings, game.sim);

  function restart() {
    game.restart();
    renderer.resetFx();
    $('result').hidden = true;
    shownResult = false;
    input.active = false;
    $('scene').classList.remove('holding');
    $('hint').classList.remove('gone');
  }
  function reconfigure() {
    settings = readSettings();
    game.configure(settings);
    updateOutputs(settings, game.sim);
    restart();
    showRecords();
  }
  for (const id of ['drink', 'glass', 'surface']) {
    $(id).addEventListener('change', () => {
      presetAdvanced();
      reconfigure();
    });
  }
  for (const id of ['liquidTemp', 'glassTemp', 'ice', 'targetPct', 'gv', 'foamLife', 'sites', 'entrain']) {
    $(id).addEventListener('input', () => updateOutputs(readSettings(), game.sim));
    $(id).addEventListener('change', reconfigure);
  }
  $('tryCola').addEventListener('click', () => {
    $('drink').value = 'cola';
    presetAdvanced();
    reconfigure();
  });
  $('resetAdvanced').addEventListener('click', () => {
    presetAdvanced();
    reconfigure();
  });
  $('restartBtn').addEventListener('click', restart);
  $('againBtn').addEventListener('click', restart);
  // 遊び方(モーダル)。Esc・✕・外側のクリックで閉じる
  const help = $('helpPanel');
  $('helpBtn').addEventListener('click', () => help.showModal());
  $('helpClose').addEventListener('click', () => help.close());
  help.addEventListener('click', (e) => {
    if (e.target === help) help.close(); // 余白(::backdrop)を押したとき
  });
  let speed = 1;
  $('speed').addEventListener('change', () => (speed = +$('speed').value));

  // ---------- 入力 ----------
  const input = { active: false, ux: 0.3, uy: 0.5, mouth: 0.015, key: false };
  const canvas = $('scene');
  function setPos(e) {
    const r = canvas.getBoundingClientRect();
    input.ux = clamp((e.clientX - r.left) / r.width, 0, 1);
    input.uy = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (game.state === 'done' || game.state === 'failed') return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 合成イベントなどで捕捉できなくても操作は続ける */
    }
    setPos(e);
    input.active = true;
    canvas.classList.add('holding');
    $('hint').classList.add('gone');
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (input.active) setPos(e);
  });
  const release = () => {
    input.active = false;
    canvas.classList.remove('holding');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  function setMouth(cm) {
    input.mouth = clamp(cm, 0.5, 12) / 100;
    $('mouth').value = (input.mouth * 100).toFixed(1);
    $('mouthOut').textContent = `${(input.mouth * 100).toFixed(1)} cm`;
  }
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setMouth(input.mouth * 100 + (e.deltaY < 0 ? 0.5 : -0.5));
    },
    { passive: false },
  );
  $('mouth').addEventListener('input', () => setMouth(+$('mouth').value));
  setMouth(1.5);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (help.open) return;
    if (e.key === 'r' || e.key === 'R') restart();
    else if (e.key === ' ') {
      if (game.state === 'done' || game.state === 'failed') return;
      input.active = true;
      input.key = true;
      $('hint').classList.add('gone');
    } else if (e.key === 'ArrowUp') input.uy = clamp(input.uy + 0.04, 0, 1);
    else if (e.key === 'ArrowDown') input.uy = clamp(input.uy - 0.04, 0, 1);
    else if (e.key === 'ArrowRight') input.ux = clamp(input.ux + 0.04, 0, 1);
    else if (e.key === 'ArrowLeft') input.ux = clamp(input.ux - 0.04, 0, 1);
    else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && input.key) {
      input.key = false;
      release();
    }
  });

  function controls() {
    const sim = game.sim;
    if (!input.active) return { bottleTilt: 0, glassTilt: 0, mouthHeight: input.mouth };
    // 液が口に届く角度(残量で変わる)の 14° 手前 〜 27° 先を画面の下端〜上端に割り当てる。
    // 下から 1/3 あたりで出始め、上 1/5 ほどでゴボゴボ言う全開になる。
    const bottleTilt = sim.onsetTilt() - 0.25 + input.uy * 0.72;
    const gx = clamp((input.ux - 0.15) / 0.65, 0, 1);
    return { bottleTilt, glassTilt: P.MAX_GLASS_TILT * gx, mouthHeight: input.mouth };
  }

  // ---------- 記録 ----------
  const settingsKey = (s) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
  const label = (s) => `${P.DRINKS[s.drink].name} ${s.liquidTemp}℃・${P.GLASSES[s.glass].name}${s.ice ? `・氷${s.ice}` : ''}`;
  function showRecords() {
    const best = store.get(BEST_KEY, {})[settingsKey(settings)];
    $('bestLine').innerHTML = best
      ? `この条件のベスト: <b>${best.record.toFixed(2)} 秒</b>(こぼれ ${best.spill.toFixed(1)} mL)`
      : 'この条件のベスト: —';
    const recent = store.get(RECENT_KEY, []);
    $('recent').innerHTML = recent.length
      ? recent
          .map(
            (r) =>
              `<tr${r.ok ? '' : ' class="failed"'}><td class="num">${r.ok ? r.record.toFixed(2) : '失敗'}</td>` +
              `<td>${r.label}</td><td class="num">${r.spill.toFixed(1)}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="3" class="empty">まだ記録はありません</td></tr>';
  }
  showRecords();

  let shownResult = false;
  function showResult() {
    const r = game.result;
    const card = document.querySelector('.result-card');
    const bests = store.get(BEST_KEY, {});
    const key = settingsKey(settings);
    const prev = bests[key];
    card.classList.toggle('failed', !r.ok);
    if (r.ok) {
      $('resultTitle').textContent = r.spill < 0.05 ? 'クリア(こぼさず!)' : 'クリア';
      $('resRecord').textContent = r.record.toFixed(2);
      $('resTime').textContent = `${r.time.toFixed(2)} 秒`;
      $('resSpill').textContent = `${r.spill.toFixed(1)} mL`;
      $('resPenalty').textContent = `+${r.penalty.toFixed(2)} 秒`;
      $('resFoam').textContent = `${(r.foamMax * 1000).toFixed(0)} mm`;
      const isBest = !prev || r.record < prev.record;
      $('resBest').textContent = isBest ? (prev ? `ベスト更新!(前回 ${prev.record.toFixed(2)} 秒)` : 'この条件で初めての記録') : `ベスト ${prev.record.toFixed(2)} 秒`;
      if (isBest) {
        bests[key] = { record: r.record, time: r.time, spill: r.spill };
        store.set(BEST_KEY, bests);
      }
    } else {
      $('resultTitle').textContent = '失敗';
      $('resRecord').textContent = 'ボトルが空になりました';
      $('resBest').textContent = '';
      $('resTime').textContent = `${r.time.toFixed(2)} 秒`;
      $('resSpill').textContent = `${r.spill.toFixed(1)} mL`;
      $('resPenalty').textContent = '—';
      $('resFoam').textContent = `${(game.foamMax * 1000).toFixed(0)} mm`;
    }
    const recent = store.get(RECENT_KEY, []);
    recent.unshift({ ok: r.ok, record: r.record || 0, spill: r.spill, label: label(settings) });
    store.set(RECENT_KEY, recent.slice(0, 8));
    showRecords();
    $('result').hidden = false;
    release();
  }

  // ---------- HUD ----------
  const MODE = { plunge: '直接', film: '壁伝い', filmBottom: '壁伝い', bottom: '底に衝突' };
  function updateHud() {
    const sim = game.sim;
    const st = sim.stats();
    $('hudTime').textContent = (game.finishTime != null ? game.finishTime : game.time).toFixed(2);
    $('hudLiquid').textContent = Math.round(st.VL * 1e6);
    $('hudTarget').textContent = Math.round(sim.targetVolume * 1e6);
    $('hudFillBar').style.width = `${clamp(st.VL / sim.targetVolume, 0, 1) * 100}%`;
    $('hudFoam').textContent = (st.foam * 1000).toFixed(0);
    $('hudSpill').textContent = (st.spilled * 1e6).toFixed(1);
    $('stage').classList.toggle('spilling', st.spilled > 5e-8);
    $('hudQ').textContent = Math.round(st.Q * 1e6);
    $('hudV').textContent = st.impactV ? `${st.impactV.toFixed(2)} m/s` : '—';
    $('hudMode').textContent = st.impactMode ? `(${MODE[st.impactMode]})` : '';
    $('hudS').textContent = sim.gv > 0 ? st.S.toFixed(2) : '—';
    $('hudTL').textContent = st.TL.toFixed(1);
    $('hudTg').textContent = st.Tg.toFixed(1);
    $('hudBottle').textContent = Math.round(st.bottle * 1e6);
  }

  // ---------- ループ ----------
  function resize() {
    renderer.resize();
    charts.resize();
  }
  window.addEventListener('resize', resize);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', () => renderer.readTheme());
  resize();
  updateHud();

  let last = performance.now();
  let hudClock = 0;
  let chartClock = 0;
  function frame(now) {
    const real = Math.min(0.05, (now - last) / 1000);
    last = now;
    const dt = real * speed;
    game.update(dt, controls());
    renderer.render(game, dt);
    hudClock += real;
    chartClock += real;
    if (hudClock > 0.066) {
      updateHud();
      hudClock = 0;
    }
    if (chartClock > 0.15) {
      charts.draw(game);
      budget.update(game.sim.co2Budget());
      chartClock = 0;
    }
    if (!shownResult && (game.state === 'done' || game.state === 'failed')) {
      shownResult = true;
      showResult();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // デバッグ・検証用(コンソールから状態を見られるように)
  window.sodaGame = game;
})();
