/* Novig v3 API Explorer — plain JS, no build step.
   All content lives in data/*.json; this file only draws it. */
(() => {
  'use strict';

  const DATA = ['routes', 'throttle', 'ws_channels', 'fees', 'tif', 'price_grid',
    'environments', 'quickstart', 'public_data', 'hard_limits', 'meta'];
  const D = {};
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else n.setAttribute(k, v);
    }
    kids.flat().forEach((c) => n.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return n;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const int = new Intl.NumberFormat('en');
  const usd = (v, d = 2) => '$' + v.toFixed(d);
  const p3 = (v) => v.toFixed(3);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const COLORS = ['--accent', '--accent-2', '--accent-3'];
  const color = (i) => css(COLORS[i % COLORS.length]);
  const isReadKey = (r) => r.keys.includes('::read') || r.keys.startsWith('any');

  /* ---------- theme ---------- */
  const themeBtn = $('.theme');
  const savedTheme = (() => { try { return localStorage.getItem('nv-theme'); } catch { return null; } })();
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('nv-theme', next); } catch { /* storage off */ }
    drawCharts();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCharts);

  /* ---------- tooltip ---------- */
  const tip = $('#tip');
  function showTip(event, head, lines) {
    tip.replaceChildren(el('div', { class: 'h' }, head),
      ...lines.map(([c, text]) => el('div', {}, c ? el('span', { class: 'sw', style: `background:${c}` }) : '', text)));
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = event.clientX + 14, y = event.clientY - h - 10;
    if (x + w > innerWidth - 8) x = event.clientX - w - 14;
    if (y < 8) y = event.clientY + 16;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.style.display = 'none'; };

  /* ---------- tabs ---------- */
  const tabs = [...document.querySelectorAll('.tab')];
  let current = 'routes';
  function show(page, push = true) {
    const tab = tabs.find((t) => t.dataset.page === page) || tabs[0];
    current = tab.dataset.page;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      document.getElementById(t.dataset.page).hidden = !on;
    });
    if (push) history.replaceState(null, '', '#' + current);
    drawCharts();
  }
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.page)));

  /* ---------- horizontal bar chart ---------- */
  function hbar(box, rows, { label, value, fmt, fill, tipText, onClick, active }) {
    box.replaceChildren();
    const W = box.clientWidth;
    if (!W) return;
    const row = 26, gap = 8, H = rows.length * (row + gap) - gap;
    const svg = svgEl('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}` });
    box.append(svg);
    const measure = (t) => { const n = svgEl('text', { 'font-size': 12 }); n.textContent = t; svg.append(n); const w = n.getComputedTextLength(); n.remove(); return w; };
    const left = Math.ceil(Math.max(...rows.map((r) => measure(label(r))))) + 12;
    const right = Math.ceil(Math.max(...rows.map((r) => measure(fmt(value(r)))))) + 10;
    const max = Math.max(...rows.map(value)) || 1;
    const span = Math.max(10, W - left - right);
    rows.forEach((r, i) => {
      const g = svgEl('g', { transform: `translate(0,${i * (row + gap)})` });
      if (onClick) g.style.cursor = 'pointer';
      const w = Math.max(2, (value(r) / max) * span);
      const dim = active && active() && active() !== label(r);
      const t1 = svgEl('text', { x: left - 12, y: row / 2, dy: '0.35em', 'text-anchor': 'end', 'font-size': 12 });
      t1.style.fill = css('--fg'); t1.textContent = label(r);
      const b = svgEl('rect', { x: left, y: (row - 18) / 2, height: 18, width: w, rx: 4 });
      b.style.fill = fill(r, i); b.style.opacity = dim ? 0.35 : 1;
      const t2 = svgEl('text', { x: left + w + 6, y: row / 2, dy: '0.35em', 'font-size': 12 });
      t2.style.fill = css('--muted'); t2.textContent = fmt(value(r));
      const hit = svgEl('rect', { x: 0, y: 0, width: W, height: row, fill: 'transparent' });
      g.append(t1, b, t2, hit);
      g.addEventListener('mousemove', (e) => showTip(e, label(r), [[null, tipText(r)]]));
      g.addEventListener('mouseleave', hideTip);
      if (onClick) g.addEventListener('click', () => onClick(r));
      svg.append(g);
    });
  }

  /* ---------- header ---------- */
  function drawHeader() {
    const r = D.routes;
    const groups = new Set(r.map((x) => x.group)).size;
    const writes = r.filter((x) => x.method !== 'GET').length;
    const orderWrites = r.filter((x) => x.method !== 'GET' && x.keys === 'trading').length;
    const readOk = r.filter(isReadKey).length;
    const b = (v) => el('b', {}, int.format(v));
    $('#takeaway').replaceChildren(
      b(r.length), ' routes in ', b(groups),
      ' groups. You can read markets, books and history, place and cancel orders, fund subaccounts and stream live order books. ',
      b(writes), ' routes change something; ', b(readOk), ' work with a read-only key.');
    const tiles = [
      ['Routes', r.length, 'REST and websocket, v3'],
      ['Write routes', writes, 'POST, PATCH or DELETE'],
      ['Order routes', orderWrites, 'Need a trading key'],
      ['Stream channels', D.ws_channels.length, 'On one websocket'],
      ['Throttle buckets', D.throttle.length, 'Token buckets, per key'],
    ];
    $('#tiles').replaceChildren(...tiles.map(([l, n, s]) =>
      el('div', { class: 'tile' }, el('div', { class: 'lbl' }, l), el('div', { class: 'num' }, int.format(n)), el('div', { class: 'sub' }, s))));
    if (D.meta && D.meta.updated) {
      const d = new Date(D.meta.updated + 'T12:00:00');
      $('#updated').textContent = 'Last updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.';
    }
  }

  /* ---------- routes ---------- */
  const q = $('#q'), grp = $('#grp'), keySel = $('#key'), count = $('#count');
  const rBody = $('#table-routes tbody');
  const sort = { key: null, dir: 'ascending' };
  let groupFilter = '';

  function drawRoutes() {
    const all = D.routes;
    const groups = [...new Set(all.map((r) => r.group))];
    grp.replaceChildren(new Option('All groups', ''), ...groups.map((g) => new Option(g, g)));
    grp.value = groupFilter;
    const term = q.value.trim().toLowerCase();
    const k = keySel.value;
    let list = all.filter((r) => (!groupFilter || r.group === groupFilter)
      && (!term || [r.method, r.path, r.name, r.group, r.keys, r.throttle, r.cost, r.what].join(' ').toLowerCase().includes(term))
      && (!k || (k === 'read' ? isReadKey(r) : r.keys.split(', ').includes(k))));
    if (sort.key) {
      const s = sort.dir === 'ascending' ? 1 : -1;
      list = list.slice().sort((a, b) => s * String(a[sort.key]).localeCompare(String(b[sort.key])));
    }
    rBody.replaceChildren(...(list.length ? list.map((r) => {
      const tr = el('tr', { tabindex: '0' },
        el('td', {}, el('span', { class: `m m-${r.method}` }, r.method)),
        el('td', { class: 'mono' }, r.path, el('span', { class: 'sub-name' }, r.name)),
        el('td', { class: 'hide-sm' }, r.name),
        el('td', { class: 'hide-sm' }, r.keys),
        el('td', { class: 'mono hide-sm' }, r.throttle),
        el('td', { class: 'hide-sm' }, r.cost));
      tr.addEventListener('click', () => openDetail(r));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(r); });
      return tr;
    }) : [el('tr', {}, el('td', { colspan: '6', class: 'empty' }, 'No routes match.'))]));
    count.textContent = `${int.format(list.length)} of ${int.format(all.length)}`;
  }
  document.querySelectorAll('#table-routes th button').forEach((b) => b.addEventListener('click', () => {
    sort.dir = sort.key === b.dataset.k && sort.dir === 'ascending' ? 'descending' : 'ascending';
    sort.key = b.dataset.k;
    document.querySelectorAll('#table-routes th').forEach((th) => th.removeAttribute('aria-sort'));
    b.closest('th').setAttribute('aria-sort', sort.dir);
    drawRoutes();
  }));
  q.addEventListener('input', drawRoutes);
  keySel.addEventListener('change', drawRoutes);
  grp.addEventListener('change', () => { groupFilter = grp.value; drawRoutes(); drawCharts(); });

  /* ---------- route detail ---------- */
  const dlg = $('#detail');
  dlg.querySelector('.close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  function openDetail(r) {
    const rows = [['Group', r.group], ['Key', r.keys], ['Throttle', r.throttle], ['Cost', r.cost + ' tokens'], ['Notes', r.what]];
    $('#d-body').replaceChildren(
      el('span', { class: `m m-${r.method}` }, r.method),
      el('h2', { id: 'd-title' }, r.name),
      el('div', { class: 'path' }, r.path),
      el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      r.doc ? el('a', { class: 'doc', href: r.doc, target: '_blank', rel: 'noopener' }, 'Open in Novig docs ↗') : '');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  /* ---------- simple tables ---------- */
  function fill(sel, rows, cells) {
    $(sel + ' tbody').replaceChildren(...rows.map((r) =>
      el('tr', {}, cells.map(([get, cls]) => {
        const v = get(r);
        return el('td', cls ? { class: cls } : {}, v);
      }))));
  }

  function drawTables() {
    const maxCap = Math.max(...D.throttle.map((t) => t.capacity));
    fill('#table-throttle', D.throttle, [
      [(r) => r.bucket, 'mono'],
      [(r) => el('div', { class: 'bar' }, el('i', { style: `width:${Math.max(4, (r.capacity / maxCap) * 120)}px` }), el('span', {}, int.format(r.capacity)))],
      [(r) => int.format(r.refill_per_sec), 'n'],
      [(r) => int.format(r.capacity / r.refill_per_sec) + ' s', 'n'],
      [(r) => r.used_for, 'hide-md'],
    ]);
    fill('#table-hard', D.hard_limits, [[(r) => r.limit], [(r) => int.format(r.value), 'n'], [(r) => r.unit]]);
    fill('#table-grid', D.price_grid, [
      [(r) => r.band], [(r) => p3(r.from_price), 'n'], [(r) => p3(r.to_price), 'n'], [(r) => p3(r.step), 'n'],
      [(r) => int.format(ticks(r)), 'n'],
    ]);
    fill('#table-fees', D.fees, [
      [(r) => r.schedule], [(r) => r.coefficient.toFixed(2), 'n'], [(r) => r.maker_credit.toFixed(1), 'n'],
      [(r) => r.charged, 'hide-md'],
      [(r) => (isRfq(r) ? '—' : usd(takerFee(r.coefficient, 0.5, 10000), 4)), 'n'],
      [(r) => (isRfq(r) ? '—' : usd(takerFee(r.coefficient, 0.5, 10000) * r.maker_credit, 4)), 'n'],
    ]);
    fill('#table-tif', D.tif, [[(r) => r.tif, 'mono'], [(r) => r.name], [(r) => r.behavior], [(r) => r.ttl]]);
    fill('#table-env', D.environments, [
      [(r) => r.environment], [(r) => r.rest, 'mono'], [(r) => r.websocket, 'mono hide-md'],
      [(r) => r.money], [(r) => r.location_check], [(r) => r.keys_from, 'hide-md'],
    ]);
    fill('#table-public', D.public_data, [[(r) => r.file], [(r) => r.path, 'mono'], [(r) => r.contents, 'hide-md']]);
    $('#list-quick').replaceChildren(...D.quickstart.map((r) => el('li', {},
      el('div', { class: 'k' }, r.step),
      el('div', {}, el('div', { class: 'call' }, r.call), el('div', { class: 'what' }, r.key + ' key · ' + r.what)))));
  }

  /* ---------- fees ---------- */
  const isRfq = (f) => f.schedule.startsWith('RFQ');
  const takerFee = (c, p, n) => c * p * (1 - p) * n * 0.01;
  const ticks = (g) => Math.round((g.to_price - g.from_price) / g.step) + 1;
  const bookFees = () => D.fees.filter((f) => !isRfq(f));

  const cSched = $('#c-sched'), cPrice = $('#c-price'), cQty = $('#c-qty'), cLive = $('#c-live');
  function initCalc() {
    cSched.replaceChildren(...bookFees().map((f, i) => new Option(f.schedule, String(i))));
    [cSched, cPrice, cQty, cLive].forEach((n) => n.addEventListener('input', drawCalc));
    drawCalc();
  }
  function drawCalc() {
    const f = bookFees()[Number(cSched.value) || 0];
    const p = Number(cPrice.value), n = Math.floor(Number(cQty.value));
    const out = $('#c-out');
    if (!f || !(p > 0 && p < 1) || !(n >= 1)) {
      out.replaceChildren(el('div', { class: 'warn' }, 'Enter a price between 0.001 and 0.999 and at least 1 contract.'));
      return;
    }
    const liveOnly = f.charged.toLowerCase().startsWith('only while live');
    const charged = !liveOnly || cLive.checked;
    // Novig rounds fees half up to the millicent ($0.00001).
    const fee = charged ? Math.round(takerFee(f.coefficient, p, n) * 100000 + 1e-9) / 100000 : 0;
    const credit = fee * f.maker_credit;
    const cost = p * n * 0.01;
    const onGrid = D.price_grid.some((g) => p >= g.from_price - 1e-9 && p <= g.to_price + 1e-9
      && Math.abs(((p - g.from_price) / g.step) - Math.round((p - g.from_price) / g.step)) < 1e-6);
    const box = (lbl, v) => el('div', {}, el('div', { class: 'lbl' }, lbl), el('div', { class: 'num' }, v));
    out.replaceChildren(
      box('Cost of the contracts', usd(cost)),
      box('Taker fee', usd(fee, 5)),
      box('Fee as % of cost', cost ? (fee / cost * 100).toFixed(2) + '%' : '—'),
      box('Maker credit', usd(credit, 5)),
      ...(charged ? [] : [el('div', { class: 'warn' }, 'This schedule only charges while the event is live, so a pre-game fill is free.')]),
      ...(onGrid ? [] : [el('div', { class: 'warn' }, `${p} isn't on the price grid, so the API would reject it with INVALID_PRICE.`)]));
  }

  function drawCurve() {
    const box = $('#chart-curve'), leg = $('#curve-legend');
    box.replaceChildren();
    const W = box.clientWidth;
    if (!W) return;
    const H = 224, top = 8, bottom = 24;
    const cs = [...new Set(bookFees().map((f) => f.coefficient))];
    const lines = cs.map((c) => ({
      c,
      name: bookFees().filter((f) => f.coefficient === c).map((f) => f.schedule).join(' · ') + ` (c = ${c})`,
      pts: Array.from({ length: 99 }, (_, i) => { const p = (i + 1) / 100; return { p, v: takerFee(c, p, 1000) }; }),
    }));
    leg.replaceChildren(...lines.map((l, i) => el('span', { style: `--sw:${color(i)}` }, l.name)));
    const maxV = Math.max(...lines.flatMap((l) => l.pts.map((d) => d.v))) * 1.1;
    const step = maxV > 0.1 ? 0.05 : 0.02;
    const yMax = Math.ceil(maxV / step) * step;
    const yTicks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
    const svg = svgEl('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}` });
    box.append(svg);
    const meas = svgEl('text', { 'font-size': 12 }); svg.append(meas);
    const ml = Math.max(...yTicks.map((t) => { meas.textContent = usd(t); return meas.getComputedTextLength(); })) + 10;
    meas.remove();
    const x = (p) => ml + p * (W - 12 - ml);
    const y = (v) => H - bottom - (v / yMax) * (H - bottom - top);
    yTicks.forEach((t) => {
      const ln = svgEl('line', { x1: ml, x2: W - 12, y1: y(t), y2: y(t) }); ln.style.stroke = t === 0 ? css('--axis') : css('--grid');
      const tx = svgEl('text', { x: ml - 8, y: y(t), dy: '0.35em', 'text-anchor': 'end', 'font-size': 12 }); tx.style.fill = css('--muted'); tx.textContent = usd(t);
      svg.append(ln, tx);
    });
    (W < 380 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).forEach((t) => {
      const tx = svgEl('text', { x: x(t), y: H - 6, 'text-anchor': t === 0 ? 'start' : t === 1 ? 'end' : 'middle', 'font-size': 12 });
      tx.style.fill = css('--muted'); tx.textContent = t.toFixed(2); svg.append(tx);
    });
    lines.forEach((l, i) => {
      const path = svgEl('path', { d: 'M' + l.pts.map((d) => `${x(d.p).toFixed(1)},${y(d.v).toFixed(1)}`).join('L'), fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      path.style.stroke = color(i); svg.append(path);
    });
    const rule = svgEl('line', { y1: top, y2: H - bottom }); rule.style.stroke = css('--axis'); rule.style.display = 'none';
    const dots = lines.map((l, i) => { const d = svgEl('circle', { r: 4 }); d.style.fill = color(i); d.style.display = 'none'; return d; });
    const hit = svgEl('rect', { x: ml, y: 0, width: Math.max(0, W - 12 - ml), height: H - bottom, fill: 'transparent' });
    svg.append(rule, ...dots, hit);
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (W / r.width);
      const p = Math.min(0.99, Math.max(0.01, Math.round(((mx - ml) / (W - 12 - ml)) * 100) / 100));
      rule.setAttribute('x1', x(p)); rule.setAttribute('x2', x(p)); rule.style.display = '';
      const vals = lines.map((l, i) => {
        const v = takerFee(l.c, p, 1000);
        dots[i].setAttribute('cx', x(p)); dots[i].setAttribute('cy', y(v)); dots[i].style.display = '';
        return [color(i), `c = ${l.c}: ${usd(v, 4)}`];
      });
      showTip(e, `Price ${p.toFixed(2)} · per 1,000 contracts`, vals);
    });
    hit.addEventListener('mouseleave', () => { hideTip(); rule.style.display = 'none'; dots.forEach((d) => { d.style.display = 'none'; }); });
  }

  function drawGrid() {
    const box = $('#chart-grid');
    box.replaceChildren();
    const W = box.clientWidth;
    if (!W) return;
    const H = 96;
    const x = (p) => 8 + p * (W - 16);
    const svg = svgEl('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}` });
    box.append(svg);
    D.price_grid.forEach((g, i) => {
      const n = ticks(g);
      const grp = svgEl('g');
      for (let k = 0; k < n; k++) {
        const px = x(g.from_price + k * g.step);
        const ln = svgEl('line', { x1: px, x2: px, y1: 18, y2: 50 }); ln.style.stroke = color(i); ln.style.opacity = 0.8; grp.append(ln);
      }
      const hit = svgEl('rect', { x: x(g.from_price) - 2, y: 14, width: Math.max(4, x(g.to_price) - x(g.from_price) + 4), height: 40, fill: 'transparent' });
      hit.addEventListener('mousemove', (e) => showTip(e, g.band, [[color(i), `${p3(g.from_price)} to ${p3(g.to_price)}, step ${p3(g.step)}`], [null, `${int.format(n)} prices`]]));
      hit.addEventListener('mouseleave', hideTip);
      grp.append(hit);
      svg.append(grp);
    });
    const axis = svgEl('line', { x1: x(0), x2: x(1), y1: 58, y2: 58 }); axis.style.stroke = css('--axis'); svg.append(axis);
    (W < 380 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).forEach((t) => {
      const tx = svgEl('text', { x: x(t), y: 76, 'text-anchor': t === 0 ? 'start' : t === 1 ? 'end' : 'middle', 'font-size': 12 });
      tx.style.fill = css('--muted'); tx.textContent = t.toFixed(2); svg.append(tx);
    });
  }

  /* ---------- charts per tab ---------- */
  function drawGroups() {
    const n = {};
    D.routes.forEach((r) => { n[r.group] = (n[r.group] || 0) + 1; });
    const rows = Object.keys(n).map((group) => ({ group, n: n[group] })).sort((a, b) => b.n - a.n);
    hbar($('#chart-groups'), rows, {
      label: (d) => d.group, value: (d) => d.n, fmt: (v) => int.format(v),
      fill: () => color(0), tipText: (d) => `${int.format(d.n)} routes`,
      active: () => groupFilter,
      onClick: (d) => { groupFilter = groupFilter === d.group ? '' : d.group; drawRoutes(); drawGroups(); },
    });
  }
  function drawWs() {
    const kinds = [...new Set(D.ws_channels.map((r) => r.applies_to))];
    const c = (k) => color(kinds.indexOf(k));
    $('#ws-legend').replaceChildren(...kinds.map((k) => el('span', { style: `--sw:${c(k)}` }, k)));
    hbar($('#chart-ws'), D.ws_channels, {
      label: (d) => d.channel, value: (d) => d.weight, fmt: (v) => int.format(v) + ' tok',
      fill: (d) => c(d.applies_to), tipText: (d) => d.carries,
    });
  }
  function drawCharts() {
    if (!D.routes) return;
    if (current === 'routes') drawGroups();
    if (current === 'limits') drawWs();
    if (current === 'fees') { drawCurve(); drawGrid(); }
  }
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 120); });

  /* ---------- load ---------- */
  Promise.all(DATA.map((name) => fetch(`data/${name}.json`, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`data/${name}.json: ${r.status}`); return r.json(); })
    .then((j) => { D[name] = j; })))
    .then(() => {
      drawHeader();
      drawRoutes();
      drawTables();
      initCalc();
      const start = location.hash.slice(1);
      show(tabs.some((t) => t.dataset.page === start) ? start : 'routes', false);
    })
    .catch((err) => {
      $('#takeaway').replaceChildren(el('span', { class: 'fail' }, 'Couldn’t load the API data. ' + err.message));
      console.error(err);
    });
})();
