// Token Radar's page. It reads window.RADAR (written beside dashboard/ by
// main.ts) and paints the ranked board, the filters, and one protocol's
// detail sheet. Everything it shows is already in data.js: no fetch, no
// network, no framework. The sheet re-runs the model on the row it opens
// and says whether the recomputed price matches the one board.json carries,
// so the page and the board are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var root = document.getElementById('board');
  var onWatch = {};
  (DATA.watchlist || []).forEach(function (slug) { onWatch[slug] = true; });

  var view = {
    q: '', cat: 'all', chain: 'all', watchOnly: false,
    tab: 'pre-token', sort: 'implied', dir: -1, picked: null
  };

  var moneyFmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return moneyFmt.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function chainLabel(r) {
    return (r.chains && r.chains.length) ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  // The model, again, in the page's own words: a size-decaying multiple, a
  // clamped weekly push, and seasoning for time spent with no token. It
  // must agree with lib/model.ts; the sheet below proves it per row.
  function priceOf(row, tune) {
    var factor = Math.min(tune.capMultiple, Math.max(tune.floorMultiple,
      tune.baseMultiple * Math.pow(tune.referenceTvl / row.tvl_usd, tune.exponent)));
    var weekly = Math.min(tune.growthHigh, Math.max(tune.growthLow,
      row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var push = 1 + (weekly / 100) * tune.growthWeight;
    var age = row.age_days === null || row.age_days === undefined ? tune.defaultAgeDays : row.age_days;
    var season = tune.maturityFloor +
      (Math.min(Math.max(age, 0), tune.maturityDays) / tune.maturityDays) * tune.maturitySpan;
    return Math.max(1, Math.round(row.tvl_usd * factor * push * season));
  }

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var params = new URLSearchParams(raw);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.picked = params.get('p');
    if (params.get('category')) view.cat = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('watch') === '1') view.watchOnly = true;
    if (params.get('tab') === 'live') view.tab = 'live';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.cat !== 'all') params.set('category', view.cat);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchOnly) params.set('watch', '1');
    if (view.tab === 'live') params.set('tab', 'live');
    if (view.picked) params.set('p', view.picked);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var needle = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.watchOnly && !onWatch[r.slug]) return false;
      if (view.cat !== 'all' && r.category !== view.cat) return false;
      if (view.chain !== 'all' && !(r.chains || []).some(function (c) { return c === view.chain; })) return false;
      if (!needle) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }
  function orderedRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var x, y;
      if (key === 'name') { x = a.name.toLowerCase(); y = b.name.toLowerCase(); }
      else if (key === 'tvl') { x = a.tvl_usd; y = b.tvl_usd; }
      else if (key === 'growth') { x = a.change_7d === null ? -Infinity : a.change_7d; y = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { x = a.age_days === null ? Infinity : a.age_days; y = b.age_days === null ? Infinity : b.age_days; }
      else { x = a.implied_value_usd; y = b.implied_value_usd; }
      if (x < y) return -view.dir;
      if (x > y) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function sortBtn(key, label) {
    var mark = view.sort === key ? (view.dir < 0 ? ' v' : ' ^') : '';
    return '<th scope="col"><button type="button" data-sort="' + key + '">' + esc(label) +
      (mark ? '<span aria-hidden="true">' + mark + '</span>' : '') + '</button></th>';
  }

  function mastHtml() {
    return '<header class="mast">' +
      '<div><div class="kicker">Token Radar</div>' +
      '<h1>' + DATA.watchlist_size + ' watchlist protocols, ranked by implied value</h1></div>' +
      '<div class="mast-meta"><span>Snapshot ' + esc(DATA.as_of) + '</span>' +
      '<span>DefiLlama protocol index</span><span>' + esc(DATA.model_version) + ' model</span></div>' +
      '</header>';
  }

  function heroHtml() {
    var floorM = Math.round(DATA.floor_usd / 1e6);
    return '<section class="hero"><div>' +
      '<p>The watchlist is the floor: every protocol with at least <strong>$' + floorM +
      'M</strong> of TVL and no token on record. The early radar adds <strong>' + DATA.early_size +
      '</strong> pre-token protocols below that floor, every one the snapshot can score. ' +
      'Implied value is a model, not a promise — and never a prediction that a token is coming.</p>' +
      '</div><div class="stats">' +
      '<div class="stat"><span>Watchlist covered</span><b>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</b></div>' +
      '<div class="stat"><span>Pre-token rows scored</span><b>' + DATA.board_size + '</b></div>' +
      '<div class="stat"><span>Early rows below the floor</span><b>' + DATA.early_size + '</b></div>' +
      '<div class="stat"><span>Live-token protocols set aside</span><b>' + DATA.live_size + '</b></div>' +
      '</div></section>';
  }

  function spotHtml() {
    function card(tag, name, fig) {
      return '<div class="spot-card"><span class="tag">' + esc(tag) + '</span><b>' + esc(name || 'n/a') +
        '</b><span class="fig">' + esc(fig) + '</span></div>';
    }
    var top = DATA.rows[0];
    var grown = DATA.rows.filter(function (r) { return r.change_7d !== null; })
      .sort(function (a, b) { return b.change_7d - a.change_7d; })[0];
    var oldest = DATA.rows.filter(function (r) { return r.age_days !== null; })
      .sort(function (a, b) { return b.age_days - a.age_days; })[0];
    return '<section class="spot" aria-label="Highlights">' +
      card('Highest implied value', top && top.name, top ? money(top.implied_value_usd) + '  ·  rank 1' : '') +
      card('Fastest 7-day growth', grown && grown.name, grown ? pct(grown.change_7d) + ' TVL  ·  ' + money(grown.tvl_usd) : '') +
      card('Longest run with no token', oldest && oldest.name, oldest ? ageLabel(oldest.age_days) + ' listed  ·  ' + money(oldest.implied_value_usd) : '') +
      '</section>';
  }

  function filtersHtml() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    function opts(list, current, allLabel) {
      var out = '<option value="all">' + esc(allLabel) + '</option>';
      list.forEach(function (v) {
        out += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
      });
      return out;
    }
    var count = view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols';
    return '<div class="filters">' +
      '<div class="field"><label for="q">Search</label>' +
      '<input type="search" id="q" placeholder="Search name, category or chain" value="' + esc(view.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label>' +
      '<select id="category" aria-label="Filter by category">' + opts(cats, view.cat, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label>' +
      '<select id="chain" aria-label="Filter by chain">' + opts(chains, view.chain, 'All chains') + '</select></div>' +
      '<label class="toggle" for="watch"><input type="checkbox" id="watch"' + (view.watchOnly ? ' checked' : '') + '>Watchlist only</label>' +
      '<div class="field"><span class="cap">Token status</span><div class="chip-row">' +
      '<button type="button" data-tab="pre-token" aria-pressed="' + (view.tab === 'pre-token') + '">Pre-token</button>' +
      '<button type="button" data-tab="live" aria-pressed="' + (view.tab === 'live') + '">Live token</button>' +
      '</div></div>' +
      '<span class="showing">' + esc(count) + '</span></div>';
  }

  function boardHtml() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return '<div class="tbl-wrap"><div class="blank"><h2>No protocol matches that filter</h2>' +
        '<p>Clear the search or pick another category to see the board again.</p>' +
        '<button class="btn solid" type="button" data-clear="1">Clear filters</button></div></div>';
    }
    var top = list[0].implied_value_usd || 1;
    var rows = list.map(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var gcls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
      var width = Math.max(3, Math.round((r.implied_value_usd / top) * 100));
      return '<tr data-slug="' + esc(r.slug) + '" data-picked="' + (view.picked === r.slug) + '" tabindex="0">' +
        '<td class="nums">' + r.rank + '</td>' +
        '<td><div class="who"><b>' + esc(r.name) + '</b><span class="fine">' +
        esc(r.category || 'Other') + ' on ' + esc(chainLabel(r)) + '</span></div></td>' +
        '<td class="nums">' + money(r.tvl_usd) + '</td>' +
        '<td class="nums ' + gcls + '">' + growth + '</td>' +
        '<td class="nums">' + ageLabel(r.age_days) + '</td>' +
        '<td><div class="valued"><div class="meter" aria-hidden="true"><i style="width:' + width + '%"></i></div>' +
        '<span class="nums">' + money(r.implied_value_usd) + '</span></div></td>' +
        '<td><span class="pill' + (onWatch[r.slug] ? ' gold' : '') + '">' + (onWatch[r.slug] ? 'watchlist' : 'early') + '</span></td>' +
        '</tr>';
    }).join('');
    return '<div class="tbl-wrap"><table>' +
      '<caption>Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.</caption>' +
      '<thead><tr>' + sortBtn('implied', 'Rank') + sortBtn('name', 'Protocol') + sortBtn('tvl', 'TVL') +
      sortBtn('growth', '7d') + sortBtn('age', 'Age') + sortBtn('implied', 'Implied value') +
      '<th scope="col">List</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function liveHtml() {
    var rows = DATA.live.map(function (r) {
      var gcls = r.change_7d !== null && r.change_7d >= 0 ? 'up' : 'down';
      return '<tr><td class="nums">live</td>' +
        '<td><div class="who"><b>' + esc(r.name) + '</b><span class="fine">' +
        esc(r.category || 'Other') + ' on ' + esc(chainLabel(r)) + '</span></div></td>' +
        '<td class="nums">' + money(r.tvl_usd) + '</td>' +
        '<td class="nums ' + gcls + '">' + pct(r.change_7d) + '</td>' +
        '<td class="nums">' + money(r.mcap_usd) + '</td>' +
        '<td><span class="pill live">already trades</span></td></tr>';
    }).join('');
    return '<div class="tbl-wrap"><table>' +
      '<caption>Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th>' +
      '<th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function howtoHtml() {
    var m = DATA.model;
    return '<section class="tbl-wrap howto"><h2>How implied value is computed</h2>' +
      '<p class="fine">One function scores every protocol. No name is special-cased, and no row is hand-picked.</p>' +
      '<div class="math">' +
      '<div>multiple = clamp(<b>' + m.baseMultiple + '</b> x (<b>$' + (m.referenceTvl / 1e6) + 'M</b> / tvl_usd)^<b>' + m.exponent + '</b>, <b>' + m.floorMultiple + '</b>, <b>' + m.capMultiple + '</b>)</div>' +
      '<div>growth = 1 + clamp(change_7d, <b>' + m.growthLow + '</b>, <b>' + m.growthHigh + '</b>) / 100 x <b>' + m.growthWeight + '</b></div>' +
      '<div>maturity = <b>' + m.maturityFloor + '</b> + <b>' + m.maturitySpan + '</b> x min(age_days, <b>' + m.maturityDays + '</b>) / <b>' + m.maturityDays + '</b></div>' +
      '<div>implied = round(tvl_usd x multiple x growth x maturity)</div></div>' +
      '<p class="fine">The multiple decays with size and is anchored to this snapshot: its live-token protocols trade at a median market-cap-to-TVL of about 0.21, and the multiple sits in that band. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.defaultAgeDays + ' days.</p>' +
      '</section>' +
      '<p class="caveat">“No token” means the snapshot records none: a protocol on this board may still have a token its record does not carry. Wrapped, staked and bridged products of tokens that already trade are left off the board entirely.</p>';
  }

  var sheet = document.createElement('dialog');
  sheet.className = 'sheet';
  sheet.id = 'detail';
  sheet.setAttribute('aria-labelledby', 'detail-title');
  sheet.addEventListener('close', function () { view.picked = null; writeHash(); });

  function openSheet(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    view.picked = slug;
    writeHash();
    var again = priceOf(row, DATA.model);
    var match = again === row.implied_value_usd;
    var steps = (row.farm_steps || []).map(function (s) {
      var at = s.indexOf(' Cost: ');
      var move = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(move) + '</b><span class="price-tag">' + esc(tail) + '</span></li>';
    }).join('');
    sheet.innerHTML =
      '<div class="sheet-top"><div>' +
      '<span class="kicker">Rank ' + row.rank + ' of ' + DATA.board_size + (onWatch[row.slug] ? '  ·  watchlist' : '  ·  early') + '</span>' +
      '<h2 id="detail-title">' + esc(row.name) + '</h2>' +
      '<p class="fine">' + esc(row.category || 'Other') + ' on ' + esc((row.chains || []).join(', ') || 'an unnamed chain') + '</p>' +
      '</div><button class="shut" type="button" aria-label="Close details" data-shut="1">Close</button></div>' +
      '<section class="sheet-block"><h3>Implied value</h3><div class="sum">' +
      '<div><span>TVL</span><b>' + money(row.tvl_usd) + '</b></div>' +
      '<div><span>TVL multiple</span><b>' + row.multiple + '</b></div>' +
      '<div><span>Seven-day growth</span><b>' + pct(row.change_7d) + '</b></div>' +
      '<div><span>Growth multiplier</span><b>' + row.growth_mult + '</b></div>' +
      '<div><span>Age with no token</span><b>' + ageLabel(row.age_days) + '</b></div>' +
      '<div><span>Maturity multiplier</span><b>' + row.maturity_mult + '</b></div>' +
      '<div><span>Implied value</span><b>' + money(row.implied_value_usd) + '</b></div>' +
      '</div><p class="check-line">Model ' + esc(DATA.model_version) + ': the page recomputes this row as ' + money(again) +
      (match ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') +
      ' This is an estimate, not a price, and not a prediction of a launch.</p></section>' +
      '<section class="sheet-block"><h3>Farm plan</h3><ol class="plan">' + steps + '</ol></section>';
    if (typeof sheet.showModal === 'function') {
      if (!sheet.open) sheet.showModal();
    } else {
      sheet.setAttribute('open', '');
    }
  }

  function paint() {
    var html = '<div class="wrap">' + mastHtml() + heroHtml() + spotHtml() + filtersHtml() +
      (view.tab === 'pre-token' ? boardHtml() : liveHtml());
    if (view.tab === 'pre-token') html += howtoHtml();
    html += '</div>';
    root.innerHTML = html;
    root.setAttribute('aria-busy', 'false');
    if (!sheet.isConnected) root.appendChild(sheet);
    if (view.picked) openSheet(view.picked);
  }

  function wire() {
    root.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'q') { view.q = e.target.value; writeHash(); paint(); }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'category') { view.cat = t.value; writeHash(); paint(); }
      if (t.id === 'chain') { view.chain = t.value; writeHash(); paint(); }
      if (t.id === 'watch') { view.watchOnly = t.checked; writeHash(); paint(); }
    });
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      var sort = t.closest ? t.closest('[data-sort]') : null;
      if (sort) {
        var key = sort.getAttribute('data-sort');
        if (view.sort === key) view.dir = -view.dir;
        else { view.sort = key; view.dir = -1; }
        paint();
        return;
      }
      var tab = t.closest ? t.closest('[data-tab]') : null;
      if (tab) { view.tab = tab.getAttribute('data-tab'); paint(); return; }
      if (t.closest && t.closest('[data-clear]')) {
        view.q = ''; view.cat = 'all'; view.chain = 'all'; view.watchOnly = false;
        writeHash(); paint();
        return;
      }
      if (t.closest && t.closest('[data-shut]')) { sheet.close(); return; }
      var tr = t.closest ? t.closest('tr[data-slug]') : null;
      if (tr) openSheet(tr.getAttribute('data-slug'));
    });
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('tr[data-slug]')) {
        e.preventDefault();
        openSheet(e.target.getAttribute('data-slug'));
      }
    });
  }

  readHash();
  paint();
  wire();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheet.open) sheet.close();
  });
})();
