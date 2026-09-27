/* GenVario DNA engine - moved verbatim out of index.html into its own file.
   Needs #visual, #dna, #regRows, #regCount, #regStatus to exist in the DOM.
   Exposes window.__helix for debugging (fps, level, mutate, state). */
(function () {
  'use strict';

  var canvas = document.getElementById('dna');
  var ctx = canvas.getContext('2d', { alpha: false });

  // Слои-помощники: фон, слой ДНК, слой для свечения (bloom), виньетка
  var layer  = document.createElement('canvas'), lctx = layer.getContext('2d');
  var glow   = document.createElement('canvas'), gctx = glow.getContext('2d');
  var bg     = document.createElement('canvas'), bgx  = bg.getContext('2d');
  var vig    = document.createElement('canvas'), vgx  = vig.getContext('2d');

  var S = { W: 1, H: 1, dpr: 1, bloom: true, ema: 16, canFilter: ('filter' in ctx) };
  // Уровни качества: 2 — максимум, 1 — без свечения, 0 — облегчённый режим
  var Q = { level: 2, stride: 1, slowFrames: 0 };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function applyQuality(lvl) {
    Q.level = clamp(lvl, 0, 2);
    Q.stride = Q.level === 0 ? 2 : 1;
    S.bloom = Q.level === 2 && S.canFilter;
    resize(true);          // меняем только буферы: геном и состояния мутаций сохраняются
  }

  // ---------- утилиты ----------
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(90317);

  // ---------- спрайты свечения (кэш по цвету) ----------
  var sprites = {};
  function sprite(r, g, b) {
    var key = r + ',' + g + ',' + b;
    if (sprites[key]) return sprites[key];
    var size = 64, c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d');
    var grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0.00, 'rgba(' + r + ',' + g + ',' + b + ',0.98)');
    grd.addColorStop(0.16, 'rgba(' + r + ',' + g + ',' + b + ',0.60)');
    grd.addColorStop(0.42, 'rgba(' + r + ',' + g + ',' + b + ',0.17)');
    grd.addColorStop(1.00, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    x.fillStyle = grd;
    x.fillRect(0, 0, size, size);
    sprites[key] = c;
    return c;
  }
  function glowDot(g, sp, x, y, size, alpha) {
    if (alpha <= 0.005 || size <= 0.5) return;
    g.globalAlpha = alpha > 1 ? 1 : alpha;
    g.drawImage(sp, x - size * 0.5, y - size * 0.5, size, size);
  }

  // ---------- цифры 0 / 1 (кэш глифов по символу и цвету) ----------
  var glyphs = {};
  var GLYPH = {
    normal: [186, 236, 255],
    red:    [255, 88, 100],
    mint:   [126, 255, 192]
  };
  function glyphSprite(ch, rgb) {
    var key = ch + '|' + rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    if (glyphs[key]) return glyphs[key];
    var size = 64, c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d');
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = '700 44px Consolas, "SF Mono", "Roboto Mono", ui-monospace, monospace';
    x.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',1)';
    x.shadowColor = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.95)';
    x.shadowBlur = 8;
    x.fillText(ch, size / 2, size / 2 + 1);
    x.fillText(ch, size / 2, size / 2 + 1);   // второй проход — плотнее и ярче
    glyphs[key] = c;
    return c;
  }

  // рисует узел: свечение-подложка + цифра (или точка, если узел слишком мелкий)
  function drawNode(g, spGlow, x, y, size, alpha, bit, mode, t, seed) {
    if (alpha <= 0.012 || size <= 0.6) return;
    var isRed = mode === 1, isMint = mode === 2;
    // свечение-подложка: держит объём спирали, цифра читается поверх него
    glowDot(g, spGlow, x, y, size * (isRed ? 2.2 : 1.4), alpha * (isRed ? 0.85 : 0.6));
    if (isRed) glowDot(g, spGlow, x, y, size * 6, alpha * 0.13);   // «тревожное» гало

    if (size < 7) {                       // вдали узел читается как светящаяся точка
      glowDot(g, spGlow, x, y, size * 0.8, alpha * 0.6);
      return;
    }

    var ch = bit ? '1' : '0';
    var jx = 0, jy = 0, ga = alpha;
    if (isRed) {                          // «глитч»: цифра дрожит и мерцает
      var n1 = Math.sin(t * 37 + seed * 12.9898) * 43758.5453;
      n1 -= Math.floor(n1);
      var n2 = Math.sin(t * 29 + seed * 78.233) * 12345.6789;
      n2 -= Math.floor(n2);
      jx = (n1 - 0.5) * 3.4;
      jy = (n2 - 0.5) * 2.6;
      ga *= (n1 > 0.72) ? 0.35 : (0.7 + 0.3 * n2);
      if (n1 > 0.86) ch = bit ? '0' : '1';   // бит «плывёт»
    }
    var sp = glyphSprite(ch, isRed ? GLYPH.red : (isMint ? GLYPH.mint : GLYPH.normal));
    var gs = size * 1.12;
    g.globalAlpha = clamp(ga * (isRed ? 1 : 0.62), 0, 1);
    g.drawImage(sp, x + jx - gs * 0.5, y + jy - gs * 0.5, gs, gs);
  }

  // ---------- цвета ----------
  var COL = {
    strandA: [128, 224, 255],
    strandB: [158, 186, 255],
    coreA:   [236, 252, 255],
    coreB:   [230, 238, 255],
    dust:    [170, 210, 255]
  };
  // типы пар оснований: цвет «перекладины»
  var PAIRS = [
    { c: [124, 231, 255], w: 1.00 }, // A–T
    { c: [188, 166, 255], w: 0.95 }, // G–C
    { c: [148, 240, 222], w: 0.90 }, // T–A
    { c: [206, 214, 255], w: 0.92 }  // C–G
  ];

  // ---------- модель спирали ----------
  var M = {
    n: 0, y: null, jitter: null, type: null, rungEvery: 3,
    worldH: 0, radius: 0, kTwist: 0, camZ: 1, focal: 1, cx: 0, cy: 0,
    waveAmp: 0, dust: []
  };

  function buildModel() {
    var H = S.H, W = S.W;

    M.worldH = H * 1.34;                                  // длина спирали в «мировых» единицах
    M.radius = H * 0.085;                                 // радиус витка
    M.camZ   = H * 0.62;                                  // расстояние до камеры (перспектива)
    M.focal  = M.camZ;                                    // k = 1 в плоскости z = 0
    // справа живёт панель реестра — спираль сдвигаем в левую часть панели
    var narrow = window.matchMedia('(max-width: 900px)').matches;
    M.cx     = W * (narrow ? 0.5 : 0.34);
    M.cy     = H * (narrow ? 0.13 : 0.5);
    M.waveAmp = H * 0.05;                                 // лёгкая «змейка» оси

    var turns = 3.3;
    var n = Math.round(turns * 52);                       // узлов на виток
    var perTurn = M.worldH / turns;
    M.kTwist = (Math.PI * 2) / perTurn;
    M.n = n;
    M.y = new Float32Array(n);
    M.jitter = new Float32Array(n);
    M.type = new Uint8Array(n);

    for (var i = 0; i < n; i++) {
      M.y[i] = (i / (n - 1) - 0.5) * M.worldH;
      M.jitter[i] = 0.80 + rnd() * 0.45;
      M.type[i] = (rnd() * PAIRS.length) | 0;
    }

    // ---- геном: бит на узел + состояния пар (поиск мутаций) ----
    M.bit = new Uint8Array(n);
    M.pState = new Uint8Array(n);        // 0 норма · 1 найдена · 2 вынесена · 3 дырка · 4 синтез
    M.pTime = new Float32Array(n);
    M.lastX = new Float32Array(n);
    M.lastY = new Float32Array(n);
    M.lastXB = new Float32Array(n);
    M.lastYB = new Float32Array(n);
    M.lastK = new Float32Array(n);
    M.pending = new Array(n);
    for (var b = 0; b < n; b++) { M.bit[b] = rnd() < 0.5 ? 0 : 1; M.lastK[b] = 1; }

    // пары, которые может «найти» сканер (кратны 6 — работают на любом уровне качества)
    M.pairIdx = [];
    for (var q = 6; q < n - 6; q += 6) M.pairIdx.push(q);

    M.flights = [];                      // вынесенные фрагменты, летящие в таблицу
    M.mutants = [];
    M.mutFound = 0;
    M.mutFixed = 0;
    M.regIndex = 0;
    M.scanY = -M.worldH * 0.45;
    M.scanPause = 0.8;
    for (var s = 0; s < 5; s++) scheduleMutant();
    seedMutantAt(-M.worldH * 0.22);            // первая мутация — уже в кадре

    // «пылинки» вокруг спирали
    M.dust.length = 0;
    var dcount = Math.round(clamp(W * H / 12000, 40, 130));
    for (var d = 0; d < dcount; d++) {
      M.dust.push({
        x: (rnd() - 0.5) * W * 1.25,
        y: (rnd() - 0.5) * H * 1.4,
        z: (rnd() - 0.5) * M.radius * 4,
        r: 0.8 + rnd() * 2.1,
        a: 0.10 + rnd() * 0.35,
        v: 3 + rnd() * 14,
        ph: rnd() * Math.PI * 2
      });
    }
  }

  // ---------- фон ----------
  function buildBackdrop() {
    var w = canvas.width, h = canvas.height;
    bg.width = w; bg.height = h;
    vig.width = w; vig.height = h;

    var x = bgx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1; x.filter = 'none';
    x.fillStyle = '#04070e';
    x.fillRect(0, 0, w, h);

    // мягкие туманности
    function nebula(cx, cy, r, color, a) {
      var g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(' + color + ',' + a + ')');
      g.addColorStop(1, 'rgba(' + color + ',0)');
      x.fillStyle = g;
      x.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    nebula(w * 0.52, h * 0.28, Math.max(w, h) * 0.78, '26,64,120', 0.30);
    nebula(w * 0.70, h * 0.80, Math.max(w, h) * 0.62, '24,52,104', 0.22);
    nebula(w * 0.28, h * 0.55, Math.max(w, h) * 0.45, '16,40,80', 0.18);
    nebula(w * 0.50, h * 0.50, Math.min(w, h) * 0.60, '34,104,138', 0.09);

    // звёздная пыль
    var stars = Math.round(w * h / 5200);
    for (var i = 0; i < stars; i++) {
      var sx = rnd() * w, sy = rnd() * h;
      var sr = (rnd() * 1.25 + 0.25) * S.dpr;
      var sa = 0.06 + rnd() * 0.5;
      var tint = rnd();
      var col = tint > 0.75 ? '190,215,255' : (tint > 0.45 ? '150,205,240' : '225,235,255');
      var g2 = x.createRadialGradient(sx, sy, 0, sx, sy, sr * 4);
      g2.addColorStop(0, 'rgba(' + col + ',' + sa + ')');
      g2.addColorStop(1, 'rgba(' + col + ',0)');
      x.fillStyle = g2;
      x.fillRect(sx - sr * 4, sy - sr * 4, sr * 8, sr * 8);
    }

    // виньетка поверх всего
    var r = Math.hypot(w, h) * 0.62;
    var vg = vgx.createRadialGradient(w * 0.5, h * 0.5, r * 0.30, w * 0.5, h * 0.5, r);
    vg.addColorStop(0, 'rgba(3,6,12,0)');
    vg.addColorStop(0.65, 'rgba(3,6,12,0.30)');
    vg.addColorStop(1, 'rgba(2,4,9,0.80)');
    vgx.setTransform(1, 0, 0, 1, 0, 0);
    vgx.globalCompositeOperation = 'source-over';
    vgx.clearRect(0, 0, w, h);
    vgx.fillStyle = vg;
    vgx.fillRect(0, 0, w, h);
  }

  function resize(keepModel) {
    var rect = document.getElementById('visual').getBoundingClientRect();
    S.W = Math.max(1, Math.round(rect.width));
    S.H = Math.max(1, Math.round(rect.height));
    S.dpr = Math.min(window.devicePixelRatio || 1, Q.level === 2 ? 2 : (Q.level === 1 ? 1.5 : 1));

    canvas.width = Math.round(S.W * S.dpr);
    canvas.height = Math.round(S.H * S.dpr);
    canvas.style.width = S.W + 'px';
    canvas.style.height = S.H + 'px';

    layer.width = canvas.width; layer.height = canvas.height;
    glow.width = Math.max(1, Math.round(canvas.width / 2));
    glow.height = Math.max(1, Math.round(canvas.height / 2));

    if (!keepModel) buildModel();
    buildBackdrop();
  }

  // ---------- геном: поиск мутаций, вынос фрагмента и индексация ----------
  var MUT = { DETECT: 1.05, EXTRACT: 1.60, GAP: 0.45, RESYNTH: 0.85 };

  var regRows = document.getElementById('regRows');
  var regCount = document.getElementById('regCount');
  var regStatus = document.getElementById('regStatus');
  var visualEl = document.getElementById('visual');

  function hex4(i) {
    var s = i.toString(16).toUpperCase();
    while (s.length < 4) s = '0' + s;
    return '0x' + s;
  }

  // — справочник «настоящих» мутаций: гены, транскрипты, цитогенетика
  var GENES = [
    { g: 'BRCA1', chr: 'chr17', pos: 41196312, tx: 'NM_007294.4', n: 5592 },
    { g: 'BRCA2', chr: 'chr13', pos: 32972285, tx: 'NM_000059.4', n: 10257 },
    { g: 'TP53',  chr: 'chr17', pos: 7676154,  tx: 'NM_000546.6', n: 1182 },
    { g: 'EGFR',  chr: 'chr7',  pos: 55259515, tx: 'NM_005228.5', n: 3630 },
    { g: 'KRAS',  chr: 'chr12', pos: 25398284, tx: 'NM_004985.5', n: 567 },
    { g: 'CFTR',  chr: 'chr7',  pos: 117199644, tx: 'NM_000492.4', n: 4443 },
    { g: 'HBB',   chr: 'chr11', pos: 5246696,  tx: 'NM_000518.5', n: 444 },
    { g: 'APOE',  chr: 'chr19', pos: 45411941, tx: 'NM_000041.4', n: 954 },
    { g: 'PTEN',  chr: 'chr10', pos: 89692905, tx: 'NM_000314.8', n: 1212 },
    { g: 'MLH1',  chr: 'chr3',  pos: 37034841, tx: 'NM_000249.4', n: 2271 },
    { g: 'PIK3CA', chr: 'chr3', pos: 178936091, tx: 'NM_006218.4', n: 3207 },
    { g: 'LDLR',  chr: 'chr19', pos: 11199660, tx: 'NM_000527.5', n: 2583 },
    { g: 'SMN1',  chr: 'chr5',  pos: 70925030, tx: 'NM_000344.4', n: 885 }
  ];
  var AA = ['Ala', 'Arg', 'Asn', 'Asp', 'Cys', 'Gln', 'Glu', 'Gly', 'His', 'Ile',
            'Leu', 'Lys', 'Met', 'Phe', 'Pro', 'Ser', 'Thr', 'Trp', 'Tyr', 'Val'];
  var BASES = ['A', 'C', 'G', 'T'];
  var CLASSES = [
    { name: 'pathogenic',     key: 'path',   w: 30 },
    { name: 'likely path.',   key: 'likely', w: 22 },
    { name: 'VUS',            key: 'vus',    w: 28 },
    { name: 'likely benign',  key: 'benign', w: 20 }
  ];

  function pick(arr) { return arr[(rnd() * arr.length) | 0]; }
  function weighted(list) {
    var total = 0, q;
    for (q = 0; q < list.length; q++) total += list[q].w;
    var x = rnd() * total;
    for (q = 0; q < list.length; q++) { x -= list[q].w; if (x <= 0) return list[q]; }
    return list[list.length - 1];
  }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }

  // генерирует правдоподобную запись о мутации (HGVS c./p., координата, rs, частота)
  function makeMutation() {
    var g = pick(GENES);
    var kind = weighted([
      { k: 'missense', w: 34 }, { k: 'nonsense', w: 12 }, { k: 'frameshift', w: 18 },
      { k: 'dup', w: 10 }, { k: 'inframe', w: 10 }, { k: 'splice', w: 9 }, { k: 'synonymous', w: 7 }
    ]).k;
    var cds = 60 + ((rnd() * Math.min(g.n, 2600)) | 0);
    var ref = pick(BASES), alt = pick(BASES.filter(function (b) { return b !== ref; }));
    var aaPos = 20 + ((cds / 3) | 0) + ((rnd() * 6) | 0);
    var aa = pick(AA), aa2 = pick(AA);
    var c, p, effect;

    if (kind === 'missense') {
      c = 'c.' + cds + ref + '>' + alt;
      p = 'p.' + aa + aaPos + aa2;
      effect = 'missense';
    } else if (kind === 'nonsense') {
      c = 'c.' + cds + ref + '>' + alt;
      p = 'p.' + aa + aaPos + 'Ter';
      effect = 'nonsense';
    } else if (kind === 'synonymous') {
      c = 'c.' + cds + ref + '>' + alt;
      p = 'p.' + aa + aaPos + '=';
      effect = 'synonymous';
    } else if (kind === 'frameshift') {
      var del = 1 + ((rnd() * 2) | 0);
      c = del === 1 ? 'c.' + cds + 'del' : 'c.' + cds + '_' + (cds + del - 1) + 'del';
      p = 'p.' + aa + aaPos + aa2 + 'fs*' + (3 + ((rnd() * 40) | 0));
      effect = 'frameshift';
    } else if (kind === 'dup') {
      var dup = 1 + ((rnd() * 3) | 0);
      c = dup === 1 ? 'c.' + cds + 'dup' : 'c.' + cds + '_' + (cds + dup - 1) + 'dup';
      p = 'p.' + aa + aaPos + aa2 + 'fs*' + (2 + ((rnd() * 30) | 0));
      effect = 'dup';
    } else if (kind === 'inframe') {
      var len = 3 + 3 * ((rnd() * 2) | 0);
      c = 'c.' + cds + '_' + (cds + len - 1) + 'del';
      p = 'p.' + aa + aaPos + '_' + aa2 + (aaPos + len / 3) + 'del';
      effect = 'in-fr. del';
    } else {
      c = 'c.' + cds + (rnd() < 0.5 ? '+1G>A' : '-1G>C');
      p = 'p.?';
      effect = 'splice';
    }

    var cls = weighted(CLASSES);
    var af = rnd();
    return {
      id: '#0000',
      gene: g.g,
      tx: g.tx,
      c: c,
      p: p,
      effect: effect,
      cls: cls.name,
      clsKey: cls.key,
      locus: g.chr + ':' + group(g.pos + ((rnd() * 900 - 450) | 0)),
      rs: rnd() < 0.55 ? 'rs' + (10000000 + ((rnd() * 89999999) | 0)) : 'novel',
      zyg: rnd() < 0.62 ? 'het' : 'hom',
      af: af < 0.7 ? (af * 0.4).toFixed(2) + '%' : '1/' + (200 + ((rnd() * 40000) | 0))
    };
  }

  // строка реестра: ID · ген · HGVS · эффект + детали
  function addRegistryRow(m, nodeIndex) {
    if (!regRows) return;
    m.id = '#' + pad4(++M.regIndex);
    var row = document.createElement('div');
    row.className = 'reg-row';
    row.setAttribute('data-cls', m.clsKey);
    row.title = m.tx + ' · ' + m.locus + ' · ' + m.zyg + ' · AF ' + m.af;
    row.innerHTML =
      '<div class="reg-main">' +
        '<span class="c-id">' + m.id + '</span>' +
        '<span class="c-gene">' + m.gene + '</span>' +
        '<span class="c-var">' + m.c + '</span>' +
        '<span class="c-eff">' + m.effect + '</span>' +
      '</div>' +
      '<div class="reg-sub">' + m.locus + ' · ' + m.p + ' · ' + m.cls + ' · ' + m.rs + '</div>';
    regRows.insertBefore(row, regRows.firstChild);
    while (regRows.childNodes.length > 5) regRows.removeChild(regRows.lastChild);
    if (regCount) regCount.textContent = M.regIndex;
    if (regStatus) regStatus.textContent = 'indexed ' + m.id + ' ' + m.gene + ' ' + m.c;
  }

  function setStatus(text) {
    if (regStatus) regStatus.textContent = text;
  }
  function refreshHud() {
    if (regCount) regCount.textContent = M.regIndex;
  }

  // выбираем узел, который сканер «найдёт» на следующем проходе
  function scheduleMutant() {
    if (!M.pairIdx || !M.pairIdx.length) return;
    for (var tries = 0; tries < 60; tries++) {
      var cand = M.pairIdx[(rnd() * M.pairIdx.length) | 0];
      if (M.pState[cand] !== 0) continue;
      if (M.mutants.indexOf(cand) >= 0) continue;
      if (Math.abs(M.y[cand] - M.scanY) < M.worldH * 0.11) continue;
      M.mutants.push(cand);
      return;
    }
  }

  // ставит мутацию в ближайший к заданной точке узел
  function seedMutantAt(targetY) {
    if (!M.pairIdx || !M.pairIdx.length) return;
    var best = -1, bestD = Infinity;
    for (var q = 0; q < M.pairIdx.length; q++) {
      var cand = M.pairIdx[q];
      if (M.pState[cand] !== 0 || M.mutants.indexOf(cand) >= 0) continue;
      var d = Math.abs(M.y[cand] - targetY);
      if (d < bestD) { bestD = d; best = cand; }
    }
    if (best >= 0) M.mutants.push(best);
  }

  function triggerMutation(i) {
    M.pState[i] = 1;
    M.pTime[i] = 0;
    M.mutFound++;
    M.pending[i] = makeMutation();       // данные готовим сразу — их унесёт фрагмент
    setStatus('mutation found ' + hex4(i));
  }

  // цель в экранных координатах: верх реестра, куда «влетает» фрагмент
  function registryTarget() {
    if (!regRows || !visualEl) return { x: S.W * 0.8, y: 40 };
    var pr = visualEl.getBoundingClientRect();
    var rr = regRows.getBoundingClientRect();
    if (!rr.width) return { x: S.W * 0.8, y: 40 };
    return { x: rr.left - pr.left + Math.min(rr.width * 0.5, 110), y: rr.top - pr.top + 8 };
  }

  // «вынос» фрагмента: пара отделяется от спирали и улетает в таблицу
  function launchFragment(i, ax, ay, bx, by, ka) {
    var tgt = registryTarget();
    var midX = (ax + bx) * 0.5, midY = (ay + by) * 0.5;
    var arc = Math.min(160, Math.abs(tgt.x - midX) * 0.35 + 70);
    M.flights.push({
      x0: midX, y0: midY, x1: tgt.x, y1: tgt.y,
      px: midX + (tgt.x - midX) * 0.45, py: midY - arc,      // контрольная точка дуги
      sep: Math.hypot(bx - ax, by - ay),
      size: Math.max(16, 24 * ka),
      bit: M.bit[i],
      t: 0, dur: MUT.EXTRACT * 0.96,
      data: M.pending[i]
    });
  }

  function updateGenome(dt, t) {
    // сканер медленно идёт вдоль оси спирали
    if (M.scanPause > 0) {
      M.scanPause -= dt;
      if (M.scanPause <= 0) M.scanY = -M.worldH * 0.5 - M.worldH * 0.05;
    } else {
      var prevY = M.scanY;
      M.scanY += dt * (M.worldH / 12);
      for (var m = M.mutants.length - 1; m >= 0; m--) {
        var idx = M.mutants[m];
        var yy = M.y[idx];
        if (prevY <= yy && yy < M.scanY && M.pState[idx] === 0) {
          M.mutants.splice(m, 1);
          triggerMutation(idx);
        }
      }
      if (M.scanY > M.worldH * 0.5) {
        M.scanY = M.worldH * 0.5;
        M.scanPause = 1.6;
      }
    }

    // состояния пар: найдена → вынесена → дырка → синтез новой пары → норма
    for (var i = 0; i < M.pState.length; i++) {
      var st = M.pState[i];
      if (!st) continue;
      M.pTime[i] += dt;
      var tt = M.pTime[i];
      if (st === 1 && tt > MUT.DETECT) {
        M.pState[i] = 2; M.pTime[i] = 0;
        launchFragment(i, M.lastX[i], M.lastY[i], M.lastXB[i], M.lastYB[i], M.lastK[i]);
        setStatus('extracting ' + hex4(i) + ' → registry');
      } else if (st === 2 && tt > MUT.EXTRACT) {
        M.pState[i] = 3; M.pTime[i] = 0;
      } else if (st === 3 && tt > MUT.GAP) {
        M.pState[i] = 4; M.pTime[i] = 0;
      } else if (st === 4 && tt > MUT.RESYNTH) {
        M.pState[i] = 0; M.pTime[i] = 0;
        M.bit[i] = rnd() < 0.5 ? 0 : 1;      // на место дефекта встаёт исправный нуклеотид
        M.mutFixed++;
        refreshHud();
        scheduleMutant();                    // новая цель для сканера
      }
    }

    // полёт фрагмента к таблице
    for (var f = M.flights.length - 1; f >= 0; f--) {
      var fl = M.flights[f];
      fl.t += dt;
      if (fl.t >= fl.dur) {
        addRegistryRow(fl.data, fl);
        M.flights.splice(f, 1);
      }
    }
  }

  function flightPoint(fl, e, out) {
    var u = 1 - e;
    out.x = u * u * fl.x0 + 2 * u * e * fl.px + e * e * fl.x1;
    out.y = u * u * fl.y0 + 2 * u * e * fl.py + e * e * fl.y1;
    return out;
  }
  var _fp = { x: 0, y: 0 };

  // ---------- геометрия кадра ----------
  var phase = 0, last = 0, mouseX = 0, mouseY = 0, mTiltX = 0, mTiltY = 0;

  function drawDNA(t) {
    var H = S.H, W = S.W;
    var g = lctx;
    var camZ = M.camZ, focal = M.focal;
    var R0 = M.radius, kTw = M.kTwist, n = M.n;
    var cx = M.cx, cy = M.cy;
    var waveAmp = M.waveAmp;
    var spA = sprite(COL.strandA[0], COL.strandA[1], COL.strandA[2]);
    var spB = sprite(COL.strandB[0], COL.strandB[1], COL.strandB[2]);
    var spD = sprite(COL.dust[0], COL.dust[1], COL.dust[2]);
    var spRed = sprite(255, 96, 108);
    var spMint = sprite(132, 255, 198);
    var spScan = sprite(180, 240, 255);

    var breathe = 1 + 0.055 * Math.sin(t * 0.42);

    // — пылинки
    for (var d = 0; d < M.dust.length; d++) {
      var p = M.dust[d];
      var dy = ((p.y + t * p.v) % (H * 1.5) + H * 1.5) % (H * 1.5) - H * 0.75;
      var pd = p.z + camZ;
      if (pd < 1) continue;
      var pk = focal / pd;
      var px = cx + (p.x + Math.sin(t * 0.6 + p.ph) * 12) * pk;
      var py = cy + dy * pk;
      if (px < -40 || px > W + 40) continue;
      glowDot(g, spD, px, py, p.r * 9 * pk, p.a * 0.9);
    }

    // — луч сканера поперёк спирали
    var sk = focal / camZ;
    var scanScreenY = cy + M.scanY * sk;
    var scanFade = M.scanPause > 0 ? clamp(1 - (1.6 - M.scanPause) / 1.6, 0, 1) : 1;
    var sw = R0 * 3.6 * sk, sh = Math.max(14, H * 0.05) * sk;
    g.globalAlpha = 0.26 * scanFade;
    g.drawImage(spScan, cx - sw * 0.5, scanScreenY - sh * 0.5, sw, sh);
    g.globalAlpha = 0.34 * scanFade;
    g.drawImage(spScan, cx - sw * 0.5, scanScreenY - 1.5, sw, 3);

    // — две нити (цифры 0/1) + перекладины пар
    var rungStep = M.rungEvery * Q.stride;
    var stride = Q.stride;
    var scanSigma = Math.max(1, H * 0.055);
    var mutated = false;

    for (var i = 0; i < n; i += stride) {
      var y = M.y[i];
      var th = y * kTw + phase;
      var R = R0 * breathe * (1 + 0.075 * Math.sin(y * 0.0042 + t * 0.5));
      var ca = Math.cos(th), sa = Math.sin(th);
      var xa = R * ca, za = R * sa;
      var xb = -xa, zb = -za;
      var wave = Math.sin(y * 0.0019 + 0.6) * waveAmp;

      // проекция обеих точек
      var da = za + camZ, db = zb + camZ;
      var ka = da > 1 ? focal / da : 0, kb = db > 1 ? focal / db : 0;
      var ax = cx + xa * ka + wave * ka, ay = cy + y * ka;
      var bx = cx + xb * kb + wave * kb, by = cy + y * kb;

      // глубина: 1 = ближе к камере
      var na = clamp((-za + R0) / (2 * R0), 0, 1);
      var nb = clamp((-zb + R0) / (2 * R0), 0, 1);
      var j = M.jitter[i];

      // ---- состояние пары: вспышка → вынос → дырка → синтез новой пары
      var st = M.pState[i];
      var mode = 0, kill = 1, sizeK = 1, boost = 1, pulse = 0, redMin = 0;
      if (st === 1) {
        var ramp = smoothstep(0, 0.2, M.pTime[i]);
        pulse = 0.55 + 0.45 * Math.sin(t * 15 + i * 0.7);
        mode = 1;
        sizeK = 1 + 0.6 * ramp * pulse;
        boost = 1 + 1.5 * ramp * (0.7 + 0.3 * pulse);
        redMin = 0.42 * ramp;             // мутация видна даже на дальней нити
      } else if (st === 2) {
        // пара «поднята» из спирали и уже летит в таблицу — на её месте пусто
        kill = 0.9 * (1 - smoothstep(0, 0.18, M.pTime[i]));
        sizeK = kill;
        mode = 1;
      } else if (st === 3) {
        kill = 0; sizeK = 0;
      } else if (st === 4) {
        // новая, исправная пара плавно встаёт на место
        var rt = smoothstep(0, MUT.RESYNTH, M.pTime[i]);
        kill = rt; sizeK = 0.3 + 0.7 * rt; mode = 2;
      }
      // запоминаем экранные координаты пары — по ним фрагмент «выносится» наружу
      if (st) {
        M.lastX[i] = ax; M.lastY[i] = ay;
        M.lastXB[i] = bx; M.lastYB[i] = by;
        M.lastK[i] = ka;
      }

      // подсветка узлов, которые сейчас «читает» сканер
      var sd = (y - M.scanY) / scanSigma;
      var scanBoost = Math.exp(-sd * sd) * scanFade;

      var baseSz = R0 * 0.225 * (0.82 + 0.3 * j);
      var szA = baseSz * ka * (0.78 + 0.45 * na) * sizeK * (1 + 0.3 * scanBoost);
      var szB = baseSz * kb * (0.78 + 0.45 * nb) * sizeK * (1 + 0.3 * scanBoost);
      var twinkle = 0.82 + 0.18 * Math.sin(t * 1.7 + i * 0.8);
      var alA = (0.16 + 0.84 * Math.pow(na, 0.85)) * (0.5 + 0.5 * j) * twinkle * kill * boost * (1 + 0.85 * scanBoost);
      var alB = (0.16 + 0.84 * Math.pow(nb, 0.85)) * (0.5 + 0.5 * j) * twinkle * kill * boost * (1 + 0.85 * scanBoost);
      if (redMin > 0) {
        alA = Math.max(alA, redMin * (0.75 + 0.25 * pulse)) * kill;
        alB = Math.max(alB, redMin * (0.75 + 0.25 * pulse)) * kill;
      }

      var glowA = st ? (mode === 1 ? spRed : (mode === 2 ? spMint : spA)) : spA;
      var glowB = st ? (mode === 1 ? spRed : (mode === 2 ? spMint : spB)) : spB;

      // при синтезе новой пары показываем уже исправный нуклеотид
      var bitA = (st === 4) ? (M.bit[i] ^ 1) : M.bit[i];
      drawNode(g, glowA, ax, ay, szA, alA, bitA, mode, t, i);
      drawNode(g, glowB, bx, by, szB, alB, bitA, mode, t, i + 0.5);

      // рамка-«прицел» вокруг всей пары (обе нити) + расходящееся кольцо
      if (st === 1) {
        mutated = true;
        var prog = clamp(M.pTime[i] / MUT.DETECT, 0, 1);
        var pcx = (ax + bx) * 0.5, pcy = (ay + by) * 0.5;
        var rr = Math.max(20 * ka, Math.hypot(bx - ax, by - ay) * 0.75) + 7 * pulse;
        var e = rr * 0.45;
        g.globalAlpha = clamp(0.25 + 0.7 * pulse, 0, 1);
        g.strokeStyle = 'rgba(255,96,110,1)';
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(pcx - rr, pcy - rr + e); g.lineTo(pcx - rr, pcy - rr); g.lineTo(pcx - rr + e, pcy - rr);
        g.moveTo(pcx + rr - e, pcy - rr); g.lineTo(pcx + rr, pcy - rr); g.lineTo(pcx + rr, pcy - rr + e);
        g.moveTo(pcx + rr, pcy + rr - e); g.lineTo(pcx + rr, pcy + rr); g.lineTo(pcx + rr - e, pcy + rr);
        g.moveTo(pcx - rr + e, pcy + rr); g.lineTo(pcx - rr, pcy + rr); g.lineTo(pcx - rr, pcy + rr - e);
        g.stroke();

        g.globalAlpha = (1 - prog) * 0.55;
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(pcx, pcy, (10 + 52 * prog) * ka, 0, Math.PI * 2);
        g.stroke();
      }

      // синтез: к паре сходится мятное кольцо
      if (st === 4) {
        var rp = clamp(M.pTime[i] / MUT.RESYNTH, 0, 1);
        g.globalAlpha = (1 - rp) * 0.45;
        g.strokeStyle = 'rgba(132,255,198,1)';
        g.lineWidth = 1.3;
        g.beginPath();
        g.arc((ax + bx) * 0.5, (ay + by) * 0.5, (12 + 30 * (1 - rp)) * ka, 0, Math.PI * 2);
        g.stroke();
      }

      // перекладина между нитями
      if (i % rungStep === 0 && i > 0) {
        var pair = PAIRS[M.type[i]];
        var spP = st ? (mode === 1 ? spRed : (mode === 2 ? spMint : sprite(pair.c[0], pair.c[1], pair.c[2])))
                     : sprite(pair.c[0], pair.c[1], pair.c[2]);
        var len = Math.hypot(bx - ax, by - ay);
        var ratio = len / Math.max(1, 2 * R0 * ((ka + kb) * 0.5));
        var rBase = (0.10 + 0.90 * smoothstep(0.16, 0.86, ratio)) * kill * (st === 1 ? 1.6 : 1);
        var accent = (i % (rungStep * 9) === 0);
        var dots = 14;

        for (var k = 1; k < dots; k++) {
          var f = k / dots;
          var xx = lerp(xa, xb, f), zz = lerp(za, zb, f);
          var dd = zz + camZ;
          if (dd < 1) continue;
          var kk = focal / dd;
          var depthN = clamp((-zz + R0) / (2 * R0), 0, 1);
          var depthA = 0.18 + 0.82 * Math.pow(depthN, 0.9);
          var sxp = cx + xx * kk + wave * kk;
          var syp = cy + y * kk;
          if (sxp < -30 || sxp > W + 30) continue;
          var bulge = 0.55 + 0.45 * Math.sin(f * Math.PI);
          var sSize = (2.6 + 3.6 * bulge) * kk * (accent ? 1.35 : 1) * (st === 1 ? 1.2 : 1);
          glowDot(g, spP, sxp, syp, sSize, rBase * depthA * pair.w);
        }
      }
    }

    // — вынесенные фрагменты: пара летит по дуге в таблицу реестра
    var spRedG = sprite(GLYPH.red[0], GLYPH.red[1], GLYPH.red[2]);
    for (var q = 0; q < M.flights.length; q++) {
      var fl = M.flights[q];
      var p = clamp(fl.t / fl.dur, 0, 1);
      var ee = p * p * (3 - 2 * p);

      // шлейф: несколько «призраков» по пройденной части пути
      for (var gq = 4; gq >= 1; gq--) {
        var pe = clamp(ee - gq * 0.035, 0, 1);
        if (pe <= 0.001) continue;
        var pt = flightPoint(fl, pe, _fp);
        glowDot(g, spRedG, pt.x, pt.y, fl.size * 2.2 * (1 - gq * 0.16), 0.1 * (1 - gq * 0.2));
      }

      var cur = flightPoint(fl, ee, _fp);
      // «поводок»: видно, откуда фрагмент извлечён
      g.globalAlpha = 0.22 * (1 - p);
      g.strokeStyle = 'rgba(255,120,132,1)';
      g.lineWidth = 1;
      g.setLineDash([3, 5]);
      g.beginPath();
      g.moveTo(fl.x0, fl.y0);
      g.lineTo(cur.x, cur.y);
      g.stroke();
      g.setLineDash([]);

      // ориентация «плашки» — перпендикулярно направлению полёта
      var ang = Math.atan2(fl.y1 - fl.y0, fl.x1 - fl.x0) + Math.PI * 0.5;
      var sep = lerp(fl.sep, 13, ee) * 0.5;
      var dx = Math.cos(ang) * sep, dy = Math.sin(ang) * sep;
      var nsize = lerp(fl.size, 12, ee);

      // перекладина вынесенной пары
      g.globalAlpha = 0.55 * (1 - 0.35 * ee);
      g.strokeStyle = 'rgba(255,110,122,1)';
      g.lineWidth = 1.2;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(cur.x - dx, cur.y - dy);
      g.lineTo(cur.x + dx, cur.y + dy);
      g.stroke();
      g.setLineDash([]);

      // два узла с битами
      var spG = glyphSprite(fl.bit ? '1' : '0', GLYPH.red);
      g.globalAlpha = 1;
      g.drawImage(spG, cur.x - dx - nsize * 0.6, cur.y - dy - nsize * 0.6, nsize * 1.2, nsize * 1.2);
      g.drawImage(spG, cur.x + dx - nsize * 0.6, cur.y + dy - nsize * 0.6, nsize * 1.2, nsize * 1.2);
      glowDot(g, spRed, cur.x, cur.y, nsize * 3.4, 0.30);
    }

    // пока идёт вспышка — тёплый отсвет на весь кадр
    if (mutated) {
      g.globalAlpha = 0.05 + 0.04 * Math.sin(t * 15);
      g.drawImage(sprite(255, 70, 90), cx - W * 0.5, cy - H * 0.5, W, H);
    }
  }

  // ---------- кадр целиком ----------
  function frame(now) {
    var t = now / 1000;
    var dt = last ? Math.min(now - last, 60) : 16;
    last = now;
    S.ema = S.ema * 0.9 + dt * 0.1;

    // авто-качество: если стабильно тяжело — снижаем уровень нагрузки
    if (t > 2 && dt > 30) Q.slowFrames++; else if (Q.slowFrames > 0) Q.slowFrames--;
    if (Q.slowFrames > 40 && Q.level > 0) { Q.slowFrames = 0; applyQuality(Q.level - 1); }

    if (!reduceMotion) {
      phase += (dt / 1000) * (0.62 + 0.10 * Math.sin(t * 0.23));
    }
    updateGenome(dt / 1000, t);
    mTiltX += ((mouseX * 0.055) - mTiltX) * 0.045;
    mTiltY += ((mouseY * 0.045) - mTiltY) * 0.045;

    // фон
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.drawImage(bg, 0, 0);

    // слой ДНК (аддитивно, на прозрачном фоне)
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    lctx.globalCompositeOperation = 'lighter';
    lctx.save();
    lctx.translate(M.cx + mTiltX * 10, M.cy + mTiltY * 8);
    lctx.rotate(mTiltY * 0.012);
    lctx.translate(-M.cx, -M.cy);
    drawDNA(t);
    lctx.restore();

    // свечение (bloom)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    if (S.bloom && S.canFilter) {
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.globalCompositeOperation = 'source-over';
      gctx.clearRect(0, 0, glow.width, glow.height);
      gctx.drawImage(layer, 0, 0, glow.width, glow.height);
      ctx.filter = 'blur(' + Math.max(2, Math.round(5 * S.dpr)) + 'px)';
      ctx.globalAlpha = 0.30;
      ctx.drawImage(glow, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(layer, 0, 0);

    // виньетка
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(vig, 0, 0);

    raf = requestAnimationFrame(frame);
  }

  // ---------- запуск ----------
  var raf = 0;
  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  var rTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rTimer);
    rTimer = setTimeout(resize, 140);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  document.getElementById('visual').addEventListener('pointermove', function (e) {
    var r = this.getBoundingClientRect();
    mouseX = (e.clientX - r.left) / r.width * 2 - 1;
    mouseY = (e.clientY - r.top) / r.height * 2 - 1;
  });
  document.getElementById('visual').addEventListener('pointerleave', function () {
    mouseX = 0; mouseY = 0;
  });

  resize();
  start();

  // отладочный доступ к анимации (в консоли браузера)
  window.__helix = {
    get fps() { return Math.round(1000 / S.ema); },
    get level() { return Q.level; },
    setLevel: applyQuality,
    mutate: function (i) { triggerMutation(clamp(i | 0, 0, M.n - 1)); },   // вручную запустить мутацию
    timing: MUT,
    state: function () {
      var out = [];
      for (var i = 0; i < M.pState.length; i++) if (M.pState[i]) out.push([i, M.pState[i], +M.pTime[i].toFixed(2)]);
      return { scan: +M.scanY.toFixed(1), world: +M.worldH.toFixed(1), pending: M.mutants.length, active: out };
    }
  };
})();
