/* Markets tab: live prices from Novig's public, keyless routes (api.novig.com/v3/public).
   Every price shown comes from an order book fetched in this browser. */
(() => {
  'use strict';

  const API = 'https://api.novig.com/v3/public';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c))); });
    return n;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
  };

  /* ---------- rate-limited fetch ----------
     The public throttle is per IP, roughly a 10-request burst refilling ~2/s.
     Browsers can't read Retry-After here, so a 429 waits 1.5 s and retries. */
  const bucket = { tokens: 6, cap: 6, rate: 1.8, last: performance.now() };
  // Local live mode (your key, via local/server.mjs): the signed read bucket is 64 burst, 16/s.
  const LIVE = { restDown: false, keyProblem: '', on: false, client: null, max: 30, es: null, watching: [], ws: 'idle', error: '', streaming: 0, last: null };
  const queue = [];
  let pumping = false;
  function take() {
    const now = performance.now();
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate);
    bucket.last = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
    return ((1 - bucket.tokens) / bucket.rate) * 1000;
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const wait = take();
      if (wait) { await sleep(wait); continue; }
      const job = queue.shift();
      run(job);
    }
    pumping = false;
  }
  async function run(job) {
    try {
      const useKey = LIVE.on && !LIVE.restDown;
      const res = await fetch((useKey ? '/local/api/v3' : API) + job.path, { cache: 'no-store' });
      if (res.status === 429 && job.tries < 4) {
        job.tries += 1;
        bucket.tokens = Math.min(bucket.tokens, 0);
        await sleep(1500);
        queue.unshift(job);
        pump();
        return;
      }
      if (!res.ok) {
        let code = '';
        let message = '';
        try { const j = await res.json(); code = j.code || ''; message = j.message || ''; } catch { /* not json */ }
        if (useKey && res.status !== 404) {
          // Novig refused the keyed request: fall back to the public routes so prices still show.
          LIVE.restDown = true;
          LIVE.keyProblem = `${res.status}${code ? ' ' + code : ''}${message ? ': ' + message.slice(0, 120) : ''}`;
          Object.assign(bucket, { tokens: Math.min(bucket.tokens, 6), cap: 6, rate: 1.8 });
          liveStatus();
          queue.unshift(job);
          pump();
          return;
        }
        throw new Error(`${res.status}${code ? ' ' + code : ''}${message && LIVE.on ? ': ' + message.slice(0, 120) : ''}`);
      }
      job.resolve(await res.json());
    } catch (err) {
      job.reject(err);
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = (path, front = false) => new Promise((resolve, reject) => {
    const job = { path, resolve, reject, tries: 0 };
    if (front) queue.unshift(job); else queue.push(job);
    pump();
  });

  async function pages(path, max = 4) {
    const out = [];
    let after = null;
    for (let i = 0; i < max; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await api(path + (after ? `${sep}after=${encodeURIComponent(after)}` : ''));
      out.push(...(page.items || []));
      if (!page.next) break;
      after = page.next;
    }
    return out;
  }

  /* ---------- prices ---------- */
  const num = (s) => Number(s);
  const cents = (p) => (p * 100).toFixed(p * 100 % 1 ? 1 : 0) + '¢';
  function american(p) {
    if (!(p > 0 && p < 1)) return '—';
    return p >= 0.5 ? '−' + Math.round((100 * p) / (1 - p)) : '+' + Math.round((100 * (1 - p)) / p);
  }
  const money = (v) => (v >= 1000 ? '$' + new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : '$' + v.toFixed(v < 10 ? 2 : 0));

  /* A book holds resting BUY orders per outcome, best (highest) price first.
     Buying outcome A now matches the best resting buy of B at price q, so A costs 1 − q.
     Each contract pays $0.01 if it wins. */
  function levels(orders) {
    const by = new Map();
    (orders || []).forEach((o) => { const p = num(o.price); by.set(p, (by.get(p) || 0) + o.qty); });
    return [...by.entries()].map(([price, qty]) => ({ price, qty })).sort((a, b) => b.price - a.price);
  }
  function quote(market, book) {
    const outs = market.outcomes || [];
    const lv = Object.fromEntries(outs.map((o) => [o.outcomeId, levels(book && book.orders ? book.orders[o.outcomeId] : [])]));
    return outs.map((o) => {
      const others = outs.filter((x) => x.outcomeId !== o.outcomeId);
      const bid = lv[o.outcomeId][0] || null;
      let ask = null;
      if (others.length === 1) {
        const ob = lv[others[0].outcomeId][0];
        if (ob) ask = { price: Math.round((1 - ob.price) * 1000) / 1000, qty: ob.qty };
      }
      return { outcome: o, bid, ask, levels: lv[o.outcomeId] };
    });
  }

  /* Gap = 1 − (best bid on side A) − (best bid on side B): the spread you'd pay to buy one side
     and immediately buy the other. One price step (0.5¢ in the middle of the grid) is as tight as it gets. */
  function gapOf(m, book) {
    if (!m || !book || !m.outcomes || m.outcomes.length !== 2) return null;
    const [a, b] = m.outcomes.map((o) => levels(book.orders ? book.orders[o.outcomeId] : [])[0] || null);
    if (!a || !b) return { oneSided: true, a, b, cents: null };
    return { oneSided: false, a, b, cents: Math.round((1 - a.price - b.price) * 1000) / 10 };
  }
  const gapText = (c) => (Number.isInteger(c) ? c : c.toFixed(1)) + '¢';
  const isWide = (g) => g && !g.oneSided && g.cents > S.threshold + 1e-9;

  /* ---------- state ---------- */
  const S = {
    started: false,
    league: store.get('nv-league') || 'NFL',
    view: 'games',
    term: '',
    events: [],
    money: new Map(), // eventId -> MONEY market
    books: new Map(), // marketId -> { book, at }
    open: new Set(),
    eventMarkets: new Map(), // eventId -> markets[]
    openBook: null,
    openMarket: null,
    loadedAt: null,
    auto: null,
    loading: false,
    gen: 0,
    problem: '',
    threshold: Number(store.get('nv-gap')) >= 0 && store.get('nv-gap') !== null ? Number(store.get('nv-gap')) : 0.5,
    autoOn: true,
    pollGen: 0,
    inflight: new Set(),
    oneSided: false,
    moreOpen: new Set(), // "<eventId>:<type>" whose "Other lines" fold-out is open
    mkEvent: new Map(), // marketId -> eventId, for markets of opened events
    dirtyEvents: new Set(),
    scan: { markets: [], loaded: false, loading: false, scope: store.get('nv-scope') || 'main', league: '', error: '' },
  };

  const root = $('#markets');
  const list = $('#mk-list');
  const status = $('#mk-status');
  const leagueSel = $('#mk-league');
  const search = $('#mk-q');

  const isGame = (e) => e.description.includes(' @ ') || e.description.includes(' vs ');
  const isOpen = (e) => !/FINAL|CANCEL|VOID|SETTLED|CLOSED/i.test(e.status || '');
  const when = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const day = sameDay ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return day + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  function setStatus(text, bad = false) {
    status.textContent = text;
    status.classList.toggle('fail', bad);
  }

  /* ---------- loading ---------- */
  async function loadLeagues() {
    try {
      const leagues = await api('/types/leagues', true);
      leagueSel.replaceChildren(...leagues.map((l) => new Option(l, l)));
      if (!leagues.includes(S.league)) S.league = leagues[0];
      leagueSel.value = S.league;
    } catch (err) {
      leagueSel.replaceChildren(new Option(S.league, S.league));
      S.problem = `Couldn’t load the league list (${err.message}).`;
      liveStatus();
    }
  }

  async function loadLeague() {
    const gen = ++S.gen;
    S.loading = true;
    S.events = []; S.money.clear(); S.open.clear(); S.eventMarkets.clear(); S.openBook = null;
    S.scan = { markets: [], loaded: false, loading: false, scope: S.scan.scope, league: S.league, error: '' };
    draw();
    setStatus(`Loading ${S.league}…`);
    try {
      const lg = encodeURIComponent(S.league);
      const [events, money] = await Promise.all([
        pages(`/catalog/events?league=${lg}&limit=500`),
        pages(`/catalog/markets?league=${lg}&marketType=MONEY&limit=500`),
      ]);
      if (gen !== S.gen) return;
      S.events = events.filter(isOpen).sort((a, b) => a.startsTs - b.startsTs);
      if (S.problem.startsWith('Couldn’t load ' + S.league) || S.problem.startsWith('Couldn’t load the league')) S.problem = '';
      money.forEach((m) => { if (m.status === 'OPEN' && !S.money.has(m.eventId)) S.money.set(m.eventId, m); });
      S.loading = false;
      draw();
      if (S.view === 'gaps') ensureScan();
      await refreshBooks(gen);
    } catch (err) {
      if (gen !== S.gen) return;
      S.loading = false;
      draw();
      if (LIVE.on) { S.problem = `Couldn’t load ${S.league} from Novig (${err.message}).`; liveStatus(); }
      else setStatus(`Couldn’t reach Novig (${err.message}). Check your connection and try Refresh.`, true);
    }
  }

  function visibleEvents() {
    const t = S.term.trim().toLowerCase();
    return S.events.filter((e) => (S.view === 'futures' ? !isGame(e) : isGame(e)) && (!t || e.description.toLowerCase().includes(t)));
  }

  async function refreshBooks(gen = S.gen) {
    if (S.loading || gen !== S.gen) return;
    if (S.autoOn) { draw(); watch(); startPolling(); return; }
    const targets = [...new Set(candidates())].map((marketId) => ({ marketId }));
    const total = targets.length;
    if (!total) { stamp(); return; }
    let done = 0;
    setStatus(`Loading prices… 0 of ${total}`);
    await Promise.all(targets.map((m) => getBook(m.marketId).then(() => {
      if (gen !== S.gen) return;
      done += 1;
      setStatus(`Loading prices… ${done} of ${total}`);
      drawRowPrices(m.marketId);
    }).catch(() => { done += 1; })));
    if (gen !== S.gen) return;
    stamp();
    draw();
    watch();
  }

  async function getBook(marketId) {
    const book = await api(`/catalog/markets/${marketId}/book?depth=20`);
    S.books.set(marketId, { book, at: Date.now() });
    return book;
  }

  const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function stamp() {
    S.loadedAt = new Date();
    if (LIVE.on) return liveStatus();
    setStatus(`Prices as of ${clock(S.loadedAt)} · public data, no key`);
  }
  function liveStatus() {
    if (!LIVE.on) return;
    const badge = $('#mk-mode');
    if (S.problem) {
      badge.textContent = 'Your key';
      badge.className = 'mode';
      status.classList.add('fail');
      status.replaceChildren(S.problem + ' ', el('a', { href: '/local/diag', target: '_blank', rel: 'noopener' }, 'Run diagnostics'), '. The black server window shows the details too.');
      return;
    }
    if (LIVE.restDown && LIVE.ws !== 'live') {
      badge.textContent = 'Public';
      badge.className = 'mode';
      status.classList.add('fail');
      status.replaceChildren(`Novig refused your key (${LIVE.keyProblem}), so these are public prices${S.loadedAt ? ' as of ' + clock(S.loadedAt) : ''}. `, el('a', { href: '/local/diag', target: '_blank', rel: 'noopener' }, 'Run diagnostics'), '.');
      return;
    }
    if (LIVE.ws === 'live') {
      badge.textContent = 'Live';
      badge.className = 'mode on';
      const joining = LIVE.waiting ? ` · ${LIVE.waiting} more joining as Novig's stream limit allows (about 1 every 4s)` : '';
      setStatus(`Streaming ${LIVE.streaming} market${LIVE.streaming === 1 ? '' : 's'} live${joining}${LIVE.last ? ' · last change ' + clock(LIVE.last) : ''}${S.autoOn && S.pending ? ` · ${S.pending} others refreshed about every ${S.cycle || 1}s` : ''}`);
    } else {
      badge.textContent = 'Your key';
      badge.className = 'mode';
      setStatus(`Using your key · stream ${LIVE.ws === 'connecting' ? 'connecting…' : 'reconnecting' + (LIVE.error ? ' (' + LIVE.error + ')' : '')}${S.loadedAt ? ' · prices as of ' + clock(S.loadedAt) : ''}`, LIVE.ws === 'down');
    }
  }

  async function toggleEvent(e) {
    if (S.open.has(e.eventId)) { S.open.delete(e.eventId); draw(); return; }
    S.open.add(e.eventId);
    draw();
    if (!S.eventMarkets.has(e.eventId)) {
      try {
        const ms = await pages(`/catalog/markets?event=${e.eventId}&limit=500`, 2);
        const open = ms.filter((m) => m.eventId === e.eventId && m.status === 'OPEN');
        S.eventMarkets.set(e.eventId, open);
        open.forEach((m) => S.mkEvent.set(m.marketId, e.eventId));
        if (isTennis(e)) {
          watch();
          if (S.autoOn) startPolling();
          else open.filter((m) => TENNIS_TYPES.includes(m.marketType)).forEach((m) => getBook(m.marketId).then(() => markDirty(m.marketId)).catch(() => {}));
        }
      } catch (err) {
        S.eventMarkets.set(e.eventId, { error: err.message });
      }
      draw();
    }
  }

  async function openBook(m) {
    S.openBook = S.openBook === m.marketId ? null : m.marketId;
    S.openMarket = S.openBook ? m : null;
    draw();
    watch();
    if (S.openBook && !S.books.has(m.marketId)) {
      try { await getBook(m.marketId); } catch (err) { S.books.set(m.marketId, { error: err.message, at: Date.now() }); }
      draw();
    }
  }

  /* ---------- drawing ---------- */
  function priceCell(q) {
    if (!q) return el('div', { class: 'px empty-px' }, '—');
    const buy = q.ask;
    return el('div', { class: 'px' },
      el('div', { class: 'px-name' }, q.outcome.name),
      buy
        ? el('div', { class: 'px-main' }, el('b', {}, american(buy.price)), ' ', el('span', { class: 'px-c' }, cents(buy.price)))
        : el('div', { class: 'px-main muted' }, 'No offer'),
      buy ? el('div', { class: 'px-sub', title: 'Total payout of the contracts offered at this price' }, money(buy.qty * 0.01) + ' max payout') : el('div', { class: 'px-sub' }, q.bid ? 'Best bid ' + cents(q.bid.price) : ' '));
  }

  function eventRow(e) {
    const m = S.money.get(e.eventId);
    const b = m && S.books.get(m.marketId);
    const quotes = m && b && b.book ? quote(m, b.book) : null;
    const live = /INGAME|LIVE/i.test(e.status || '');
    const open = S.open.has(e.eventId);
    const head = el('div', { class: 'ev-head', role: 'button', tabindex: '0', 'aria-expanded': String(open),
      onclick: () => toggleEvent(e), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleEvent(e); } } },
      el('div', { class: 'ev-main' },
        el('div', { class: 'ev-title' }, e.description),
        el('div', { class: 'ev-when' }, live ? el('span', { class: 'live' }, 'Live') : '', when(e.startsTs), m ? gapChip(m, b) : '')),
      el('div', { class: 'ev-prices', 'data-market': m ? m.marketId : '' },
        m ? (quotes ? quotes.slice(0, 2).map(priceCell) : [el('div', { class: 'px loading-px' }, el('span', { class: 'skel' }, 'loading')), el('div', { class: 'px loading-px' }, el('span', { class: 'skel' }, 'loading'))])
          : el('div', { class: 'px-sub muted' }, S.view === 'games' ? 'No moneyline' : 'Open for markets')),
      el('div', { class: 'chev', 'aria-hidden': 'true' }, open ? '▴' : '▾'));
    const card = el('div', { class: 'ev' + (open ? ' open' : ''), id: 'ev-' + e.eventId }, head);
    if (open) card.append(eventDetail(e));
    return card;
  }

  function gapChip(m, b) {
    const g = b && b.book ? gapOf(m, b.book) : null;
    const chip = el('span', { class: 'gap' + (isWide(g) ? ' wide' : ''), 'data-gap': m.marketId, title: 'Gap: 1 − both sides’ best bids' });
    if (g) chip.textContent = g.oneSided ? 'one side empty' : 'Gap ' + gapText(g.cents);
    return chip;
  }

  /* ---------- tennis: Moneyline, Spread, Total; tightest lines first ---------- */
  const TENNIS_TYPES = ['MONEY', 'SPREAD', 'TOTAL'];
  const isTennis = (e) => /TENNIS/i.test(e.sport || '') || /^(ATP|WTA)$/i.test(e.league || '');
  function widthOf(m) {
    const b = S.books.get(m.marketId);
    if (!b || !b.book) return { known: false };
    const g = gapOf(m, b.book);
    if (!g) return { known: false };
    return g.oneSided ? { known: true, oneSided: true, cents: Infinity } : { known: true, oneSided: false, cents: g.cents };
  }
  function widthChip(m) {
    const w = widthOf(m);
    const chip = el('span', { class: 'gap w' + (w.known && !w.oneSided && w.cents > S.threshold + 1e-9 ? ' wide' : ''), title: 'Market width: 1 − both sides’ best bids' });
    chip.textContent = !w.known ? 'width …' : w.oneSided ? 'one-sided' : 'Width ' + gapText(w.cents);
    return chip;
  }
  function markDirty(marketId) {
    const ev = S.mkEvent.get(marketId);
    if (ev && S.open.has(ev)) S.dirtyEvents.add(ev);
  }
  function tennisMarkets(eventId) {
    const ms = S.eventMarkets.get(eventId);
    return Array.isArray(ms) ? ms.filter((m) => TENNIS_TYPES.includes(m.marketType)) : [];
  }
  // The lines tied for the narrowest width, and the rest.
  function splitTight(ms) {
    const known = ms.map((m) => ({ m, w: widthOf(m) }));
    const widths = known.filter((x) => x.w.known && !x.w.oneSided).map((x) => x.w.cents);
    if (!widths.length) return { min: null, tight: [], rest: ms };
    const min = Math.min(...widths);
    const tight = known.filter((x) => x.w.known && !x.w.oneSided && Math.abs(x.w.cents - min) < 1e-9).map((x) => x.m);
    return { min, tight, rest: ms.filter((m) => !tight.includes(m)) };
  }
  const byStrike = (a, b) => (num(a.strike) || 0) - (num(b.strike) || 0) || a.description.localeCompare(b.description);

  function tennisDetail(e, ms) {
    const pick = (t) => ms.filter((m) => m.marketType === t).sort(byStrike);
    const loaded = (list) => list.filter((m) => widthOf(m).known).length;
    const section = (title, list, ladder, type) => {
      if (!list.length) return null;
      const head = (extra) => el('div', { class: 'tn-h' }, el('b', {}, title), el('span', { class: 'muted' }, extra));
      if (!ladder) return el('div', { class: 'tn-sec' }, head(''), el('div', { class: 'mk-rows' }, list.map((m) => marketRow(m))));
      const { min, tight, rest } = splitTight(list);
      const key = e.eventId + ':' + type;
      const n = loaded(list);
      const note = min === null
        ? (n < list.length ? ` · loading widths ${n} of ${list.length}` : ' · no two-sided lines')
        : ` · tightest ${gapText(min)}${tight.length > 1 ? ` (${tight.length} lines tied)` : ''}${n < list.length ? ` · ${n} of ${list.length} loaded` : ''}`;
      const more = el('details', { class: 'tn-more', open: S.moreOpen.has(key) ? true : null },
        el('summary', {}, `Other lines (${rest.length})`),
        el('div', { class: 'mk-rows' }, rest.map((m) => marketRow(m))));
      more.addEventListener('toggle', () => { if (more.open) S.moreOpen.add(key); else S.moreOpen.delete(key); });
      return el('div', { class: 'tn-sec' }, head(note),
        tight.length ? el('div', { class: 'mk-rows' }, tight.map((m) => marketRow(m))) : el('div', { class: 'mk-rows' }, el('div', { class: 'tn-wait muted' }, el('span', { class: 'skel' }, 'Finding the tightest line'))),
        rest.length ? more : null);
    };
    const parts = [section('Moneyline', pick('MONEY'), false, 'MONEY'), section('Spread', pick('SPREAD'), true, 'SPREAD'), section('Total', pick('TOTAL'), true, 'TOTAL')].filter(Boolean);
    return el('div', { class: 'ev-body', 'data-body': e.eventId },
      parts.length ? parts : el('p', { class: 'muted note' }, 'No moneyline, spread or total markets open.'));
  }

  function eventDetail(e) {
    const ms = S.eventMarkets.get(e.eventId);
    if (!ms) return el('div', { class: 'ev-body' }, el('span', { class: 'skel' }, 'Loading markets for this event'));
    if (ms.error) return el('div', { class: 'ev-body fail' }, 'Couldn’t load markets: ' + ms.error);
    if (!ms.length) return el('div', { class: 'ev-body muted' }, 'No open markets.');
    if (isTennis(e)) return tennisDetail(e, ms);
    const groups = new Map();
    ms.forEach((m) => { if (!groups.has(m.marketType)) groups.set(m.marketType, []); groups.get(m.marketType).push(m); });
    const order = ['MONEY', 'SPREAD', 'TOTAL', 'TEAM_TOTAL'];
    const keys = [...groups.keys()].sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99) || a.localeCompare(b));
    return el('div', { class: 'ev-body' },
      el('p', { class: 'note' }, `${ms.length} open markets. Click one to load its order book.`),
      keys.map((k) => el('details', { class: 'mk-group', open: k === 'MONEY' || k === 'SPREAD' || k === 'TOTAL' ? true : null },
        el('summary', {}, pretty(k), el('span', { class: 'muted' }, ' · ' + groups.get(k).length)),
        el('div', { class: 'mk-rows' }, groups.get(k)
          .sort((a, b) => (num(a.strike) || 0) - (num(b.strike) || 0) || a.description.localeCompare(b.description))
          .map((m) => marketRow(m))))));
  }

  const pretty = (t) => t.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).replace(/\b(1h|2h|1q|nfl|nba)\b/gi, (x) => x.toUpperCase());

  function marketRow(m) {
    const isOpenBook = S.openBook === m.marketId;
    const b = S.books.get(m.marketId);
    const qs = b && b.book ? quote(m, b.book) : null;
    const row = el('div', { class: 'mk' + (isOpenBook ? ' sel' : '') },
      el('button', { class: 'mk-btn', type: 'button', 'aria-expanded': String(isOpenBook), onclick: () => openBook(m) },
        el('span', { class: 'mk-desc' }, m.description, m.outcomes && m.outcomes.length === 2 && (b || S.mkEvent.has(m.marketId)) ? widthChip(m) : ''),
        qs ? el('span', { class: 'mk-q' }, qs.map((q) => `${q.outcome.name} ${q.ask ? american(q.ask.price) : '—'}`).join('  ·  ')) : el('span', { class: 'mk-q muted' }, isOpenBook ? 'Loading…' : 'Show book')));
    if (isOpenBook) row.append(bookView(m, b));
    return row;
  }

  function bookView(m, b) {
    if (!b) return el('div', { class: 'book' }, el('span', { class: 'skel' }, 'Loading order book'));
    if (b.error) return el('div', { class: 'book fail' }, 'Couldn’t load the book: ' + b.error);
    const qs = quote(m, b.book);
    const maxQty = Math.max(1, ...qs.flatMap((q) => q.levels.map((l) => l.qty)));
    const fee = m.fee ? `Taker fee c = ${m.fee.coefficient}, ${m.fee.charged === 'WHEN_LIVE' ? 'charged only while live' : 'always charged'}.` : '';
    return el('div', { class: 'book' },
      el('div', { class: 'book-cols' }, qs.map((q, i) => el('div', { class: 'book-col' },
        el('div', { class: 'book-h' },
          el('b', {}, q.outcome.name),
          el('span', { class: 'muted' }, q.ask ? ` buy now ${cents(q.ask.price)} (${american(q.ask.price)})` : ' no offer')),
        q.levels.length
          ? el('table', { class: 'table book-t' },
            el('thead', {}, el('tr', {}, el('th', {}, 'Bid'), el('th', { class: 'n' }, 'Contracts'), el('th', { class: 'n' }, 'Pays'))),
            el('tbody', {}, q.levels.map((l) => el('tr', {},
              el('td', {}, el('div', { class: 'depth' }, el('i', { style: `width:${Math.max(3, (l.qty / maxQty) * 100)}%;background:var(${i ? '--accent-2' : '--accent'})` }), el('span', {}, cents(l.price)))),
              el('td', { class: 'n' }, new Intl.NumberFormat('en').format(l.qty)),
              el('td', { class: 'n' }, money(l.qty * 0.01))))))
          : el('p', { class: 'muted note' }, 'No resting bids.')))),
      el('p', { class: 'note' }, `Bids are resting orders to buy that side. Buying one side now fills against the other side's best bid, so its price is 1 − that bid. Each contract pays $0.01. ${fee} ${b.live ? 'Live, updated ' : 'Snapshot from '}${new Date(b.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`));
  }

  function drawEventBody(eventId) {
    const card = list.querySelector(`#ev-${CSS.escape(eventId)}`);
    const e = S.events.find((x) => x.eventId === eventId);
    if (!card || !e || !S.open.has(eventId)) return;
    const old = card.querySelector('.ev-body');
    const fresh = eventDetail(e);
    if (old) old.replaceWith(fresh); else card.append(fresh);
  }

  function drawRowPrices(marketId) {
    const slot = list.querySelector(`.ev-prices[data-market="${marketId}"]`);
    if (!slot) return;
    const ev = S.events.find((e) => { const m = S.money.get(e.eventId); return m && m.marketId === marketId; });
    if (!ev) return;
    const m = S.money.get(ev.eventId);
    const b = S.books.get(marketId);
    if (!(b && b.book)) return;
    const before = [...slot.querySelectorAll('.px-main')].map((n) => n.textContent);
    const cells = quote(m, b.book).slice(0, 2).map(priceCell);
    cells.forEach((c, i) => { if (before.length && before[i] !== undefined && c.querySelector('.px-main') && c.querySelector('.px-main').textContent !== before[i]) c.classList.add('flash'); });
    slot.replaceChildren(...cells);
    const chip = list.querySelector(`.gap[data-gap="${marketId}"]`);
    if (chip) chip.replaceWith(gapChip(m, b));
  }

  function draw() {
    const scrollY = window.scrollY;
    if (S.loading) {
      list.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'ev' }, el('div', { class: 'ev-head' }, el('div', { class: 'ev-main' }, el('span', { class: 'skel' }, 'Loading event name here'))))));
      return;
    }
    $('#mk-gapbar').hidden = S.view !== 'gaps';
    if (S.view === 'gaps') { drawGaps(); window.scrollTo(0, scrollY); return; }
    const evs = visibleEvents();
    $('#mk-count').textContent = `${evs.length} ${S.view === 'games' ? (evs.length === 1 ? 'game' : 'games') : 'futures'}`;
    list.replaceChildren(...(evs.length ? evs.map(eventRow) : [el('div', { class: 'empty' }, S.events.length ? 'Nothing matches.' : `No open ${S.league} events right now.`)]));
    drawLiveMarks();
    window.scrollTo(0, scrollY);
  }

  /* ---------- gap scanner ---------- */
  const eventName = (id) => { const e = S.events.find((x) => x.eventId === id); return e ? e.description : ''; };
  async function ensureScan() {
    const sc = S.scan;
    if (sc.loaded || sc.loading || S.loading) return;
    sc.loading = true; sc.error = '';
    const gen = S.gen;
    drawGaps();
    try {
      const types = sc.scope === 'main' ? '&marketType=MONEY,SPREAD,TOTAL' : '';
      const ms = await pages(`/catalog/markets?league=${encodeURIComponent(S.league)}${types}&limit=1000`, 12);
      if (gen !== S.gen) return;
      const live = new Set(S.events.map((e) => e.eventId));
      sc.markets = ms.filter((m) => m.status === 'OPEN' && m.outcomes && m.outcomes.length === 2 && live.has(m.eventId));
      sc.loaded = true;
    } catch (err) {
      sc.error = err.message;
    }
    sc.loading = false;
    drawGaps();
    startPolling();
  }

  function gapRows() {
    const t = S.term.trim().toLowerCase();
    const rows = [];
    for (const m of S.scan.markets) {
      const b = S.books.get(m.marketId);
      if (!b || !b.book) continue;
      const g = gapOf(m, b.book);
      if (!g || !(isWide(g) || (S.oneSided && g.oneSided))) continue;
      const ev = eventName(m.eventId);
      if (t && !(ev + ' ' + m.description).toLowerCase().includes(t)) continue;
      rows.push({ m, b, g, ev });
    }
    rows.sort((x, y) => (x.g.oneSided - y.g.oneSided) || ((y.g.cents || 0) - (x.g.cents || 0)) || (x.m.startsTs - y.m.startsTs));
    return rows;
  }

  function sideCell(o, lvl, other) {
    const buy = other ? Math.round((1 - other.price) * 1000) / 1000 : null;
    return el('td', { class: 'side' },
      el('div', {}, el('b', {}, o.name)),
      el('div', {}, buy !== null ? `Buy ${cents(buy)} (${american(buy)})` : 'No offer'),
      el('div', { class: 'muted' }, lvl ? `Bid ${cents(lvl.price)} × ${new Intl.NumberFormat('en', { notation: 'compact' }).format(lvl.qty)}` : 'No bid'));
  }

  function drawGaps() {
    if (S.view !== 'gaps') return;
    const sc = S.scan;
    const scanned = sc.markets.filter((m) => S.books.has(m.marketId)).length;
    const rows = sc.loaded ? gapRows() : [];
    $('#mk-count').textContent = sc.loaded ? `${rows.length} market${rows.length === 1 ? '' : 's'} with a gap over ${gapText(S.threshold)}` : '';
    $('#mk-scan').textContent = sc.error ? `Couldn’t load markets (${sc.error})` : sc.loading ? 'Loading the market list…'
      : `Scanned ${new Intl.NumberFormat('en').format(scanned)} of ${new Intl.NumberFormat('en').format(sc.markets.length)} markets${S.cycle ? ` · each re-checked about every ${S.cycle}s` : ''}`;
    if (!sc.loaded) {
      list.replaceChildren(el('div', { class: 'empty' }, sc.error ? 'Couldn’t load the market list. Try Refresh.' : el('span', { class: 'skel' }, 'Loading markets to scan')));
      return;
    }
    const now = Date.now();
    const age = (b) => {
      if (b.live && LIVE.on && LIVE.ws === 'live' && LIVE.watching.includes(b.book.marketId)) return el('td', { class: 'age streaming hide-g' }, '● live');
      const sec = Math.max(0, Math.round((now - b.at) / 1000));
      return el('td', { class: 'age hide-g' }, sec < 1 ? 'now' : `${sec}s ago`);
    };
    const body = [];
    for (const r of rows) {
      const [oa, ob] = r.m.outcomes;
      const sel = S.openBook === r.m.marketId;
      body.push(el('tr', { class: 'g' + (sel ? ' sel' : ''), tabindex: '0', onclick: () => openBook(r.m), onkeydown: (e) => { if (e.key === 'Enter') openBook(r.m); } },
        el('td', { class: 'gc' }, r.g.oneSided ? 'one side' : gapText(r.g.cents)),
        el('td', {}, el('div', { class: 'ev-n' }, r.ev || '—'), el('div', { class: 'mk-n' }, `${pretty(r.m.marketType)} · ${r.m.description}`)),
        sideCell(oa, r.g.a, r.g.b),
        sideCell(ob, r.g.b, r.g.a),
        age(r.b)));
      if (sel) body.push(el('tr', {}, el('td', { colspan: '5', class: 'bookcell' }, bookView(r.m, S.books.get(r.m.marketId)))));
    }
    if (!rows.length) {
      list.replaceChildren(el('div', { class: 'empty' }, scanned < sc.markets.length ? `No gaps over ${gapText(S.threshold)} yet · still scanning` : `No markets with a gap over ${gapText(S.threshold)} right now.`));
      return;
    }
    list.replaceChildren(el('table', { class: 'gaps-t' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Gap'), el('th', {}, 'Market'), el('th', {}, 'Side A'), el('th', {}, 'Side B'), el('th', { class: 'hide-g' }, 'Updated'))),
      el('tbody', {}, body)));
  }

  /* ---------- polling: refresh what isn't streamed, oldest first ---------- */
  function streamed(id) { const b = S.books.get(id); return LIVE.on && LIVE.ws === 'live' && b && b.live && LIVE.watching.includes(id); }
  function candidates() {
    const ids = [];
    if (S.openBook) ids.push(S.openBook);
    if (S.view !== 'gaps') for (const ev of S.open) { const e = S.events.find((x) => x.eventId === ev); if (e && isTennis(e)) tennisMarkets(ev).forEach((m) => ids.push(m.marketId)); }
    if (S.view === 'gaps') S.scan.markets.forEach((m) => ids.push(m.marketId));
    else visibleEvents().forEach((e) => { const m = S.money.get(e.eventId); if (m) ids.push(m.marketId); });
    return ids;
  }
  function nextToPoll() {
    const now = Date.now();
    let best = null; let bestAt = Infinity; let pending = 0;
    for (const id of candidates()) {
      if (S.inflight.has(id) || streamed(id)) continue;
      pending += 1;
      const b = S.books.get(id);
      const at = b ? b.at : 0;
      if (now - at < 1000) continue;
      if (at < bestAt) { bestAt = at; best = id; }
    }
    S.pending = pending;
    return best;
  }
  async function worker(gen) {
    while (S.autoOn && gen === S.pollGen) {
      if (document.hidden || root.hidden || S.loading) { await sleep(500); continue; }
      const id = nextToPoll();
      if (!id) { await sleep(250); continue; }
      S.inflight.add(id);
      try {
        await getBook(id);
        markDirty(id);
        drawRowPrices(id);
        if (S.openBook === id && S.view !== 'gaps') drawOpenBook();
      } catch { /* shown via status */ }
      S.inflight.delete(id);
    }
  }
  function startPolling() {
    if (!S.autoOn) return;
    S.pollGen += 1;
    const n = LIVE.on && !LIVE.restDown ? 4 : 1;
    for (let i = 0; i < n; i++) worker(S.pollGen);
  }

  // Every second: estimate the refresh cycle, redraw the gaps table, re-aim the stream.
  let tickN = 0;
  setInterval(() => {
    if (root.hidden || !S.started) return;
    tickN += 1;
    if (S.autoOn) S.cycle = Math.max(1, Math.round((S.pending || 0) / bucket.rate));
    if (S.view === 'gaps') { drawGaps(); if (tickN % 5 === 0) watch(); }
    else if (S.dirtyEvents.size) { const evs = [...S.dirtyEvents]; S.dirtyEvents.clear(); evs.forEach(drawEventBody); if (tickN % 5 === 0) watch(); }
    if (LIVE.on) liveStatus(); else if (S.autoOn && S.books.size && !S.loading && !S.problem) setStatus(`Updating every second · public data, no key${S.cycle > 1 ? ` · each market about every ${S.cycle}s` : ''}`);
  }, 1000);

  /* ---------- live mode: local server with your key ---------- */
  async function detectLocal() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return false;
    try {
      const r = await fetch('/local/status', { cache: 'no-store' });
      const j = await r.json();
      if (!j || !j.version) return false;
      if (!j.ok) {
        const why = j.management ? j.message : `${j.status || 'no answer'}${j.code ? ' ' + j.code : ''}${j.message ? ': ' + j.message : ''}`;
        const note = $('#mk-keynote');
        note.replaceChildren(el('b', {}, 'Your key isn’t being used. '), `Novig refused it (${why}), so these are public prices. `,
          el('a', { href: '/local/diag', target: '_blank', rel: 'noopener' }, 'Run diagnostics'), j.management ? '. In the novig-explorer\\local folder, double-click make-read-key.cmd, then restart start.cmd.' : ' for details, then restart start.cmd once it’s fixed.');
        note.hidden = false;
        return false;
      }
      LIVE.on = true;
      LIVE.max = (j.stream && j.stream.max) || 30;
      Object.assign(bucket, { tokens: 48, cap: 48, rate: 14 });
      $('#mk-mode').hidden = false;
      $('#markets .mk-top .note').textContent = 'Streaming from Novig with your read-only key through the server on this computer. Green-edged prices update live; prices are what it costs to buy that side right now, before any fee.';
      openStream();
      return true;
    } catch { return false; }
  }

  function openStream() {
    LIVE.es = new EventSource('/local/stream');
    LIVE.es.addEventListener('hello', (ev) => { const d = JSON.parse(ev.data); LIVE.client = d.client; LIVE.max = d.max || LIVE.max; watch(true); });
    LIVE.es.addEventListener('status', (ev) => { const d = JSON.parse(ev.data); LIVE.ws = d.ws; LIVE.error = d.error; LIVE.streaming = d.streaming; LIVE.waiting = d.waiting || 0; LIVE.limited = !!d.limited; liveStatus(); });
    LIVE.es.addEventListener('notice', (ev) => { const d = JSON.parse(ev.data); console.warn('Novig:', d.code, d.message); });
    LIVE.es.addEventListener('book', (ev) => {
      const b = JSON.parse(ev.data);
      S.books.set(b.marketId, { book: b, at: Date.now(), live: true });
      LIVE.last = new Date();
      drawRowPrices(b.marketId);
      markDirty(b.marketId);
      if (S.openBook === b.marketId) drawOpenBook();
      liveStatus();
    });
    LIVE.es.onerror = () => { LIVE.ws = 'down'; LIVE.error = 'local server stopped?'; liveStatus(); };
  }

  // Stream the open book first, then the soonest visible games' moneylines, up to the server's cap.
  let watchTimer = null;
  function watch(now = false) {
    if (!LIVE.on || !LIVE.client) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      const ids = [];
      const add = (id) => { if (id && !ids.includes(id) && ids.length < LIVE.max) ids.push(id); };
      add(S.openBook);
      if (S.view !== 'gaps') for (const ev of S.open) {
        const e = S.events.find((x) => x.eventId === ev);
        if (!e || !isTennis(e)) continue;
        const tm = tennisMarkets(ev);
        tm.filter((m) => m.marketType === 'MONEY').forEach((m) => add(m.marketId));
        ['SPREAD', 'TOTAL'].forEach((t) => splitTight(tm.filter((m) => m.marketType === t)).tight.forEach((m) => add(m.marketId)));
      }
      if (S.view === 'gaps' && S.scan.loaded) {
        const gapped = gapRows().map((r) => r.m.marketId);
        const keep = new Set(gapped);
        LIVE.watching.filter((id) => keep.has(id)).forEach(add); // keep what's already streaming, so subscriptions don't churn
        gapped.forEach(add);
      }
      for (const e of visibleEvents()) { const m = S.money.get(e.eventId); if (m) add(m.marketId); }
      const key = ids.join(',');
      if (key === LIVE.watching.join(',')) return;
      LIVE.watching = ids;
      fetch('/local/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: LIVE.client, markets: ids }) }).catch(() => {});
      drawLiveMarks();
    }, now ? 0 : 300);
  }

  function drawLiveMarks() {
    list.querySelectorAll('.ev-prices[data-market]').forEach((slot) => slot.classList.toggle('streamed', LIVE.on && LIVE.watching.includes(slot.dataset.market)));
  }

  function drawOpenBook() {
    const row = list.querySelector('.mk.sel');
    if (!row || !S.openMarket) return;
    const old = row.querySelector('.book');
    const fresh = bookView(S.openMarket, S.books.get(S.openBook));
    if (old) old.replaceWith(fresh); else row.append(fresh);
    const q = row.querySelector('.mk-q');
    const b = S.books.get(S.openBook);
    if (q && b && b.book) q.textContent = quote(S.openMarket, b.book).map((x) => `${x.outcome.name} ${x.ask ? american(x.ask.price) : '—'}`).join('  ·  ');
  }

  /* ---------- controls ---------- */
  leagueSel.addEventListener('change', () => { S.league = leagueSel.value; store.set('nv-league', S.league); S.openBook = null; S.openMarket = null; loadLeague(); });
  document.querySelectorAll('.mk-view').forEach((b) => b.addEventListener('click', () => {
    S.view = b.dataset.view;
    S.openBook = null; S.openMarket = null;
    document.querySelectorAll('.mk-view').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
    if (S.view === 'gaps') ensureScan();
    refreshBooks();
  }));
  const gapIn = $('#mk-gap');
  gapIn.value = String(S.threshold);
  gapIn.addEventListener('input', () => {
    const v = Number(gapIn.value);
    if (!(v >= 0)) return;
    S.threshold = v; store.set('nv-gap', String(v));
    list.querySelectorAll('.gap[data-gap]').forEach((c) => { const ev = S.events.find((e) => { const m = S.money.get(e.eventId); return m && m.marketId === c.dataset.gap; }); if (ev) { const m = S.money.get(ev.eventId); c.replaceWith(gapChip(m, S.books.get(m.marketId))); } });
    drawGaps();
  });
  const scopeSel = $('#mk-scope');
  scopeSel.value = S.scan.scope;
  scopeSel.addEventListener('change', () => { S.scan = { markets: [], loaded: false, loading: false, scope: scopeSel.value, league: S.league, error: '' }; store.set('nv-scope', scopeSel.value); ensureScan(); });
  $('#mk-onesided').addEventListener('change', (e) => { S.oneSided = e.target.checked; drawGaps(); });
  let searchTimer;
  search.addEventListener('input', () => {
    S.term = search.value;
    draw();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshBooks(), 400);
  });
  $('#mk-refresh').addEventListener('click', () => {
    if (LIVE.on && LIVE.restDown) {
      // Try the key again.
      LIVE.restDown = false; LIVE.keyProblem = '';
      Object.assign(bucket, { tokens: 48, cap: 48, rate: 14 });
      if (S.problem) { S.problem = ''; loadLeagues().then(loadLeague); return; }
    }
    for (const [id, b] of S.books) if (!b.live) S.books.delete(id);
    if (S.view === 'gaps' && !S.scan.loaded) ensureScan();
    draw();
    if (S.autoOn) { startPolling(); return; }
    refreshBooks(); // one full pass when updating is off
  });
  $('#mk-auto').addEventListener('change', (ev) => {
    S.autoOn = ev.target.checked;
    if (S.autoOn) startPolling(); else { S.pollGen += 1; stamp(); }
  });

  function start() {
    if (S.started) return;
    S.started = true;
    detectLocal().then(loadLeagues).then(loadLeague);
  }
  document.addEventListener('nv:tab', (ev) => { if (ev.detail === 'markets') start(); });
  if (!root.hidden) start();
})();
