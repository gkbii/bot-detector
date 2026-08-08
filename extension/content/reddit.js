/**
 * content/reddit.js — the Reddit adapter.
 *
 * Its whole job is to turn a Reddit page into a stream of
 * `{container, anchor, username}` and hand each one to the neutral badge UI in
 * content/badge.js. Nothing platform-specific lives anywhere else, and nothing
 * about a Verdict lives here — TikTok or X later is a second file next to this
 * one, not a rewrite.
 *
 * Loaded as a classic script (Chrome does not support ES modules for
 * declaratively-injected content scripts); it reads `window.__bdUI`, which
 * content/badge.js defines and manifest.json loads first.
 *
 * Three rules:
 *   - Badge as things scroll into view, via IntersectionObserver. A 4000-comment
 *     thread must never fire 4000 lookups, and the *point* of the feature is
 *     seeing the shape of a whole thread rather than checking the one name you
 *     already suspected.
 *   - Never fetch here. The service worker owns the queue, the cap and the
 *     backoff, because those only mean anything if they are global across tabs.
 *   - Never block, replace or restyle Reddit's own content. The only write to
 *     their DOM is one `insertAdjacentElement` of our own badge, and every
 *     entry point below is wrapped so that if we throw, the page is untouched.
 */

(() => {
  'use strict';
  if (window.__bdRedditLoaded) return;
  window.__bdRedditLoaded = true;

  const UI = window.__bdUI;
  if (!UI) return; // badge.js failed to load; do nothing rather than half-run

  // =========================================================================
  // SELECTOR TABLE — the only place Reddit's DOM is described.
  //
  // A Reddit redesign is a one-file, one-table fix. Everything below this block
  // works in terms of `container` / `anchor` / `username` and never touches a
  // Reddit class name again.
  //
  //   detect      does this layout own the current page?
  //   container   the repeating unit that holds one author (comments nest, so
  //               every author lookup inside it is `:scope >`-anchored)
  //   authorAttr  attribute on the container holding the username, if any —
  //               preferred over the link text, which can be a display name
  //   anchor      where our badge is inserted (afterend of the first match);
  //               tried in order, so a missing meta row degrades to the row
  //   dark        does the page render dark right now?
  // =========================================================================
  const LAYOUTS = {
    shreddit: {
      label: 'new Reddit',
      detect: () => Boolean(document.querySelector('shreddit-app, shreddit-comment, shreddit-post')),
      comment: {
        container: 'shreddit-comment',
        authorAttr: 'author',
        authorLink: ':scope > [slot="commentMeta"] a[href*="/user/"]',
        anchor: [
          ':scope > [slot="commentMeta"] a[href*="/user/"]',
          ':scope > [slot="commentMeta"] faceplate-hovercard',
          ':scope > [slot="commentMeta"]',
        ],
        // New Reddit renames these slots from time to time — that rename is
        // exactly what broke comment badging while post badging kept working.
        // When every `anchor` selector above misses, fall back to the comment's
        // own author link (see ownAuthorLink) so a rename moves the badge rather
        // than dropping it.
        ownAuthorLink: true,
      },
      post: {
        container: 'shreddit-post',
        authorAttr: 'author',
        authorLink: ':scope a[href*="/user/"]',
        anchor: [
          ':scope [slot="credit-bar"] a[href*="/user/"]',
          ':scope [slot="credit-bar"] faceplate-hovercard',
          ':scope [slot="credit-bar"]',
        ],
        ownAuthorLink: true,
      },
      self: [
        '#user-drawer-content a[href^="/user/"]',
        '#USER_DROPDOWN_ID span',
        'faceplate-dropdown-menu a[href^="/user/"]',
      ],
      dark: () => document.documentElement.classList.contains('theme-dark'),
    },

    old: {
      label: 'old Reddit',
      detect: () => Boolean(document.querySelector('#siteTable, #header-bottom-left, .thing .entry .tagline')),
      comment: {
        container: '.thing.comment',
        authorAttr: 'data-author',
        authorLink: ':scope > .entry .tagline a.author',
        anchor: [':scope > .entry .tagline a.author', ':scope > .entry .tagline'],
      },
      post: {
        container: '.thing.link',
        authorAttr: 'data-author',
        authorLink: ':scope > .entry .tagline a.author',
        anchor: [':scope > .entry .tagline a.author', ':scope > .entry .tagline'],
      },
      self: ['#header-bottom-right span.user > a'],
      // Old Reddit has no first-party dark mode; RES adds `.res-nightmode`.
      dark: () => document.body.classList.contains('res-nightmode'),
    },
  };

  // Accounts we never badge. Not a judgement — badging these is noise, and
  // guessing at "bot-looking" usernames would be exactly the unevidenced
  // accusation this extension exists to replace with working.
  const NEVER_BADGE = new Set([
    '[deleted]', '[removed]', 'automoderator', 'reddit', 'redditcareresources',
    'remindmebot', 'sneakpeekbot', 'wikitextbot', 'totesmessenger', 'b0trank',
    'goodbot_badbot', 'haikusbot', 'imagelinkerbot', 'converter-bot',
    'savevideo', 'vreddit_bot', 'stabbot', 'gifreversingbot', 'transcribersofreddit',
    'anti-evil-operations', 'modcodeofconduct',
  ].map((n) => n.toLowerCase()));

  const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const seenContainers = new WeakSet(); // never mutates Reddit's DOM to mark work
  const containerSpec = new WeakMap();  // container -> {kind}
  const badgePayload = new WeakMap();   // badge -> last lookup result
  const badgeUser = new WeakMap();      // badge -> username
  let settings = { autoScan: true, scanPosts: true };
  let backendConfigured = false;
  let selfUser = null;
  let selfTries = 0;
  let layout = null;
  let observer = null;
  let mutationObserver = null;
  let extensionDead = false;
  let errorBudget = 25;

  // -------------------------------------------------------------------------
  // Guard rails: any throw is contained, and a persistently broken build
  // stands down completely rather than fighting the page.
  // -------------------------------------------------------------------------
  function safe(fn, label) {
    return (...args) => {
      if (extensionDead) return undefined;
      try {
        return fn(...args);
      } catch (err) {
        if (--errorBudget <= 0) {
          console.warn('[bot-detector] too many errors, standing down', label, err);
          teardown();
        }
        return undefined;
      }
    };
  }

  function teardown() {
    extensionDead = true;
    try { if (observer) observer.disconnect(); } catch { /* ignore */ }
    try { if (mutationObserver) mutationObserver.disconnect(); } catch { /* ignore */ }
    try { UI.closePanel(); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Messaging — the content script only ever asks.
  // -------------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function askBackground(message, retries = 1) {
    if (extensionDead) throw new Error('extension unloaded');
    let res;
    try {
      res = await chrome.runtime.sendMessage(message);
    } catch (err) {
      const text = String((err && err.message) || err);
      if (/Extension context invalidated/i.test(text)) {
        teardown();
        throw new Error('extension was reloaded — refresh the page');
      }
      if (retries > 0 && /connection|Receiving end|port closed/i.test(text)) {
        // The MV3 worker was asleep and is spinning back up. One retry.
        await sleep(400);
        return askBackground(message, retries - 1);
      }
      throw new Error(text);
    }
    if (!res) throw new Error('no response from the extension worker');
    if (!res.ok) {
      const err = new Error((res.error && res.error.message) || 'lookup failed');
      err.kind = res.error && res.error.kind;
      throw err;
    }
    return res.data;
  }

  // -------------------------------------------------------------------------
  // Layout + identity
  // -------------------------------------------------------------------------
  function resolveLayout() {
    if (layout && layout.detect()) return layout;
    for (const candidate of [LAYOUTS.shreddit, LAYOUTS.old]) {
      if (candidate.detect()) {
        layout = candidate;
        return layout;
      }
    }
    return null;
  }

  // Best effort, and deliberately so: if we cannot work out who is logged in,
  // the only consequence is that you get badged too. Guessing wrong in the
  // other direction — skipping someone else's account — would be worse.
  function resolveSelf() {
    if (selfUser || selfTries > 8 || !layout) return selfUser;
    selfTries += 1;
    for (const selector of layout.self || []) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const name = usernameFromHref(node.getAttribute && node.getAttribute('href')) || (node.textContent || '').trim();
      if (USERNAME_RE.test(name)) {
        selfUser = name.toLowerCase();
        return selfUser;
      }
    }
    return null;
  }

  function usernameFromHref(href) {
    if (!href) return null;
    const match = /\/(?:user|u)\/([A-Za-z0-9_-]{3,20})(?:[/?#]|$)/.exec(href);
    return match ? match[1] : null;
  }

  function shouldSkip(username) {
    if (!username || !USERNAME_RE.test(username)) return true;
    const lower = username.toLowerCase();
    if (NEVER_BADGE.has(lower)) return true;
    if (selfUser && lower === selfUser) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Discovery + observation
  // -------------------------------------------------------------------------
  function queryAll(root, selector) {
    const out = [];
    if (root.nodeType !== 1) return out;
    if (root.matches && root.matches(selector)) out.push(root);
    if (root.querySelectorAll) out.push(...root.querySelectorAll(selector));
    return out;
  }

  function collect(root) {
    if (!resolveLayout()) return;
    resolveSelf();
    const kinds = settings.scanPosts ? ['comment', 'post'] : ['comment'];
    for (const kind of kinds) {
      const spec = layout[kind];
      if (!spec) continue;
      for (const container of queryAll(root, spec.container)) {
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);
        containerSpec.set(container, { kind });
        observer.observe(container);
      }
    }
  }

  const onIntersect = safe((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      attach(entry.target);
    }
  }, 'intersect');

  const attach = safe((container) => {
    const meta = containerSpec.get(container);
    if (!meta || !layout) return;
    const spec = layout[meta.kind];
    if (!spec) return;

    const username = readUsername(container, spec);
    if (shouldSkip(username)) return;

    const anchor = findAnchor(container, spec);
    if (!anchor) return;
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList &&
        anchor.nextElementSibling.classList.contains('bd-badge')) return;

    const badge = UI.createBadge(username, layout.dark());
    badgeUser.set(badge, username);
    badge.addEventListener('click', onBadgeActivate);
    badge.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onBadgeActivate({ currentTarget: badge });
      }
    });

    // The one and only write to Reddit's DOM.
    anchor.insertAdjacentElement('afterend', badge);
    lookup(badge, username, false);
  }, 'attach');

  function readUsername(container, spec) {
    if (spec.authorAttr) {
      const attr = container.getAttribute(spec.authorAttr);
      if (attr && USERNAME_RE.test(attr)) return attr;
      if (attr) return attr.trim(); // e.g. "[deleted]" — shouldSkip handles it
    }
    const link = spec.authorLink && container.querySelector(spec.authorLink);
    if (link) {
      const fromHref = usernameFromHref(link.getAttribute('href'));
      if (fromHref) return fromHref;
      const text = (link.textContent || '').trim();
      if (USERNAME_RE.test(text)) return text;
    }
    return null;
  }

  function findAnchor(container, spec) {
    for (const selector of spec.anchor || []) {
      const node = container.querySelector(selector);
      if (node) return node;
    }
    // Every pinned slot selector missed. On new Reddit this happens when a slot
    // is renamed; rather than silently drop the badge, insert next to the
    // container's own author link.
    if (spec.ownAuthorLink) {
      const link = ownAuthorLink(container, spec.container);
      if (link) return link;
    }
    return null;
  }

  // The comment's own author link, and only its own. shreddit-comment elements
  // nest — a reply is a descendant shreddit-comment — so a bare querySelector
  // would happily return a child comment's author and hang this comment's badge
  // inside a reply. Requiring the link's nearest container to be *this* one
  // keeps us on the right meta row. The username test skips post-body mentions
  // of /user/x that are not real handles.
  //
  // The byline has two links to the same profile — the avatar (wraps only an
  // image) and the name (has visible text). Prefer the name: anchoring on the
  // avatar drops the badge into the narrow avatar column, where the two chips
  // overlap the name row. The avatar is only the last-resort fallback.
  function ownAuthorLink(container, containerSelector) {
    let avatarLink = null;
    for (const link of container.querySelectorAll('a[href*="/user/"]')) {
      if (link.closest(containerSelector) !== container) continue;
      if (!usernameFromHref(link.getAttribute('href'))) continue;
      if ((link.textContent || '').trim()) return link;
      if (!avatarLink) avatarLink = link;
    }
    return avatarLink;
  }

  // -------------------------------------------------------------------------
  // Lookup + panel
  // -------------------------------------------------------------------------
  async function lookup(badge, username, force) {
    if (extensionDead || !badge.isConnected) return;
    UI.setPending(badge);
    try {
      const data = await askBackground({ type: 'BD_LOOKUP', platform: 'reddit', username, force: Boolean(force) });
      if (!badge.isConnected) return;
      badgePayload.set(badge, data);
      UI.setVerdict(badge, data);
      if (UI.isPanelOpenFor(badge)) showPanel(badge);
    } catch (err) {
      if (!badge.isConnected) return;
      UI.setError(badge, (err && err.message) || 'lookup failed');
    }
  }

  const onBadgeActivate = safe((event) => {
    const badge = event.currentTarget;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    const payload = badgePayload.get(badge);
    if (!payload) {
      lookup(badge, badgeUser.get(badge), true);
      return;
    }
    if (UI.isPanelOpenFor(badge)) {
      UI.closePanel();
      return;
    }
    showPanel(badge);
  }, 'activate');

  function showPanel(badge, deepRunning = false) {
    const payload = badgePayload.get(badge);
    const username = badgeUser.get(badge);
    UI.openPanel(badge, payload, {
      backendConfigured,
      deepRunning,
      onRetry: () => lookup(badge, username, true),
      // Click-to-run only, and only with a backend configured. A deep read
      // costs the backend an LLM call per account; firing one automatically
      // for every commenter in a thread is how you get a bill and a rate limit.
      onDeep: async () => {
        showPanel(badge, true);
        try {
          const data = await askBackground({
            type: 'BD_LOOKUP', platform: 'reddit', username, deep: true, force: true,
          });
          badgePayload.set(badge, data);
          UI.setVerdict(badge, data);
          showPanel(badge, false);
        } catch (err) {
          badgePayload.set(badge, {
            ...payload,
            degraded: true,
            degradedReason: `Deep read failed: ${(err && err.message) || 'unknown error'}`,
          });
          showPanel(badge, false);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function start() {
    if (observer) return;
    observer = new IntersectionObserver(onIntersect, { root: null, rootMargin: '200px 0px' });
    mutationObserver = new MutationObserver(safe((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) collect(node);
        }
      }
    }, 'mutation'));
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    collect(document.body);
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    UI.closePanel();
    for (const badge of document.querySelectorAll('.bd-badge')) badge.remove();
  }

  async function boot() {
    try {
      const status = await askBackground({ type: 'BD_STATUS' });
      settings = status.settings || settings;
      backendConfigured = status.mode === 'backend';
    } catch {
      // The worker may be missing its core modules entirely. Auto-scan still
      // runs; each badge will render its own "unavailable" state, which is the
      // honest thing to show and costs the page nothing.
    }
    if (settings.autoScan) start();
  }

  chrome.storage.onChanged.addListener(safe((changes, area) => {
    if (area !== 'sync') return;
    if (changes.autoScan) {
      settings.autoScan = changes.autoScan.newValue !== false;
      if (settings.autoScan) start();
      else stop();
    }
    if (changes.scanPosts) settings.scanPosts = changes.scanPosts.newValue !== false;
    if (changes.backendUrl) backendConfigured = Boolean(changes.backendUrl.newValue);
  }, 'settings-change'));

  boot();
})();
