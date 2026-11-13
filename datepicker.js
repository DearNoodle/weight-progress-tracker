/* weight-progress-tracker / datepicker.js
   Custom, phone-first date picker. Replaces the native <input type="date">
   controls so selection is large, clean and easy on a phone. Exposes
   window.WPT.openDatePicker(opts) and a couple of helpers used by app.js.

   opts = {
     value:   'YYYY-MM-DD' | ''   (initial selection)
     min:     'YYYY-MM-DD' | null (earliest selectable, inclusive)
     max:     'YYYY-MM-DD' | null (latest selectable, inclusive)
     presets: [{ label, iso }]    (quick-pick chips; out-of-range ones disable)
     title:   string              (aria label for the title button)
     onConfirm(iso)               (called with the chosen 'YYYY-MM-DD')
   }

   The picker owns its own DOM (a fixed full-screen layer) and is a singleton,
   so multiple callers can reuse it without leaking nodes. */
(function () {
  'use strict';
  var W = window.WPT;
  if (!W) return;

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function parseISO(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    var y = +p[0], m = +p[1], d = +p[2];
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    return { y: y, m: m, d: d };
  }
  function todayISO() { var d = new Date(); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  function addDays(s, n) {
    var p = parseISO(s); if (!p) return s;
    var dt = new Date(p.y, p.m - 1, p.d); dt.setDate(dt.getDate() + n);
    return iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function wday(s) { var p = parseISO(s); return new Date(p.y, p.m - 1, p.d).getDay(); }
  function inRange(s, min, max) {
    if (min && s < min) return false;
    if (max && s > max) return false;
    return true;
  }
  function fmtLabel(s) {
    if (!s) return '—';
    var t = todayISO();
    if (s === t) return '今天';
    if (s === addDays(t, -1)) return '昨天';
    if (s === addDays(t, -2)) return '前天';
    var p = parseISO(s);
    return p.m + '月' + p.d + '日 · 週' + WEEK[wday(s)];
  }

  var el = {}, st = null, built = false;

  function build() {
    if (built) return; built = true;
    var L = document.createElement('div');
    L.className = 'dp-layer';
    L.hidden = true;
    L.innerHTML = [
      '<div class="dp-backdrop" data-act="cancel"></div>',
      '<section class="dp-sheet" role="dialog" aria-modal="true" aria-label="選擇日期">',
        '<div class="dp-grab" aria-hidden="true"></div>',
        '<div class="dp-head">',
          '<button type="button" class="dp-nav" data-act="prev" aria-label="上一個月"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>',
          '<button type="button" class="dp-title" data-act="toggleYM" aria-label="切換年月選擇">',
            '<span class="dp-title-y" data-el="year"></span>',
            '<span class="dp-title-m" data-el="month"></span>',
            '<svg class="dp-caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
          '</button>',
          '<button type="button" class="dp-nav" data-act="next" aria-label="下一個月"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>',
        '</div>',
        '<div class="dp-presets" data-el="presets"></div>',
        '<div class="dp-cal" data-el="cal">',
          '<div class="dp-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>',
          '<div class="dp-grid" data-el="grid"></div>',
        '</div>',
        '<div class="dp-ym" data-el="ym" hidden>',
          '<div class="dp-ym-head"><span data-el="ymYear"></span></div>',
          '<div class="dp-ym-body">',
            '<div class="dp-years" data-el="years"></div>',
            '<div class="dp-months" data-el="months"></div>',
          '</div>',
        '</div>',
        '<div class="dp-sel" data-el="sel"></div>',
        '<div class="dp-foot">',
          '<button type="button" class="dp-btn dp-cancel" data-act="cancel">取消</button>',
          '<button type="button" class="dp-btn dp-done" data-act="done">完成</button>',
        '</div>',
      '</section>'
    ].join('');
    document.body.appendChild(L);
    el.layer = L;
    el.sheet = L.querySelector('.dp-sheet');
    el.year = L.querySelector('[data-el="year"]');
    el.month = L.querySelector('[data-el="month"]');
    el.presets = L.querySelector('[data-el="presets"]');
    el.cal = L.querySelector('[data-el="cal"]');
    el.grid = L.querySelector('[data-el="grid"]');
    el.ym = L.querySelector('[data-el="ym"]');
    el.ymYear = L.querySelector('[data-el="ymYear"]');
    el.years = L.querySelector('[data-el="years"]');
    el.months = L.querySelector('[data-el="months"]');
    el.sel = L.querySelector('[data-el="sel"]');
    L.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
  }

  function render() {
    if (!st) return;
    if (st.view === 'ym') renderYM(); else renderDay();
    el.presets.hidden = (st.view === 'ym');
    el.cal.hidden = (st.view === 'ym');
    el.ym.hidden = !(st.view === 'ym');
    el.sheet.classList.toggle('ym-open', st.view === 'ym');
    el.sel.textContent = st.selISO ? ('已選 ' + fmtLabel(st.selISO)) : '點選一個日期';
    el.sel.classList.toggle('empty', !st.selISO);
  }

  function renderDay() {
    el.year.textContent = st.dispY + ' 年';
    el.month.textContent = st.dispM + ' 月';
    var lo = st.min ? parseISO(st.min) : null, hi = st.max ? parseISO(st.max) : null;
    var atMin = lo && (st.dispY * 12 + st.dispM) <= (lo.y * 12 + lo.m);
    var atMax = hi && (st.dispY * 12 + st.dispM) >= (hi.y * 12 + hi.m);
    el.sheet.querySelector('[data-act="prev"]').disabled = !!atMin;
    el.sheet.querySelector('[data-act="next"]').disabled = !!atMax;

    el.presets.innerHTML = st.presets.map(function (p) {
      var ok = inRange(p.iso, st.min, st.max);
      var on = p.iso === st.selISO;
      return '<button type="button" class="dp-chip' + (on ? ' on' : '') + (ok ? '' : ' dis') +
        '" data-act="preset" data-iso="' + p.iso + '"' + (ok ? '' : ' disabled') + '>' + p.label + '</button>';
    }).join('');

    var first = new Date(st.dispY, st.dispM - 1, 1);
    var lead = first.getDay();
    var days = new Date(st.dispY, st.dispM, 0).getDate();
    var t = todayISO();
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push('<span class="dp-cell blank"></span>');
    for (var d = 1; d <= days; d++) {
      var s = iso(st.dispY, st.dispM, d);
      var cls = 'dp-cell';
      if (s === t) cls += ' today';
      if (s === st.selISO) cls += ' sel';
      var ok = inRange(s, st.min, st.max);
      if (!ok) cls += ' out';
      cells.push('<button type="button" class="' + cls + '" data-act="day" data-iso="' + s + '"' +
        (ok ? '' : ' disabled') + '>' + d + '</button>');
    }
    el.grid.innerHTML = cells.join('');
  }

  function renderYM() {
    el.ymYear.textContent = st.dispY + ' 年';
    var cy = new Date().getFullYear();
    var minY = st.min ? parseISO(st.min).y : (st.max ? parseISO(st.max).y - 1 : 2015);
    var maxY = st.max ? parseISO(st.max).y : (st.min ? parseISO(st.min).y + 5 : cy + 2);
    var lo = st.min ? parseISO(st.min) : null, hi = st.max ? parseISO(st.max) : null;
    var yh = [];
    for (var y = maxY; y >= minY; y--) {
      var yOk = !(lo && y < lo.y) && !(hi && y > hi.y);
      yh.push('<button type="button" class="dp-year' + (y === st.dispY ? ' on' : '') +
        '" data-act="year" data-y="' + y + '"' + (yOk ? '' : ' disabled') + '>' + y + '</button>');
    }
    el.years.innerHTML = yh.join('');
    var mh = [];
    for (var m = 1; m <= 12; m++) {
      var mOk = true;
      if (lo && (st.dispY < lo.y || (st.dispY === lo.y && m < lo.m))) mOk = false;
      if (hi && (st.dispY > hi.y || (st.dispY === hi.y && m > hi.m))) mOk = false;
      mh.push('<button type="button" class="dp-month' + (m === st.dispM ? ' on' : '') +
        '" data-act="month" data-m="' + m + '"' + (mOk ? '' : ' disabled') + '>' + m + '月</button>');
    }
    el.months.innerHTML = mh.join('');
    var onY = el.years.querySelector('.dp-year.on');
    if (onY) onY.scrollIntoView({ block: 'center' });
  }

  function stepMonth(n) {
    var m = st.dispM + n, y = st.dispY;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    st.dispY = y; st.dispM = m;
    renderDay();
  }

  function onClick(e) {
    var t = e.target.closest && e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'cancel') { close(); return; }
    if (act === 'done') { confirmPick(); return; }
    if (act === 'prev') { stepMonth(-1); return; }
    if (act === 'next') { stepMonth(1); return; }
    if (act === 'toggleYM') { st.view = (st.view === 'ym') ? 'day' : 'ym'; render(); return; }
    if (act === 'day') { st.selISO = t.getAttribute('data-iso'); render(); return; }
    if (act === 'preset') { st.selISO = t.getAttribute('data-iso'); confirmPick(); return; }
    if (act === 'year') { st.dispY = +t.getAttribute('data-y'); renderYM(); return; }
    if (act === 'month') { st.dispM = +t.getAttribute('data-m'); st.view = 'day'; render(); return; }
  }

  function onKey(e) {
    if (!st) return;
    if (e.key === 'Escape' || e.key === 'Esc') { e.stopImmediatePropagation(); e.preventDefault(); close(); }
  }

  function confirmPick() {
    var v = st.selISO, fn = st.onConfirm;
    teardown();
    if (fn) fn(v);
  }
  function close() { teardown(); }
  function teardown() {
    if (!el.layer) return;
    el.layer.classList.remove('open');
    var layer = el.layer;
    setTimeout(function () { layer.hidden = true; }, 300);
    st = null;
  }

  function open(opts) {
    build();
    opts = opts || {};
    var val = opts.value || todayISO();
    var p = parseISO(val) || parseISO(todayISO());
    var clamped = val;
    if (opts.min && val < opts.min) clamped = opts.min;
    if (opts.max && clamped > opts.max) clamped = opts.max;
    st = {
      view: 'day',
      dispY: p.y, dispM: p.m,
      selISO: inRange(clamped, opts.min, opts.max) ? clamped : clamped,
      min: opts.min || null,
      max: opts.max || null,
      presets: opts.presets || [],
      onConfirm: opts.onConfirm || null,
      title: opts.title || '選擇日期'
    };
    el.sheet.querySelector('.dp-title').setAttribute('aria-label', st.title);
    el.layer.hidden = false;
    requestAnimationFrame(function () { el.layer.classList.add('open'); });
    render();
  }

  W.openDatePicker = open;
  W.fmtDateLabel = fmtLabel;
  W.addDaysISO = addDays;
})(typeof window !== 'undefined' ? window : this);
