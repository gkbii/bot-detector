/**
 * content/badge.js — everything this extension draws.
 *
 * Loaded as a classic script, not an ES module: Chrome does not support
 * `"type": "module"` for declaratively-injected content scripts, so the two
 * content scripts share the isolated world's globals instead of importing each
 * other. `content/reddit.js` (the platform adapter) is the only consumer; it
 * loads second, per the order in manifest.json.
 *
 * Two rules this file exists to enforce:
 *
 * 1. Purely additive. Every node created here is ours and namespaced `bd-*`.
 *    Nothing reads, moves, hides or restyles a node Reddit made — the single
 *    write to Reddit's DOM is `insertAdjacentElement` of one badge, done by the
 *    adapter, and if this file throws the page is exactly as Reddit rendered it.
 *
 * 2. `insufficient-data` is its own visibly-neutral state. It is drawn grey and
 *    dashed and reads "no data" — never as a low/clean score. An account nobody
 *    has evidence about must not look like an account that was checked and
 *    cleared.
 */

(() => {
  'use strict';
  if (window.__bdUI) return;

  const BANDS = ['insufficient-data', 'low', 'moderate', 'high'];
  const BAND_SHORT = {
    'insufficient-data': 'no data',
    low: 'low',
    moderate: 'med',
    high: 'high',
  };
  const BAND_LONG = {
    'insufficient-data': 'Insufficient data',
    low: 'Low',
    moderate: 'Moderate',
    high: 'High',
  };
  const AXES = [
    ['automation', 'Automation', 'How much of this account reads as machine-driven rather than typed by a person.'],
    ['agenda', 'Agenda', 'How narrowly and repetitively this account pushes a single line.'],
    ['authenticity', 'Authenticity', 'Whether the account behaves like a lived-in account or a freshly-stood-up one.'],
  ];

  /**
   * Plain-language one-liners for the default view, keyed by signal key. The
   * full evidence string — the sentence with the working in it — stays one tap
   * away behind "why?", and the full report renders it in full; these are the
   * headline a reader who doesn't want the working can act on. Only signals
   * that can RAISE concern are listed: authenticity signals are vouches and
   * never appear as concerns.
   */
  const CONCERN_TEXT = {
    'posting-hour-dead-zone': 'Posts around the clock, with no sleep gap',
    'sustained-posting-rate': 'Posts at a very high rate, nonstop',
    'interval-regularity': 'Posts at unusually even time intervals',
    'cross-thread-bursts': 'Rapid-fire comments across unrelated threads',
    'length-uniformity': 'Comments are all nearly the same length',
    'karma-velocity': 'Gains karma unusually fast',
    'near-duplicate-bodies': 'Repeats nearly identical comments',
    'conversation-depth': 'Broadcasts without ever replying to anyone',
    'clock-alignment': 'Posts land on exact clock marks, like a scheduler',
    'template-structure': 'Comments reuse one fill-in-the-blanks layout',
    'topic-concentration': 'Nearly all activity pushes one subject',
    'stock-phrasing': 'Repeats the same phrases across unrelated threads',
    'drive-by-ratio': 'Drops a message and never comes back',
    'dormancy-revival': 'Long-dormant account suddenly reactivated',
    'link-domain-concentration': 'Keeps steering readers to one website',
    'title-repost': 'Posts the same thing across many communities',
    'pre-history-gap': 'Account existed for years before any activity',
  };

  // --- tiny DOM helpers; textContent everywhere, never innerHTML ------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function bandOf(axis) {
    const band = axis && axis.band;
    return BANDS.includes(band) ? band : 'insufficient-data';
  }

  function fmtValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return String(value);
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value)) return truncate(value.map(fmtValue).join(', '), 140);
    if (typeof value === 'object') {
      try {
        return truncate(JSON.stringify(value), 140);
      } catch {
        return '[object]';
      }
    }
    return truncate(String(value), 200);
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // `deadZoneStartHour` -> `dead zone start hour`. The scoring names its
  // components in code style; the panel is read by a person.
  function humanKey(key) {
    return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  }

  /**
   * Some signals carry a structured value rather than a single number — the
   * whole posting-hours histogram, for instance. Rendering that as raw JSON in
   * the right-hand value column is unreadable and unbounded, so it becomes its
   * own small key/value block under the signal, with the numbers rounded.
   */
  function kvBlock(obj) {
    const wrap = el('div', 'bd-kv');
    // `example` is a machine-readable item reference, rendered as a link
    // elsewhere — as a key/value pair it is just JSON noise.
    const entries = Object.entries(obj).filter(([key]) => key !== 'example');
    for (const [key, value] of entries.slice(0, 8)) {
      const pair = el('span', 'bd-kv-pair');
      pair.appendChild(el('span', 'bd-kv-k', humanKey(key)));
      pair.appendChild(el('span', 'bd-kv-v', fmtValue(value)));
      wrap.appendChild(pair);
    }
    if (entries.length > 8) wrap.appendChild(el('span', 'bd-kv-pair', `+${entries.length - 8} more`));
    return wrap;
  }

  function fmtScore(score) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    return String(Math.round(score * 10) / 10);
  }

  function fmtWhen(iso) {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // --- badge ---------------------------------------------------------------

  /** @returns {HTMLElement} a badge in its idle state, ready to insert. */
  function createBadge(username, isDark) {
    const badge = el('span', 'bd-badge');
    if (isDark) badge.classList.add('bd-dark');
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.dataset.bdUser = username;
    setIdle(badge);
    return badge;
  }

  /**
   * The on-demand resting state: a button, not a verdict. It must read as
   * "nothing has been checked" — the same rule as `insufficient-data`, one
   * step earlier: an unchecked account must not look like a checked one.
   */
  function setIdle(badge) {
    badge.className = badgeClasses(badge, 'bd-state-idle');
    badge.replaceChildren(el('span', 'bd-chip bd-chip-idle', 'bot?'));
    badge.title = `Check u/${badge.dataset.bdUser} for automation and agenda signals.\n`
      + 'Fetches their public history only when you click.';
    badge.setAttribute('aria-label', `Bot Detector: check u/${badge.dataset.bdUser}`);
  }

  function setPending(badge) {
    badge.className = badgeClasses(badge, 'bd-state-pending');
    badge.replaceChildren(el('span', 'bd-chip bd-chip-pending', 'checking…'));
    badge.title = '';
    badge.setAttribute('aria-label', `Bot Detector: checking u/${badge.dataset.bdUser}`);
  }

  function setError(badge, message) {
    badge.className = badgeClasses(badge, 'bd-state-error');
    badge.replaceChildren(el('span', 'bd-chip bd-chip-error', 'unavailable'));
    badge.title = `Bot Detector could not score this account: ${message}\nClick to retry.`;
    badge.setAttribute('aria-label', `Bot Detector: unavailable for u/${badge.dataset.bdUser}`);
  }

  function setVerdict(badge, payload) {
    const verdict = (payload && payload.verdict) || {};
    const auto = bandOf(verdict.automation);
    const agenda = bandOf(verdict.agenda);
    badge.className = badgeClasses(badge, 'bd-state-ready');
    badge.replaceChildren(chip('auto', auto), chip('agenda', agenda));
    const provider = payload.degraded ? 'local (degraded)' : payload.provider || 'local';
    badge.title = [
      `u/${badge.dataset.bdUser}`,
      `automation: ${BAND_LONG[auto]} · agenda: ${BAND_LONG[agenda]}`,
      verdict.headline || '',
      `scored by ${provider}${payload.cached ? ', cached' : ''}`,
      'Click for what stood out.',
    ].filter(Boolean).join('\n');
    badge.setAttribute(
      'aria-label',
      `Bot Detector for u/${badge.dataset.bdUser}: automation ${BAND_LONG[auto]}, agenda ${BAND_LONG[agenda]}. Activate for details.`,
    );
  }

  function badgeClasses(badge, state) {
    const dark = badge.classList.contains('bd-dark') ? ' bd-dark' : '';
    return `bd-badge ${state}${dark}`;
  }

  function chip(label, band) {
    const wrap = el('span', `bd-chip bd-band-${band}`);
    wrap.appendChild(el('span', 'bd-k', label));
    wrap.appendChild(el('span', 'bd-v', BAND_SHORT[band]));
    return wrap;
  }

  // --- panel ---------------------------------------------------------------
  let openPanelEl = null;
  let openAnchor = null;

  function closePanel() {
    if (openPanelEl && openPanelEl.isConnected) openPanelEl.remove();
    if (openAnchor) openAnchor.classList.remove('bd-open');
    openPanelEl = null;
    openAnchor = null;
  }

  /**
   * @param {HTMLElement} anchor the badge that was clicked
   * @param {object} payload {verdict, provider, degraded, degradedReason, cached}
   * @param {{onDeep?: Function, onRetry?: Function, backendConfigured?: boolean, deepRunning?: boolean}} handlers
   */
  function openPanel(anchor, payload, handlers = {}) {
    closePanel();
    const panel = buildPanel(anchor.dataset.bdUser, payload, handlers);
    if (anchor.classList.contains('bd-dark')) panel.classList.add('bd-dark');
    document.body.appendChild(panel);
    openPanelEl = panel;
    openAnchor = anchor;
    anchor.classList.add('bd-open');
    position(panel, anchor);
    return panel;
  }

  function position(panel, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 380;
    let left = rect.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    let top = rect.bottom + 6;
    const height = panel.offsetHeight || 320;
    if (top + height > window.innerHeight - 12) {
      const above = rect.top - height - 6;
      top = above > 12 ? above : Math.max(12, window.innerHeight - height - 12);
    }
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  /**
   * The panel has two views. The DEFAULT is the simple one: the headline, the
   * three bands, and only the signals that stood out — each as a plain
   * sentence with a link to one concrete example the reader can open. The
   * full report — every signal, its evidence sentence, its weight, coverage —
   * is one click away behind "Full report", never gone: a band with no
   * working behind it is just an accusation, so the working stays reachable.
   */
  function buildPanel(username, payload, handlers) {
    const verdict = (payload && payload.verdict) || {};
    const panel = el('div', 'bd-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `Bot Detector report for u/${username}`);

    const head = el('div', 'bd-panel-head');
    head.appendChild(el('span', 'bd-panel-user', `u/${username}`));
    const close = el('button', 'bd-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closePanel);
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('div', 'bd-panel-body');
    panel.appendChild(body);

    const foot = el('div', 'bd-panel-foot');
    const toggle = el('button', 'bd-btn', 'Full report');
    let full = false;

    const render = () => {
      body.replaceChildren();
      if (verdict.headline) body.appendChild(el('p', 'bd-headline', verdict.headline));

      if (full) {
        body.appendChild(provenance(payload, verdict));
        for (const [key, title, blurb] of AXES) {
          body.appendChild(axisSection(title, blurb, verdict[key], handlers));
        }
        const llm = verdict.agenda && verdict.agenda.llm;
        if (llm) body.appendChild(llmSection(llm));
        const cov = coverageSection(verdict.coverage);
        if (cov) body.appendChild(cov);
      } else {
        if (payload && payload.degraded) {
          const warn = el('div', 'bd-prov bd-prov-degraded');
          warn.appendChild(el('div', 'bd-prov-warn', payload.degradedReason || 'Backend unavailable; this is the local score.'));
          body.appendChild(warn);
        }
        body.appendChild(summaryChips(verdict));
        body.appendChild(concernsSection(verdict, handlers));
        const llm = verdict.agenda && verdict.agenda.llm;
        if (llm && llm.summary) {
          const section = el('section', 'bd-axis bd-llm');
          section.appendChild(el('p', 'bd-llm-summary', llm.summary));
          body.appendChild(section);
        }
        body.appendChild(simpleMeta(payload, verdict));
      }
      toggle.textContent = full ? 'Simple view' : 'Full report';
      // Re-fit after a toggle changes the panel's height; the first render
      // happens before the panel is in the DOM and openPanel positions it.
      if (panel.isConnected && openAnchor) position(panel, openAnchor);
    };

    toggle.title = 'Switch between the short read and every signal with its full working.';
    toggle.addEventListener('click', () => {
      full = !full;
      render();
    });
    foot.appendChild(toggle);

    if (handlers.backendConfigured && typeof handlers.onDeep === 'function') {
      const deep = el('button', 'bd-btn', handlers.deepRunning ? 'reading…' : 'Deep read (LLM)');
      deep.disabled = Boolean(handlers.deepRunning);
      deep.title = 'Sends this username to your configured backend for an LLM agenda read. Never runs automatically.';
      deep.addEventListener('click', () => handlers.onDeep(deep));
      foot.appendChild(deep);
    }
    const refresh = el('button', 'bd-btn bd-btn-quiet', 'Re-check');
    refresh.addEventListener('click', () => {
      if (typeof handlers.onRetry === 'function') handlers.onRetry();
      closePanel();
    });
    foot.appendChild(refresh);
    panel.appendChild(foot);

    render();
    return panel;
  }

  /** One compact row: the three axis bands at a glance. */
  function summaryChips(verdict) {
    const row = el('div', 'bd-summary');
    for (const [key, title] of AXES) {
      const band = bandOf(verdict[key]);
      row.appendChild(el('span', `bd-pill bd-band-${band}`, `${title}: ${BAND_SHORT[band]}`));
    }
    return row;
  }

  /**
   * The concern list: automation and agenda signals whose band is moderate or
   * high. Authenticity is deliberately absent — a low score there is "no
   * positive evidence found", not a concern, and listing it here would turn
   * every unremarkable account into a suspect. When nothing stood out the
   * section says so honestly, in both directions: "nothing stood out" when the
   * checks ran clean, "no data" when they could not run at all.
   */
  function collectConcerns(verdict) {
    const out = [];
    for (const axisKey of ['automation', 'agenda']) {
      const axis = verdict[axisKey];
      if (!axis || !Array.isArray(axis.signals)) continue;
      for (const sig of axis.signals) {
        if (sig && (sig.band === 'high' || sig.band === 'moderate')) out.push({ ...sig, axis: axisKey });
      }
    }
    const rank = { high: 0, moderate: 1 };
    out.sort((a, b) => (rank[a.band] - rank[b.band]) || ((b.weight || 0) - (a.weight || 0)));
    return out;
  }

  function concernsSection(verdict, handlers) {
    const section = el('section', 'bd-axis bd-concerns');
    const head = el('div', 'bd-axis-head');
    head.appendChild(el('span', 'bd-axis-title', 'What stood out'));
    section.appendChild(head);

    if (bandOf(verdict.automation) === 'insufficient-data' && bandOf(verdict.agenda) === 'insufficient-data') {
      section.appendChild(el('p', 'bd-empty', 'Not enough history to run the checks. That is "no data", not a clean result.'));
      return section;
    }

    const concerns = collectConcerns(verdict);
    if (!concerns.length) {
      section.appendChild(el('p', 'bd-empty', 'Nothing stood out on the automation or agenda checks.'));
      return section;
    }

    const list = el('ul', 'bd-signals');
    for (const concern of concerns) list.appendChild(concernRow(concern, handlers));
    section.appendChild(list);
    return section;
  }

  function concernRow(sig, handlers) {
    const band = BANDS.includes(sig.band) ? sig.band : 'insufficient-data';
    const item = el('li', 'bd-concern');

    const head = el('div', 'bd-concern-head');
    head.appendChild(el('span', `bd-dot bd-band-${band}`, ''));
    head.appendChild(el('span', 'bd-concern-text', CONCERN_TEXT[sig.key] || sig.label || sig.key));
    head.appendChild(el('span', 'bd-concern-axis', sig.axis));
    item.appendChild(head);

    const links = el('div', 'bd-concern-links');
    const url = exampleUrlFor(sig, handlers);
    if (url) links.appendChild(exampleAnchor(url));
    const detail = el('div', 'bd-signal-evidence bd-hidden');
    if (sig.evidence) {
      detail.textContent = sig.evidence;
      const why = el('button', 'bd-why', 'why?');
      why.addEventListener('click', () => {
        const hidden = detail.classList.toggle('bd-hidden');
        why.textContent = hidden ? 'why?' : 'hide';
      });
      links.appendChild(why);
    }
    if (links.childElementCount) item.appendChild(links);
    item.appendChild(detail);
    return item;
  }

  /** The simple view's one-line provenance: where the verdict came from. */
  function simpleMeta(payload, verdict) {
    const bits = [];
    bits.push(payload && payload.provider === 'backend' ? 'scored by your backend' : 'scored in this browser');
    if (payload && payload.cached) bits.push('cached');
    const when = fmtWhen(verdict && verdict.fetchedAt);
    if (when) bits.push(`fetched ${when}`);
    if (verdict.coverage && verdict.coverage.truncated) bits.push('partial history');
    return el('div', 'bd-prov-meta bd-simple-meta', bits.join(' · '));
  }

  /**
   * The link to one concrete item behind a signal. The scorers publish a
   * platform-neutral reference in `value.example`; the platform adapter passes
   * `handlers.exampleUrl` to turn it into a real URL, so this file never
   * learns what a Reddit permalink looks like.
   */
  function exampleUrlFor(sig, handlers) {
    const ref = sig && isPlainObject(sig.value) ? sig.value.example : null;
    if (!ref || typeof handlers.exampleUrl !== 'function') return null;
    try {
      return handlers.exampleUrl(ref) || null;
    } catch {
      return null;
    }
  }

  function exampleAnchor(url) {
    const link = el('a', 'bd-example', 'see an example ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.addEventListener('click', (event) => event.stopPropagation());
    return link;
  }

  function provenance(payload, verdict) {
    const box = el('div', 'bd-prov');
    const backend = payload && payload.provider === 'backend';
    const line = backend
      ? 'Scored by your configured backend.'
      : 'Scored locally, in this browser. Nothing but the username left your machine.';
    box.appendChild(el('div', 'bd-prov-line', line));
    if (payload && payload.degraded) {
      box.classList.add('bd-prov-degraded');
      box.appendChild(el('div', 'bd-prov-warn', payload.degradedReason || 'Backend unavailable; this is the local score.'));
    }
    const bits = [];
    if (payload && payload.cached) bits.push('cached');
    const when = fmtWhen(verdict && verdict.fetchedAt);
    if (when) bits.push(`fetched ${when}`);
    if (bits.length) box.appendChild(el('div', 'bd-prov-meta', bits.join(' · ')));
    return box;
  }

  function axisSection(title, blurb, axis, handlers) {
    const band = bandOf(axis);
    const section = el('section', 'bd-axis');
    const head = el('div', 'bd-axis-head');
    head.appendChild(el('span', 'bd-axis-title', title));
    const pill = el('span', `bd-pill bd-band-${band}`, BAND_LONG[band]);
    head.appendChild(pill);
    const score = fmtScore(axis && axis.score);
    if (score !== null) head.appendChild(el('span', 'bd-axis-score', score));
    section.appendChild(head);
    section.appendChild(el('p', 'bd-axis-blurb', blurb));

    const signals = (axis && Array.isArray(axis.signals) ? axis.signals : []).filter(Boolean);
    if (!signals.length) {
      section.appendChild(el('p', 'bd-empty', 'No signals reported for this axis.'));
      return section;
    }
    const list = el('ul', 'bd-signals');
    for (const signal of signals) list.appendChild(signalRow(signal, handlers));
    section.appendChild(list);
    return section;
  }

  function signalRow(signal, handlers = {}) {
    const band = BANDS.includes(signal.band) ? signal.band : 'insufficient-data';
    const dir = signal.direction === 'raises' ? 'raises' : signal.direction === 'lowers' ? 'lowers' : 'neutral';
    const item = el('li', `bd-signal bd-dir-${dir}`);

    const row = el('div', 'bd-signal-head');
    const arrow = dir === 'raises' ? '▲' : dir === 'lowers' ? '▼' : '•';
    const mark = el('span', 'bd-signal-dir', arrow);
    mark.title = dir === 'raises' ? 'raises suspicion' : dir === 'lowers' ? 'lowers suspicion' : 'context only';
    row.appendChild(mark);
    row.appendChild(el('span', 'bd-signal-label', signal.label || signal.key || 'signal'));
    row.appendChild(el('span', `bd-dot bd-band-${band}`, ''));
    const structured = isPlainObject(signal.value);
    if (!structured) row.appendChild(el('span', 'bd-signal-value', fmtValue(signal.value)));
    item.appendChild(row);
    if (structured) item.appendChild(kvBlock(signal.value));

    // The evidence string is the product. A band with no working behind it is
    // just an accusation, so it is always rendered when it exists.
    if (signal.evidence) item.appendChild(el('div', 'bd-signal-evidence', signal.evidence));
    const url = exampleUrlFor(signal, handlers);
    if (url) {
      const links = el('div', 'bd-concern-links');
      links.appendChild(exampleAnchor(url));
      item.appendChild(links);
    }
    if (typeof signal.weight === 'number' && Number.isFinite(signal.weight)) {
      item.appendChild(el('div', 'bd-signal-weight', `weight ${fmtValue(signal.weight)}`));
    }
    return item;
  }

  function llmSection(llm) {
    const section = el('section', 'bd-axis bd-llm');
    const head = el('div', 'bd-axis-head');
    head.appendChild(el('span', 'bd-axis-title', 'Agenda — LLM read'));
    head.appendChild(el('span', 'bd-pill bd-pill-llm', 'backend'));
    section.appendChild(head);
    if (llm.summary) section.appendChild(el('p', 'bd-llm-summary', llm.summary));
    const claims = Array.isArray(llm.claims) ? llm.claims : Array.isArray(llm.themes) ? llm.themes : [];
    if (claims.length) {
      const list = el('ul', 'bd-signals');
      for (const claim of claims) {
        const item = el('li', 'bd-signal');
        item.appendChild(el('div', 'bd-signal-head', typeof claim === 'string' ? claim : claim.label || claim.title || 'claim'));
        const evidence = claim && (claim.evidence || claim.quote);
        if (evidence) item.appendChild(el('div', 'bd-signal-evidence', evidence));
        list.appendChild(item);
      }
      section.appendChild(list);
    }
    if (llm.model) section.appendChild(el('div', 'bd-prov-meta', `model: ${llm.model}`));
    return section;
  }

  function coverageSection(coverage) {
    if (!coverage || typeof coverage !== 'object') return null;
    const section = el('section', 'bd-coverage');
    section.appendChild(el('div', 'bd-axis-title', 'Coverage'));
    const bits = [];
    if (Number.isFinite(coverage.commentsFetched)) {
      bits.push(`${coverage.commentsFetched}${Number.isFinite(coverage.commentsTotal) ? `/${coverage.commentsTotal}` : ''} comments`);
    }
    if (Number.isFinite(coverage.postsFetched)) {
      bits.push(`${coverage.postsFetched}${Number.isFinite(coverage.postsTotal) ? `/${coverage.postsTotal}` : ''} posts`);
    }
    if (coverage.truncated) bits.push('truncated');
    if (Array.isArray(coverage.sources) && coverage.sources.length) bits.push(`via ${coverage.sources.join(', ')}`);
    section.appendChild(el('div', 'bd-prov-meta', bits.length ? bits.join(' · ') : 'not reported'));
    const errors = Array.isArray(coverage.errors) ? coverage.errors.filter(Boolean) : [];
    for (const error of errors) section.appendChild(el('div', 'bd-cov-error', String(error)));
    return section;
  }

  // Close on outside click / Escape. Both listeners are passive observers of
  // the page; neither cancels an event, so Reddit's own handlers still run.
  document.addEventListener('click', (event) => {
    if (!openPanelEl) return;
    if (openPanelEl.contains(event.target)) return;
    if (openAnchor && openAnchor.contains(event.target)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openPanelEl) closePanel();
  }, true);
  window.addEventListener('resize', () => {
    if (openPanelEl && openAnchor) position(openPanelEl, openAnchor);
  });
  window.addEventListener('scroll', () => {
    if (openPanelEl && openAnchor) position(openPanelEl, openAnchor);
  }, true);

  window.__bdUI = {
    createBadge,
    setIdle,
    setPending,
    setError,
    setVerdict,
    openPanel,
    closePanel,
    isPanelOpenFor: (badge) => openAnchor === badge,
  };
})();
