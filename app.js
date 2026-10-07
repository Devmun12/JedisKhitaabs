/* Jedis Khitaabs: collect titles for Section J classmates.
   No dependencies. The page only ever sends data; it never reads anything back
   except the script's one-line "saved" or "rejected" answer. */
(function () {
  'use strict';

  var CFG = Object.assign({ endpoint: '', maxTitles: 40, maxTitleLength: 80 }, window.JEDIS_CONFIG || {});
  var ROSTER = (window.JEDIS_ROSTER || []).slice();
  var ENDPOINT_OK = /^https:\/\/script\.google\.com\/.+\/exec$/.test(CFG.endpoint);
  var MAX_TITLES_PER_CLASSMATE = 10;
  var DRAFT_KEY = 'jedis.draft.v1';
  var ME_KEY = 'jedis.me.v1';
  var RETRY_DELAYS = CFG.retryDelays || [0, 1500, 4000, 9000];
  var REQUEST_TIMEOUT = CFG.requestTimeout || 20000;

  var ICON = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>'
  };

  var seq = 0;
  var state = {
    me: '',
    cards: [],
    showErrors: false,
    sending: false,
    failed: false,
    pending: null,
    saveTimer: null
  };

  /* ---------- small helpers ---------- */

  function $(sel) { return document.querySelector(sel); }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // static icon strings only, never user text
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function norm(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function store(op, key, val) {
    try {
      if (op === 'get') return localStorage.getItem(key);
      if (op === 'set') localStorage.setItem(key, val);
      if (op === 'del') localStorage.removeItem(key);
    } catch (e) { /* private mode or blocked storage: the page still works */ }
    return null;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---------- classmate search ---------- */

  function search(query, items) {
    var q = norm(query).trim();
    if (!q) return items.slice();
    var tokens = q.split(/\s+/);
    var out = [];
    items.forEach(function (it, i) {
      var n = norm(it.name);
      var words = n.split(' ');
      var ok = tokens.every(function (t) { return n.indexOf(t) !== -1; });
      if (!ok) return;
      var prefix = tokens.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0; }); });
      var rank = prefix ? (n.indexOf(tokens[0]) === 0 ? 0 : 1) : 2;
      out.push({ it: it, rank: rank, i: i });
    });
    out.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
    return out.map(function (o) { return o.it; });
  }

  function highlight(name, query) {
    var frag = document.createDocumentFragment();
    var q = norm(query).trim();
    var n = norm(name);
    if (!q || n.length !== name.length) { frag.appendChild(document.createTextNode(name)); return frag; }
    var marks = new Array(name.length);
    q.split(/\s+/).forEach(function (t) {
      var at = n.indexOf(t);
      if (at === -1) return;
      for (var i = at; i < at + t.length; i++) marks[i] = true;
    });
    var i = 0;
    while (i < name.length) {
      var on = !!marks[i];
      var j = i;
      while (j < name.length && !!marks[j] === on) j++;
      var text = name.slice(i, j);
      frag.appendChild(on ? h('mark', { text: text }) : document.createTextNode(text));
      i = j;
    }
    return frag;
  }

  function createCombobox(o) {
    var listId = o.id + '-list';
    var input = h('input', {
      id: o.id, class: 'input', type: 'text', role: 'combobox', autocomplete: 'off',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
      placeholder: o.placeholder, 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId, 'aria-labelledby': o.labelledBy
    });
    var list = h('ul', { id: listId, class: 'list', role: 'listbox', hidden: true, 'aria-labelledby': o.labelledBy });
    var wrap = h('div', { class: 'combo' }, [input, list]);
    var items = [];
    var active = -1;
    var open = false;

    function enabled(it) { return !it.disabled; }

    function paintActive(scroll) {
      var opts = list.querySelectorAll('.item');
      for (var i = 0; i < opts.length; i++) opts[i].setAttribute('aria-selected', i === active ? 'true' : 'false');
      if (active >= 0 && opts[active]) {
        input.setAttribute('aria-activedescendant', opts[active].id);
        if (scroll) opts[active].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function firstEnabled() {
      for (var i = 0; i < items.length; i++) if (enabled(items[i])) return i;
      return -1;
    }

    function render() {
      items = search(input.value, o.getItems());
      list.textContent = '';
      if (!items.length) {
        list.appendChild(h('li', { class: 'empty', role: 'presentation', text: 'No classmate matches “' + input.value.trim() + '”. Check the spelling.' }));
        active = -1;
        paintActive(false);
        return;
      }
      items.forEach(function (it, i) {
        var li = h('li', { id: listId + '-' + i, class: 'item', role: 'option', 'aria-selected': 'false', 'aria-disabled': it.disabled ? 'true' : 'false' });
        li.appendChild(h('span', { class: 'nm' }, [highlight(it.name, input.value)]));
        if (it.note) li.appendChild(h('span', { class: 'note', text: it.note }));
        li.addEventListener('click', function () { if (!it.disabled) pick(it.name); });
        list.appendChild(li);
      });
      active = input.value.trim() ? firstEnabled() : -1;
      paintActive(false);
    }

    function openList() {
      if (open) return;
      open = true;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
    }

    function closeList() {
      open = false;
      list.hidden = true;
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function pick(name) {
      closeList();
      input.value = '';
      o.onPick(name);
    }

    function move(dir) {
      if (!items.length) return;
      var i = active;
      for (var step = 0; step < items.length; step++) {
        i = (i + dir + items.length) % items.length;
        if (enabled(items[i])) { active = i; break; }
      }
      paintActive(true);
    }

    input.addEventListener('focus', function () {
      openList();
      setTimeout(function () { try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }, 250);
    });
    input.addEventListener('click', openList);
    input.addEventListener('input', function () { if (!open) openList(); else render(); });
    input.addEventListener('blur', function () { setTimeout(closeList, 150); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openList(); else move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) move(-1); }
      else if (e.key === 'Enter') {
        if (!open) return;
        e.preventDefault();
        if (active >= 0 && enabled(items[active])) pick(items[active].name);
        else {
          var en = items.filter(enabled);
          if (en.length === 1) pick(en[0].name);
        }
      }
      else if (e.key === 'Escape') { if (open) { e.preventDefault(); closeList(); } }
      else if (e.key === 'Tab') { closeList(); }
    });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });

    return { el: wrap, input: input, focus: function () { input.focus(); } };
  }

  /* ---------- data model ---------- */

  function newCard(person, titles) {
    return { id: ++seq, person: person || '', titles: titles && titles.length ? titles : [''], el: null };
  }

  function hasContent(card) {
    return !!card.person || card.titles.some(function (t) { return clean(t); });
  }

  function collect() {
    var entries = [];
    var problems = [];
    state.cards.forEach(function (c) {
      var seen = {};
      var titles = [];
      c.titles.forEach(function (t) {
        var v = clean(t);
        if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = true; titles.push(v); }
      });
      if (!c.person && titles.length) problems.push({ card: c, kind: 'person' });
      else if (c.person && !titles.length) problems.push({ card: c, kind: 'title' });
      else if (c.person) titles.forEach(function (t) { entries.push({ classmate: c.person, title: t }); });
    });
    return { entries: entries, problems: problems };
  }

  function itemsForCard(card) {
    var taken = {};
    state.cards.forEach(function (c) { if (c !== card && c.person) taken[c.person] = true; });
    return ROSTER.filter(function (n) { return n !== state.me; }).map(function (n) {
      return taken[n] ? { name: n, disabled: true, note: 'Added' } : { name: n };
    });
  }

  /* ---------- rendering ---------- */

  function buildCard(card) {
    var pid = 'c' + card.id;
    var el = h('section', { class: 'card', 'data-id': String(card.id) });
    card.el = el;
    card.combo = null;

    var head = h('div', { class: 'card-head' });
    if (card.person) head.appendChild(h('span', { class: 'lbl', id: pid + '-lbl', text: 'Classmate' }));
    else head.appendChild(h('label', { class: 'lbl', id: pid + '-lbl', for: pid, text: 'Classmate' }));
    if (state.cards.length > 1) {
      head.appendChild(h('button', {
        type: 'button', class: 'text-btn', 'aria-label': card.person ? 'Remove ' + card.person : 'Remove this classmate', text: 'Remove',
        onclick: function () { removeCard(card); }
      }));
    }
    el.appendChild(head);

    if (card.person) {
      el.appendChild(h('div', { class: 'chosen' }, [
        h('span', { class: 'chosen-name', text: card.person }),
        h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': 'Change classmate', html: ICON.x,
          onclick: function () { card.person = ''; rebuild(card, { kind: 'person' }); changed(card); }
        })
      ]));
    } else {
      var cb = createCombobox({
        id: pid, placeholder: 'Search a name', labelledBy: pid + '-lbl',
        getItems: function () { return itemsForCard(card); },
        onPick: function (name) {
          card.person = name;
          var firstEmpty = card.titles.findIndex(function (t) { return !clean(t); });
          rebuild(card, { kind: 'title', index: firstEmpty === -1 ? card.titles.length - 1 : firstEmpty });
          changed(card);
        }
      });
      card.combo = cb;
      el.appendChild(cb.el);
    }
    card.personErr = h('p', { class: 'err', id: pid + '-perr', hidden: true });
    el.appendChild(card.personErr);

    var titles = h('div', { class: 'titles' });
    titles.appendChild(h('span', { class: 'lbl', text: card.titles.length > 1 ? 'Titles' : 'Title' }));
    card.titleInputs = [];
    card.titles.forEach(function (t, i) {
      var inp = h('input', {
        id: pid + '-t' + i, class: 'input', type: 'text', maxlength: String(CFG.maxTitleLength), value: t,
        placeholder: i ? 'Another title' : 'Type a title', autocomplete: 'off', enterkeyhint: 'next',
        'aria-label': 'Title ' + (i + 1) + (card.person ? ' for ' + card.person : '')
      });
      inp.addEventListener('input', function () { card.titles[i] = inp.value; changed(card); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i < card.titles.length - 1) card.titleInputs[i + 1].focus();
          else if (clean(inp.value)) addTitle(card);
        } else if (e.key === 'Backspace' && !inp.value && card.titles.length > 1) {
          e.preventDefault();
          removeTitle(card, i);
        }
      });
      card.titleInputs.push(inp);
      var row = h('div', { class: 'title-row' }, [inp]);
      if (card.titles.length > 1) {
        row.appendChild(h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': 'Remove title ' + (i + 1), html: ICON.x,
          onclick: function () { removeTitle(card, i); }
        }));
      }
      titles.appendChild(row);
    });
    card.titleErr = h('p', { class: 'err', id: pid + '-terr', hidden: true });
    titles.appendChild(card.titleErr);
    card.addTitleBtn = h('button', {
      type: 'button', class: 'link', html: ICON.plus + '<span>Add another title</span>',
      onclick: function () { addTitle(card); }
    });
    titles.appendChild(card.addTitleBtn);
    el.appendChild(titles);

    refreshCard(card);
    return el;
  }

  function renderCards() {
    var wrap = $('#cards');
    wrap.textContent = '';
    state.cards.forEach(function (c) { wrap.appendChild(buildCard(c)); });
    updateBar();
  }

  function rebuild(card, focus) {
    var old = card.el;
    var fresh = buildCard(card);
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
    if (focus) focusCard(card, focus);
    if (state.showErrors) paintErrors(collect().problems);
  }

  function focusCard(card, spec) {
    if (spec.kind === 'person' && card.combo) card.combo.focus();
    else if (spec.kind === 'title' && card.titleInputs[spec.index]) card.titleInputs[spec.index].focus();
  }

  function refreshCard(card) {
    var last = card.titles[card.titles.length - 1];
    var canAdd = !!clean(last) && card.titles.length < MAX_TITLES_PER_CLASSMATE;
    card.addTitleBtn.hidden = !canAdd;
  }

  function addCard() {
    var card = newCard();
    state.cards.push(card);
    renderCards();
    if (card.combo) card.combo.focus();
    changed();
  }

  function removeCard(card) {
    var i = state.cards.indexOf(card);
    if (i === -1) return;
    state.cards.splice(i, 1);
    if (!state.cards.length) state.cards.push(newCard());
    renderCards();
    if (state.showErrors) paintErrors(collect().problems);
    changed();
  }

  function addTitle(card) {
    if (card.titles.length >= MAX_TITLES_PER_CLASSMATE) return;
    card.titles.push('');
    rebuild(card, { kind: 'title', index: card.titles.length - 1 });
    changed(card);
  }

  function removeTitle(card, i) {
    card.titles.splice(i, 1);
    if (!card.titles.length) card.titles.push('');
    rebuild(card, { kind: 'title', index: Math.max(0, Math.min(i - 1, card.titles.length - 1)) });
    changed(card);
  }

  function paintErrors(problems) {
    state.cards.forEach(function (c) {
      if (!c.el) return;
      c.personErr.hidden = true;
      c.titleErr.hidden = true;
      var pi = c.combo && c.combo.input;
      if (pi) pi.removeAttribute('aria-invalid');
      c.titleInputs.forEach(function (i) { i.removeAttribute('aria-invalid'); });
    });
    problems.forEach(function (p) {
      var c = p.card;
      if (!c.el) return;
      if (p.kind === 'person') {
        setErr(c.personErr, 'Pick a classmate for this title.');
        if (c.combo) c.combo.input.setAttribute('aria-invalid', 'true');
      } else {
        setErr(c.titleErr, 'Add a title for ' + c.person + '.');
        if (c.titleInputs[0]) c.titleInputs[0].setAttribute('aria-invalid', 'true');
      }
    });
  }

  function setErr(el, text) {
    el.textContent = '';
    el.appendChild(h('span', { html: ICON.alert }));
    el.appendChild(h('span', { text: text }));
    el.hidden = false;
  }

  /* ---------- "your name" ---------- */

  function renderMe() {
    var slot = $('#me-slot');
    slot.textContent = '';
    if (state.me) {
      slot.appendChild(h('div', { class: 'chosen' }, [
        h('span', { class: 'chosen-name', text: state.me }),
        h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': 'Change your name', html: ICON.x,
          onclick: function () { setMe(''); var cb = $('#me-input'); if (cb) cb.focus(); }
        })
      ]));
      $('#me-label').removeAttribute('for');
    } else {
      var cb = createCombobox({
        id: 'me-input', placeholder: 'Pick your name', labelledBy: 'me-label',
        getItems: function () { return ROSTER.map(function (n) { return { name: n }; }); },
        onPick: function (name) { setMe(name); }
      });
      $('#me-label').setAttribute('for', 'me-input');
      slot.appendChild(cb.el);
    }
  }

  function setMe(name) {
    state.me = name;
    store(name ? 'set' : 'del', ME_KEY, name);
    var cleared = false;
    state.cards.forEach(function (c) { if (name && c.person === name) { c.person = ''; cleared = true; } });
    renderMe();
    if (cleared) renderCards();
    changed();
    if (cleared) setStatus('You can’t pick yourself, so that classmate was cleared.', '');
  }

  /* ---------- bar and status ---------- */

  function setStatus(text, kind) {
    var s = $('#status');
    s.textContent = '';
    s.className = 'status' + (kind ? ' ' + kind : '');
    if (!text) return;
    if (kind === 'error') s.appendChild(h('span', { html: ICON.alert }));
    s.appendChild(h('span', { text: text }));
  }

  function updateBar() {
    var c = collect();
    var n = c.entries.length;
    var any = state.cards.some(hasContent);
    var btn = $('#send');
    btn.disabled = state.sending || !any;
    btn.setAttribute('aria-busy', state.sending ? 'true' : 'false');
    var label = 'Send titles';
    if (state.sending) label = 'Sending…';
    else if (state.failed) label = 'Try again';
    else if (n) label = 'Send ' + plural(n, 'title', 'titles');
    btn.querySelector('.label').textContent = label;
  }

  function changed(card) {
    if (card) refreshCard(card);
    state.failed = false;
    if (state.showErrors) paintErrors(collect().problems);
    if (!state.sending && $('#status').classList.contains('error')) setStatus('', '');
    updateBar();
    scheduleSave();
  }

  /* ---------- draft ---------- */

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveDraft, 300);
  }

  function saveDraft() {
    var any = state.cards.some(hasContent);
    if (!any) { store('del', DRAFT_KEY); return; }
    store('set', DRAFT_KEY, JSON.stringify({
      cards: state.cards.map(function (c) { return { person: c.person, titles: c.titles }; })
    }));
  }

  function loadDraft() {
    var me = store('get', ME_KEY) || '';
    state.me = ROSTER.indexOf(me) !== -1 ? me : '';
    var cards = [];
    try {
      var d = JSON.parse(store('get', DRAFT_KEY) || 'null');
      if (d && Array.isArray(d.cards)) {
        d.cards.slice(0, 40).forEach(function (c) {
          var person = ROSTER.indexOf(c.person) !== -1 && c.person !== state.me ? c.person : '';
          var titles = Array.isArray(c.titles) ? c.titles.slice(0, MAX_TITLES_PER_CLASSMATE).map(function (t) { return String(t).slice(0, CFG.maxTitleLength); }) : [''];
          if (person || titles.some(function (t) { return clean(t); })) cards.push(newCard(person, titles));
        });
      }
    } catch (e) { cards = []; }
    state.cards = cards.length ? cards : [newCard()];
  }

  /* ---------- sending ---------- */

  function setSending(on) {
    state.sending = on;
    $('#view-form').inert = on;
    updateBar();
  }

  async function postOnce(payload) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, REQUEST_TIMEOUT);
    try {
      var res = await fetch(CFG.endpoint, {
        method: 'POST', body: JSON.stringify(payload), redirect: 'follow',
        credentials: 'omit', cache: 'no-store', signal: ctl.signal
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function postWithRetry(payload) {
    var message = 'Couldn’t send. Your titles are saved on this phone. Check your connection and tap Try again.';
    for (var i = 0; i < RETRY_DELAYS.length; i++) {
      if (RETRY_DELAYS[i]) {
        setStatus('Still trying…', '');
        await sleep(RETRY_DELAYS[i] + Math.random() * 400);
      }
      try {
        var data = await postOnce(payload);
        if (data && data.ok === true) return { ok: true, data: data };
        if (data && data.ok === false && data.retry === false) {
          return { ok: false, message: data.message || 'That wasn’t accepted. Check your list and try again.' };
        }
      } catch (e) { /* network error or timeout: try again */ }
    }
    return { ok: false, message: message };
  }

  function focusProblem(p) {
    var c = p.card;
    if (p.kind === 'person' && c.combo) c.combo.focus();
    else if (c.titleInputs && c.titleInputs[0]) c.titleInputs[0].focus();
    if (c.el) c.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function send() {
    if (state.sending) return;
    var c = collect();
    state.showErrors = true;
    paintErrors(c.problems);
    if (c.problems.length) {
      focusProblem(c.problems[0]);
      setStatus('Fix the highlighted spots, then send again.', 'error');
      return;
    }
    if (!c.entries.length) return;
    if (c.entries.length > CFG.maxTitles) {
      setStatus('That’s more than ' + CFG.maxTitles + ' titles at once. Send these first, then add more.', 'error');
      return;
    }
    if (!ENDPOINT_OK) {
      setStatus('This page isn’t connected to its Sheet yet. Tell the organiser.', 'error');
      return;
    }
    if (navigator.onLine === false) {
      state.failed = true;
      setStatus('You’re offline. Your titles are saved on this phone. Reconnect, then tap Try again.', 'error');
      updateBar();
      return;
    }

    var key = JSON.stringify([state.me, c.entries]);
    if (!state.pending || state.pending.key !== key) state.pending = { key: key, id: uid() };
    var payload = { v: 1, submissionId: state.pending.id, responder: state.me, entries: c.entries, hp: '' };

    setStatus('', '');
    saveDraft();
    setSending(true);
    var res = await postWithRetry(payload);
    setSending(false);

    if (res.ok) {
      finish(c.entries);
    } else {
      state.failed = true;
      setStatus(res.message, 'error');
      updateBar();
    }
  }

  function finish(entries) {
    store('del', DRAFT_KEY);
    state.pending = null;
    state.failed = false;
    setStatus('', '');

    var groups = [];
    entries.forEach(function (e) {
      var g = groups.find(function (x) { return x.name === e.classmate; });
      if (!g) { g = { name: e.classmate, titles: [] }; groups.push(g); }
      g.titles.push(e.title);
    });
    var box = $('#receipt');
    box.textContent = '';
    groups.forEach(function (g) {
      box.appendChild(h('p', { class: 'who', text: g.name }));
      box.appendChild(h('ul', {}, g.titles.map(function (t) { return h('li', { text: t }); })));
    });
    $('#done-title').textContent = plural(entries.length, 'title', 'titles') + ' sent';

    $('#view-form').hidden = true;
    $('#view-done').hidden = false;
    $('#bar').hidden = true;
    window.scrollTo(0, 0);
    $('#done-title').focus();
  }

  function startOver() {
    state.cards = [newCard()];
    state.showErrors = false;
    state.failed = false;
    $('#view-done').hidden = true;
    $('#view-form').hidden = false;
    $('#bar').hidden = false;
    renderMe();
    renderCards();
    window.scrollTo(0, 0);
    var first = state.cards[0].combo;
    if (first) first.focus();
  }

  /* ---------- start ---------- */

  function init() {
    $('#add-card').innerHTML = ICON.plus + '<span>Add another classmate</span>';
    $('#done-title').parentNode.querySelector('.done-icon').innerHTML = ICON.check;
    Array.prototype.forEach.call(document.querySelectorAll('.ico'), function (n) { n.innerHTML = ICON.lock; });

    if (!ENDPOINT_OK) $('#setup-notice').hidden = false;

    loadDraft();
    renderMe();
    renderCards();

    $('#add-card').addEventListener('click', addCard);
    $('#send').addEventListener('click', send);
    $('#more').addEventListener('click', startOver);

    window.addEventListener('pagehide', saveDraft);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveDraft(); });
    window.addEventListener('beforeunload', function (e) {
      if (state.sending) { e.preventDefault(); e.returnValue = ''; }
    });
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var onResize = function () {
        var typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');
        $('#bar').classList.toggle('kb', typing && vv.height < window.innerHeight * 0.8);
      };
      vv.addEventListener('resize', onResize);
    }
  }

  init();
})();
