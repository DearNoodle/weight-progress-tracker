/* weight-progress-tracker / model.js
   Pure math. No DOM, no storage, no side effects.
   Exposed as window.WPT so the page also works from file:// without modules. */
(function (global) {
  'use strict';

  var LB_PER_KG = 2.2046226218;
  var DAY_MS = 86400000;
  /* Single source of truth for the localStorage key, shared by app.js and the
     optional test-only mock loader. */
  var STORAGE_KEY = 'wpt.v1';

  /* A fitted curve is useful as soon as there is a short run of readings.
     Sparse fits are flagged "provisional" so the UI can be honest about them,
     instead of silently hiding the line for the first two weeks. */
  var FIT_MIN_POINTS = 4;
  var FIT_MIN_SPAN = 3;

  /* Trend / forecast tuning. Only the most recent two weeks may vote at all;
     inside that window an exponential recency kernel plus a smooth taper to
     zero at the boundary makes the closest few days dominate. The fitted
     shape is an exponential relaxation, so the forecast bends and eases into
     a plateau rather than running downhill as a straight line forever. */
  var FIT_LOOKBACK_DAYS = 14;
  var FIT_HALF_LIFE_DAYS = 3;
  var FIT_TAU_PRIOR_DAYS = 70;      /* default decay time constant, days */
  var FIT_TAU_MIN_DAYS = 25;
  var FIT_TAU_MAX_DAYS = 210;
  var FIT_FORECAST_DAYS = 180;      /* cap on forward extrapolation */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Dates are pure UTC calendar days (integer day numbers), so daylight
     saving and time zones can never shift an entry by a day. */
  function isoToDays(s) {
    if (!s) return NaN;
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3) return NaN;
    var y = +p[0], m = +p[1], d = +p[2];
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return NaN;
    return Date.UTC(y, m - 1, d) / DAY_MS;
  }

  function daysToIso(n) {
    var d = new Date(Math.round(n) * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function daysToParts(n) {
    var d = new Date(Math.round(n) * DAY_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayDays() { return isoToDays(todayIso()); }

  function shortDate(n) {
    var p = daysToParts(n);
    return p.m + '/' + p.d;
  }

  function longDate(n) {
    var p = daysToParts(n);
    return p.y + '/' + pad2(p.m) + '/' + pad2(p.d);
  }

  function kgToUnit(kg, unit) { return unit === 'lb' ? kg * LB_PER_KG : kg; }
  function unitToKg(v, unit) { return unit === 'lb' ? v / LB_PER_KG : v; }
  function unitLabel(unit) { return unit === 'lb' ? 'lb' : 'kg'; }

  function fmtKg(kg, unit, digits) {
    if (kg == null || !isFinite(kg)) return '—';
    return kgToUnit(kg, unit).toFixed(digits == null ? 1 : digits);
  }

  function signedKg(kg, unit, digits) {
    if (kg == null || !isFinite(kg)) return '—';
    var v = kgToUnit(kg, unit);
    var d = digits == null ? 1 : digits;
    if (Math.abs(v) < Math.pow(10, -d) / 2) return (0).toFixed(d);
    return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);
  }

  function bmi(kg, heightCm) {
    if (kg == null || !heightCm || heightCm <= 0) return null;
    var m = heightCm / 100;
    return kg / (m * m);
  }

  function bmiBand(v) {
    if (v == null || !isFinite(v)) return { key: 'none', label: '—', tone: 'muted' };
    if (v < 18.5) return { key: 'under', label: '過輕', tone: 'blue' };
    if (v < 24) return { key: 'normal', label: '正常', tone: 'green' };
    if (v < 27) return { key: 'over', label: '過重', tone: 'amber' };
    return { key: 'obese', label: '肥胖', tone: 'clay' };
  }

  /* Non-lagging 7-day smoothing on real calendar days.
     A causal EWMA (alpha = 1 - exp(-dt/7) ~= 0.133 for daily readings) only
     absorbs 13% of each new value, so on a short run it floats several kg
     above the data and reads as a second, unrelated curve. Instead we do a
     symmetric, triangular-kernel LOCAL LINEAR fit at each day: readings
     within +/-3.5 days vote with weight (1 - |dt| / 3.5)^2, and the fitted
     intercept at that day is the smoothed value. Local linear (rather than a
     plain moving average) has no boundary bias, so the line also tracks the
     first and last readings. Evaluated on a dense day grid to stay smooth
     even when days are missing; gaps fall back to linear interpolation. */
  function smoothSeries(entries, tau) {
    if (!entries || !entries.length) return [];
    var half = (tau || 7) / 2;
    var t0 = entries[0].t, t1 = entries[entries.length - 1].t;
    var span = t1 - t0;
    if (!(span > 0)) return [{ t: t0, kg: entries[0].kg }];

    var n = Math.min(320, Math.max(12, Math.ceil(span * 4)));
    var out = [], k, i;
    for (k = 0; k <= n; k++) {
      var t = (k === n) ? t1 : t0 + span * k / n;
      var Sw = 0, Swx = 0, Swxx = 0, Swy = 0, Swxy = 0;
      var lo = Infinity, hi = -Infinity;
      for (i = 0; i < entries.length; i++) {
        var d = entries[i].t - t;
        var ad = d < 0 ? -d : d;
        if (ad >= half) continue;
        var u = 1 - ad / half;
        var w = u * u;                          /* compact, quickly decaying */
        var y = entries[i].kg;
        Sw += w; Swx += w * d; Swxx += w * d * d;
        Swy += w * y; Swxy += w * d * y;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      var v;
      if (Sw <= 0) {
        v = interp(entries, t);                     /* wide gap in the log */
      } else {
        var det = Sw * Swxx - Swx * Swx;
        v = det > 1e-9 ? (Swy * Swxx - Swx * Swxy) / det : Swy / Sw;
        /* A one-day spike must not make the fit overshoot its own window. */
        if (isFinite(lo)) v = Math.min(hi + 0.4, Math.max(lo - 0.4, v));
      }
      if (isFinite(v)) out.push({ t: t, kg: v });
    }
    return out;
  }

  /* Kept as an alias so older callers keep working. */
  function emaSeries(entries, tau) { return smoothSeries(entries, tau); }

  function interp(series, t) {
    if (!series || !series.length) return NaN;
    if (t <= series[0].t) return series[0].kg;
    var last = series[series.length - 1];
    if (t >= last.t) return last.kg;
    for (var i = 1; i < series.length; i++) {
      if (t <= series[i].t) {
        var a = series[i - 1], b = series[i];
        var f = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return a.kg + f * (b.kg - a.kg);
      }
    }
    return last.kg;
  }

  /* Recency-weighted exponential-relaxation trend + forecast.
     ------------------------------------------------------------------
     Only readings inside the last FIT_LOOKBACK_DAYS (14) take part at all.
     Within that window each one is weighted by an exponential recency kernel
     (~3-day half-life) times a taper that falls smoothly to exactly zero at
     the 14-day boundary: the closest few days set the level and the pace,
     week-old readings barely vote, and anything older is ignored instead of
     quietly dragging the curve. Local-median clipping plus Tukey-biweight
     IRLS keeps one salty meal from bending the fit.

     The shape is an exponential relaxation, not a straight line:

         W(s) = level + (slope / k) * (1 - exp(-k*s)),   s = t - tRef

     Its tangent at the newest reading equals the fitted recent slope, while
     the pace itself decays with time constant tau = 1/k, so the forecast
     bends and eases toward a plateau instead of falling linearly forever.
     For any fixed k the model is linear in (level, slope), so we scan a small
     log grid of tau and take the lowest weighted error plus a weak prior
     around 70 days — two weeks of data cannot identify a months-long plateau
     on its own.

     Nothing is cached: every call re-fits from the entries it is handed, so
     adding or editing a reading immediately moves both halves of the line.
  */
  function fitAsymptotic(entries, opts) {
    opts = opts || {};
    var minPoints = opts.minPoints || FIT_MIN_POINTS;
    var minSpan = opts.minSpan || FIT_MIN_SPAN;
    var lookback = opts.lookbackDays || FIT_LOOKBACK_DAYS;
    var halfLife = opts.halfLifeDays || FIT_HALF_LIFE_DAYS;
    var horizon = opts.horizonDays || 28;
    if (!entries || entries.length < 2) return null;

    var t0 = entries[0].t;
    var tRef = entries[entries.length - 1].t;
    var lambda = Math.LN2 / halfLife;
    var i;

    /* Hard two-week window. Consecutive identical values are carry-forward
       days from auto-fill (or an unchanged scale reading), so they get only a
       fraction of the weight of the day that value was actually measured on.
       A long flat stretch cannot fake a zero slope, while a genuine plateau
       still yields a flat line instead of no line at all. */
    var xs = [], ys = [], w0 = [], w = [], usedT = [], prevKg = null;
    var cut = 0.65 * lookback;           /* full weight until ~9 days back */
    var wSum = 0, freshCount = 0;
    for (i = 0; i < entries.length; i++) {
      var age = tRef - entries[i].t;
      if (age < -1e-6 || age > lookback) continue;
      var repeat = prevKg != null && Math.abs(entries[i].kg - prevKg) < 1e-9;
      prevKg = entries[i].kg;
      var taper = age <= cut ? 1
        : 0.5 * (1 + Math.cos(Math.PI * (age - cut) / (lookback - cut)));
      var wi = Math.exp(-lambda * age) * taper * (repeat ? 0.05 : 1);
      if (!(wi > 1e-9)) continue;        /* zero at the 2-week boundary */
      if (!repeat) freshCount++;
      xs.push(-age);
      ys.push(entries[i].kg);
      w0.push(wi); usedT.push(entries[i].t);
      wSum += wi;
    }
    if (xs.length < 2 || !(wSum > 0)) return null;
    /* Normalise so the regression stays well conditioned even when the whole
       window consists of low-weight carry-forward days. */
    for (i = 0; i < w0.length; i++) { w0[i] /= wSum; w.push(w0[i]); }

    /* Hampel-lite de-spiking. The newest reading is a high-leverage point, so
       residual-based robust regression alone cannot see a one-day water spike
       there. Clip isolated jumps relative to the median of the surrounding
       days; a sustained change still comes through as soon as it repeats. */
    var rawY = ys.slice();
    for (i = 0; i < ys.length; i++) {
      var nb = [], j;
      for (j = Math.max(0, i - 2); j <= Math.min(ys.length - 1, i + 2); j++) {
        if (j !== i) nb.push(rawY[j]);
      }
      if (nb.length < 2) continue;
      nb.sort(function (p, q) { return p - q; });
      var med = nb[Math.floor(nb.length / 2)];
      ys[i] = med + clamp(rawY[i] - med, -0.45, 0.45);
    }

    var fitFrom = usedT[0];
    var windowSpan = Math.max(1, tRef - fitFrom);
    if (windowSpan < minSpan) return null;

    /* Weighted least squares on y = c0 + c1*g(x), with g(0) = 0. c0 is the
       level at tRef and c1 the instantaneous slope there. */
    function wls(g, wts) {
      var Sw = 0, Sg = 0, Sgg = 0, Sy = 0, Sgy = 0, j, gi, wj;
      for (j = 0; j < xs.length; j++) {
        gi = g(xs[j]); wj = wts[j];
        Sw += wj; Sg += wj * gi; Sgg += wj * gi * gi;
        Sy += wj * ys[j]; Sgy += wj * gi * ys[j];
      }
      if (!(Sw > 1e-8)) return null;
      var eps = 1e-9 * Math.max(1, Sw);
      var det = (Sw + eps) * (Sgg + eps) - Sg * Sg;
      if (!(det > 1e-14) || !isFinite(det)) return null;
      var c1 = ((Sw + eps) * Sgy - Sg * Sy) / det;
      var c0 = (Sy - c1 * Sg) / Sw;
      var sse = 0, r;
      for (j = 0; j < xs.length; j++) {
        r = ys[j] - (c0 + c1 * g(xs[j]));
        sse += wts[j] * r * r;
      }
      return { c0: c0, c1: c1, sse: sse, sw: Sw };
    }

    /* Robust weights (Tukey biweight IRLS), started from a plain straight-line
       fit. A single water-weight spike on the newest day is exactly the case
       that would otherwise swing the whole forecast, so outliers are pushed
       almost — but not completely — out of the fit. */
    function linear(s) { return s; }
    var fit = wls(linear, w);
    if (!fit) return null;
    var sigma = 0.4;
    for (var iter = 0; iter < 8; iter++) {
      var res = [], abs = [], j2;
      for (j2 = 0; j2 < xs.length; j2++) {
        var r = ys[j2] - (fit.c0 + fit.c1 * xs[j2]);
        var ar = r < 0 ? -r : r;
        res.push(ar); abs.push(ar);
      }
      abs.sort(function (p, q) { return p - q; });
      var mad = abs[Math.floor(abs.length / 2)] || 0;
      sigma = Math.max(0.12, 1.4826 * mad);
      var cutR = 3.2 * sigma;
      for (j2 = 0; j2 < w.length; j2++) {
        var u = res[j2] / cutR;
        var rw = u >= 1 ? 0 : Math.pow(1 - u * u, 2);
        w[j2] = w0[j2] * Math.max(0.02, rw);
      }
      var next = wls(linear, w);
      if (!next) return null;
      fit = next;
    }

    /* Scan decay constants: best weighted fit + a weak prior on tau. */
    var reg = Math.max(0.002, 0.04 * sigma * sigma);
    var best = null, q, steps = 24;
    for (q = 0; q <= steps; q++) {
      var tau = FIT_TAU_MIN_DAYS *
        Math.pow(FIT_TAU_MAX_DAYS / FIT_TAU_MIN_DAYS, q / steps);
      var k = 1 / tau;
      var g = (function (kk) {
        return function (s) { return -Math.expm1(-kk * s) / kk; };
      })(k);
      var f = wls(g, w);
      if (!f) continue;
      var penalty = reg * Math.pow(Math.log(tau / FIT_TAU_PRIOR_DAYS), 2);
      var score = f.sse / Math.max(1e-9, f.sw) + penalty;
      if (!best || score < best.score) {
        best = { score: score, k: k, tau: tau, level: f.c0, slope: f.c1 };
      }
    }
    if (!best) return null;

    var level = best.level, k = best.k;
    var maxSlope = Math.max(0.12, Math.min(0.5, level * 0.005));
    var slope = clamp(best.slope, -maxSlope, maxSlope);

    var Sw = 0, Sw2 = 0, xbar = 0, Sxx = 0, j3;
    for (j3 = 0; j3 < w.length; j3++) { Sw += w[j3]; Sw2 += w[j3] * w[j3]; }
    var neff = (Sw * Sw) / Math.max(1e-9, Sw2);
    for (j3 = 0; j3 < xs.length; j3++) xbar += w[j3] * xs[j3];
    xbar /= Math.max(1e-9, Sw);
    for (j3 = 0; j3 < xs.length; j3++) {
      var dx = xs[j3] - xbar;
      Sxx += w[j3] * dx * dx;
    }

    function predictAt(t) {
      var s = t - tRef;
      if (s < -windowSpan) s = -windowSpan;      /* never extrapolate back */
      if (s > FIT_FORECAST_DAYS) s = FIT_FORECAST_DAYS;
      return level + (slope / k) * (-Math.expm1(-k * s));
    }
    function halfWidthAt(t, mult) {
      var s = t - tRef;
      var fwd = s > 0 ? s : 0;
      var xc = s - xbar;
      var lev = s < -windowSpan ? 0 : (xc * xc) / Math.max(1e-6, Sxx);
      var grow = 1 - Math.exp(-fwd / 21);        /* saturating uncertainty */
      var v = 1 + 1 / Math.max(1, neff) + Math.min(6, lev) + 5 * grow * grow;
      return (mult || 1.96) * sigma * Math.sqrt(v);
    }

    return {
      t0: t0,
      tRef: tRef,
      fitFrom: fitFrom,
      forecastTo: tRef + FIT_FORECAST_DAYS,
      lookbackDays: lookback,
      k: k,
      tau: best.tau,
      A: predictAt(tRef + horizon),              /* ~4-week ahead projection */
      B: slope * 7,                              /* recent weekly pace */
      slopePerDay: slope,
      levelAtRef: level,
      plateau: level + slope / k,
      sigma: sigma,
      count: xs.length,
      span: tRef - t0,
      windowSpan: windowSpan,
      neff: neff,
      provisional: (neff < 4) || (windowSpan < 5) || (freshCount < minPoints),
      declining: slope < 0,
      predictAt: predictAt,
      halfWidthAt: halfWidthAt
    };
  }

  /* When (and whether) the decaying curve reaches the goal weight. Inverting
     W(s) = level + (slope/k)*(1 - exp(-k*s)) gives the date below; if the goal
     sits below the plateau the curve can never get there, which is reported
     separately from a merely distant goal. */
  function goalOutlook(model, goalKg) {
    if (!model || goalKg == null || !isFinite(goalKg)) return null;
    var slope = model.slopePerDay;                /* kg/day; negative = losing */
    if (slope >= -1e-6) return { reachable: false, reason: 'no-decline' };
    var left = model.levelAtRef - goalKg;          /* kg still to lose */
    if (left <= 0) return { reachable: true, dateDays: model.tRef, daysAway: model.tRef - todayDays(), reason: 'already-there' };

    var k = model.k || 0, rate = -slope, days;
    if (k > 1e-6) {
      var q = 1 - left * k / rate;                /* = exp(-k*s) at the goal */
      if (!(q > 0)) return { reachable: false, reason: 'plateau' };
      days = -Math.log(q) / k;
    } else {
      days = left / rate;
    }
    if (!isFinite(days) || days > 730) return { reachable: false, reason: 'too-far' };
    var dateDays = model.tRef + days;
    return { reachable: true, dateDays: dateDays, daysAway: dateDays - todayDays() };
  }

  /* Front-loaded ("early water, later slow") reference path. Only used when a
     target date was actually entered. */
  function goalTrajectory(startDays, startKg, targetDays, goalKg) {
    if (!targetDays || !isFinite(targetDays) || targetDays <= startDays ||
        startKg == null || goalKg == null) return null;
    var span = targetDays - startDays;
    return {
      startDays: startDays,
      targetDays: targetDays,
      at: function (t) {
        var s = Math.min(1, Math.max(0, (t - startDays) / span));
        return goalKg + (startKg - goalKg) * Math.pow(1 - s, 1.35);
      }
    };
  }

  /* Four period deltas. Derived from the fitted curve when it exists, so a
     single salty meal does not dominate the "1 day" number. */
  function computeDeltas(entries, model, smooth, fallbackStartDays, today, unit) {
    var result = [];
    if (!entries || !entries.length) {
      return [
        { key: 'd1', label: '這 1 天', value: null },
        { key: 'w1', label: '這 1 星期', value: null },
        { key: 'm1', label: '這 1 個月', value: null },
        { key: 'all', label: '定下目標以來', value: null }
      ];
    }
    var first = entries[0].t;
    var lastT = entries[entries.length - 1].t;
    var refT = today;
    /* The curve is fitted only on the last two weeks. Short deltas use it (so
       one salty meal does not dominate); longer ones must come from the
       smoothed readings instead of extrapolating the curve months backwards. */
    var curve = (smooth && smooth.length > 2) ? smooth : entries;
    var fitFrom = model ? model.fitFrom : Infinity;
    var goalFrom = isFinite(fallbackStartDays) ? fallbackStartDays : first;
    var specs = [
      { key: 'd1', label: '這 1 天', from: refT - 1 },
      { key: 'w1', label: '這 1 星期', from: refT - 7 },
      { key: 'm1', label: '這 1 個月', from: refT - 30 },
      { key: 'all', label: '定下目標以來', from: goalFrom }
    ];
    for (var i = 0; i < specs.length; i++) {
      var s = specs[i];
      var span = refT - s.from;
      if (span < 0.9 || s.from < first - 0.6) {
        result.push({ key: s.key, label: s.label, value: null, unit: unit });
        continue;
      }
      var useFit = !!model && s.from >= fitFrom - 0.6;
      var nowV = useFit ? model.predictAt(Math.min(refT, model.tRef))
        : interp(curve, Math.min(refT, lastT));
      var oldV = useFit ? model.predictAt(s.from) : interp(curve, s.from);
      result.push({
        key: s.key, label: s.label, value: nowV - oldV, unit: unit
      });
    }
    return result;
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var exp = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / exp;
    var m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return m * exp;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  global.WPT = {
    LB_PER_KG: LB_PER_KG,
    DAY_MS: DAY_MS,
    STORAGE_KEY: STORAGE_KEY,
    FIT_MIN_POINTS: FIT_MIN_POINTS,
    FIT_MIN_SPAN: FIT_MIN_SPAN,
    FIT_LOOKBACK_DAYS: FIT_LOOKBACK_DAYS,
    FIT_HALF_LIFE_DAYS: FIT_HALF_LIFE_DAYS,
    FIT_FORECAST_DAYS: FIT_FORECAST_DAYS,
    isoToDays: isoToDays,
    daysToIso: daysToIso,
    daysToParts: daysToParts,
    todayIso: todayIso,
    todayDays: todayDays,
    shortDate: shortDate,
    longDate: longDate,
    kgToUnit: kgToUnit,
    unitToKg: unitToKg,
    unitLabel: unitLabel,
    fmtKg: fmtKg,
    signedKg: signedKg,
    bmi: bmi,
    bmiBand: bmiBand,
    emaSeries: emaSeries,
    smoothSeries: smoothSeries,
    interp: interp,
    fitAsymptotic: fitAsymptotic,
    goalOutlook: goalOutlook,
    goalTrajectory: goalTrajectory,
    computeDeltas: computeDeltas,
    niceStep: niceStep,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : this);
