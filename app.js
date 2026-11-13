/* weight-progress-tracker / app.js
   State, rendering and interaction. All numbers are stored in kg; conversion
   happens only at the input and display boundary. Start weight/date are derived
   from the first record — they are never configured by the user. */
(function () {
  'use strict';

  var W = window.WPT;
  var KEY = W.STORAGE_KEY;
  var $ = function (id) { return document.getElementById(id); };

  var RANGES = [
    { key: '1w', label: '1 週' },
    { key: '1m', label: '1 月' },
    { key: '3m', label: '3 月' },
    { key: 'auto', label: '自動' }
  ];
  var PAGE_NAMES = ['我的進度', 'BMI', '變化走勢'];

  var state = null;
  var memoryStore = null;
  var ui = { page: 0, confirmClear: false };
  var toastTimer = null;

  /* chart geometry (design units, fixed viewBox). A taller viewBox makes the
     plot fill the chart page's vertical space instead of leaving a dead band. */
  var CHART_L = 34, CHART_R = 10, CHART_T = 9, CHART_B = 22;
  var CHART_VW = 340, CHART_VH = 300;
  var CHART_PW = CHART_VW - CHART_L - CHART_R, CHART_PH = CHART_VH - CHART_T - CHART_B;

  /* chart camera + pan/zoom gesture state */
  var chartCtx = null, chartWin = null, world = null, cam = null, chartSig = null;
  var panPts = {}, panLast = null, pinchPrev = null, rafPending = false;

  /* ------------------------------------------------------------------ state */

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function normalizeState(s) {
    s = s || {};
    var pref = s.prefs || {};
    var range = pref.chartRange;
    if (RANGES.map(function (r) { return r.key; }).indexOf(range) < 0) range = '1w';
    var out = {
      schema: 2,
      unit: s.unit === 'lb' ? 'lb' : 'kg',
      heightCm: numOrNull(s.heightCm),
      goal: {
        kg: numOrNull(s.goal && s.goal.kg),
        targetDate: (s.goal && s.goal.targetDate) || null,
        setDate: (s.goal && s.goal.setDate) || null
      },
      entries: [],
      prefs: {
        showTrend: typeof pref.showTrend === 'boolean' ? pref.showTrend : true,
        showSmooth: !!pref.showSmooth,
        chartRange: range,
        autoFillGaps: typeof pref.autoFillGaps === 'boolean' ? pref.autoFillGaps : true
      }
    };
    var seen = {};
    (Array.isArray(s.entries) ? s.entries : []).forEach(function (e) {
      if (!e || !e.date) return;
      var kg = parseFloat(e.kg);
      if (!isFinite(kg) || kg < 10 || kg > 400) return;
      seen[String(e.date).slice(0, 10)] = kg;
    });
    out.entries = Object.keys(seen).sort().map(function (d) { return { date: d, kg: seen[d] }; });
    return out;
  }

  function persist(s) {
    memoryStore = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* in-memory only */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        /* Old builds seeded a demo journey. Drop it so the first run is clean. */
        if (parsed && parsed.demo) {
          var fresh = blankState(null);
          persist(fresh);
          return fresh;
        }
        return normalizeState(parsed);
      }
    } catch (e) { /* file:// or privacy mode */ }
    return memoryStore;
  }

  function save() { persist(state); }

  function blankState(prev) {
    prev = prev || {};
    return normalizeState({
      schema: 2,
      unit: prev.unit === 'lb' ? 'lb' : 'kg',
      heightCm: numOrNull(prev.heightCm),
      goal: { kg: null, targetDate: null, setDate: null },
      entries: [],
      prefs: {
        showTrend: prev.prefs && typeof prev.prefs.showTrend === 'boolean' ? prev.prefs.showTrend : true,
        showSmooth: prev.prefs ? !!prev.prefs.showSmooth : false,
        chartRange: prev.prefs ? prev.prefs.chartRange : '1w',
        autoFillGaps: prev.prefs && typeof prev.prefs.autoFillGaps === 'boolean' ? prev.prefs.autoFillGaps : true
      }
    });
  }

  /* Fill every missing day (up to yesterday; today is excluded) with the most
     recent known weight before that day. Runs on boot and when the toggle is
     turned on. Days before the first record have no "previous" weight, so they
     are left empty on purpose. */
  function autoFillGaps() {
    if (!state || !state.prefs.autoFillGaps) return;
    var entries = state.entries;
    if (!entries.length) return;
    var byDate = {};
    entries.forEach(function (e) { byDate[e.date] = e; });
    var todayD = W.todayDays();
    var firstD = W.isoToDays(entries[0].date);
    if (!isFinite(firstD) || !isFinite(todayD)) return;
    var lastKg = null, added = 0, d, iso, e;
    for (d = firstD; d < todayD; d++) {
      iso = W.daysToIso(d);
      e = byDate[iso];
      if (e) {
        lastKg = e.kg;
      } else if (lastKg != null) {
        var ne = { date: iso, kg: lastKg };
        entries.push(ne);
        byDate[iso] = ne;
        added++;
      }
    }
    if (added) {
      entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      save();
    }
  }

  function setByPath(obj, path, val) {
    var p = path.split('.'), o = obj, i;
    for (i = 0; i < p.length - 1; i++) {
      if (o[p[i]] == null) o[p[i]] = {};
      o = o[p[i]];
    }
    o[p[p.length - 1]] = val;
  }

  /* --------------------------------------------------------------- context */

  function buildCtx() {
    var entries = state.entries.map(function (e) {
      return { t: W.isoToDays(e.date), kg: e.kg, date: e.date };
    }).filter(function (e) { return isFinite(e.t); });

    var today = W.todayDays();
    var model = W.fitAsymptotic(entries);
    var smooth = W.smoothSeries(entries, 7);
    var current = entries.length ? entries[entries.length - 1].kg : null;
    var startDays = entries.length ? entries[0].t : NaN;
    var startKg = entries.length ? entries[0].kg : null;
    /* 目標軌道從「最新一筆紀錄」算到目標日，代表的是剩餘路徑的理想線，
       而非從第一筆就開始。起點體重也用最新紀錄，才與實測現況接得上。 */
    var lastDays = entries.length ? entries[entries.length - 1].t : NaN;
    var lastKg = current;
    var targetDays = state.goal.targetDate ? W.isoToDays(state.goal.targetDate) : null;
    var traj = (lastKg != null && state.goal.kg != null && targetDays && isFinite(lastDays))
      ? W.goalTrajectory(lastDays, lastKg, targetDays, state.goal.kg) : null;
    var outlook = W.goalOutlook(model, state.goal.kg);
    var setDays = state.goal.setDate ? W.isoToDays(state.goal.setDate) : startDays;
    var deltas = W.computeDeltas(entries, model, smooth, setDays, today, state.unit);

    return {
      entries: entries, model: model, smooth: smooth, today: today, current: current,
      goal: state.goal, startDays: startDays, startKg: startKg, targetDays: targetDays, traj: traj,
      outlook: outlook, setDays: setDays, deltas: deltas
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function unit() { return W.unitLabel(state.unit); }

  /* ------------------------------------------------------------- page one */

  function renderPage1(ctx) {
    var u = unit();
    var c = ctx.current;
    $('heroNum').textContent = c == null ? '—' : W.fmtKg(c, state.unit, 1);
    $('heroUnit').textContent = u;

    var last = ctx.entries.length ? ctx.entries[ctx.entries.length - 1] : null;
    if (!last) $('heroSub').textContent = '尚未記錄 · 在下面輸入第一筆體重';
    else if (last.date === W.todayIso()) $('heroSub').textContent = '今天已記錄 · 想改就直接覆蓋';
    else $('heroSub').textContent = '上次記錄 ' + W.longDate(last.t) + ' · 幾天沒量也沒關係';

    var s = ctx.startKg, g = state.goal.kg;
    var pct = null, lost = null, left = null;
    if (s != null && c != null) lost = s - c;
    if (g != null && c != null) left = Math.max(0, c - g);
    if (s != null && g != null && c != null && s > g) pct = W.clamp((s - c) / (s - g), 0, 1);

    $('progressFill').style.width = pct == null ? '0%' : (pct * 100).toFixed(1) + '%';
    $('progressPct').textContent = pct == null ? '—' : Math.round(pct * 100) + '%';
    $('progressSummary').textContent = '已減 ' +
      (lost == null ? '—' : W.fmtKg(Math.abs(lost), state.unit, 1) + (lost < 0 ? '（增加）' : '')) +
      ' · 還差 ' + (left == null ? '—' : W.fmtKg(left, state.unit, 1)) +
      (left == null ? '' : ' ' + u);

    $('statStart').textContent = s == null ? '—' : W.fmtKg(s, state.unit, 1) + ' ' + u;
    $('statGoal').textContent = g == null ? '—' : W.fmtKg(g, state.unit, 1) + ' ' + u;
    $('statLost').textContent = lost == null ? '—'
      : (lost >= 0 ? '' : '−') + W.fmtKg(Math.abs(lost), state.unit, 1) + ' ' + u;
    $('statLost').className = 'stat-value' + (lost > 0 ? ' good' : lost < 0 ? ' bad' : '');
    $('statLeft').textContent = left == null ? '—' : W.fmtKg(left, state.unit, 1) + ' ' + u;

    var note;
    if (!ctx.model) {
      note = '再多記錄幾天（至少 ' + W.FIT_MIN_POINTS + ' 筆、橫跨 ' + W.FIT_MIN_SPAN +
        ' 天），這裡會出現以近期為主的趨勢與節奏。';
      if (g == null) note += ' 目標體重可在右上角設定。';
    } else {
      /* Average pace of the fitted curve over the last week (or however much
         of the two-week fit window exists), so the copy matches the line. */
      var refT = Math.min(ctx.today, ctx.model.tRef);
      var back = Math.max(ctx.model.fitFrom, refT - 7);
      var spanD = refT - back;
      var weekly = spanD > 0.9
        ? (ctx.model.predictAt(refT) - ctx.model.predictAt(back)) / spanD * 7 : null;
      note = '依近兩週紀錄，近期約 <b>' + W.signedKg(weekly, state.unit, 2) + ' ' + u + ' / 週</b>。';
      if (weekly == null || Math.abs(weekly) < 0.01) {
        note += ' 資料太少或變化不明顯，再多記幾天更準。';
      } else if (ctx.outlook && ctx.outlook.reachable) {
        note += ' 若照近期逐漸放緩的節奏，約 ' + W.longDate(ctx.outlook.dateDays) + ' 接近目標，僅供參考。';
      } else if (ctx.outlook && ctx.outlook.reason === 'already-there') {
        note += ' 已經在目標範圍內了。';
      } else if (ctx.outlook && ctx.outlook.reason === 'no-decline') {
        note += ' 近期體重沒有下降（甚至上升），維持現況難以在目標日前達標。';
      } else if (ctx.outlook && ctx.outlook.reason === 'plateau') {
        note += ' 近期速度正逐漸放緩，照這條曲線可能到不了目標。';
      } else if (ctx.outlook) {
        note += ' 以近期節奏距目標仍很遠。';
      }
      if (ctx.traj && !ctx.model.provisional) {
        var diff = ctx.model.predictAt(ctx.today) - ctx.traj.at(ctx.today);
        if (diff > 0.2) note += ' 比理想進度多 ' + W.fmtKg(diff, state.unit, 1) + ' ' + u + '。';
        else if (diff < -0.2) note += ' 比理想進度少 ' + W.fmtKg(-diff, state.unit, 1) + ' ' + u + '。';
        else note += ' 與理想進度接近。';
      }
    }
    $('paceNote').innerHTML = note;
  }

  /* ------------------------------------------------------------- page two */

  function renderPage2(ctx) {
    var h = state.heightCm;
    var nowBmi = W.bmi(ctx.current, h);
    var goalBmi = W.bmi(state.goal.kg, h);
    var band = W.bmiBand(nowBmi);

    $('bmiNum').textContent = nowBmi == null ? '—' : nowBmi.toFixed(1);
    var pill = $('bmiBandLabel');
    pill.textContent = band.label;
    pill.className = 'band-pill ' + band.tone;

    function toPct(v) { return v == null ? -10 : W.clamp((v - 15) / 20 * 100, -2, 102); }
    $('bmiMarkerNow').style.left = toPct(nowBmi) + '%';
    $('bmiMarkerGoal').style.left = toPct(goalBmi) + '%';
    $('bmiMarkerNow').style.display = nowBmi == null ? 'none' : '';
    $('bmiMarkerGoal').style.display = goalBmi == null ? 'none' : '';

    var rows = '';
    rows += '<div class="bmi-legend-row"><span class="swatch" style="background:var(--ink)"></span>' +
      '<span class="lbl">現在</span><span class="tag">' + band.label + '</span>' +
      '<span class="val">' + (nowBmi == null ? '—' : nowBmi.toFixed(1)) + '</span></div>';
    var gBand = W.bmiBand(goalBmi);
    rows += '<div class="bmi-legend-row"><span class="swatch" style="border:2px solid var(--ink);background:transparent"></span>' +
      '<span class="lbl">目標體重對應</span><span class="tag">' + (goalBmi == null ? '未設定' : gBand.label) + '</span>' +
      '<span class="val">' + (goalBmi == null ? '—' : goalBmi.toFixed(1)) + '</span></div>';
    $('bmiLegend').innerHTML = rows;

    var note;
    if (!h) note = '還沒填身高。點右上角的設定鈕輸入一次，BMI 就會出現。';
    else if (nowBmi == null) note = '記錄第一筆體重後，這裡會顯示落在哪個區間。';
    else {
      var upperNormal = 24 * Math.pow(h / 100, 2);
      if (ctx.current > upperNormal) {
        note = '距離「正常」範圍還差約 <b>' + W.fmtKg(ctx.current - upperNormal, state.unit, 1) + ' ' + unit() + '</b>。';
      } else if (nowBmi < 18.5) {
        note = '目前低於正常範圍，設定目標時留意一下。';
      } else {
        note = '目前落在「正常」範圍內。';
      }
      if (state.goal.kg != null && W.bmi(state.goal.kg, h) < 18.5) {
        note += ' 目標體重對應的 BMI 偏低，可以再調整。';
      }
    }
    $('bmiNote').innerHTML = note;
  }

  /* ----------------------------------------------------------- page three */

  function chartLabel(x, y, txt, color, anchor) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + (anchor || 'end') +
      '" style="font-family:var(--font-mono);font-size:9px;fill:' + color +
      ';paint-order:stroke;stroke:var(--surface-2);stroke-width:3px;stroke-linejoin:round">' + esc(txt) + '</text>';
  }

  function axisDate(t, span) {
    var p = W.daysToParts(t);
    return span > 200 ? (p.y + '/' + p.m) : (p.m + '/' + p.d);
  }

  /* The visible x window is a function of the chosen range. "auto" hugs the
     data so a 7-day run is not squashed into the left 8% of a 90-day axis. */
  function chartWindow(ctx) {
    var e = ctx.entries;
    var first = e[0].t, last = e[e.length - 1].t;
    var dataSpan = last - first;
    var anchor = Math.max(ctx.today, last);
    var key = state.prefs.chartRange || 'auto';
    var hist, fc;

    /* 1週 / 1月 / 3月：前 : 後 比例約 1 : 0.5（如 1週 = 7 天前 : 3 天後）。
       "自動" 維持原邏輯：貼著資料收視窗。 */
    if (key === '1w') { hist = 7; fc = 3; }
    else if (key === '1m') { hist = 30; fc = 15; }
    else if (key === '3m') { hist = 90; fc = 45; }
    else {
      hist = Math.max(8, dataSpan + 2);
      fc = Math.max(5, Math.min(21, dataSpan * 0.35 + 4));
    }

    var xMin = anchor - hist;
    var xMax = anchor + fc;
    /* 目標日只延伸「自動」視窗；1週/1月/3月 嚴格遵守前:後 1:0.5 比例，
       不被遠方的目標日拉長（目標軌道線會在視窗內自然截斷）。 */
    if (ctx.targetDays && ctx.targetDays > anchor && key === 'auto' && ctx.traj) {
      xMax = Math.max(xMax, Math.min(ctx.targetDays, anchor + 365));
    }
    /* "自動" must never clip the first reading when the last one
       was logged a while ago and the window was measured back from today. */
    if (key === 'auto') xMin = Math.min(xMin, first - 1);
    if (last < xMin) xMin = last - 1;   /* never show a completely empty chart */
    return { xMin: xMin, xMax: xMax, span: xMax - xMin, anchor: anchor, key: key, fc: fc };
  }

  /* ---- chart camera (pan / pinch-zoom) -----------------------------------
     The SVG keeps a fixed 340x300 design viewBox. A "camera" maps a data window
     (cam.x, cam.w in days; cam.y, cam.h in kg) onto that box. Every data point
     is always drawn; panning/zooming only moves the window, so nothing is ever
     dropped. world holds the full data domain used to clamp the camera. */

  function niceDayStep(span) {
    var target = span / 5;
    var steps = [1, 2, 3, 5, 7, 10, 14, 21, 30, 60, 90, 120, 180, 365];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= target) return steps[i];
    return 365;
  }

  function worldBounds(ctx) {
    var e = ctx.entries;
    if (!e.length) return null;
    var first = e[0].t, last = e[e.length - 1].t;
    var xMin = first - 2, xMax = last + 2;
    if (ctx.model) xMax = Math.max(xMax, ctx.model.forecastTo);
    if (ctx.targetDays) xMax = Math.max(xMax, Math.min(ctx.targetDays, last + 365) + 2);
    var vals = e.map(function (p) { return p.kg; });
    if (ctx.goal.kg != null) vals.push(ctx.goal.kg);
    if (ctx.model) {
      vals.push(ctx.model.A);
      /* Only sample the curve where it is defined: from the 2-week fit window
         forward to the forecast cap. Extrapolating backwards would explode. */
      var qFrom = Math.max(ctx.model.fitFrom, xMin);
      var qTo = Math.min(ctx.model.forecastTo, xMax);
      if (qTo > qFrom) {
        for (var q = 0; q <= 32; q++) {
          var tq = qFrom + (qTo - qFrom) * q / 32;
          var pr = ctx.model.predictAt(tq);
          var hw = Math.min(5, ctx.model.halfWidthAt(tq));
          vals.push(pr, pr + hw, pr - hw);
        }
      }
    }
    if (ctx.traj) {
      for (var q2 = 0; q2 <= 24; q2++) {
        var tt = ctx.traj.startDays + (ctx.traj.targetDays - ctx.traj.startDays) * q2 / 24;
        if (tt >= xMin && tt <= xMax) vals.push(ctx.traj.at(tt));
      }
    }
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    var pad = (vmax - vmin) * 0.11; if (pad < 0.3) pad = 0.3;
    return { xMin: xMin, xMax: xMax, yMin: vmin - pad, yMax: vmax + pad,
             w: xMax - xMin, h: (vmax + pad) - (vmin - pad) };
  }

  /* auto-fit y for a given x window (replicates the old per-window y logic) */
  function fitY(ctx, xMin, xMax) {
    var e = ctx.entries;
    var visible = e.filter(function (p) { return p.t >= xMin - 0.001 && p.t <= xMax + 0.001; });
    var vals = visible.map(function (p) { return p.kg; });
    var model = ctx.model, useTrend = state.prefs.showTrend && !!model;
    var fEnd = Math.min(xMax, model ? model.forecastTo : xMax);
    var cFrom = useTrend ? Math.max(xMin, model.fitFrom) : xMin;
    if (useTrend && fEnd > cFrom) {
      for (var q = 0; q <= 32; q++) {
        var tq = cFrom + (fEnd - cFrom) * q / 32;
        var pred = model.predictAt(tq);
        var hw = Math.min(5, model.halfWidthAt(tq));
        vals.push(pred, pred + hw, pred - hw);
      }
    }
    if (ctx.traj) {
      for (var q2 = 0; q2 <= 24; q2++) {
        var tt = ctx.traj.startDays + (ctx.traj.targetDays - ctx.traj.startDays) * q2 / 24;
        if (tt >= xMin && tt <= xMax) vals.push(ctx.traj.at(tt));
      }
    }
    if (!vals.length) vals.push(e[e.length - 1].kg);
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    var span = xMax - xMin;
    var minRange = span > 120 ? 3 : span > 40 ? 2 : 1.2;
    if (vmax - vmin < minRange) { var mid = (vmax + vmin) / 2; vmin = mid - minRange / 2; vmax = mid + minRange / 2; }
    var baseRange = vmax - vmin;
    if (state.goal.kg != null && state.goal.kg >= vmin - baseRange * 0.55 &&
      state.goal.kg <= vmax + baseRange * 0.55) {
      vmin = Math.min(vmin, state.goal.kg); vmax = Math.max(vmax, state.goal.kg);
    }
    var pad = (vmax - vmin) * 0.11;
    return { yMin: vmin - pad, yMax: vmax + pad };
  }

  function defaultCamera(win) {
    var fy = fitY(chartCtx, win.xMin, win.xMax);
    return { x: win.xMin, w: win.span, y: fy.yMin, h: fy.yMax - fy.yMin, key: win.key };
  }

  /* Cheap content hash of the readings. When a record is added or edited the
     curve moves, so re-fit the camera instead of leaving the new forecast
     clipped by a view framed for the old one. Toggles/ranges keep the pan. */
  function chartSignature(ctx) {
    var h = 2166136261, i, j;
    for (i = 0; i < ctx.entries.length; i++) {
      var s = ctx.entries[i].date + ':' + ctx.entries[i].kg + ';';
      for (j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
    }
    return ctx.entries.length + ':' + (h >>> 0);
  }

  function clampCamera() {
    if (!world || !cam) return;
    cam.w = W.clamp(cam.w, 2, world.w);     /* zoom-in floor 2 days; zoom-out = all data */
    cam.h = W.clamp(cam.h, 0.8, world.h);
    cam.x = W.clamp(cam.x, world.xMin, world.xMax - cam.w);
    cam.y = W.clamp(cam.y, world.yMin, world.yMax - cam.h);
  }

  function buildChart(ctx, win, cam) {
    var e = ctx.entries;
    if (!e.length) {
      return '<div class="chart-empty"><strong>還沒有紀錄</strong>' +
        '<span>在下方輸入第一筆體重，走勢就會從這裡開始。</span></div>';
    }

    var L = CHART_L, R = CHART_R, T = CHART_T, B = CHART_B, VW = CHART_VW, VH = CHART_VH;
    var pw = CHART_PW, ph = CHART_PH;
    var xMin = cam.x, xMax = cam.x + cam.w;
    var yMin = cam.y, yMax = cam.y + cam.h;
    var lastT = e[e.length - 1].t;
    var model = ctx.model;
    var useTrend = state.prefs.showTrend && !!model;
    var fEnd = Math.min(xMax, model ? model.forecastTo : xMax);
    var cFrom = useTrend ? Math.max(xMin, model.fitFrom) : xMin;
    var spanX = Math.max(1, xMax - xMin);
    var spanY = Math.max(0.001, yMax - yMin);

    function X(t) { return L + (t - xMin) / spanX * pw; }
    function Y(kg) { return T + (yMax - kg) / spanY * ph; }
    function path(arr) {
      return arr.map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ');
    }

    var s = [];
    s.push('<svg viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="體重變化折線圖，含近兩週加權的指數衰減曲線與推估；可拖曳平移、雙指縮放">');
    s.push('<defs><clipPath id="wptPlotClip"><rect x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '"/></clipPath></defs>');
    s.push('<rect x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph +
      '" style="fill:var(--surface);opacity:.55" />');

    /* grid ticks: lines are clipped to the plot, labels sit in the margins */
    var yTicks = [], xTicks = [];
    var dMin = W.kgToUnit(yMin, state.unit), dMax = W.kgToUnit(yMax, state.unit);
    var step = W.niceStep((dMax - dMin) / 4);
    for (var v = Math.ceil(dMin / step) * step; v <= dMax + 1e-9; v += step) {
      var wv = W.unitToKg(v, state.unit);
      if (wv < yMin - 0.001 || wv > yMax + 0.001) continue;
      yTicks.push(wv);
    }
    var dx = niceDayStep(cam.w);
    for (var t0 = Math.ceil(xMin / dx) * dx; t0 <= xMax + 1e-9; t0 += dx) xTicks.push(t0);

    s.push('<g clip-path="url(#wptPlotClip)">');
    yTicks.forEach(function (wv) {
      var yy = Y(wv);
      s.push('<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (L + pw) + '" y2="' + yy.toFixed(1) +
        '" style="stroke:var(--line);stroke-width:1" />');
    });
    xTicks.forEach(function (tt) {
      var xx = X(tt);
      s.push('<line x1="' + xx.toFixed(1) + '" y1="' + T + '" x2="' + xx.toFixed(1) + '" y2="' + (T + ph) +
        '" style="stroke:var(--line);stroke-width:1;opacity:.6" />');
    });

    /* today marker */
    if (ctx.today >= xMin && ctx.today <= xMax) {
      var tx = X(ctx.today);
      s.push('<line x1="' + tx.toFixed(1) + '" y1="' + T + '" x2="' + tx.toFixed(1) + '" y2="' + (T + ph) +
        '" style="stroke:var(--line-strong);stroke-width:1;stroke-dasharray:3 4" />');
      s.push(chartLabel(tx - 3, T + 9, '今天', 'var(--muted)', 'end'));
    }

    /* goal weight */
    if (state.goal.kg != null && state.goal.kg > yMin && state.goal.kg < yMax) {
      var gy = Y(state.goal.kg);
      s.push('<line x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (L + pw) + '" y2="' + gy.toFixed(1) +
        '" style="stroke:var(--clay);stroke-width:1;stroke-dasharray:2 5;opacity:.7" />');
      s.push(chartLabel(L + pw - 2, gy - 5, '目標 ' + W.fmtKg(state.goal.kg, state.unit, 1), 'var(--clay)'));
    }

    /* uncertainty band behind the trend */
    if (useTrend && fEnd > cFrom) {
      var up = [], dn = [];
      for (var b = 0; b <= 40; b++) {
        var tb = cFrom + (Math.min(fEnd, xMax) - cFrom) * b / 40;
        var pb = model.predictAt(tb);
        var hb = Math.min(5, model.halfWidthAt(tb));
        up.push([tb, pb + hb]); dn.push([tb, pb - hb]);
      }
      s.push('<polygon points="' + path(up) + ' ' + path(dn.slice().reverse()) +
        '" style="fill:var(--curve);opacity:.09" />');
    }

    /* prescriptive path, only when a target date exists */
    if (ctx.traj) {
      var tr = [];
      for (var g2 = 0; g2 <= 40; g2++) {
        var tg = ctx.traj.startDays + (ctx.traj.targetDays - ctx.traj.startDays) * g2 / 40;
        if (tg >= xMin && tg <= xMax) tr.push([tg, ctx.traj.at(tg)]);
      }
      if (tr.length > 1) {
        s.push('<polyline points="' + path(tr) + '" fill="none" ' +
          'style="stroke:var(--clay);stroke-width:1.3;stroke-dasharray:7 5;opacity:.7" />');
      }
    }

    /* 7-day smoothing (whole series; clipped to the window) */
    if (state.prefs.showSmooth && ctx.smooth.length > 1) {
      var ep = ctx.smooth.map(function (p) { return [p.t, p.kg]; });
      s.push('<polyline points="' + path(ep) + '" fill="none" ' +
        'style="stroke:var(--accent);stroke-width:1.7;stroke-linejoin:round;opacity:.9" />');
    }

    /* fitted curve: solid over history, dashed into the future */
    if (useTrend) {
      var solidEnd = Math.min(lastT, xMax);
      if (solidEnd > cFrom) {
        var hist = [];
        for (var h2 = 0; h2 <= 50; h2++) {
          var th = cFrom + (solidEnd - cFrom) * h2 / 50;
          hist.push([th, model.predictAt(th)]);
        }
        s.push('<polyline points="' + path(hist) + '" fill="none" ' +
          'style="stroke:var(--curve);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round" />');
      }
      if (fEnd > solidEnd) {
        var fc = [];
        for (var f2 = 0; f2 <= 30; f2++) {
          var tf = solidEnd + (fEnd - solidEnd) * f2 / 30;
          fc.push([tf, model.predictAt(tf)]);
        }
        s.push('<polyline points="' + path(fc) + '" fill="none" ' +
          'style="stroke:var(--forecast);stroke-width:2;stroke-dasharray:5 5;stroke-linecap:round" />');
      }
    }

    /* raw readings (whole series; clipped to the window) */
    var raw = e.map(function (p) { return [p.t, p.kg]; });
    if (raw.length > 1) {
      s.push('<polyline points="' + path(raw) + '" fill="none" ' +
        'style="stroke:var(--ink-2);stroke-width:1.1;stroke-linejoin:round;opacity:.45" />');
    }
    e.forEach(function (p) {
      s.push('<circle cx="' + X(p.t).toFixed(1) + '" cy="' + Y(p.kg).toFixed(1) + '" r="1.9" ' +
        'style="fill:var(--ink);opacity:.6" />');
    });

    s.push('</g>');

    /* axis labels in the margins (unclipped) */
    yTicks.forEach(function (wv) {
      var yy = Y(wv);
      var disp = W.kgToUnit(wv, state.unit);
      s.push('<text x="' + (L - 6) + '" y="' + (yy + 3.2).toFixed(1) + '" text-anchor="end" ' +
        'style="font-family:var(--font-mono);font-size:9px;fill:var(--muted)">' +
        (step < 1 ? disp.toFixed(1) : Math.round(disp)) + '</text>');
    });
    xTicks.forEach(function (tt) {
      var xx = X(tt);
      var anchor = (tt <= xMin + 0.5) ? 'start' : (tt >= xMax - 0.5) ? 'end' : 'middle';
      s.push('<text x="' + xx.toFixed(1) + '" y="' + (T + ph + 15) + '" text-anchor="' + anchor +
        '" style="font-family:var(--font-mono);font-size:9px;fill:var(--muted)">' +
        axisDate(tt, cam.w) + '</text>');
    });

    s.push('</svg>');
    return s.join('');
  }

  function rerenderChart() {
    if (!chartCtx || !chartWin || !cam || !world) return;
    clampCamera();
    $('chartHost').innerHTML = buildChart(chartCtx, chartWin, cam);
    $('chartRange').textContent = axisDate(cam.x, cam.w) + ' — ' + axisDate(cam.x + cam.w, cam.w);
    var ent = chartCtx.entries;
    var vis = ent.filter(function (p) { return p.t >= cam.x - 0.001 && p.t <= cam.x + cam.w + 0.001; }).length;
    $('chartCount').textContent = (vis < ent.length ? vis + ' / ' + ent.length : ent.length) + ' 筆';
  }

  /* ----------------------------------------------------- pan / zoom input */

  function chartGeom() { return $('chartHost').getBoundingClientRect(); }
  function toDesign(ev) {
    var r = chartGeom();
    return { x: (ev.clientX - r.left) / r.width * CHART_VW, y: (ev.clientY - r.top) / r.height * CHART_VH };
  }
  function pdist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function pmid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function scheduleRerender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; rerenderChart(); });
  }
  function panBy(dxD, dyD) {
    if (!cam) return;
    cam.x -= dxD / CHART_PW * cam.w;
    cam.y += dyD / CHART_PH * cam.h;
    clampCamera();
    scheduleRerender();
  }
  function zoomAt(dx, dy, factor) {
    if (!cam || !world) return;
    var newW = W.clamp(cam.w * factor, 2, world.w);
    var newH = W.clamp(cam.h * factor, 0.8, world.h);
    var fx = cam.x + (dx - CHART_L) / CHART_PW * cam.w;
    var fy = cam.y + cam.h - (dy - CHART_T) / CHART_PH * cam.h;
    cam.w = newW; cam.h = newH;
    cam.x = fx - (dx - CHART_L) / CHART_PW * cam.w;
    cam.y = fy - cam.h + (dy - CHART_T) / CHART_PH * cam.h;
    clampCamera();
    scheduleRerender();
  }
  function onChartDown(ev) {
    if (!cam || !world) return;
    ev.preventDefault();
    try { $('chartHost').setPointerCapture(ev.pointerId); } catch (e) {}
    var d = toDesign(ev);
    panPts[ev.pointerId] = d;
    var ids = Object.keys(panPts);
    if (ids.length === 1) { panLast = d; pinchPrev = null; }
    else if (ids.length === 2) {
      var a = panPts[ids[0]], b = panPts[ids[1]];
      pinchPrev = { dist: pdist(a, b), m: pmid(a, b) };
      panLast = null;
    }
  }
  function onChartMove(ev) {
    if (!cam || !world || !(ev.pointerId in panPts)) return;
    ev.preventDefault();
    var d = toDesign(ev);
    panPts[ev.pointerId] = d;
    var ids = Object.keys(panPts);
    if (ids.length === 1) {
      if (panLast) { panBy(d.x - panLast.x, d.y - panLast.y); panLast = d; }
    } else if (ids.length === 2) {
      var a = panPts[ids[0]], b = panPts[ids[1]];
      var dd = pdist(a, b), m = pmid(a, b);
      if (pinchPrev) {
        var scale = dd / pinchPrev.dist;            /* >1 = fingers apart = zoom in */
        cam.w = W.clamp(cam.w / scale, 2, world.w);
        cam.h = W.clamp(cam.h / scale, 0.8, world.h);
        var fx = cam.x + (m.x - CHART_L) / CHART_PW * cam.w;
        var fy = cam.y + cam.h - (m.y - CHART_T) / CHART_PH * cam.h;
        cam.x = fx - (m.x - CHART_L) / CHART_PW * cam.w;
        cam.y = fy - cam.h + (m.y - CHART_T) / CHART_PH * cam.h;
        /* pan by midpoint movement too */
        cam.x -= (m.x - pinchPrev.m.x) / CHART_PW * cam.w;
        cam.y += (m.y - pinchPrev.m.y) / CHART_PH * cam.h;
        clampCamera();
        scheduleRerender();
      }
      pinchPrev = { dist: dd, m: m };
    }
  }
  function onChartUp(ev) {
    delete panPts[ev.pointerId];
    var ids = Object.keys(panPts);
    if (ids.length === 1) { panLast = panPts[ids[0]]; pinchPrev = null; }
    else { panLast = null; pinchPrev = null; }
  }
  function onChartWheel(ev) {
    if (!cam || !world) return;
    ev.preventDefault();
    var d = toDesign(ev);
    zoomAt(d.x, d.y, ev.deltaY < 0 ? 0.88 : 1 / 0.88);
  }

  function renderPage3(ctx) {
    var u = unit();
    $('deltaRow').innerHTML = ctx.deltas.map(function (d) {
      var cls = 'none', txt = '—';
      if (d.value != null && isFinite(d.value)) {
        txt = W.signedKg(d.value, state.unit, 1);
        cls = d.value < -0.05 ? 'down' : d.value > 0.05 ? 'up' : '';
      }
      return '<div class="delta-cell"><span class="dl">' + esc(d.label) + '</span>' +
        '<span class="dv ' + cls + '">' + txt + '</span><span class="du">' + u + '</span></div>';
    }).join('');

    $('rangeRow').innerHTML = RANGES.map(function (r) {
      return '<button type="button" class="range-btn' + (state.prefs.chartRange === r.key ? ' on' : '') +
        '" data-range="' + r.key + '" aria-pressed="' + (state.prefs.chartRange === r.key) + '">' +
        r.label + '</button>';
    }).join('');

    chartCtx = ctx;
    var sig = chartSignature(ctx);
    var dataChanged = (chartSig !== null && sig !== chartSig);
    chartSig = sig;
    if (!ctx.entries.length) {
      world = null; cam = null; chartWin = null;
      $('chartRange').textContent = '—';
      $('chartCount').textContent = '0 筆';
      $('chartHost').innerHTML = '<div class="chart-empty"><strong>還沒有紀錄</strong><span>在下方輸入第一筆體重，走勢就會從這裡開始。</span></div>';
    } else {
      var win = chartWindow(ctx);
      chartWin = win;
      world = worldBounds(ctx);
      if (!cam || cam.key !== win.key || dataChanged) cam = defaultCamera(win);
      else clampCamera();
      rerenderChart();
    }

    var legend = [];
    legend.push('<span><i class="swatch-dot" style="background:var(--ink)"></i>實測</span>');
    if (state.prefs.showTrend && ctx.model) {
      legend.push('<span><i style="border-color:var(--curve)"></i>趨勢</span>');
      legend.push('<span><i class="dash" style="border-color:var(--forecast)"></i>推估</span>');
    }
    if (state.prefs.showSmooth) legend.push('<span><i style="border-color:var(--accent)"></i>平滑線</span>');
    if (ctx.traj) legend.push('<span><i class="dash" style="border-color:var(--clay)"></i>目標軌道</span>');
    $('chartLegend').innerHTML = legend.join('');

    /* Only surface a toggle when its line can actually be drawn. The trend line
       needs a valid fit (fitAsymptotic returns null on too little data);
       the smoothing needs at least two points or it draws nothing. */
    var tq = '';
    if (ctx.model) {
      tq += '<button type="button" class="qtoggle' + (state.prefs.showTrend ? ' on' : '') +
        '" data-toggle="showTrend" role="switch" aria-checked="' + state.prefs.showTrend +
        '"><span>近期趨勢線</span><span class="mini-switch"><i></i></span></button>';
    }
    if (ctx.smooth.length > 1) {
      tq += '<button type="button" class="qtoggle' + (state.prefs.showSmooth ? ' on' : '') +
        '" data-toggle="showSmooth" role="switch" aria-checked="' + state.prefs.showSmooth +
        '"><span>平滑線</span><span class="mini-switch"><i></i></span></button>';
    }
    var qt = $('quickToggles');
    qt.innerHTML = tq;
    qt.hidden = !tq;

  }

  /* -------------------------------------------------------------- dock/dots */

  function dockDate() { return $('entryDate').value || W.todayIso(); }

  function entryFor(date) {
    var found = null;
    state.entries.forEach(function (e) { if (e.date === date) found = e; });
    return found;
  }

  /* Four explicit states, plus the natural "past date with no record" variant:
     first / new-today / update-today / update-old / new-old. Only the button
     label, the value and the placeholder express the state; the selected date
     is authoritative and renderAll() must never reset it. */
  function renderDock(opts) {
    opts = opts || {};
    var date = dockDate();
    var rec = entryFor(date);
    var isToday = date === W.todayIso();
    var hasAny = state.entries.length > 0;
    var lastEntry = hasAny ? state.entries[state.entries.length - 1] : null;

    var mode;
    if (!hasAny) mode = 'first';
    else if (rec && isToday) mode = 'update-today';
    else if (rec) mode = 'update-old';
    else if (isToday) mode = 'new-today';
    else mode = 'new-old';

    $('recordBtn').textContent =
      mode.indexOf('update') === 0 ? '更新' : mode === 'new-old' ? '補登' : '記錄';
    $('recordBtn').dataset.mode = mode;
    $('weightUnitSuffix').textContent = unit();
    var dlbl = $('entryDateLabel');
    if (dlbl) dlbl.textContent = W.fmtDateLabel(date);
    /* Selected-date hint: the placeholder shows that day's own recorded
       weight when one exists; when the date has no entry ("not available")
       it falls back to a bare dash. */
    $('weightInput').placeholder = rec ? W.fmtKg(rec.kg, state.unit, 1) : '—';
    if (opts.keepValue) {
      /* unit / range / pref changes: leave the typed value untouched */
    } else if (opts.select) {
      /* selecting a date: clear the field and let the placeholder surface
         that day's recorded weight */
      $('weightInput').value = '';
    } else {
      $('weightInput').value = rec ? W.kgToUnit(rec.kg, state.unit).toFixed(1) : '';
    }
  }

  function updateDots() {
    var dots = document.querySelectorAll('#dots .dot');
    for (var i = 0; i < dots.length; i++) {
      var on = i === ui.page;
      dots[i].classList.toggle('on', on);
      if (on) dots[i].setAttribute('aria-current', 'true');
      else dots[i].removeAttribute('aria-current');
    }
    $('pageIndex').textContent = '0' + (ui.page + 1) + ' / 03';
    $('brandName').textContent = PAGE_NAMES[ui.page];
  }

  function goPage(i) {
    ui.page = W.clamp(i, 0, 2);
    $('pages').scrollTo({ left: ui.page * $('pages').clientWidth, behavior: 'smooth' });
    updateDots();
  }

  function renderAll(opts) {
    var ctx = buildCtx();
    renderPage1(ctx);
    renderPage2(ctx);
    renderPage3(ctx);
    renderDock(opts);
    updateDots();
  }

  /* -------------------------------------------------------- settings sheet */

  function fNum(label, key, val, suffix, extra) {
    return '<div class="field"><label>' + label + '</label><div class="field-input">' +
      '<input type="number" data-k="' + key + '" value="' + (val == null ? '' : val) + '" ' + (extra || 'step="0.1"') + '>' +
      '<span>' + suffix + '</span></div></div>';
  }

  function fDate(label, key, val) {
    var txt = val ? W.fmtDateLabel(val) : '選擇日期';
    return '<div class="field"><label>' + label + '</label><div class="field-input">' +
      '<input type="date" data-k="' + key + '" value="' + (val || '') + '" hidden>' +
      '<button type="button" class="date-trigger sm' + (val ? '' : ' empty') + '" data-datefor="' + key + '" aria-label="' + label + '">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.2" y="4.5" width="17.6" height="16.5" rx="2.4"/><path d="M3.2 9h17.6M8 2.6v3.8M16 2.6v3.8"/></svg>' +
      '<span class="dt-label">' + txt + '</span></button></div></div>';
  }

  function renderSettings() {
    var u = unit();
    var kg = function (v) { return v == null ? '' : W.kgToUnit(v, state.unit).toFixed(1); };
    var h = [];

    h.push('<div class="set-section"><p class="set-title">顯示單位</p>' +
      '<div class="segmented">' +
      '<button type="button" data-unit="kg" class="' + (state.unit === 'kg' ? 'on' : '') + '">公斤 kg</button>' +
      '<button type="button" data-unit="lb" class="' + (state.unit === 'lb' ? 'on' : '') + '">磅 lb</button>' +
      '</div></div>');

    h.push('<div class="set-section"><p class="set-title">基本資料</p>' +
      fNum('身高', 'heightCm', state.heightCm == null ? '' : state.heightCm, 'cm', 'step="0.5" min="80" max="250"') +
      '</div>');

    h.push('<div class="set-section"><p class="set-title">目標</p>' +
      fNum('目標體重', 'goal.kg', kg(state.goal.kg), u) +
      fDate('目標日期', 'goal.targetDate', state.goal.targetDate) +
      '<p class="field-note">目標日期可以留空，填了會多一條理想進度線。' +
      ' <button type="button" class="link-btn" data-action="clearGoalDate">清除日期</button></p></div>');

    var recs = state.entries.slice().reverse();
    h.push('<div class="set-section">');
    h.push('<div class="set-head"><p class="set-title">紀錄 · ' + recs.length + ' 筆</p>' +
      '<button type="button" class="fill-toggle' + (state.prefs.autoFillGaps ? ' on' : '') +
      '" data-toggle="autoFillGaps" role="switch" aria-checked="' + state.prefs.autoFillGaps +
      '"><span class="ft-label">自動補齊</span><span class="mini-switch"><i></i></span></button></div>');
    if (!recs.length) {
      h.push('<p class="rec-empty">還沒有紀錄。同一天再記一次會覆蓋前一次。</p>');
    } else {
      h.push('<div class="rec-list">');
      recs.slice(0, 40).forEach(function (e) {
        h.push('<div class="rec-row"><span class="rd">' + esc(e.date) + '</span>' +
          '<span class="rv">' + W.fmtKg(e.kg, state.unit, 1) + ' ' + u + '</span>' +
          '<button type="button" data-del="' + esc(e.date) + '" aria-label="刪除 ' + esc(e.date) + ' 的紀錄">×</button></div>');
      });
      h.push('</div>');
    }
    h.push('</div>');

    h.push('<div class="set-section"><p class="set-title">資料</p><div class="action-grid">' +
      '<button type="button" class="action-btn danger" data-action="clear">清除全部資料</button>' +
      '</div></div>');

    $('sheetBody').innerHTML = h.join('');
    ui.confirmClear = false;
  }

  function openSheet() {
    renderSettings();
    $('sheetLayer').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('closeSettings').focus(); }, 50);
  }

  function closeSheet() {
    $('sheetLayer').hidden = true;
    document.body.style.overflow = '';
    $('openSettings').focus();
  }

  /* --------------------------------------------------- onboarding modal
     Shown once on boot when the profile is incomplete (no height or no goal
     weight). Every field is optional: submit saves only the filled ones, and
     when nothing is filled the button doubles as "略過". */

  var ONBOARD_IDS = ['obHeight', 'obWeight', 'obGoal', 'obDate'];

  function openOnboard() {
    $('obWeightUnit').textContent = unit();
    $('obGoalUnit').textContent = unit();
    ONBOARD_IDS.forEach(function (id) { $(id).value = ''; });
    $('onboardLayer').hidden = false;
    refreshOnboardBtn();
    setTimeout(function () { $('obHeight').focus(); }, 60);
  }

  function closeOnboard() {
    $('onboardLayer').hidden = true;
  }

  function refreshOnboardBtn() {
    var any = ONBOARD_IDS.some(function (id) {
      var v = $(id).value;
      return v != null && String(v).trim() !== '';
    });
    var btn = $('onboardBtn');
    btn.textContent = any ? '送出' : '略過';
    btn.classList.toggle('skip', !any);
  }

  function submitOnboard() {
    var any = false;
    var u = state.unit;

    var h = parseFloat($('obHeight').value);
    if (isFinite(h) && h >= 80 && h <= 250) { state.heightCm = h; any = true; }

    var w = W.unitToKg(parseFloat($('obWeight').value), u);
    if (isFinite(w) && w >= 15 && w <= 300) {
      var date = W.todayIso();
      var ex = entryFor(date);
      if (ex) ex.kg = Math.round(w * 100) / 100;
      else {
        state.entries.push({ date: date, kg: Math.round(w * 100) / 100 });
        state.entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      }
      any = true;
    }

    var g = W.unitToKg(parseFloat($('obGoal').value), u);
    if (isFinite(g) && g >= 15 && g <= 300) {
      state.goal.kg = g;
      if (state.goal.setDate == null) state.goal.setDate = W.todayIso();
      any = true;
    }

    var d = $('obDate').value;
    if (d != null && String(d).trim() !== '') {
      state.goal.targetDate = String(d).slice(0, 10);
      any = true;
    }

    if (any) { save(); renderAll(); }
    closeOnboard();
  }

  /* --------------------------------------------------------------- actions */

  function addEntry() {
    var raw = parseFloat($('weightInput').value);
    var kg = W.unitToKg(raw, state.unit);
    if (!isFinite(kg) || kg < 15 || kg > 300) {
      toast('請輸入有效體重');
      $('weightInput').focus();
      return;
    }
    kg = Math.round(kg * 100) / 100;
    var date = $('entryDate').value || W.todayIso();
    var existing = entryFor(date);
    if (existing) existing.kg = kg;
    else state.entries.push({ date: date, kg: kg });
    state.entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    if (state.goal.setDate == null) state.goal.setDate = W.todayIso();

    save();
    /* Deliberately no date reset here: editing an old day must keep that day
       selected, with its newly saved value shown. */
    renderAll();
    var btn = $('recordBtn');
    btn.classList.remove('saved');
    void btn.offsetWidth;
    btn.classList.add('saved');
    toast((existing ? '已更新 ' : '已記錄 ') + W.shortDate(W.isoToDays(date)) + ' · ' +
      W.fmtKg(kg, state.unit, 1) + ' ' + unit());
  }

  function clearAll() {
    state = blankState(state);
    $('entryDate').value = W.todayIso();
    save();
    renderAll();
    renderSettings();
    toast('已清除，開始記錄吧');
  }

  function handleAction(action, btn) {
    if (action === 'clearGoalDate') {
      state.goal.targetDate = null;
      save(); renderAll(); renderSettings();
      toast('已清除目標日期，其他功能照常');
    } else if (action === 'clear') {
      if (!ui.confirmClear) {
        ui.confirmClear = true;
        btn.textContent = '再按一次，確認清除';
        toast('這會刪掉所有紀錄，無法復原');
      } else {
        clearAll();
      }
    }
  }

  function togglePref(key) {
    if (key === 'autoFillGaps') {
      state.prefs.autoFillGaps = !state.prefs.autoFillGaps;
      save();
      if (state.prefs.autoFillGaps) autoFillGaps();
      renderAll({ keepValue: true });
      renderSettings();
      return;
    }
    if (key !== 'showTrend' && key !== 'showSmooth') return;
    state.prefs[key] = !state.prefs[key];
    save();
    renderAll({ keepValue: true });
  }

  /* ---------------------------------------------------------------- events */

  function bind() {
    $('openSettings').addEventListener('click', openSheet);
    $('closeSettings').addEventListener('click', closeSheet);
    $('sheetBackdrop').addEventListener('click', closeSheet);
    $('recordBtn').addEventListener('click', addEntry);

    $('onboardClose').addEventListener('click', closeOnboard);
    $('onboardBackdrop').addEventListener('click', closeOnboard);
    $('onboardBtn').addEventListener('click', submitOnboard);
    ONBOARD_IDS.forEach(function (id) {
      $(id).addEventListener('input', refreshOnboardBtn);
    });
    $('weightInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); addEntry(); }
    });
    /* Selecting a date clears the field and shows that day's recorded weight
       as a placeholder (empty when the date has no entry). */
    $('entryDate').addEventListener('change', function () {
      renderDock({ select: true });
    });

    /* Custom date picker — replaces the three native <input type=date> controls
       (dock entry date, onboarding goal date, settings goal date) with one
       phone-friendly calendar sheet. */
    function openPicker(o) { if (W.openDatePicker) W.openDatePicker(o); }
    function entryPresets() {
      var t = W.todayIso();
      return [
        { label: '今天', iso: t },
        { label: '昨天', iso: W.addDaysISO(t, -1) },
        { label: '前天', iso: W.addDaysISO(t, -2) },
        { label: '一週前', iso: W.addDaysISO(t, -7) }
      ];
    }
    function goalPresets() {
      var t = W.todayIso();
      return [
        { label: '一個月後', iso: W.addDaysISO(t, 30) },
        { label: '三個月後', iso: W.addDaysISO(t, 90) },
        { label: '半年後', iso: W.addDaysISO(t, 182) },
        { label: '一年後', iso: W.addDaysISO(t, 365) }
      ];
    }

    var entryTrigger = $('entryDateTrigger');
    if (entryTrigger) entryTrigger.addEventListener('click', function () {
      openPicker({
        value: $('entryDate').value || W.todayIso(),
        max: W.todayIso(),
        presets: entryPresets(),
        title: '選擇紀錄日期',
        onConfirm: function (v) { $('entryDate').value = v; renderDock({ select: true }); }
      });
    });

    var obTrigger = $('obDateTrigger');
    if (obTrigger) obTrigger.addEventListener('click', function () {
      openPicker({
        value: $('obDate').value || '',
        min: W.todayIso(),
        presets: goalPresets(),
        title: '選擇目標日期',
        onConfirm: function (v) {
          $('obDate').value = v;
          var lbl = $('obDateLabel'); if (lbl) lbl.textContent = W.fmtDateLabel(v);
        }
      });
    });

    $('sheetBody').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-datefor]');
      if (!b) return;
      var key = b.getAttribute('data-datefor');
      var hidden = $('sheetBody').querySelector('input[data-k="' + key + '"]');
      var cur = hidden ? hidden.value : '';
      openPicker({
        value: cur || '',
        min: key === 'goal.targetDate' ? W.todayIso() : null,
        presets: goalPresets(),
        title: '選擇目標日期',
        onConfirm: function (v) {
          if (hidden) { hidden.value = v; hidden.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      });
    });

    $('pages').addEventListener('scroll', function () {
      var i = Math.round($('pages').scrollLeft / Math.max(1, $('pages').clientWidth));
      if (i !== ui.page) { ui.page = W.clamp(i, 0, 2); updateDots(); }
    });
    $('dots').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-page]');
      if (b) goPage(parseInt(b.getAttribute('data-page'), 10));
    });

    $('rangeRow').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-range]');
      if (!b) return;
      state.prefs.chartRange = b.getAttribute('data-range');
      save();
      renderAll({ keepValue: true });
    });
    $('quickToggles').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-toggle]');
      if (b) togglePref(b.getAttribute('data-toggle'));
    });

    $('sheetBody').addEventListener('change', function (ev) {
      var el = ev.target, key = el.getAttribute && el.getAttribute('data-k');
      if (!key) return;
      var val = el.value;
      if (key === 'goal.targetDate') {
        setByPath(state, key, val || null);
      } else if (key === 'goal.kg') {
        var n = parseFloat(val);
        var kg = isFinite(n) ? W.unitToKg(n, state.unit) : null;
        if (kg != null && (kg < 15 || kg > 300)) kg = null;
        setByPath(state, key, kg);
        if (kg != null && state.goal.setDate == null) state.goal.setDate = W.todayIso();
      } else {
        var m = parseFloat(val);
        setByPath(state, key, isFinite(m) ? m : null);
      }
      save();
      renderAll({ keepValue: true });
      renderSettings();
    });

    $('sheetBody').addEventListener('click', function (ev) {
      var t = ev.target;
      var tog = t.closest('[data-toggle]');
      if (tog) { togglePref(tog.getAttribute('data-toggle')); return; }
      var uBtn = t.closest('[data-unit]');
      if (uBtn) {
        var oldUnit = state.unit;
        var typed = parseFloat($('weightInput').value);
        state.unit = uBtn.getAttribute('data-unit');
        save(); renderAll(); renderSettings();
        if (isFinite(typed)) {
          $('weightInput').value = W.kgToUnit(W.unitToKg(typed, oldUnit), state.unit).toFixed(1);
        }
        return;
      }
      var del = t.closest('[data-del]');
      if (del) {
        var d = del.getAttribute('data-del');
        state.entries = state.entries.filter(function (e) { return e.date !== d; });
        save(); renderAll(); renderSettings();
        toast('已刪除 ' + d);
        return;
      }
      var act = t.closest('[data-action]');
      if (act) handleAction(act.getAttribute('data-action'), act);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('onboardLayer').hidden) { closeOnboard(); return; }
      if (ev.key === 'Escape' && !$('sheetLayer').hidden) { closeSheet(); return; }
      if ($('sheetLayer').hidden && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        var tag = ev.target && ev.target.tagName;
        if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
        goPage(ui.page + (ev.key === 'ArrowRight' ? 1 : -1));
      }
    });

    /* chart pan / pinch-zoom (touch + mouse). touch-action:none on the host
       lets us own the gestures instead of the page swiper. */
    var chost = $('chartHost');
    chost.addEventListener('pointerdown', onChartDown);
    chost.addEventListener('pointermove', onChartMove);
    chost.addEventListener('pointerup', onChartUp);
    chost.addEventListener('pointercancel', onChartUp);
    chost.addEventListener('wheel', onChartWheel, { passive: false });

    window.addEventListener('resize', function () {
      $('pages').scrollLeft = ui.page * $('pages').clientWidth;
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    state = load();
    if (!state) { state = blankState(null); save(); }
    autoFillGaps();
    $('entryDate').value = W.todayIso();
    $('entryDate').max = W.todayIso();
    bind();
    renderAll();

    /* Optional deep link: #0 / #1 / #2 opens a page, #settings opens the sheet. */
    var hash = (location.hash || '').replace('#', '');
    if (hash === 'settings') {
      setTimeout(openSheet, 80);
    } else if (hash !== '') {
      var p = parseInt(hash, 10);
      if (isFinite(p)) ui.page = W.clamp(p, 0, 2);
    }
    requestAnimationFrame(function () {
      var p = $('pages');
      p.style.scrollBehavior = 'auto';
      p.scrollLeft = ui.page * p.clientWidth;
      updateDots();
      requestAnimationFrame(function () { p.style.scrollBehavior = ''; });
    });

    /* Prompt for the basics the first time the profile is incomplete
       (missing height or goal weight). No field is required. */
    if (state.heightCm == null || state.goal.kg == null) {
      setTimeout(openOnboard, 420);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
