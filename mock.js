/* weight-progress-tracker / mock.js — TEST ONLY
   ------------------------------------------------------------------
   No UI, no buttons, no menu entries. This file is completely inert unless
   the URL carries ?mock=<scenario> or you call window.WPT_MOCK in DevTools.
   It is loaded BEFORE app.js so the data is already in localStorage when the
   app boots. Production users never see or trigger any of it.

   Quick start
     index.html?mock=7d        seven consecutive days (provisional curve)
     index.html?mock=default   90-day slow diet-led journey
     index.html?mock=plateau   weight loss that flattens out
     index.html?mock=history   20 hardcoded previous date-weight entries
     index.html?mock=clear     wipe everything back to a clean first run

   In DevTools
     WPT_MOCK.help()                 list every scenario
     WPT_MOCK.load('plateau')        write a scenario and reload
     WPT_MOCK.custom({days:21,...})  your own curve, then reload
     WPT_MOCK.print('7d')            print JSON to paste into localStorage
     WPT_MOCK.clear()                remove the saved state and reload

   The ?mock= parameter is stripped after seeding, so editing a record and
   reloading keeps YOUR change instead of silently restoring the mock set.
*/
(function (global) {
  'use strict';

  var W = global.WPT;
  if (!W) return;
  var KEY = W.STORAGE_KEY;

  /* Deterministic PRNG: the same scenario always produces the same numbers. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* opts:
       days, seed, curve(d), skip, noise, spike, weekend,
       unit, heightCm, goal, targetDate (number = days from today, or ISO),
       showTrend, showSmooth, chartRange                                   */
  function makeState(opts) {
    opts = opts || {};
    var today = W.todayDays();
    var days = Math.max(1, opts.days || 90);
    var t0 = today - (days - 1);
    var rnd = mulberry32(opts.seed || 20261112);
    var curve = opts.curve || function (d) { return 82.5 - 7.2 * (1 - Math.exp(-0.022 * d)); };
    var skip = opts.skip == null ? 0.22 : opts.skip;
    var noise = opts.noise == null ? 0.7 : opts.noise;
    var spike = opts.spike == null ? 0.07 : opts.spike;
    var weekend = opts.weekend == null ? 0.18 : opts.weekend;
    var entries = [], d;

    for (d = 0; d < days; d++) {
      /* Always keep the first and last day so start/end are well defined. */
      if (d > 0 && d < days - 1 && rnd() < skip) continue;
      var v = curve(d) + (rnd() - 0.5) * noise;
      var wd = W.daysToParts(t0 + d).w;
      if (wd === 0 || wd === 6) v += weekend;
      if (rnd() < spike) v += 0.9;               /* off-plan meal / water */
      entries.push({ date: W.daysToIso(t0 + d), kg: Math.round(v * 10) / 10 });
    }

    var target = null;
    if (typeof opts.targetDate === 'number') target = W.daysToIso(today + opts.targetDate);
    else if (opts.targetDate) target = String(opts.targetDate).slice(0, 10);

    return {
      schema: 2,
      unit: opts.unit || 'kg',
      heightCm: opts.heightCm == null ? 175 : opts.heightCm,
      goal: {
        kg: opts.goal == null ? null : opts.goal,
        targetDate: target,
        setDate: W.daysToIso(t0)
      },
      entries: entries,
      prefs: {
        showTrend: opts.showTrend == null ? true : !!opts.showTrend,
        showSmooth: !!opts.showSmooth,
        chartRange: opts.chartRange || 'auto'
      }
    };
  }

  var SCENARIOS = {
    /* A believable slow, imperfect, diet-led 3 months: gaps, water noise,
       weekend bumps and a couple of off-plan spikes. */
    'default': function () { return makeState({ goal: 70, targetDate: 60 }); },
    '1': function () { return makeState({ goal: 70, targetDate: 60 }); },

    /* Minimal data that still produces the weighted asymptotic curve. */
    '7d': function () {
      return makeState({
        days: 7, seed: 77, skip: 0, noise: 0.18, spike: 0, weekend: 0,
        curve: function (d) { return 80.4 - 0.12 * d; },
        goal: 72, targetDate: 90
      });
    },

    /* One month, denser logging, both chart helpers on. */
    '1m': function () {
      return makeState({
        days: 30, seed: 3030, skip: 0.1, noise: 0.55,
        curve: function (d) { return 79 - 3.1 * (1 - Math.exp(-0.055 * d)); },
        goal: 70, targetDate: 45, showSmooth: true
      });
    },

    /* A full year: exercises long x ranges and year/month axis labels. */
    '1y': function () {
      return makeState({
        days: 365, seed: 3651, skip: 0.3, noise: 0.8,
        curve: function (d) { return 84 - 9.5 * (1 - Math.exp(-0.009 * d)); },
        goal: 70, targetDate: null
      });
    },

    /* Loses weight then stalls: the "may not reach goal" copy should appear. */
    'plateau': function () {
      return makeState({
        days: 120, seed: 9090, skip: 0.15, noise: 0.5,
        curve: function (d) { return 82 - 6.2 * (1 - Math.exp(-0.05 * Math.min(d, 55))); },
        goal: 70, targetDate: 60
      });
    },

    /* A setback: down for 40 days, drifting back up afterwards. */
    'gain': function () {
      return makeState({
        days: 60, seed: 5150, skip: 0.18, noise: 0.5,
        curve: function (d) { return d < 40 ? 80 - 0.13 * d : 74.8 + 0.11 * (d - 40); },
        goal: 70, targetDate: 80
      });
    },

    /* Very irregular logging: gaps, interpolation, sparse chart windows. */
    'sparse': function () {
      return makeState({
        days: 180, seed: 1801, skip: 0.62, noise: 0.6,
        curve: function (d) { return 83 - 8 * (1 - Math.exp(-0.016 * d)); },
        goal: 70, targetDate: null
      });
    },

    /* lb display while everything is still stored in kg. */
    'lb': function () {
      return makeState({ seed: 4545, unit: 'lb', heightCm: 170, goal: 154, targetDate: 60 });
    },

    /* No target date at all — the app must still work completely. */
    'notarget': function () {
      return makeState({
        days: 45, seed: 4546, skip: 0.2, noise: 0.6,
        curve: function (d) { return 80 - 4.2 * (1 - Math.exp(-0.04 * d)); },
        goal: 72, targetDate: null
      });
    },

    /* kg / lb switching and an empty goal. */
    'minimal': function () {
      return makeState({
        days: 9, seed: 9009, skip: 0, noise: 0.3, spike: 0,
        curve: function (d) { return 60 - 0.16 * d; },
        goal: null, targetDate: null
      });
    },

    /* 20 筆寫死的歷史體重：最近 20 天，每日一筆，含目標設定。 */
    'history': function () {
      var entries = [
        { date: '2026-10-24', kg: 82.3 },
        { date: '2026-10-25', kg: 82.0 },
        { date: '2026-10-26', kg: 81.6 },
        { date: '2026-10-27', kg: 81.8 },
        { date: '2026-10-28', kg: 81.4 },
        { date: '2026-10-29', kg: 81.1 },
        { date: '2026-10-30', kg: 80.9 },
        { date: '2026-10-31', kg: 80.5 },
        { date: '2026-11-01', kg: 80.2 },
        { date: '2026-11-02', kg: 80.4 },
        { date: '2026-11-03', kg: 79.9 },
        { date: '2026-11-04', kg: 79.6 },
        { date: '2026-11-05', kg: 79.3 },
        { date: '2026-11-06', kg: 79.5 },
        { date: '2026-11-07', kg: 79.0 },
        { date: '2026-11-08', kg: 78.7 },
        { date: '2026-11-09', kg: 78.5 },
        { date: '2026-11-10', kg: 78.2 },
        { date: '2026-11-11', kg: 78.4 },
        { date: '2026-11-12', kg: 78.1 }
      ];
      return {
        schema: 2,
        unit: 'kg',
        heightCm: 175,
        goal: { kg: 75, targetDate: '2026-12-31', setDate: '2026-10-24' },
        entries: entries,
        prefs: { showTrend: true, showSmooth: true, chartRange: 'auto' }
      };
    }
  };

  function norm(name) {
    name = String(name == null || name === '' ? 'default' : name).toLowerCase();
    return name === 'true' ? 'default' : name;
  }
  function isClear(name) {
    return name === 'clear' || name === 'empty' || name === '0' || name === 'off' || name === 'none';
  }
  function names() { return Object.keys(SCENARIOS).concat(['clear']); }

  function write(state) {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('[WPT_MOCK] localStorage unavailable: ' + e); }
  }
  function wipe() {
    try { global.localStorage.removeItem(KEY); }
    catch (e) { console.warn('[WPT_MOCK] localStorage unavailable: ' + e); }
  }

  /* Same routine used by both the URL entry point and the console API. */
  function apply(name) {
    name = norm(name);
    if (isClear(name)) { wipe(); return 'clear'; }
    if (!SCENARIOS[name]) {
      console.warn('[WPT_MOCK] unknown scenario "' + name + '". Available: ' + names().join(', '));
      return null;
    }
    write(SCENARIOS[name]());
    return name;
  }

  var API = {
    scenarios: names(),
    help: function () {
      console.info('[WPT_MOCK] append ?mock=<name> to the URL, or call WPT_MOCK.load(name).\n' +
        'Scenarios: ' + names().join(', ') + '\n' +
        'Other helpers: WPT_MOCK.build(name), WPT_MOCK.custom({days,curve,...}), ' +
        'WPT_MOCK.print(name), WPT_MOCK.clear()');
      return names();
    },
    build: function (name) {
      name = norm(name);
      return isClear(name) ? null : (SCENARIOS[name] ? SCENARIOS[name]() : null);
    },
    makeState: makeState,
    load: function (name) { if (apply(name) !== null) global.location.reload(); },
    custom: function (opts) { write(makeState(opts)); global.location.reload(); },
    clear: function () { wipe(); global.location.reload(); },
    print: function (name) {
      var s = this.build(name);
      var txt = JSON.stringify(s, null, 2);
      console.log(txt);
      return txt;
    }
  };

  global.WPT_MOCK = API;

  /* URL entry point. Only runs when ?mock= is actually present. */
  var search = (global.location && global.location.search) || '';
  var m = /[?&]mock(?:=([^&#]*))?/.exec(search);
  if (!m) return;

  var applied = apply(decodeURIComponent(m[1] || 'default'));
  if (applied === null) return;

  /* Drop the parameter so a later reload keeps any edits made in the app. */
  try {
    var clean = global.location.href
      .replace(/([?&])mock(?:=[^&#]*)?&?/, '$1')
      .replace(/[?&]$/, '');
    global.history.replaceState(null, '', clean);
  } catch (e) { /* file:// may refuse replaceState; harmless */ }

  console.info('[WPT_MOCK] seeded "' + applied + '" (' +
    (applied === 'clear' ? 'empty state' : (API.build(applied) || { entries: [] }).entries.length + ' entries') +
    '). Call WPT_MOCK.help() for all scenarios.');
})(typeof window !== 'undefined' ? window : this);
