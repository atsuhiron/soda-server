/*
 * Soda Server — 物理エンジン(DOM 非依存)
 *
 * soda_foam_physics_report.md の §9「L1 モデル」をリアルタイムで解く。
 *  ・CO₂ 収支(§1.3) ボトル / 液柱 / 溶存 / 気泡 / 泡層 / 大気 / こぼれ の合計を常に保存
 *  ・核生成(§2)     壁面サイト(Type IV)・氷・注ぎの空気巻き込み(Biń 1993)・乱流
 *  ・温度(§3)       液温とグラス温度(集中定数)、壁面液膜の接触温度とその緩和
 *  ・気泡の成長(§4) Epstein–Plesset 型の拡散流入 + Ranz–Marshall のシャーウッド数
 *  ・気泡の上昇(§5) 剛体球 Schiller–Naumann 抵抗(界面活性剤で汚れた気泡)+ Mendelson 上限
 *  ・泡層(§6)       気体 / 液体の 2 成分 ODE(泡膜からの脱ガス・排液・膜破裂)
 *  ・液面からの逸散(§7)
 * グラスとボトルは軸対称容器として扱い、任意の傾きでの「体積 ⇔ 液面高さ」を
 * スライスごとの円の弦で切った面積を解析的に積分して求める。
 *
 * 座標: SI 単位、x 右向き・y 上向き。原点はグラスの回転中心(軸の中央)。
 * ブラウザでは window.SodaPhysics、Node では require('./physics.js')。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SodaPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===== 基本定数 =====
  const G = 9.81; // m/s²
  const R_GAS = 8.314; // J/(mol·K)
  const P_ATM = 101325; // Pa
  const M_CO2 = 44.01; // g/mol
  const T0K = 273.15;
  const RHO_ICE = 917; // kg/m³
  const CP_LIQ = 4180; // J/(kg·K)
  const GV_GL = 1.96; // 1 GV ≒ 1.96 g/L(§1.2)
  const EFF_WATER = 1580; // 熱浸透率 √(kρc)
  const MAX_GLASS_TILT = Math.PI / 3; // 60°
  const MAX_BOTTLE_TILT = (165 * Math.PI) / 180;
  const PENALTY_PER_ML = 0.5; // こぼした液 1 mL あたりのペナルティ秒

  const KIND_WALL = 0;
  const KIND_AIR = 1;
  const KIND_SEED = 2;
  const KIND_ICE = 3;
  const EDGE_WALL = 0;
  const EDGE_OPENING = 1;
  const EDGE_BOTTOM = 2;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ===== 物性(§1, §3, §5)=====
  // 1 atm の CO₂ 分圧での溶解度 [g/L](報告書 §1.1 の表)。表の外はファントホッフ式(2400 K)。
  const SOLUBILITY_TABLE = [
    [0, 3.3],
    [5, 2.9],
    [10, 2.5],
    [20, 1.7],
    [25, 1.5],
    [30, 1.3],
  ];
  const VANT_HOFF = 2400;
  function solubilityGL(tC) {
    const t = SOLUBILITY_TABLE;
    if (tC <= t[0][0]) return t[0][1] * Math.exp(VANT_HOFF * (1 / (tC + T0K) - 1 / (t[0][0] + T0K)));
    for (let i = 1; i < t.length; i++) {
      if (tC <= t[i][0]) return lerp(t[i - 1][1], t[i][1], (tC - t[i - 1][0]) / (t[i][0] - t[i - 1][0]));
    }
    const last = t[t.length - 1];
    return last[1] * Math.exp(VANT_HOFF * (1 / (tC + T0K) - 1 / (last[0] + T0K)));
  }
  // ヘンリー定数 [mol/(m³·Pa)]。salt は糖・エタノールによる塩析係数。
  function henry(tC, salt) {
    return (solubilityGL(tC) * (salt == null ? 1 : salt) * 1000) / M_CO2 / P_ATM;
  }
  function waterViscosity(tC) {
    return 2.414e-5 * Math.pow(10, 247.8 / (tC + T0K - 140));
  }
  const MU_W25 = waterViscosity(25);
  function viscosity(tC, factor) {
    return waterViscosity(tC) * factor;
  }
  // CO₂ の拡散係数: 25 ℃で 1.9e-9 m²/s、Stokes–Einstein で温度補正、糖による粘度上昇は平方根で効かせる
  function diffusivity(tC, factor) {
    return (1.9e-9 * ((tC + T0K) / 298.15) * (MU_W25 / waterViscosity(tC))) / Math.sqrt(factor);
  }
  function surfaceTension(tC, sigma25) {
    return Math.max(0.02, sigma25 - 1.5e-4 * (tC - 25));
  }
  // 終端速度: 剛体球(Schiller–Naumann)と変形気泡(Mendelson)の小さい方
  function terminalVelocity(d, rho, mu, sigma) {
    const drho = rho - 1.2;
    let U = (drho * G * d * d) / (18 * mu);
    for (let k = 0; k < 80; k++) {
      const Re = Math.max(1e-9, (rho * U * d) / mu);
      const Cd = Re < 1000 ? (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687)) : 0.44;
      const Un = Math.sqrt((4 * drho * G * d) / (3 * Cd * rho));
      U = 0.5 * (U + Un);
    }
    const Um = Math.sqrt((2.14 * sigma) / (rho * d) + 0.505 * G * d);
    return Math.min(U, Um);
  }

  // ===== 校正パラメータ =====
  const CAL = {
    dt: 1 / 240, // 内部タイムステップ [s]
    // 空気巻き込み(§2.3): Biń (1993) の Q_air/Q = 0.04 Fr^0.28 (L/d)^0.4 に突入速度の閾値を掛ける
    entrainScale: 1.5,
    vTh0: 0.6, // ここから巻き込みが立ち上がる [m/s](報告書: 乱れたジェットで概ね 1 m/s 前後)
    vTh1: 1.4, // ここで経験式どおりになる [m/s]
    wallAttachLow: 0.08, // 壁を伝う薄い液膜の巻き込み係数(自由ジェット比)
    wallAttachHigh: 0.6, // 流量が多く液膜が厚く乱れたとき
    wallQ0: 35e-6, // [m³/s]
    wallQ1: 110e-6,
    glugAir: 0.04, // ボトルがゴボゴボ言うときに液柱が抱える空気(液量比)
    brokenFactor: 2.0, // 氷に当たって砕けた液柱
    bottomSplash: 1.5, // 浅い液・底への衝突での増分
    shallowDepth: 0.012, // [m]
    airD50: 0.8e-3, // 巻き込み気泡の体積中央径 [m]
    airSigma: 0.75, // 対数標準偏差
    // 乱流による微小気泡核(§2.3)
    turbSeed: 4.5e6, // 個 / (J · 過飽和度)
    seedRadius: 18e-6,
    // 壁面核生成(§2.2)
    detachRadius: 25e-6, // 離脱半径(σ = 0.07 N/m 基準)
    siteFreq: 1.0,
    iceSites: 400, // 氷表面のサイト密度 [個/cm²]
    // 泡層(§6)
    foamDegasTau: 2.0, // 泡膜の液から泡へ CO₂ が抜ける時定数 [s]
    epsDry: 0.03, // 乾いた泡の液体率
    // 熱(§3)
    hWall: 400, // 液⇔グラスの熱伝達率 [W/(m²K)]
    // 乱れと液面逸散(§7)
    turbTau: 0.8,
    turbRef: 0.02,
    kLcalm: 2e-5,
    kLturb: 1.5e-4,
    filmTau: 0.12, // 壁を伝う液膜の摩擦時定数 [s]
    // 泡プルーム(§5.2): 気泡群が液を引きずり上げる速度 u = plumeCoef (g Q_gas / R)^(1/3)
    plumeCoef: 0.35,
    plumeTau: 0.35,
    maxParcels: 9000,
  };

  // ===== プリセット =====
  // gv: ガスボリューム, life: 泡の寿命 1/k_c [s], drain: 排液時定数 [s], sigma: 表面張力(25℃) [N/m]
  // mu: 粘度倍率(水比), salt: 塩析係数, dome: 縁から盛り上がれる泡の高さ [m], phiIn: 生まれたての泡のガス体積率
  const DRINKS = {
    // 操作の練習用。CO₂ を含まないので、泡は巻き込んだ空気だけで、液面ですぐ割れる。
    water: {
      name: '水(練習用)', gv: 0, life: 0.5, drain: 0.3, sigma: 0.072, mu: 1.0, salt: 1.0, rho: 1000,
      dome: 0.0005, phiIn: 0.72, color: [186, 214, 236], alpha: 0.24, foam: [250, 253, 255], tutorial: true,
    },
    soda: {
      name: '炭酸水', gv: 3.8, life: 1.5, drain: 0.6, sigma: 0.072, mu: 1.0, salt: 1.0, rho: 1000,
      dome: 0.001, phiIn: 0.72, color: [196, 226, 238], alpha: 0.3, foam: [250, 253, 255],
    },
    cola: {
      name: 'コーラ', gv: 3.5, life: 12, drain: 2.5, sigma: 0.065, mu: 1.25, salt: 0.95, rho: 1040,
      dome: 0.002, phiIn: 0.7, color: [62, 26, 12], alpha: 0.94, foam: [226, 200, 166],
    },
    cider: {
      name: 'サイダー', gv: 3.0, life: 5, drain: 1.5, sigma: 0.068, mu: 1.2, salt: 0.95, rho: 1040,
      dome: 0.0015, phiIn: 0.7, color: [226, 238, 226], alpha: 0.32, foam: [252, 255, 252],
    },
    beer: {
      name: 'ビール', gv: 2.6, life: 180, drain: 20, sigma: 0.044, mu: 1.6, salt: 0.97, rho: 1010,
      dome: 0.008, phiIn: 0.68, color: [218, 146, 36], alpha: 0.86, foam: [251, 246, 230],
    },
    champagne: {
      name: 'シャンパン', gv: 6.0, life: 8, drain: 2.0, sigma: 0.048, mu: 1.5, salt: 0.92, rho: 995,
      dome: 0.001, phiIn: 0.72, color: [240, 224, 160], alpha: 0.45, foam: [255, 253, 244],
    },
  };
  // profile: 内側の [高さ z, 半径 r] [m](底 → 縁)
  const GLASSES = {
    tumbler: { name: 'タンブラー', profile: [[0, 0.03], [0.11, 0.036]], wall: 0.0028, base: 0.012, material: 'glass', mass: 0.26 },
    pilsner: { name: 'ビアグラス', profile: [[0, 0.024], [0.14, 0.036]], wall: 0.0022, base: 0.014, material: 'glass', mass: 0.28 },
    flute: {
      name: 'フルート', profile: [[0, 0], [0.004, 0.009], [0.012, 0.015], [0.025, 0.019], [0.17, 0.0205]],
      wall: 0.0014, base: 0.004, stem: 0.075, foot: 0.034, material: 'glass', mass: 0.16,
    },
    plastic: { name: 'プラカップ', profile: [[0, 0.028], [0.095, 0.04]], wall: 0.0006, base: 0.0008, material: 'plastic', mass: 0.008 },
  };
  // c: 比熱, eff: 熱浸透率, siteFactor: 核生成サイトの多さ, wallTau: 壁面が液温に馴染む時定数 [s]
  const MATERIALS = {
    glass: { name: 'ガラス', c: 840, eff: 1450, siteFactor: 1, wallTau: 15 },
    plastic: { name: 'プラスチック', c: 1500, eff: 550, siteFactor: 3, wallTau: 1.5 },
  };
  // 活動中の核生成サイト密度 [個/cm²](§2.2, §9.2 では「数個〜数百個、要校正」)。
  // 静置した炭酸水が最初に毎秒 1 mL 前後のガスを出す程度になるよう、報告書の範囲の下側で校正した。
  const SURFACES = {
    clean: { name: '洗って自然乾燥', sites: 1 },
    wiped: { name: '布で拭いた(繊維が残る)', sites: 8 },
    worn: { name: '細かい傷が多い', sites: 25 },
  };
  // 500 mL の PET ボトル(内側の形)
  const BOTTLE = {
    profile: [[0, 0.03], [0.006, 0.032], [0.15, 0.032], [0.163, 0.028], [0.175, 0.02], [0.184, 0.0135], [0.189, 0.011], [0.205, 0.011]],
    mouthR: 0.011,
    volume: 500e-6,
    qCoef: 0.5, // ゴボゴボ流出の最大流量 Q = qCoef √(g d⁵)
  };
  const DEFAULT_SETTINGS = {
    drink: 'cola',
    liquidTemp: 5,
    glass: 'tumbler',
    glassTemp: 20,
    surface: 'wiped',
    ice: 0,
    targetPct: 85,
    gv: null,
    foamLife: null,
    siteDensity: null,
    entrain: 1,
  };

  // ===== 幾何 =====
  // 半径 r の円のうち座標 u より先(u' > u)の面積
  function segArea(r, u) {
    if (u <= -r) return Math.PI * r * r;
    if (u >= r) return 0;
    return r * r * Math.acos(u / r) - u * Math.sqrt(r * r - u * u);
  }
  // segArea の u についての原始関数
  function segPrim(r, u) {
    if (u <= -r) return Math.PI * r * r * u;
    if (u >= r) return 0;
    const q = r * r - u * u;
    const sq = Math.sqrt(q);
    return r * r * u * Math.acos(u / r) - r * r * sq + (q * sq) / 3;
  }

  // 軸対称の容器。高さ y = z·cosθ − u·|sinθ| で傾けた状態の体積を扱う(原点は内底の中心)。
  class Vessel {
    constructor(profile, n) {
      this.profile = profile.map((p) => [p[0], p[1]]);
      const last = this.profile[this.profile.length - 1];
      this.H = last[0];
      this.rTop = last[1];
      this.rBottom = this.profile[0][1];
      this.n = n || 64;
      this.dz = this.H / this.n;
      this.zc = new Float64Array(this.n);
      this.rc = new Float64Array(this.n);
      this.wallArea = new Float64Array(this.n);
      let V = 0;
      for (let i = 0; i < this.n; i++) {
        const za = i * this.dz;
        const zb = za + this.dz;
        const ra = this.radiusAt(za);
        const rb = this.radiusAt(zb);
        const r = Math.sqrt((ra * ra + ra * rb + rb * rb) / 3); // 円錐台と同じ体積になる等価半径
        this.zc[i] = za + 0.5 * this.dz;
        this.rc[i] = r;
        this.wallArea[i] = Math.PI * (ra + rb) * Math.hypot(this.dz, rb - ra);
        V += Math.PI * r * r * this.dz;
      }
      this.volume = V;
      this.bottomArea = Math.PI * this.rBottom * this.rBottom;
      this._area = 0;
      this._rc = NaN;
      this._rs = NaN;
      this._lo = 0;
      this._hi = 0;
    }
    radiusAt(z) {
      const p = this.profile;
      if (z <= p[0][0]) return p[0][1];
      for (let i = 1; i < p.length; i++) {
        if (z <= p[i][0]) return lerp(p[i - 1][1], p[i][1], (z - p[i - 1][0]) / (p[i][0] - p[i - 1][0]));
      }
      return p[p.length - 1][1];
    }
    // 液面(原点からの高さ L)より下の体積。副産物として水平断面積 dV/dL を this._area に置く。
    volumeArea(L, c, s) {
      s = Math.abs(s);
      const n = this.n;
      const dz = this.dz;
      const rc = this.rc;
      let V = 0;
      let A = 0;
      if (s < 1e-7) {
        const zl = L / c;
        for (let i = 0; i < n; i++) {
          const za = i * dz;
          const zb = za + dz;
          const a = Math.PI * rc[i] * rc[i];
          const len = c > 0 ? clamp(zl - za, 0, dz) : clamp(zb - zl, 0, dz);
          V += a * len;
          if (zl > za && zl < zb) A += a / Math.abs(c);
        }
      } else if (Math.abs(c) < 1e-4) {
        for (let i = 0; i < n; i++) {
          const r = rc[i];
          const u = (this.zc[i] * c - L) / s;
          V += segArea(r, u) * dz;
          if (Math.abs(u) < r) A += (2 * Math.sqrt(r * r - u * u) * dz) / s;
        }
      } else {
        const k = s / c;
        for (let i = 0; i < n; i++) {
          const r = rc[i];
          const za = i * dz;
          const ua = (za * c - L) / s;
          const ub = ((za + dz) * c - L) / s;
          V += k * (segPrim(r, ub) - segPrim(r, ua));
          A += (segArea(r, ua) - segArea(r, ub)) / c;
        }
      }
      this._area = A;
      return V;
    }
    levelRange(c, s) {
      s = Math.abs(s);
      if (c === this._rc && s === this._rs) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < this.n; i++) {
        const e = this.rc[i] * s;
        const y0 = i * this.dz * c;
        const y1 = (i + 1) * this.dz * c;
        lo = Math.min(lo, y0 - e, y1 - e);
        hi = Math.max(hi, y0 + e, y1 + e);
      }
      this._lo = lo;
      this._hi = hi;
      this._rc = c;
      this._rs = s;
    }
    // 体積 Vt になる液面高さ(ニュートン法 + 二分法)
    solveLevel(Vt, c, s, guess) {
      this.levelRange(c, s);
      let lo = this._lo;
      let hi = this._hi;
      if (Vt <= 0) {
        this._area = 0;
        return lo;
      }
      if (Vt >= this.volume) {
        this._area = 0;
        return hi;
      }
      let L = guess > lo && guess < hi ? guess : 0.5 * (lo + hi);
      for (let it = 0; it < 60; it++) {
        const f = this.volumeArea(L, c, s) - Vt;
        if (f > 0) hi = L;
        else lo = L;
        if (Math.abs(f) < 1e-13 || hi - lo < 1e-10) break;
        const A = this._area;
        let Ln = A > 1e-12 ? L - f / A : 0.5 * (lo + hi);
        if (!(Ln > lo && Ln < hi)) Ln = 0.5 * (lo + hi);
        L = Ln;
      }
      return L;
    }
    // 各スライスの壁の周長のうち液面下にある割合を out に。戻り値は底面の濡れ割合。
    wetted(L, c, s, out) {
      s = Math.abs(s);
      for (let i = 0; i < this.n; i++) {
        if (s < 1e-7) out[i] = clamp((L / c - i * this.dz) / this.dz, 0, 1);
        else out[i] = Math.acos(clamp((this.zc[i] * c - L) / s / this.rc[i], -1, 1)) / Math.PI;
      }
      if (this.rBottom <= 0) return 0;
      if (s < 1e-7) return L > 0 ? 1 : 0;
      return segArea(this.rBottom, -L / s) / this.bottomArea;
    }
  }

  // 気泡パーセル(同じ大きさ・組成の気泡 N 個の束)。構造体配列で持つ。
  class Parcels {
    constructor(cap) {
      this.cap = cap;
      this.n = 0;
      this.x = new Float64Array(cap);
      this.y = new Float64Array(cap);
      this.R = new Float64Array(cap);
      this.nC = new Float64Array(cap); // 気泡 1 個あたりの CO₂ [mol]
      this.nA = new Float64Array(cap); // 気泡 1 個あたりの空気 [mol]
      this.N = new Float64Array(cap);
      this.age = new Float32Array(cap);
      this.seed = new Float32Array(cap);
      this.kind = new Uint8Array(cap);
    }
    add(x, y, R, nC, nA, N, kind, seed) {
      if (this.n >= this.cap) return -1;
      const i = this.n++;
      this.x[i] = x;
      this.y[i] = y;
      this.R[i] = R;
      this.nC[i] = nC;
      this.nA[i] = nA;
      this.N[i] = N;
      this.age[i] = 0;
      this.seed[i] = seed;
      this.kind[i] = kind;
      return i;
    }
    remove(i) {
      const j = --this.n;
      if (i === j) return;
      this.x[i] = this.x[j];
      this.y[i] = this.y[j];
      this.R[i] = this.R[j];
      this.nC[i] = this.nC[j];
      this.nA[i] = this.nA[j];
      this.N[i] = this.N[j];
      this.age[i] = this.age[j];
      this.seed[i] = this.seed[j];
      this.kind[i] = this.kind[j];
    }
  }

  // 直径 → 終端速度の対数補間テーブル
  class RiseTable {
    constructor(rho, mu, sigma) {
      this.n = 200;
      this.lnMin = Math.log(4e-6);
      this.lnMax = Math.log(1.5e-2);
      this.v = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const d = Math.exp(this.lnMin + ((this.lnMax - this.lnMin) * i) / (this.n - 1));
        this.v[i] = terminalVelocity(d, rho, mu, sigma);
      }
      this.scale = (this.n - 1) / (this.lnMax - this.lnMin);
      this.dMin = Math.exp(this.lnMin);
    }
    at(d) {
      const x = (Math.log(d) - this.lnMin) * this.scale;
      if (x <= 0) return this.v[0] * (d / this.dMin) * (d / this.dMin);
      if (x >= this.n - 1) return this.v[this.n - 1];
      const i = x | 0;
      return this.v[i] + (this.v[i + 1] - this.v[i]) * (x - i);
    }
  }

  // 巻き込み気泡の粒径クラス(体積基準の対数正規分布、0.1〜4 mm)
  function makeAirClasses(d50, sig) {
    const out = [];
    let sum = 0;
    for (let k = 0; k < 7; k++) {
      const d = 0.1e-3 * Math.pow(40, k / 6);
      const x = Math.log(d / d50) / sig;
      const w = Math.exp(-0.5 * x * x);
      out.push({ d, w });
      sum += w;
    }
    for (const c of out) c.w /= sum;
    return out;
  }

  // 線分 p→q と線分 a→b の交点の p→q 上の位置 t(交わらなければ −1)
  function segHit(px, py, qx, qy, ax, ay, bx, by) {
    const rx = qx - px;
    const ry = qy - py;
    const sx = bx - ax;
    const sy = by - ay;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-18) return -1;
    const t = ((ax - px) * sy - (ay - py) * sx) / den;
    const u = ((ax - px) * ry - (ay - py) * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
    return t;
  }

  // ===== シミュレーション本体 =====
  class Simulation {
    constructor(settings, opts) {
      opts = opts || {};
      this.cal = Object.assign({}, CAL, opts.calibration || {});
      this.seed = opts.seed == null ? 1 : opts.seed;
      this.configure(settings);
    }

    configure(settings) {
      const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
      this.settings = s;
      this.drink = DRINKS[s.drink] || DRINKS.cola;
      this.glassDef = GLASSES[s.glass] || GLASSES.tumbler;
      this.material = MATERIALS[this.glassDef.material];
      this.gv = s.gv != null ? s.gv : this.drink.gv;
      this.foamLife = Math.max(0.2, s.foamLife != null ? s.foamLife : this.drink.life);
      const surf = SURFACES[s.surface] || SURFACES.wiped;
      this.siteDensity = s.siteDensity != null ? s.siteDensity : surf.sites * this.material.siteFactor;
      this.entrainScale = (s.entrain != null ? s.entrain : 1) * this.cal.entrainScale;
      this.Tb = s.liquidTemp;
      this.Tg0 = s.glassTemp;
      this.rho = this.drink.rho;
      this.sigma = surfaceTension(this.Tb, this.drink.sigma);
      this.rise = new RiseTable(this.rho, viscosity(this.Tb, this.drink.mu), this.sigma);
      this.detachR = this.cal.detachRadius * Math.cbrt(this.sigma / 0.07);
      this.Cbottle = (this.gv * GV_GL * 1000) / M_CO2; // mol/m³
      this.glass = new Vessel(this.glassDef.profile, 64);
      this.bottle = new Vessel(BOTTLE.profile, 96);
      this.targetVolume = (this.glass.volume * clamp(s.targetPct, 30, 98)) / 100;
      this.airClasses = makeAirClasses(this.cal.airD50, this.cal.airSigma);
      this.iceSize = Math.min(0.024, 0.85 * this.glass.rTop);
      this.buildFrame();
      this.reset();
    }

    // グラス座標(u: 軸に垂直, z: 軸方向)での形を前計算する
    buildFrame() {
      const prof = this.glassDef.profile;
      const gd = this.glassDef;
      const K = prof.length - 1;
      const pointed = prof[0][1] <= 0;
      const V = [];
      for (let k = 0; k <= K; k++) V.push({ u: prof[k][1], z: prof[k][0], side: 1, k });
      for (let k = K; k >= (pointed ? 1 : 0); k--) V.push({ u: -prof[k][1], z: prof[k][0], side: -1, k });
      this.frameInner = V;
      this.inner = V.map(() => ({ x: 0, y: 0 }));
      this.rimRi = K;
      this.rimLi = K + 1;
      this.edges = [];
      for (let i = 0; i < V.length; i++) {
        const a = V[i];
        const b = V[(i + 1) % V.length];
        let type = EDGE_WALL;
        let side = 0;
        let seg = -1;
        if (a.k === K && b.k === K && a.side !== b.side) type = EDGE_OPENING;
        else if (a.k === 0 && b.k === 0 && a.side !== b.side) type = EDGE_BOTTOM;
        else {
          side = a.side === b.side ? a.side : a.k === 0 ? b.side : a.side;
          seg = K - Math.max(a.k, b.k);
        }
        this.edges.push({ ia: i, ib: (i + 1) % V.length, type, side, seg, upperIsA: a.z > b.z, ax: 0, ay: 0, bx: 0, by: 0, nx: 0, ny: 0 });
      }
      const mkWall = (sgn) => {
        const pts = [];
        for (let k = K; k >= 0; k--) pts.push({ u: sgn * prof[k][1], z: prof[k][0] });
        const cum = [0];
        for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j].u - pts[j - 1].u, pts[j].z - pts[j - 1].z));
        return { frame: pts, cum, total: cum[cum.length - 1], world: pts.map(() => ({ x: 0, y: 0 })), dir: pts.slice(1).map(() => ({ x: 0, y: 0 })) };
      };
      this.wallR = mkWall(1);
      this.wallL = mkWall(-1);
      const O = [{ u: prof[0][1] + gd.wall, z: -gd.base }];
      for (let k = 0; k <= K; k++) O.push({ u: prof[k][1] + gd.wall, z: prof[k][0] });
      for (let k = K; k >= 0; k--) O.push({ u: -(prof[k][1] + gd.wall), z: prof[k][0] });
      O.push({ u: -(prof[0][1] + gd.wall), z: -gd.base });
      this.frameOuter = O;
      this.outer = O.map(() => ({ x: 0, y: 0, nx: 0, ny: 0 }));
      const H = this.glass.H;
      this.tableY = -H / 2 - gd.base - (gd.stem || 0) - (gd.foot ? 0.004 : 0) - 0.035;
      // 可視化用の核生成サイト(実際の放出量は面積 × サイト密度で計算し、ここに配る)
      const g = this.glass;
      let wallA = 0;
      for (let i = 0; i < g.n; i++) wallA += g.wallArea[i];
      const bottomA = g.rBottom > 0 ? g.bottomArea : 0;
      const totalA = wallA + bottomA;
      const nVis = Math.round(clamp(this.siteDensity * totalA * 1e4 * 0.01, 8, 72));
      const rng = mulberry32(this.seed * 7 + 3);
      this.sites = [];
      for (let j = 0; j < nVis; j++) {
        let pick = rng() * totalA;
        const ps = rng() * 2 * Math.PI;
        if (pick < bottomA) {
          const rr = g.rBottom * Math.sqrt(rng()) * 0.95;
          this.sites.push({ u: rr * Math.cos(ps), z: 0.0006, w: (Math.sin(ps) * rr) / g.rBottom, phase: rng(), sub: false, x: 0, y: 0 });
          continue;
        }
        pick -= bottomA;
        let i = 0;
        while (i < g.n - 1 && pick > g.wallArea[i]) {
          pick -= g.wallArea[i];
          i++;
        }
        const z = Math.min((i + rng()) * g.dz, H - 0.004);
        const r = g.radiusAt(z) * 0.985;
        this.sites.push({ u: r * Math.cos(ps), z, w: Math.sin(ps), phase: rng(), sub: false, x: 0, y: 0 });
      }
    }

    reset() {
      this.rng = mulberry32(this.seed);
      this.t = 0;
      this.phi = 0; // ボトルの傾き(0 = 直立)
      this.theta = 0; // グラスの傾き(0 = 直立、正でボトル側へ)
      this.mouthH = 0.015; // 注ぎ口の縁からの高さ
      this.Vb = BOTTLE.volume;
      this.nBottle = this.Cbottle * this.Vb;
      this.nTotal0 = this.nBottle;
      this.VL = 0;
      this.nDiss = 0;
      this.TL = this.Tb;
      this.Tg = this.Tg0;
      this.packets = [];
      this.parcels = new Parcels(this.cal.maxParcels);
      this.nFoamC = 0;
      this.nFoamA = 0;
      this.Vfl = 0;
      this.nFoamLiqC = 0;
      this.foamIn = { nC: 0, nA: 0 };
      this.nEscaped = 0;
      this.nSpilled = 0;
      this.spilledLiquid = 0;
      this.pouredVolume = 0;
      this.turbE = 0;
      this.turb = 0;
      this.gasInj = 0;
      this.qgEma = 0;
      this.plumeU = 0;
      this.Q = 0;
      this.bottleHead = 0;
      this.bottleFrac = 0;
      this.bottleLevel = 0;
      this._bottleL = undefined;
      this._onsetV = -1;
      this.impact = null;
      this.ent = { Vair: 0, xw: 0, wsum: 0, zp: 0, E: 0, ex: 0 };
      this.emitClock = 0;
      this.wetFrac = new Float64Array(this.glass.n);
      this.wetTime = new Float64Array(this.glass.n);
      this.bottomWetTime = 0;
      this.Vhold = 0;
      this.Vice = 0;
      this.Awet = 0;
      this.Asurf = 0;
      this.wallRate = 0;
      this.iceRate = 0;
      this.L1rel = undefined;
      this.L2rel = undefined;
      this.dome = 0;
      this.spillFx = { foam: 0, liquid: 0 }; // 描画側が読み取ってゼロに戻す
      this.diag = { foamGas: [0, 0, 0, 0, 0] }; // 泡層に入ったガス [mol]: 壁 / 巻き込み / 乱流核 / 氷 / 泡膜の脱ガス
      this._vrimTheta = NaN;
      this.gOx = 0;
      this.gOy = 0;
      for (const site of this.sites) site.phase = this.rng();
      this.updateGeometry();
      this.ice = this.makeIce(this.settings.ice | 0);
      this.updateLevels();
      this.aimX = null;
      this.jetVx = -0.25; // 狙いの初期値(中くらいの流量の液柱)
      this.jetVy = 0;
      this.restX = this.rimR.x + 0.072; // 置いてあるボトル(テーブルの上に立つ)
      this.restY = this.tableY + 0.0012 + this.bottle.H;
      this.mouthX = this.restX;
      this.mouthY = this.restY;
      this.bottleOx = this.mouthX;
      this.bottleOy = this.mouthY - this.bottle.H;
      for (let k = 0; k < 480; k++) this.stepIce(1 / 240);
    }

    toWorld(u, z) {
      const c = this.gc;
      const s = this.gs;
      return { x: this.gOx + u * c + z * s, y: this.gOy - u * s + z * c };
    }

    updateGeometry() {
      const th = this.theta;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const g = this.glass;
      const H = g.H;
      this.gc = c;
      this.gs = s;
      const Ox = -(H / 2) * s;
      const Oy = -(H / 2) * c;
      this.gOx = Ox;
      this.gOy = Oy;
      const FI = this.frameInner;
      const W = this.inner;
      for (let i = 0; i < FI.length; i++) {
        W[i].x = Ox + FI[i].u * c + FI[i].z * s;
        W[i].y = Oy - FI[i].u * s + FI[i].z * c;
      }
      for (const e of this.edges) {
        const a = W[e.ia];
        const b = W[e.ib];
        e.ax = a.x;
        e.ay = a.y;
        e.bx = b.x;
        e.by = b.y;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-12;
        e.nx = -dy / len;
        e.ny = dx / len;
      }
      for (const wall of [this.wallR, this.wallL]) {
        for (let j = 0; j < wall.frame.length; j++) {
          const p = wall.frame[j];
          wall.world[j].x = Ox + p.u * c + p.z * s;
          wall.world[j].y = Oy - p.u * s + p.z * c;
        }
        for (let j = 0; j < wall.dir.length; j++) {
          const a = wall.world[j];
          const b = wall.world[j + 1];
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-12;
          wall.dir[j].x = (b.x - a.x) / len;
          wall.dir[j].y = (b.y - a.y) / len;
        }
      }
      const FO = this.frameOuter;
      const WO = this.outer;
      for (let i = 0; i < FO.length; i++) {
        WO[i].x = Ox + FO[i].u * c + FO[i].z * s;
        WO[i].y = Oy - FO[i].u * s + FO[i].z * c;
      }
      for (let i = 0; i < FO.length; i++) {
        const a = WO[i];
        const b = WO[(i + 1) % FO.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        a.nx = len > 1e-9 ? -dy / len : 0;
        a.ny = len > 1e-9 ? dx / len : 0;
      }
      this.rimR = W[this.rimRi];
      this.rimL = W[this.rimLi];
      if (th !== this._vrimTheta) {
        this.Lrim = H * c - g.rTop * s; // いちばん低い縁(ボトル側)の高さ
        this.Vrim = g.volumeArea(this.Lrim, c, s);
        this._vrimTheta = th;
      }
      this.Aopen = Math.PI * g.rTop * g.rTop * c;
      for (const st of this.sites) {
        st.x = Ox + st.u * c + st.z * s;
        st.y = Oy - st.u * s + st.z * c;
      }
    }

    insideInner(x, y) {
      for (const e of this.edges) if ((x - e.ax) * e.nx + (y - e.ay) * e.ny < 0) return false;
      return true;
    }
    insideOuter(x, y) {
      for (const p of this.outer) if ((x - p.x) * p.nx + (y - p.y) * p.ny < 0) return false;
      return true;
    }
    // 鉛直線 x がグラス内側の下の壁と交わる高さ
    floorAt(x) {
      let best = Infinity;
      for (const e of this.edges) {
        if (e.type === EDGE_OPENING) continue;
        const x0 = Math.min(e.ax, e.bx);
        const x1 = Math.max(e.ax, e.bx);
        if (x < x0 || x > x1 || x1 - x0 < 1e-9) continue;
        const y = e.ay + ((e.by - e.ay) * (x - e.ax)) / (e.bx - e.ax);
        if (y < best) best = y;
      }
      if (best === Infinity) for (const p of this.inner) best = Math.min(best, p.y);
      return best;
    }

    makeIce(n) {
      const cubes = [];
      const a = this.iceSize;
      const rng = mulberry32(this.seed * 13 + 5);
      const wide = this.glass.rBottom > a * 0.9;
      for (let i = 0; i < n; i++) {
        const col = wide ? i % 2 : 0;
        const row = wide ? Math.floor(i / 2) : i;
        const u = wide ? (col - 0.5) * a * 1.1 : 0;
        const z = a * 0.6 + row * a * 1.1 + 0.002;
        const p = this.toWorld(u, Math.min(z, this.glass.H - a * 0.6));
        const sites = [];
        for (let k = 0; k < 6; k++) {
          const side = Math.floor(rng() * 4);
          const t = (rng() - 0.5) * a * 0.9;
          const h = a * 0.48;
          const lx = side === 0 ? t : side === 1 ? h : side === 2 ? t : -h;
          const ly = side === 0 ? -h : side === 1 ? t : side === 2 ? h : t;
          sites.push({ lx, ly, phase: rng(), sub: false, x: 0, y: 0 });
        }
        cubes.push({ x: p.x, y: p.y, vx: 0, vy: 0, a, ang: (rng() - 0.5) * 0.5, w: 0, fsub: 0, sites });
      }
      return cubes;
    }

    foamGasVolume() {
      return ((this.nFoamC + this.nFoamA) * R_GAS * (this.TL + T0K)) / P_ATM;
    }
    foamVolume() {
      return this.Vfl + this.foamGasVolume();
    }
    foamThickness() {
      return Math.max(0, this.yL2 - this.yL1) + this.dome;
    }
    ceq() {
      return henry(this.TL, this.drink.salt) * P_ATM;
    }
    supersat() {
      if (this.VL < 1e-9) return this.Cbottle / (henry(this.Tb, this.drink.salt) * P_ATM) - 1;
      return Math.max(0, this.nDiss / this.VL) / this.ceq() - 1;
    }

    // ボトルの液が注ぎ口に届き始める傾き
    onsetTilt() {
      if (this.Vb <= 1e-9) return MAX_BOTTLE_TILT;
      if (Math.abs(this._onsetV - this.Vb) < 2e-7) return this._onset;
      const b = this.bottle;
      const rm = BOTTLE.mouthR;
      const headAt = (phi) => {
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        return b.solveLevel(this.Vb, c, s) - (b.H * c - rm * Math.abs(s));
      };
      let lo = 0.02;
      let hi = MAX_BOTTLE_TILT;
      if (headAt(lo) > 0) hi = lo;
      else {
        for (let i = 0; i < 24; i++) {
          const mid = 0.5 * (lo + hi);
          if (headAt(mid) > 0) hi = mid;
          else lo = mid;
        }
      }
      this._onsetV = this.Vb;
      this._onset = hi;
      return hi;
    }

    stepBottle(dt) {
      const phi = this.phi;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const b = this.bottle;
      const rm = BOTTLE.mouthR;
      // 口の位置: 置いてあるときはテーブルの上、持ち上げて傾けるにつれてグラスの縁の上へ。
      // 手は液柱がボトル側の内壁(縁から 2 cm 下、壁から 4 mm 内側)に届くように狙う。
      // グラスを傾けていればそこで壁に触れて伝い落ち、直立なら壁際をまっすぐ落ちる。
      const k = smoothstep(0.05, 1.0, phi);
      const rim = this.rimR;
      const pourY = rim.y + this.mouthH + rm;
      const W = this.wallR;
      const sAim = Math.min(0.02, W.total * 0.3);
      let j = 0;
      while (j < W.dir.length - 1 && sAim > W.cum[j + 1]) j++;
      const d = W.dir[j];
      const ax = W.world[j].x + d.x * (sAim - W.cum[j]) + d.y * 0.004;
      const ay = W.world[j].y + d.y * (sAim - W.cum[j]) - d.x * 0.004;
      const jvx = this.jetVx;
      const jvy = this.jetVy;
      const drop = Math.max(0, pourY - rm * s - ay);
      const tFall = (jvy + Math.sqrt(jvy * jvy + 2 * G * drop)) / G;
      // 液の出口(下側の口縁)は縁より外へは出さない。勢いが強すぎれば壁に届かず中ほどへ落ちる。
      const exitX = clamp(ax - jvx * tFall, rim.x - 0.025, rim.x + 0.003);
      const aimX = exitX + rm * c;
      this.aimX = this.aimX == null ? aimX : this.aimX + clamp(aimX - this.aimX, -0.3 * dt, 0.3 * dt);
      this.mouthX = lerp(this.restX, this.aimX, k);
      this.mouthY = lerp(this.restY, pourY, k);
      this.bottleOx = this.mouthX + s * b.H;
      this.bottleOy = this.mouthY - c * b.H;
      let Q = 0;
      let frac = 0;
      let head = 0;
      if (this.Vb > 1e-10) {
        const L = b.solveLevel(this.Vb, c, s, this._bottleL);
        this._bottleL = L;
        this.bottleLevel = L;
        const yLow = b.H * c - rm * Math.abs(s);
        const yHigh = b.H * c + rm * Math.abs(s);
        head = L - yLow;
        if (head > 0) {
          const span = Math.max(yHigh - yLow, 3e-4);
          frac = Math.min(1, head / span);
          const qmax = BOTTLE.qCoef * Math.sqrt(G * Math.pow(2 * rm, 5));
          Q = qmax * Math.pow(frac, 1.6) * (1 + 0.15 * clamp((head - span) / 0.04, 0, 1));
          if (frac >= 1) Q *= 1 + 0.12 * Math.sin(2 * Math.PI * 5.5 * this.t); // ゴボゴボ(空気の逆流)
          Q = Math.min(Q, this.Vb / dt);
        }
      } else {
        this.bottleLevel = -1;
      }
      this.Q = Q;
      this.bottleFrac = frac;
      this.bottleHead = head;
      if (Q <= 0) return;
      const dV = Q * dt;
      const nC = this.Cbottle * dV;
      this.Vb -= dV;
      this.nBottle -= nC;
      this.pouredVolume += dV;
      const v0 = clamp(Q / (Math.PI * rm * rm * Math.max(0.12, 0.55 * frac)), 0.08, 1.2);
      const vx = -v0 * Math.max(0.2, s);
      const vy = v0 * Math.min(0, c);
      this.jetVx += (vx - this.jetVx) * Math.min(1, dt / 0.15); // 狙いに使う(手の反応は少し遅れる)
      this.jetVy += (vy - this.jetVy) * Math.min(1, dt / 0.15);
      this.packets.push({
        x: this.mouthX - rm * c, y: this.mouthY - rm * s, // 下側の口縁から出る
        vx, vy,
        dV, nC, Q, glug: smoothstep(0.9, 1.0, frac), v0, d0: Math.sqrt((4 * Q) / (Math.PI * v0)),
        mode: 0, inside: false, path: 0, s: 0, v: 0, side: 0, broken: false, age: 0,
      });
    }

    stepPackets(dt) {
      const P = this.packets;
      let w = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        let keep;
        if (p.mode === 0) keep = this.movePacketAir(p, dt);
        else if (p.mode === 1) keep = this.movePacketFilm(p, dt);
        else {
          p.vy -= G * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          keep = p.y > this.tableY;
        }
        if (keep) P[w++] = p;
      }
      P.length = w;
    }

    spillPacket(p) {
      p.mode = 2;
      this.spilledLiquid += p.dV;
      this.nSpilled += p.nC;
      p.nC = 0;
      this.spillFx.liquid += p.dV;
    }

    movePacketAir(p, dt) {
      const ox = p.x;
      const oy = p.y;
      p.vy -= G * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.path += Math.hypot(p.x - ox, p.y - oy);
      p.age += dt;
      if (!p.inside) {
        const rl = this.rimL;
        const rr = this.rimR;
        if (p.vy < 0 && segHit(ox, oy, p.x, p.y, rl.x, rl.y, rr.x, rr.y) >= 0) p.inside = true;
        else if (this.insideInner(p.x, p.y)) p.inside = true;
        else if (this.insideOuter(p.x, p.y) || p.y < this.tableY || p.age > 4) {
          this.spillPacket(p); // コップの外側に当たった / 外した
          return p.y > this.tableY;
        }
        if (!p.inside) return true;
      }
      if (this.VL > 2e-7 && p.y <= this.yL1) {
        this.deliver(p, p.x, 'plunge', Math.sqrt(p.vy * p.vy + 0.3 * p.vx * p.vx), false);
        return false;
      }
      for (const cb of this.ice) {
        const dx = p.x - cb.x;
        const dy = p.y - cb.y;
        const rr = cb.a * 0.55;
        const d2 = dx * dx + dy * dy;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 1e-9;
          const nx = dx / d;
          const ny = dy / d;
          p.x = cb.x + nx * rr;
          p.y = cb.y + ny * rr;
          const vn = p.vx * nx + p.vy * ny;
          if (vn < 0) {
            p.vx -= vn * nx;
            p.vy -= vn * ny;
          }
          p.vx *= 0.65;
          p.vy *= 0.65;
          p.broken = true;
          cb.vx += vn * nx * 0.002; // 氷が少し押される
          cb.vy += vn * ny * 0.002;
        }
      }
      let best = 2;
      let be = null;
      for (const e of this.edges) {
        if (e.type === EDGE_OPENING) continue;
        const t = segHit(ox, oy, p.x, p.y, e.ax, e.ay, e.bx, e.by);
        if (t >= 0 && t < best) {
          best = t;
          be = e;
        }
      }
      if (be) {
        const hx = ox + (p.x - ox) * best;
        const hy = oy + (p.y - oy) * best;
        if (be.type === EDGE_BOTTOM) {
          p.x = hx;
          p.y = hy;
          this.deliver(p, hx, 'bottom', Math.hypot(p.vx, p.vy), false);
          return false;
        }
        if (be.ny > 0.12) {
          // 鉛直から 7° 以上寝た壁 → 液膜になって伝い落ちる(ほぼ鉛直な壁では沿って落ちるだけ)
          const wall = be.side > 0 ? this.wallR : this.wallL;
          const d = wall.dir[be.seg];
          const ux = be.upperIsA ? be.ax : be.bx;
          const uy = be.upperIsA ? be.ay : be.by;
          p.mode = 1;
          p.side = be.side;
          p.s = wall.cum[be.seg] + Math.hypot(hx - ux, hy - uy);
          p.v = Math.max(0, p.vx * d.x + p.vy * d.y) * 0.75;
          p.x = hx;
          p.y = hy;
          if (this.VL > 2e-7 && hy <= this.yL1) {
            this.deliverFilm(p, d);
            return false;
          }
          return true;
        }
        // 張り出した壁: 法線方向の速度を失い、沿って落ちる
        const vn = p.vx * be.nx + p.vy * be.ny;
        if (vn < 0) {
          p.vx -= vn * be.nx;
          p.vy -= vn * be.ny;
        }
        p.vx *= 0.7;
        p.vy *= 0.7;
        p.x = hx + be.nx * 2e-4;
        p.y = hy + be.ny * 2e-4;
      } else if (!this.insideInner(p.x, p.y)) {
        p.inside = false; // 開口部から外へ出た
      }
      return true;
    }

    movePacketFilm(p, dt) {
      const wall = p.side > 0 ? this.wallR : this.wallL;
      let j = 0;
      while (j < wall.dir.length - 1 && p.s > wall.cum[j + 1]) j++;
      const gpar = -G * wall.dir[j].y;
      if (gpar <= 0.05 * G && p.s > 0.002) {
        this.deliver(p, p.x, 'filmBottom', p.v * 0.3, true); // 最も低い所に溜まる
        return false;
      }
      p.v += (gpar - p.v / this.cal.filmTau) * dt;
      if (p.v < 0.03) p.v = 0.03;
      p.s += p.v * dt;
      p.path += p.v * dt;
      p.age += dt;
      if (p.s >= wall.total) {
        const e = wall.world[wall.world.length - 1];
        p.x = e.x;
        p.y = e.y;
        this.deliver(p, p.x, 'filmBottom', p.v * 0.3, true);
        return false;
      }
      while (j < wall.dir.length - 1 && p.s > wall.cum[j + 1]) j++;
      const a = wall.world[j];
      const t = p.s - wall.cum[j];
      p.x = a.x + wall.dir[j].x * t;
      p.y = a.y + wall.dir[j].y * t;
      if (this.VL > 2e-7 && p.y <= this.yL1) {
        this.deliverFilm(p, wall.dir[j]);
        return false;
      }
      return true;
    }

    deliverFilm(p, d) {
      this.deliver(p, p.x, 'film', p.v * (0.25 + 0.75 * Math.max(0, -d.y)), true);
    }

    // 液柱(または液膜)がプールに入る: 液と CO₂ を加え、空気巻き込みと乱れを計算
    deliver(p, x, mode, vEff, attached) {
      const cal = this.cal;
      const dV = p.dV;
      const V0 = this.VL;
      this.VL += dV;
      this.nDiss += p.nC;
      this.TL = V0 > 1e-9 ? (this.TL * V0 + this.Tb * dV) / this.VL : this.Tb;
      const depth = Math.max(0, this.yL1 - this.floorAt(x));
      const Q = Math.max(p.Q, 1e-7);
      const v = Math.max(vEff, 0.05); // 突入速度(液面に垂直な成分が主)
      const d = Math.sqrt((4 * Q) / (Math.PI * v)); // 突入時の液柱径
      const Lj = Math.max(p.path, 0.003);
      // Biń の式はノズル(ここではボトルの口)出口の速度・径で整理されている
      const Fr0 = (p.v0 * p.v0) / (G * p.d0);
      const shallow = 1 - clamp(depth / cal.shallowDepth, 0, 1);
      const attach = attached ? lerp(cal.wallAttachLow, cal.wallAttachHigh, smoothstep(cal.wallQ0, cal.wallQ1, Q)) : 1;
      let beta = 0.04 * Math.pow(Fr0, 0.28) * Math.pow(Lj / p.d0, 0.4) * smoothstep(cal.vTh0, cal.vTh1, v);
      beta *= attach;
      if (p.broken) beta *= cal.brokenFactor;
      beta *= 1 + cal.bottomSplash * shallow;
      beta += cal.glugAir * p.glug * (attached ? 0.5 : 1);
      beta = Math.min(beta * this.entrainScale, 1.0);
      const zp = Math.min(2.1 * Math.pow(v * d, 0.775) * (attached ? 0.35 : 1), depth);
      const Vair = beta * dV;
      const E = 0.5 * this.rho * dV * v * v * (attached ? Math.max(0.2, attach) : 1) * (1 + shallow);
      this.turbE += E;
      const ent = this.ent;
      this.gasInj += Vair;
      ent.Vair += Vair;
      ent.xw += x * (Vair + 1e-12);
      ent.wsum += Vair + 1e-12;
      ent.zp = Math.max(ent.zp, zp);
      ent.E += E;
      ent.ex = x;
      this.impact = { x, y: this.yL1, v, mode, attached, Q, beta, t: this.t };
    }

    // 1/60 秒ぶんの巻き込み空気と乱流核をパーセルにする
    flushEntrainment() {
      const ent = this.ent;
      if (ent.wsum <= 0 && ent.E <= 0) return;
      if (this.VL < 2e-7) {
        ent.Vair = ent.xw = ent.wsum = ent.zp = ent.E = 0;
        return;
      }
      const rng = this.rng;
      const x0 = ent.wsum > 0 ? ent.xw / ent.wsum : ent.ex;
      const TK = this.TL + T0K;
      const P = this.parcels;
      if (ent.Vair > 0) {
        for (const cls of this.airClasses) {
          const vb = (Math.PI * cls.d * cls.d * cls.d) / 6;
          const Ntot = (ent.Vair * cls.w) / vb;
          if (Ntot < 1e-3) continue;
          const parts = Ntot > 40 ? 2 : 1;
          for (let j = 0; j < parts; j++) {
            const zd = ent.zp * (0.04 + 0.96 * Math.pow(rng(), 0.8));
            const pr = P_ATM + this.rho * G * zd;
            const nA = (pr * vb) / (R_GAS * TK);
            const i = P.add(x0 + (rng() - 0.5) * (0.006 + 0.5 * zd), this.yL1 - zd, cls.d / 2, 0, nA, Ntot / parts, KIND_AIR, rng());
            if (i >= 0) this.clampParcel(i);
          }
        }
      }
      const S = this.supersat();
      if (ent.E > 0 && S > 0) {
        const N = this.cal.turbSeed * ent.E * S;
        const R0 = this.cal.seedRadius;
        const reach = Math.max(ent.zp, Math.min(this.yL1 - this.floorAt(x0), 0.02));
        for (let j = 0; j < 3; j++) {
          const zd = reach * (0.1 + 0.9 * rng());
          const pr = P_ATM + this.rho * G * zd + (2 * this.sigma) / R0;
          const n1 = (pr * (4 / 3) * Math.PI * R0 * R0 * R0) / (R_GAS * TK);
          const Nj = N / 3;
          if (n1 * Nj > 0.05 * this.nDiss) continue;
          const i = P.add(x0 + (rng() - 0.5) * (0.01 + 0.8 * zd), this.yL1 - zd, R0, n1, 0, Nj, KIND_SEED, rng());
          if (i >= 0) {
            this.nDiss -= n1 * Nj;
            this.clampParcel(i);
          }
        }
      }
      ent.Vair = ent.xw = ent.wsum = ent.zp = ent.E = 0;
    }

    clampParcel(i) {
      const P = this.parcels;
      let x = P.x[i];
      let y = P.y[i];
      const m = P.R[i] + 3e-4;
      for (let pass = 0; pass < 2; pass++) {
        for (const e of this.edges) {
          if (e.type === EDGE_OPENING) continue;
          const d = (x - e.ax) * e.nx + (y - e.ay) * e.ny;
          if (d < m) {
            if (e.ny < 0 && Math.abs(e.nx) > 0.3) {
              x += (m - d) / e.nx; // 張り出した壁では横にだけ押す(気泡は壁に沿って昇る)
            } else {
              x += (m - d) * e.nx;
              y += (m - d) * e.ny;
            }
          }
        }
      }
      P.x[i] = x;
      P.y[i] = y;
    }

    // 壁面・氷の核生成サイト(§2.2, §3.2)
    siteFreq(Tw, CL) {
      const dC = CL - henry(Tw, this.drink.salt) * P_ATM;
      if (dC <= 0) return 0;
      const rhoG = P_ATM / (R_GAS * (Tw + T0K));
      return (this.cal.siteFreq * diffusivity(Tw, this.drink.mu) * dC) / (rhoG * this.detachR * this.detachR);
    }

    emitFromSites(list, rate, kind, dt) {
      let nSub = 0;
      for (const st of list) if (st.sub) nSub++;
      if (nSub === 0 || rate <= 0) return;
      const fVis = clamp(this._fAvg, 0.8, 6);
      const Nper = rate / (nSub * fVis);
      const R0 = this.detachR;
      const TK = this.TL + T0K;
      for (const st of list) {
        if (!st.sub) continue;
        st.phase += fVis * dt;
        if (st.phase < 1) continue;
        st.phase -= 1;
        const depth = this.yL1 - st.y;
        const pr = P_ATM + this.rho * G * depth + (2 * this.sigma) / R0;
        const n1 = (pr * (4 / 3) * Math.PI * R0 * R0 * R0) / (R_GAS * TK);
        const i = this.parcels.add(st.x, st.y, R0, n1, 0, Nper, kind, st.w || 0);
        if (i >= 0) {
          this.nDiss -= n1 * Nper;
          this.clampParcel(i);
        }
      }
    }

    stepNucleation(dt) {
      this.wallRate = 0;
      this.iceRate = 0;
      this.Awet = 0;
      if (this.VL < 2e-7) return;
      const g = this.glass;
      const mat = this.material;
      const fb = g.wetted(this.L1rel, this.gc, this.gs, this.wetFrac);
      const w0 = mat.eff / (mat.eff + EFF_WATER); // 接触温度の重み
      const TL = this.TL;
      const dT = this.Tg - TL;
      const CL = this.nDiss / this.VL;
      const sites = this.siteDensity * 1e4;
      let rate = 0;
      let Awet = 0;
      for (let i = 0; i < g.n; i++) {
        const f = this.wetFrac[i];
        if (f <= 0) continue;
        const A = g.wallArea[i] * f;
        Awet += A;
        this.wetTime[i] += f * dt;
        const Tw = TL + w0 * Math.exp(-this.wetTime[i] / mat.wallTau) * dT;
        rate += sites * A * this.siteFreq(Tw, CL);
      }
      if (fb > 0) {
        const A = g.bottomArea * fb;
        Awet += A;
        this.bottomWetTime += fb * dt;
        const Tw = TL + w0 * Math.exp(-this.bottomWetTime / mat.wallTau) * dT;
        rate += sites * A * this.siteFreq(Tw, CL);
      }
      this.Awet = Awet;
      this.wallRate = rate;
      this._fAvg = Awet > 0 ? rate / (sites * Awet) : 0;
      const yS = this.yL1 - 0.0008;
      for (const st of this.sites) st.sub = st.y < yS;
      this.emitFromSites(this.sites, rate, KIND_WALL, dt);
      if (!this.ice.length) return;
      const fIce = this.siteFreq(TL, CL);
      let rIce = 0;
      const iceSites = [];
      for (const cb of this.ice) {
        rIce += 6 * cb.a * cb.a * cb.fsub * this.cal.iceSites * 1e4 * fIce;
        const c = Math.cos(cb.ang);
        const s = Math.sin(cb.ang);
        for (const st of cb.sites) {
          st.x = cb.x + st.lx * c - st.ly * s;
          st.y = cb.y + st.lx * s + st.ly * c;
          st.sub = st.y < yS;
          iceSites.push(st);
        }
      }
      this.iceRate = rIce;
      this._fAvg = fIce;
      this.emitFromSites(iceSites, rIce, KIND_ICE, dt);
    }

    // 気泡の成長(§4)と上昇(§5)
    stepParcels(dt) {
      const P = this.parcels;
      const n = P.n;
      if (n === 0) {
        this.Vhold = 0;
        return;
      }
      const TL = this.TL;
      const TK = TL + T0K;
      const kH = henry(TL, this.drink.salt);
      const D = diffusivity(TL, this.drink.mu);
      const mu = viscosity(TL, this.drink.mu);
      const rho = this.rho;
      const Sc13 = Math.cbrt(mu / (rho * D));
      const sig2 = 2 * this.sigma;
      const CL = this.VL > 1e-9 ? Math.max(0, this.nDiss / this.VL) : 0;
      const yS = this.yL1;
      const amp = Math.sqrt(24 * (2e-6 + 4e-4 * this.turb) * dt); // 一様乱数で拡散係数 K のランダムウォーク
      const rng = this.rng;
      const edges = this.edges;
      const fi = this.foamIn;
      const up = this.plumeU;
      let sumDn = 0;
      let Vhold = 0;
      for (let i = n - 1; i >= 0; i--) {
        const depth = yS - P.y[i];
        if (depth <= 0) {
          const N = P.N[i];
          fi.nC += P.nC[i] * N;
          fi.nA += P.nA[i] * N;
          this.diag.foamGas[P.kind[i]] += (P.nC[i] + P.nA[i]) * N;
          P.remove(i);
          continue;
        }
        const R = P.R[i];
        const pr = P_ATM + rho * G * depth + sig2 / R;
        const nt = P.nC[i] + P.nA[i];
        const Cs = (kH * P.nC[i] * pr) / nt;
        const d = 2 * R;
        const U = this.rise.at(d);
        const Sh = 2 + 0.6 * Math.sqrt((rho * U * d) / mu) * Sc13;
        let dn = 4 * Math.PI * R * R * ((Sh * D) / d) * (CL - Cs) * dt;
        if (P.nC[i] + dn < 0) dn = -P.nC[i];
        P.nC[i] += dn;
        sumDn += dn * P.N[i];
        const ntot = P.nC[i] + P.nA[i];
        const V = (ntot * R_GAS * TK) / pr;
        const Rn = Math.cbrt((0.75 * V) / Math.PI);
        if (Rn < 1.5e-6) {
          sumDn -= P.nC[i] * P.N[i]; // 溶けきった: CO₂ は液に戻る
          P.remove(i);
          continue;
        }
        P.R[i] = Rn;
        Vhold += V * P.N[i];
        let x = P.x[i] + (rng() - 0.5) * amp;
        let y = P.y[i] + (U + up) * dt;
        const m = Rn + 3e-4;
        for (let k = 0; k < edges.length; k++) {
          const e = edges[k];
          if (e.type === EDGE_OPENING) continue;
          const dd = (x - e.ax) * e.nx + (y - e.ay) * e.ny;
          if (dd < m) {
            if (e.ny < 0 && Math.abs(e.nx) > 0.3) {
              x += (m - dd) / e.nx; // 張り出した壁では横にだけ押す
            } else {
              x += (m - dd) * e.nx;
              y += (m - dd) * e.ny;
            }
          }
        }
        P.x[i] = x;
        P.y[i] = y;
        P.age[i] += dt;
      }
      this.nDiss -= sumDn;
      this.Vhold = Vhold;
    }

    // 液面からの物質移動(§7)
    stepSurfaceFlux(dt) {
      if (this.VL < 2e-7 || this.Asurf <= 0) return;
      const CL = this.nDiss / this.VL;
      const Ceq = this.ceq();
      if (CL <= Ceq) return;
      const kL = this.cal.kLcalm + this.cal.kLturb * this.turb;
      const dn = Math.min(kL * (CL - Ceq) * this.Asurf * dt, 0.5 * (CL - Ceq) * this.VL);
      this.nDiss -= dn;
      this.nEscaped += dn;
    }

    // 泡層(§6): 生成 → 泡膜からの脱ガス → 排液 → 膜破裂
    stepFoam(dt) {
      const d = this.drink;
      const fi = this.foamIn;
      const TK = this.TL + T0K;
      if (fi.nC + fi.nA > 0) {
        const Vg = ((fi.nC + fi.nA) * R_GAS * TK) / P_ATM;
        const VflIn = Math.min((Vg * (1 - d.phiIn)) / d.phiIn, Math.max(0, this.VL - 1e-7) * 0.5);
        const CL = this.VL > 1e-9 ? this.nDiss / this.VL : 0;
        this.VL -= VflIn;
        this.nDiss -= CL * VflIn;
        this.Vfl += VflIn;
        this.nFoamLiqC += CL * VflIn;
        this.nFoamC += fi.nC;
        this.nFoamA += fi.nA;
        fi.nC = 0;
        fi.nA = 0;
      }
      const ngas = this.nFoamC + this.nFoamA;
      if (ngas <= 1e-15) {
        if (this.Vfl > 0) {
          this.VL += this.Vfl;
          this.nDiss += this.nFoamLiqC;
          this.Vfl = 0;
          this.nFoamLiqC = 0;
        }
        return;
      }
      // 泡膜の液は過飽和なので、その CO₂ は泡の気体へ抜ける
      const excess = this.nFoamLiqC - this.ceq() * this.Vfl;
      if (excess > 0) {
        const dn = excess * (1 - Math.exp(-dt / this.cal.foamDegasTau));
        this.nFoamLiqC -= dn;
        this.nFoamC += dn;
        this.diag.foamGas[4] += dn;
      }
      const Vfg = this.foamGasVolume();
      const epsDry = this.cal.epsDry;
      const VflMin = (Vfg * epsDry) / (1 - epsDry);
      if (this.Vfl > VflMin) {
        const dV = (this.Vfl - VflMin) * (1 - Math.exp(-dt / d.drain));
        const dnl = (this.nFoamLiqC * dV) / this.Vfl;
        this.Vfl -= dV;
        this.nFoamLiqC -= dnl;
        this.VL += dV;
        this.nDiss += dnl;
      }
      const eps = this.Vfl / (this.Vfl + Vfg);
      const epsIn = 1 - d.phiIn;
      const dry = clamp(1 - (eps - epsDry) / (epsIn - epsDry), 0, 1);
      const f = 1 - Math.exp((-(0.35 + 0.65 * dry) / this.foamLife) * dt); // 乾いた泡ほど速く壊れる
      const dVl = this.Vfl * f;
      const dnL = this.nFoamLiqC * f;
      this.nEscaped += this.nFoamC * f;
      this.nFoamC -= this.nFoamC * f;
      this.nFoamA -= this.nFoamA * f;
      this.Vfl -= dVl;
      this.nFoamLiqC -= dnL;
      this.VL += dVl;
      this.nDiss += dnL;
    }

    // 液 ⇔ グラスの熱交換(集中定数、厳密な指数緩和)
    stepThermal(dt) {
      if (this.VL < 2e-7 || this.Awet <= 0) return;
      const CLq = this.rho * CP_LIQ * (this.VL + this.Vfl);
      const Cg = this.glassDef.mass * this.material.c;
      const Teq = (CLq * this.TL + Cg * this.Tg) / (CLq + Cg);
      const decay = Math.exp(-this.cal.hWall * this.Awet * (1 / CLq + 1 / Cg) * dt);
      this.TL = Teq + (this.TL - Teq) * decay;
      this.Tg = Teq + (this.Tg - Teq) * decay;
    }

    // 氷: 浮力・重力・減衰と、壁・他の氷との位置拘束
    stepIce(dt) {
      const cubes = this.ice;
      if (!cubes.length) {
        this.Vice = 0;
        return;
      }
      const yL = this.yL1;
      const hasLiq = this.VL > 2e-7;
      let Vice = 0;
      for (const cb of cubes) {
        const fsub = hasLiq ? clamp((yL - (cb.y - cb.a / 2)) / cb.a, 0, 1) : 0;
        cb.fsub = fsub;
        cb.vy += (-G + ((G * this.rho) / RHO_ICE) * fsub) * dt;
        const damp = Math.exp(-dt * (1.5 + 10 * fsub));
        cb.vx *= damp;
        cb.vy *= damp;
        cb.w *= damp;
        cb.x += cb.vx * dt;
        cb.y += cb.vy * dt;
        cb.ang += cb.w * dt;
        Vice += cb.a * cb.a * cb.a * fsub;
      }
      const rr = cubes[0].a * 0.58;
      for (let it = 0; it < 3; it++) {
        for (let i = 0; i < cubes.length; i++) {
          for (let j = i + 1; j < cubes.length; j++) {
            const A = cubes[i];
            const B = cubes[j];
            let dx = B.x - A.x;
            let dy = B.y - A.y;
            const dist = Math.hypot(dx, dy) || 1e-9;
            const ov = 2 * rr - dist;
            if (ov <= 0) continue;
            dx /= dist;
            dy /= dist;
            A.x -= (dx * ov) / 2;
            A.y -= (dy * ov) / 2;
            B.x += (dx * ov) / 2;
            B.y += (dy * ov) / 2;
            const rv = (B.vx - A.vx) * dx + (B.vy - A.vy) * dy;
            if (rv < 0) {
              A.vx += (rv * dx) / 2;
              A.vy += (rv * dy) / 2;
              B.vx -= (rv * dx) / 2;
              B.vy -= (rv * dy) / 2;
            }
          }
        }
        for (const cb of cubes) {
          for (const e of this.edges) {
            const dd = (cb.x - e.ax) * e.nx + (cb.y - e.ay) * e.ny;
            if (dd >= rr) continue;
            cb.x += (rr - dd) * e.nx;
            cb.y += (rr - dd) * e.ny;
            const vn = cb.vx * e.nx + cb.vy * e.ny;
            if (vn < 0) {
              cb.vx -= vn * e.nx;
              cb.vy -= vn * e.ny;
            }
            cb.w += (cb.vx * e.ny - cb.vy * e.nx) * 40 * dt; // 壁を転がるような回転(見た目用)
          }
        }
      }
      this.Vice = Vice;
    }

    updateLevels() {
      const g = this.glass;
      const c = this.gc;
      const s = this.gs;
      const V1 = this.VL + this.Vhold + this.Vice;
      this.L1rel = g.solveLevel(V1, c, s, this.L1rel);
      g.volumeArea(this.L1rel, c, s);
      this.Asurf = V1 > 0 ? g._area : 0;
      const Vf = this.foamVolume();
      const V2 = V1 + Vf;
      if (V2 <= this.Vrim) {
        this.L2rel = Vf > 1e-12 ? g.solveLevel(V2, c, s, this.L2rel) : this.L1rel;
        this.dome = 0;
      } else {
        this.L2rel = Math.max(this.L1rel, this.Lrim);
        this.dome = clamp((V2 - Math.max(V1, this.Vrim)) / Math.max(1e-9, 0.5 * this.Aopen), 0, this.drink.dome);
      }
      this.yL1 = this.gOy + this.L1rel;
      this.yL2 = this.gOy + this.L2rel;
    }

    // 縁より上にはみ出した分をこぼす(泡が先、次に液)
    handleOverflow() {
      const V1 = this.VL + this.Vhold + this.Vice;
      const Vf = this.foamVolume();
      const cap = this.Vrim + 0.5 * this.Aopen * this.drink.dome;
      const excess = V1 + Vf - cap;
      if (excess > 0 && Vf > 0) {
        const f = Math.min(1, excess / Vf);
        const dVl = this.Vfl * f;
        const dnL = this.nFoamLiqC * f;
        const dnC = this.nFoamC * f;
        this.Vfl -= dVl;
        this.nFoamLiqC -= dnL;
        this.nFoamC -= dnC;
        this.nFoamA -= this.nFoamA * f;
        this.spilledLiquid += dVl;
        this.nSpilled += dnL + dnC;
        this.spillFx.foam += Vf * f;
        this.spillFx.liquid += dVl;
      }
      const over = V1 - this.Vrim;
      if (over > 0 && this.VL > 0) {
        const ex = Math.min(over, this.VL);
        const dn = (this.nDiss / this.VL) * ex;
        this.VL -= ex;
        this.nDiss -= dn;
        this.nSpilled += dn;
        this.spilledLiquid += ex;
        this.spillFx.liquid += ex;
      }
    }

    // input: { bottleTilt [rad], glassTilt [rad], mouthHeight [m] }
    step(dt, input) {
      const inp = input || {};
      this.t += dt;
      const tp = clamp(inp.bottleTilt || 0, 0, MAX_BOTTLE_TILT);
      const tg = clamp(inp.glassTilt || 0, 0, MAX_GLASS_TILT);
      if (inp.mouthHeight != null) this.mouthH = clamp(inp.mouthHeight, 0.004, 0.15);
      this.phi += clamp(tp - this.phi, -4.5 * dt, 3.2 * dt); // 手の速さには限りがある
      this.theta += clamp(tg - this.theta, -1.4 * dt, 1.4 * dt);
      this.updateGeometry();
      this.updateLevels();
      this.stepBottle(dt);
      this.stepPackets(dt);
      this.turbE *= Math.exp(-dt / this.cal.turbTau);
      this.turb = this.turbE / (this.turbE + this.cal.turbRef);
      this.qgEma += (this.gasInj / dt - this.qgEma) * Math.min(1, dt / this.cal.plumeTau);
      this.gasInj = 0;
      this.plumeU = this.cal.plumeCoef * Math.cbrt((G * this.qgEma) / this.glass.rTop);
      this.stepNucleation(dt);
      this.emitClock += dt;
      if (this.emitClock >= 1 / 60) {
        this.emitClock -= 1 / 60;
        this.flushEntrainment();
      }
      this.stepParcels(dt);
      this.stepSurfaceFlux(dt);
      this.stepFoam(dt);
      this.stepThermal(dt);
      this.stepIce(dt);
      this.updateLevels();
      this.handleOverflow();
      this.updateLevels();
    }

    // CO₂ 収支 [mol](§1.3 のモデル化のポイント)
    co2Budget() {
      let flight = 0;
      for (const p of this.packets) flight += p.nC;
      let bubbles = 0;
      const P = this.parcels;
      for (let i = 0; i < P.n; i++) bubbles += P.nC[i] * P.N[i];
      return {
        bottle: this.nBottle,
        flight,
        dissolved: this.nDiss,
        bubbles: bubbles + this.foamIn.nC,
        foam: this.nFoamC + this.nFoamLiqC,
        escaped: this.nEscaped,
        spilled: this.nSpilled,
        total0: this.nTotal0,
      };
    }

    stats() {
      const recent = this.impact && this.t - this.impact.t < 0.1;
      return {
        Q: this.Q,
        VL: this.VL,
        Vfoam: this.foamVolume(),
        Vfl: this.Vfl,
        Vhold: this.Vhold,
        foam: this.foamThickness(),
        spilled: this.spilledLiquid,
        S: this.supersat(),
        TL: this.TL,
        Tg: this.Tg,
        impactV: recent ? this.impact.v : 0,
        impactMode: recent ? this.impact.mode : null,
        bottle: this.Vb,
      };
    }
  }

  // ===== ゲーム進行 =====
  // ready → pouring(最初の 1 滴でタイマー開始)→ settling(液体が目標量に達した時点でタイム確定、
  // 泡が落ち着くまで観察してこぼれを集計)→ done。ボトルが空になったら failed。
  class Game {
    constructor(settings, opts) {
      this.sim = new Simulation(settings, opts);
      this.restart();
    }
    configure(settings) {
      this.sim.configure(settings);
      this.restart();
    }
    restart() {
      this.sim.reset();
      this.state = 'ready';
      this.time = 0;
      this.clock = 0;
      this.finishTime = null;
      this.settleTime = 0;
      this.result = null;
      this.history = [];
      this.histClock = 0;
      this.acc = 0;
      this.foamMax = 0;
      this.vfClock = 0;
      this.vfPrev = 0;
      this.vfRising = true;
      this.spillPrev = 0;
      this.spilling = false;
      this.afterTime = 0;
    }
    update(dt, input) {
      const h = this.sim.cal.dt;
      this.acc += dt;
      let n = 0;
      while (this.acc >= h && n < 96) {
        this.acc -= h;
        n++;
        this.tick(h, input);
      }
      if (n >= 96) this.acc = 0;
    }
    tick(h, input) {
      const sim = this.sim;
      const locked = this.state !== 'ready' && this.state !== 'pouring';
      sim.step(h, locked ? { bottleTilt: 0, glassTilt: 0 } : input);
      if (this.state === 'ready' && sim.pouredVolume > 0) this.state = 'pouring';
      if (this.state !== 'ready') this.clock += h;
      this.vfClock += h;
      if (this.vfClock >= 0.25) {
        const vf = sim.foamVolume();
        this.vfRising = vf > this.vfPrev * 1.002 + 1e-9;
        this.vfPrev = vf;
        this.spilling = sim.spilledLiquid > this.spillPrev + 1e-10;
        this.spillPrev = sim.spilledLiquid;
        this.vfClock = 0;
      }
      if (this.state === 'pouring') {
        this.time += h;
        if (sim.VL >= sim.targetVolume) {
          this.finishTime = this.time;
          this.state = 'settling';
          this.settleTime = 0;
        } else if (sim.Vb <= 1e-7 && sim.packets.length === 0) {
          this.state = 'failed';
          this.result = { ok: false, reason: 'empty', spill: sim.spilledLiquid * 1e6, time: this.time };
        }
      } else if (this.state === 'settling') {
        this.settleTime += h;
        const calm = this.settleTime >= 1.5 && sim.packets.length === 0 && !this.vfRising && !this.spilling;
        if (calm || this.settleTime >= 15) {
          this.state = 'done';
          this.result = this.makeResult();
        }
      }
      if (this.state === 'pouring' || this.state === 'settling') this.foamMax = Math.max(this.foamMax, sim.foamThickness());
      else if (this.state === 'done' || this.state === 'failed') this.afterTime = (this.afterTime || 0) + h;
      this.histClock += h;
      // 記録グラフは注ぎ始めから結果が出た 2 秒後まで
      const recording = this.state !== 'ready' && (this.afterTime || 0) < 2;
      if (recording && this.histClock >= 0.05 && this.history.length < 2400) {
        this.histClock = 0;
        const V1 = sim.VL + sim.Vhold + sim.Vice;
        this.history.push({
          t: this.clock,
          liquid: sim.VL,
          total: V1 + sim.foamVolume(),
          cap: sim.Vrim,
          q: sim.Q,
          spill: sim.spilledLiquid,
        });
      }
    }
    makeResult() {
      const spill = this.sim.spilledLiquid * 1e6;
      const penalty = spill * PENALTY_PER_ML;
      return { ok: true, time: this.finishTime, spill, penalty, record: this.finishTime + penalty, foamMax: this.foamMax };
    }
  }

  return {
    G, P_ATM, T0K, M_CO2, GV_GL,
    CAL, DRINKS, GLASSES, MATERIALS, SURFACES, BOTTLE, DEFAULT_SETTINGS,
    MAX_GLASS_TILT, MAX_BOTTLE_TILT, PENALTY_PER_ML,
    KIND_WALL, KIND_AIR, KIND_SEED, KIND_ICE,
    solubilityGL, henry, viscosity, diffusivity, surfaceTension, terminalVelocity,
    smoothstep, clamp, lerp, mulberry32,
    Vessel, Parcels, RiseTable, Simulation, Game,
  };
});
