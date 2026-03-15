(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'value') n.value = v ?? '';
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'selected') n.selected = !!v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, String(v));
    }
    const childList = Array.isArray(children) ? children : [children];
    for (const c of childList) {
      if (c == null) continue;
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    }
    return n;
  };

  const state = {
    db: null,
    includeArchived: false,
    topics: [],
    topicsAll: [],
    topicEntrySearchIndex: new Map(),
    topicEntrySearchIndexReady: false,
    topicEntrySearchIndexPromise: null,
    globalSearchQuery: '',
    globalSearchResults: [],
    globalSearchPromise: null,
    entries: [],
    view: 'topics', // topics | topic
    currentTopicId: null,
    lastTopicsFocusId: null,
    pendingFocusEntryId: null,
    pendingOpenEntryId: null,
    search: '',
    drag: { type: null, id: null },
    kbdNav: { index: -1, id: null },
    popupKeepModalOpenOnNextSave: false
  };
  const THEME_MODE_KEY = 'themeMode';

  const ui = {
    app: $('#app'),
    main: $('#main'),
    navBackBtn: $('#navBackBtn'),
    topTitle: $('#topTitle'),
    topbarActions: $('#topbarActions'),
    topicbarActions: $('#topicbarActions'),
    searchInput: $('#searchInput'),
    primaryBtn: $('#primaryBtn'),
    themeToggleBtn: $('#themeToggleBtn'),
    qaCreateTopicBtn: $('#qaCreateTopicBtn'),
    qaExportBtn: $('#qaExportBtn'),
    qaImportBtn: $('#qaImportBtn'),
    qaArchiveToggleBtn: $('#qaArchiveToggleBtn'),
    qaTopicExportBtn: $('#qaTopicExportBtn'),
    qaTopicEditBtn: $('#qaTopicEditBtn'),
    qaTopicArchiveBtn: $('#qaTopicArchiveBtn'),
    qaTopicDeleteBtn: $('#qaTopicDeleteBtn'),
    menuBtn: $('#menuBtn'),
    dropdown: $('#dropdown'),
    toast: $('#toast'),
    modalOverlay: $('#modalOverlay'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalFooter: $('#modalFooter'),
    modalClose: $('#modalClose')
  };
  let toastTimerId = null;

  function applyTheme(mode) {
    const next = mode === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    if (ui.themeToggleBtn) {
      ui.themeToggleBtn.title = next === 'dark' ? 'Hell aktivieren' : 'Dunkel aktivieren';
      ui.themeToggleBtn.setAttribute('aria-label', ui.themeToggleBtn.title);
      ui.themeToggleBtn.innerHTML = `<span class="icon">${next === 'dark' ? '☾' : '☼'}</span>`;
    }
    return next;
  }

  async function initTheme() {
    const settings = await ext.storage.local.get({ [THEME_MODE_KEY]: 'light' });
    let mode = applyTheme(settings?.[THEME_MODE_KEY]);
    ui.themeToggleBtn?.addEventListener('click', async () => {
      mode = applyTheme(mode === 'dark' ? 'light' : 'dark');
      await ext.storage.local.set({ [THEME_MODE_KEY]: mode });
      toast(mode === 'dark' ? 'Dunkles Theme aktiv' : 'Helles Theme aktiv');
    });
  }

  function toast(msg) {
    if (toastTimerId) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    ui.toast.classList.remove('toast--undo');
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    toastTimerId = setTimeout(() => {
      ui.toast.classList.remove('show');
      toastTimerId = null;
    }, 1600);
  }

  function hideToastNow() {
    if (toastTimerId) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    ui.toast.classList.remove('show', 'toast--undo');
    ui.toast.innerHTML = '';
  }

  function showUndoToast(message, { durationMs = 6000, onUndo } = {}) {
    hideToastNow();

    const label = el('span', { class: 'toast__text' }, [message]);
    const undoBtn = el('button', {
      class: 'toast__undo',
      type: 'button',
      onclick: async () => {
        hideToastNow();
        try {
          await onUndo?.();
        } catch (error) {
          console.error(error);
          toast('Rückgängig fehlgeschlagen');
        }
      }
    }, ['Rückgängig']);
    const progress = el('div', { class: 'toast__progress' });
    progress.style.animationDuration = `${durationMs}ms`;

    ui.toast.innerHTML = '';
    ui.toast.append(label, undoBtn, progress);
    ui.toast.classList.add('toast--undo', 'show');

    toastTimerId = setTimeout(() => {
      ui.toast.classList.remove('show', 'toast--undo');
      ui.toast.innerHTML = '';
      toastTimerId = null;
    }, durationMs);
  }

  async function deleteEntryWithUndo(entry) {
    const snapshot = { ...entry };
    await rbDB.deleteEntry(state.db, entry.id);
    markTopicSearchIndexDirty();
    await refreshEntries();
    render();

    showUndoToast('Eintrag gelöscht', {
      durationMs: 6000,
      onUndo: async () => {
        await rbDB.addEntry(state.db, snapshot.topicId, {
          type: snapshot.type,
          title: snapshot.title,
          url: snapshot.url,
          sourcePageTitle: snapshot.sourcePageTitle,
          sourcePageUrl: snapshot.sourcePageUrl,
          linkText: snapshot.linkText,
          excerpt: snapshot.excerpt,
          note: snapshot.note,
          position: snapshot.position
        });
        markTopicSearchIndexDirty();
        await refreshEntries();
        render();
        toast('Löschen rückgängig gemacht');
      }
    });
  }

  async function deleteTopicWithUndo(topicId) {
    const topic = await rbDB.getTopic(state.db, topicId);
    if (!topic) return;
    const entries = await rbDB.getEntriesByTopic(state.db, topicId);

    await rbDB.deleteTopic(state.db, topicId);
    await refreshTopics();
    await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
    backToTopics();

    showUndoToast('Thema gelöscht', {
      durationMs: 6000,
      onUndo: async () => {
        await bulkInsert([topic], entries, { keepIds: true });
        await refreshTopics();
        await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
        renderTopicsView();
        toast('Löschen rückgängig gemacht');
      }
    });
  }

  function closeDropdown() {
    ui.dropdown.classList.add('hidden');
    ui.dropdown.innerHTML = '';
    ui.dropdown.style.left = '';
    ui.dropdown.style.top = '';
    ui.dropdown.style.right = '';
  }

  function openDropdown(items, { anchorX = null, anchorY = null } = {}) {
    ui.dropdown.innerHTML = '';
    for (const it of items) {
      const node = el('div', { class: `dropitem${it.danger ? ' dropitem--danger' : ''}`, role: 'menuitem' }, [
        el('div', {}, [it.label]),
        it.hint ? el('div', { class: 'dropitem__hint' }, [it.hint]) : null
      ]);
      node.addEventListener('click', async () => {
        closeDropdown();
        await it.onClick?.();
      });
      ui.dropdown.appendChild(node);
    }
    ui.dropdown.classList.remove('hidden');
    if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
      const viewportPad = 12;
      const rect = ui.dropdown.getBoundingClientRect();
      const maxLeft = Math.max(viewportPad, window.innerWidth - rect.width - viewportPad);
      const maxTop = Math.max(viewportPad, window.innerHeight - rect.height - viewportPad);
      ui.dropdown.style.left = `${Math.min(Math.max(viewportPad, anchorX), maxLeft)}px`;
      ui.dropdown.style.top = `${Math.min(Math.max(viewportPad, anchorY), maxTop)}px`;
      ui.dropdown.style.right = 'auto';
      return;
    }
    ui.dropdown.style.left = '';
    ui.dropdown.style.top = '';
    ui.dropdown.style.right = '';
  }

  function openModal({ title, body, footer }) {
    ui.modalTitle.textContent = title;
    ui.modalBody.innerHTML = '';
    ui.modalFooter.innerHTML = '';
    ui.modal.dataset.popupSaveMode = '';
    if (body) ui.modalBody.appendChild(body);
    if (footer) ui.modalFooter.appendChild(footer);
    ui.modalOverlay.classList.remove('hidden');
    ui.modalOverlay.setAttribute('aria-hidden', 'false');
  }

  function makeZoomableTextarea(textarea, popupTitle) {
    const wrap = el('div', { class: 'textarea-zoom-wrap' }, [textarea]);
    const zoomBtn = el('button', {
      type: 'button',
      class: 'textarea-zoom-btn',
      title: 'Im Popup öffnen',
      'aria-label': 'Im Popup öffnen'
    }, ['⤢']);

    zoomBtn.addEventListener('click', () => {
      openTextareaPopup({
        title: popupTitle || 'Text bearbeiten',
        sourceTextarea: textarea
      });
    });

    wrap.appendChild(zoomBtn);
    return wrap;
  }

  function openTextareaPopup({ title, sourceTextarea }) {
    if (!sourceTextarea) return;

    const channelId = `note-popup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const popupTitle = title || 'Text bearbeiten';
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const url = ext.runtime.getURL(
      `sidebar/note-popup.html?channel=${encodeURIComponent(channelId)}&title=${encodeURIComponent(popupTitle)}&theme=${encodeURIComponent(theme)}`
    );

    const channel = new BroadcastChannel(channelId);
    const popup = window.open(url, '_blank', 'popup=yes,width=980,height=760,resizable=yes,scrollbars=yes');
    if (!popup) {
      channel.close();
      toast('Popup wurde blockiert');
      return;
    }

    const isTextareaInModal = !!(ui.modalBody && ui.modalBody.contains(sourceTextarea));
    const modalWasVisible = !!(ui.modalOverlay && !ui.modalOverlay.classList.contains('hidden'));
    const modalTemporarilyHidden = isTextareaInModal && modalWasVisible;
    if (modalTemporarilyHidden) {
      ui.modalOverlay.classList.add('hidden');
      ui.modalOverlay.setAttribute('aria-hidden', 'true');
    }

    let closed = false;
    const cleanup = ({ restoreModal = false } = {}) => {
      if (closed) return;
      closed = true;
      clearInterval(closeWatchId);
      channel.close();
      if (restoreModal && modalTemporarilyHidden) {
        ui.modalOverlay.classList.remove('hidden');
        ui.modalOverlay.setAttribute('aria-hidden', 'false');
      }
    };

    const closeWatchId = setInterval(() => {
      if (!popup.closed) return;
      cleanup();
    }, 500);

    channel.onmessage = (ev) => {
      const msg = ev?.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'popupReady') {
        channel.postMessage({ type: 'initValue', value: sourceTextarea.value || '' });
        return;
      }
      if (msg.type === 'apply') {
        sourceTextarea.value = String(msg.value ?? '');
        sourceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        const saveBtn = ui.modalFooter?.querySelector('.btn--primary');
        if (saveBtn) {
          saveBtn.click();
          cleanup({ restoreModal: false });
          return;
        }
        cleanup({ restoreModal: false });
        return;
      }
      if (msg.type === 'saveNoClose') {
        sourceTextarea.value = String(msg.value ?? '');
        sourceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        const saveBtn = ui.modalFooter?.querySelector('.btn--primary');
        if (saveBtn && ui.modal?.dataset?.popupSaveMode === 'update-entry') {
          state.popupKeepModalOpenOnNextSave = true;
          saveBtn.click();
        } else {
          toast('Zwischengespeichert');
        }
        return;
      }
      if (msg.type === 'close') {
        cleanup();
      }
    };
  }

  function openEntryNotePopupDirect(entry, triggerButton) {
    if (!entry || (entry.type !== 'note' && entry.type !== 'quote')) return;

    // Avoid sticky :focus-within hover state on the source row.
    triggerButton?.blur?.();

    const channelId = `note-popup-entry-${entry.id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const popupTitle = entry.type === 'quote' ? 'Textauszug bearbeiten' : 'Notiz bearbeiten';
    const url = ext.runtime.getURL(
      `sidebar/note-popup.html?channel=${encodeURIComponent(channelId)}&title=${encodeURIComponent(popupTitle)}&theme=${encodeURIComponent(theme)}`
    );

    const channel = new BroadcastChannel(channelId);
    const popup = window.open(url, '_blank', 'popup=yes,width=980,height=760,resizable=yes,scrollbars=yes');
    if (!popup) {
      channel.close();
      toast('Popup wurde blockiert');
      return;
    }

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(closeWatchId);
      channel.close();
      triggerButton?.blur?.();
    };

    const closeWatchId = setInterval(() => {
      if (!popup.closed) return;
      cleanup();
    }, 500);

    const persistPopupValue = async (value) => {
      const next = String(value ?? '');
      if (entry.type === 'note' || entry.type === 'quote') {
        await rbDB.updateEntry(state.db, entry.id, { excerpt: next });
        entry.excerpt = next;
      }
      markTopicSearchIndexDirty();
      await refreshEntries();
      render();
      toast('Gespeichert');
    };

    channel.onmessage = (ev) => {
      const msg = ev?.data;
      if (!msg || typeof msg !== 'object') return;

      (async () => {
        if (msg.type === 'popupReady') {
          channel.postMessage({ type: 'initValue', value: entry.excerpt || '' });
          return;
        }
        if (msg.type === 'saveNoClose') {
          await persistPopupValue(msg.value);
          return;
        }
        if (msg.type === 'apply') {
          await persistPopupValue(msg.value);
          return;
        }
        if (msg.type === 'close') {
          cleanup();
        }
      })().catch((error) => {
        console.error(error);
        toast('Speichern fehlgeschlagen');
      });
    };
  }

  function closeModal() {
    ui.modalOverlay.classList.add('hidden');
    ui.modalOverlay.setAttribute('aria-hidden', 'true');
    ui.modalBody.innerHTML = '';
    ui.modalFooter.innerHTML = '';
    ui.modal.dataset.popupSaveMode = '';
    state.popupKeepModalOpenOnNextSave = false;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = String(target.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
  }

  function getNavigableNodes() {
    let selector = '#topicsList .item';
    if (state.view === 'topic') {
      selector = '#entriesList .item';
    } else if (normalizeQuery(state.search)) {
      selector = '#searchResultsList .item';
    }
    return Array.from(document.querySelectorAll(selector));
  }

  function clearKbdActive() {
    for (const node of document.querySelectorAll('.item--kbd-active')) {
      node.classList.remove('item--kbd-active');
    }
  }

  function resolveKbdIndex(nodes) {
    if (!nodes.length) return -1;
    const byStored = Number.isInteger(state.kbdNav.index) ? state.kbdNav.index : -1;
    if (byStored >= 0 && byStored < nodes.length) {
      const id = nodes[byStored]?.dataset?.id || null;
      if (!state.kbdNav.id || state.kbdNav.id === id) return byStored;
    }
    if (state.kbdNav.id) {
      const byId = nodes.findIndex(n => n.dataset?.id === state.kbdNav.id);
      if (byId >= 0) return byId;
    }
    return -1;
  }

  function setKbdActiveIndex(nextIndex, { scroll = true } = {}) {
    const nodes = getNavigableNodes();
    clearKbdActive();
    if (!nodes.length) {
      state.kbdNav = { index: -1, id: null };
      return false;
    }
    const idx = Math.max(0, Math.min(nextIndex, nodes.length - 1));
    const node = nodes[idx];
    node.classList.add('item--kbd-active');
    if (scroll) node.scrollIntoView({ block: 'nearest' });
    state.kbdNav = { index: idx, id: node.dataset?.id || null };
    return true;
  }

  function syncKbdActiveAfterRender() {
    const nodes = getNavigableNodes();
    if (!nodes.length) {
      clearKbdActive();
      state.kbdNav = { index: -1, id: null };
      return;
    }
    const idx = resolveKbdIndex(nodes);
    if (idx < 0) {
      clearKbdActive();
      state.kbdNav = { index: -1, id: null };
      return;
    }
    setKbdActiveIndex(idx, { scroll: false });
  }

  function moveKbdSelection(delta) {
    const nodes = getNavigableNodes();
    if (!nodes.length) return false;
    const current = resolveKbdIndex(nodes);
    const base = current < 0 ? (delta > 0 ? -1 : nodes.length) : current;
    return setKbdActiveIndex(base + delta);
  }

  function activateKbdSelection() {
    const nodes = getNavigableNodes();
    if (!nodes.length) return false;
    const idx = resolveKbdIndex(nodes);
    const finalIdx = idx < 0 ? 0 : idx;
    setKbdActiveIndex(finalIdx);
    const node = nodes[finalIdx];
    node?.click();
    return !!node;
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function entryBadge(type) {
    if (type === 'link') return el('span', { class: 'badge badge--link' }, ['Link']);
    if (type === 'quote') return el('span', { class: 'badge badge--quote' }, ['Text']);
    return el('span', { class: 'badge badge--note' }, ['Notiz']);
  }

  function normalizeQuery(q) {
    return (q ?? '').trim().toLowerCase();
  }

  function escapeSelectorAttr(value) {
    const raw = String(value ?? '');
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(raw);
    return raw.replace(/["\\]/g, '\\$&');
  }

  function matchesEntry(e, q) {
    if (!q) return true;
    const hay = [
      e.title,
      e.url,
      e.excerpt,
      e.note,
      e.sourcePageTitle,
      e.sourcePageUrl,
      e.linkText
    ].join(' ').toLowerCase();
    return hay.includes(q);
  }

  function matchesTopic(t, q) {
    if (!q) return true;
    const hay = [t.title, t.description].join(' ').toLowerCase();
    return hay.includes(q);
  }

  function markTopicSearchIndexDirty() {
    state.topicEntrySearchIndex.clear();
    state.topicEntrySearchIndexReady = false;
    state.topicEntrySearchIndexPromise = null;
    state.globalSearchQuery = '';
    state.globalSearchResults = [];
    state.globalSearchPromise = null;
  }

  function getEntryMatchInfo(entry, q) {
    if (!q) return null;
    const checks = [
      { key: 'title', label: 'Titel', value: entry.title || '' },
      { key: 'excerpt', label: 'Text/Notiz', value: entry.excerpt || '' },
      { key: 'note', label: 'Notiz', value: entry.note || '' },
      { key: 'url', label: 'URL', value: entry.url || '' },
      { key: 'sourcePageTitle', label: 'Quelle', value: entry.sourcePageTitle || '' },
      { key: 'sourcePageUrl', label: 'Quell-URL', value: entry.sourcePageUrl || '' },
      { key: 'linkText', label: 'Linktext', value: entry.linkText || '' }
    ];
    for (const c of checks) {
      if (!c.value) continue;
      const lower = c.value.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 36);
      const end = Math.min(c.value.length, idx + q.length + 64);
      const snippet = c.value.slice(start, end).replace(/\s+/g, ' ').trim();
      return {
        key: c.key,
        label: c.label,
        snippet: snippet || c.value.slice(0, 100).trim()
      };
    }
    return null;
  }

  async function ensureGlobalSearchResults(q) {
    if (!q) {
      state.globalSearchQuery = '';
      state.globalSearchResults = [];
      state.globalSearchPromise = null;
      return;
    }
    if (state.globalSearchQuery === q && !state.globalSearchPromise) return;
    if (state.globalSearchPromise && state.globalSearchQuery === q) {
      await state.globalSearchPromise;
      return;
    }

    const requestedQuery = q;
    state.globalSearchQuery = requestedQuery;
    state.globalSearchPromise = (async () => {
      const topicById = new Map(state.topicsAll.map(t => [t.id, t]));
      const allEntries = await rbDB.getAllEntries(state.db);
      const results = [];
      for (const entry of allEntries) {
        const topic = topicById.get(entry.topicId);
        if (!topic) continue;
        const match = getEntryMatchInfo(entry, q);
        if (!match) continue;
        results.push({ entry, topic, match });
      }

      const typeRank = (type) => type === 'link' ? 0 : (type === 'quote' ? 1 : 2);
      const matchRank = (key) => key === 'title' ? 0 : (key === 'excerpt' ? 1 : (key === 'note' ? 2 : 3));
      results.sort((a, b) => {
        const mr = matchRank(a.match.key) - matchRank(b.match.key);
        if (mr !== 0) return mr;
        const tr = typeRank(a.entry.type) - typeRank(b.entry.type);
        if (tr !== 0) return tr;
        return String(b.entry.updatedAt || b.entry.createdAt || '').localeCompare(String(a.entry.updatedAt || a.entry.createdAt || ''));
      });

      if (state.globalSearchQuery !== requestedQuery) return;
      state.globalSearchResults = results.slice(0, 250);
    })();

    try {
      await state.globalSearchPromise;
    } finally {
      if (state.globalSearchQuery === requestedQuery) {
        state.globalSearchPromise = null;
      }
    }
  }

  async function ensureTopicEntrySearchIndex() {
    if (state.topicEntrySearchIndexReady) return;
    if (state.topicEntrySearchIndexPromise) {
      await state.topicEntrySearchIndexPromise;
      return;
    }

    state.topicEntrySearchIndexPromise = (async () => {
      const allEntries = await rbDB.getAllEntries(state.db);
      const map = new Map();
      for (const e of allEntries) {
        const topicId = e?.topicId;
        if (!topicId) continue;
        const part = normalizeQuery([
          e.title,
          e.url,
          e.excerpt,
          e.note,
          e.sourcePageTitle,
          e.sourcePageUrl,
          e.linkText
        ].join(' '));
        if (!part) continue;
        const prev = map.get(topicId);
        map.set(topicId, prev ? `${prev} ${part}` : part);
      }
      state.topicEntrySearchIndex = map;
      state.topicEntrySearchIndexReady = true;
    })();

    try {
      await state.topicEntrySearchIndexPromise;
    } finally {
      state.topicEntrySearchIndexPromise = null;
    }
  }

  async function loadSettings() {
    const settings = await ext.storage.local.get({ lastTopicId: null, includeArchived: false });
    state.includeArchived = !!settings.includeArchived;
    state.currentTopicId = settings.lastTopicId;
  }

  async function saveSettings(patch) {
    await ext.storage.local.set(patch);
  }

  async function refreshTopics() {
    state.topicsAll = await rbDB.getAllTopics(state.db, { includeArchived: true });
    state.topics = await rbDB.getAllTopics(state.db, { includeArchived: state.includeArchived });
    // If last selected topic is archived and we're not including archived, pick first non-archived.
    const exists = state.topics.some(t => t.id === state.currentTopicId);
    if (!exists) {
      const first = state.topics.find(t => !t.archived) || state.topics[0] || null;
      state.currentTopicId = first?.id ?? null;
      await saveSettings({ lastTopicId: state.currentTopicId });
    }
    markTopicSearchIndexDirty();
  }

  async function refreshEntries() {
    if (!state.currentTopicId) {
      state.entries = [];
      return;
    }
    state.entries = await rbDB.getEntriesByTopic(state.db, state.currentTopicId);
  }

  async function ensureDefaultTopic() {
    if (state.topics.length > 0) return;
    const t = await rbDB.addTopic(state.db, { title: 'Inbox', description: 'Schnellablage für neue Fundstücke' });
    state.currentTopicId = t.id;
    await saveSettings({ lastTopicId: t.id });
    await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
    await refreshTopics();
  }

  function setHeaderForTopics() {
    ui.navBackBtn.classList.add('hidden');
    ui.topTitle.classList.remove('hidden');
    ui.topTitle.textContent = 'Research Board';
    ui.primaryBtn.classList.add('hidden');
    ui.searchInput.placeholder = 'Themen suchen…';
    ui.menuBtn?.classList.add('hidden');
    ui.topbarActions?.classList.remove('hidden');
    ui.topicbarActions?.classList.add('hidden');
    ui.themeToggleBtn?.classList.remove('hidden');
  }

  function setHeaderForTopic(topic) {
    ui.navBackBtn.classList.remove('hidden');
    ui.topTitle.classList.remove('hidden');
    ui.topTitle.textContent = topic?.title || 'Thema';
    ui.primaryBtn.classList.add('hidden');
    ui.searchInput.placeholder = 'Einträge suchen…';
    ui.menuBtn?.classList.add('hidden');
    ui.topbarActions?.classList.add('hidden');
    ui.topicbarActions?.classList.remove('hidden');
    ui.themeToggleBtn?.classList.add('hidden');
    const archiveBtn = ui.qaTopicArchiveBtn;
    if (archiveBtn) {
      const archived = !!topic?.archived;
      const label = archived ? 'Thema wiederherstellen' : 'Thema archivieren';
      archiveBtn.title = label;
      archiveBtn.setAttribute('aria-label', label);
      const iconNode = archiveBtn.querySelector('.icon');
      if (iconNode) iconNode.textContent = archived ? '↺' : '🗃';
    }
  }

  function updateArchiveToggleButton() {
    const btn = ui.qaArchiveToggleBtn;
    if (!btn) return;
    const label = state.includeArchived ? 'Archiv ausblenden' : 'Archiv anzeigen';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const iconNode = btn.querySelector('.icon');
    if (iconNode) iconNode.textContent = state.includeArchived ? '🗂' : '🗃';
  }

  function renderEmpty(message, hint = '') {
    return el('div', { class: 'card' }, [
      el('div', { class: 'item__title' }, [message]),
      hint ? el('div', { class: 'subtle', style: 'margin-top:6px;' }, [hint]) : null
    ]);
  }

  function renderSidebarFooter() {
    return el('div', { class: 'sidebar-footer' }, [
      el('div', { class: 'sidebar-footer__links' }, [
        el('button', { class: 'link-subtle', onclick: showHelpModal }, ['Hilfe']),
        el('button', { class: 'link-subtle', onclick: openOptionsPage }, ['Einstellungen'])
      ]),
      el('span', { class: 'footer-signature' }, ['by magicmarcy']),
      el('button', { class: 'link-danger', onclick: showDangerResetModal }, ['Alle Daten löschen'])
    ]);
  }

  async function openOptionsPage() {
    try {
      if (typeof ext.runtime?.openOptionsPage === 'function') {
        await ext.runtime.openOptionsPage();
        return;
      }
      throw new Error('openOptionsPage unavailable');
    } catch (error) {
      console.error(error);
      toast('Einstellungen konnten nicht geöffnet werden');
    }
  }

  function renderTopicsView() {
    state.view = 'topics';
    setHeaderForTopics();

    const q = normalizeQuery(state.search);
    if (q) {
      if (state.globalSearchQuery !== q || state.globalSearchPromise) {
        ensureGlobalSearchResults(q)
          .then(() => {
            if (state.view !== 'topics') return;
            if (normalizeQuery(state.search) !== q) return;
            renderTopicsView();
          })
          .catch((err) => console.error('global search failed', err));
      }

      const list = el('div', { class: 'list', id: 'searchResultsList' });
      if (state.globalSearchPromise && state.globalSearchQuery === q && state.globalSearchResults.length === 0) {
        list.appendChild(renderEmpty('Suche läuft…'));
      } else if (state.globalSearchResults.length === 0) {
        list.appendChild(renderEmpty('Keine Treffer', 'Probiere andere Begriffe oder öffne das Archiv.'));
      } else {
        const summary = el('div', { class: 'subtle', style: 'margin-bottom:6px;' }, [
          `${state.globalSearchResults.length} Treffer`
        ]);
        list.appendChild(summary);

        for (const hit of state.globalSearchResults) {
          const e = hit.entry;
          const t = hit.topic;
          const node = el('div', {
            class: 'item item--search-hit',
            dataset: { id: e.id, topicId: t.id, kind: 'search-hit' }
          }, [
            el('div', { class: 'item__row' }, [
              entryBadge(e.type),
              el('div', { class: 'item__title' }, [e.title || (e.type === 'link' ? e.url : e.excerpt) || '(ohne Titel)'])
            ]),
            el('div', { class: 'small item__aux' }, [`${t.title} · Treffer in ${hit.match.label}`]),
            hit.match.snippet ? el('div', { class: 'small item__aux' }, [hit.match.snippet]) : null
          ]);

          node.addEventListener('click', async () => {
            await openTopic(t.id, { preserveSearch: false, focusEntryId: e.id, openEntryId: e.id });
          });

          list.appendChild(node);
        }
      }

      ui.main.innerHTML = '';
      ui.main.appendChild(list);
      ui.main.appendChild(renderSidebarFooter());
      syncKbdActiveAfterRender();
      return;
    }

    const topicSource = q ? state.topicsAll : state.topics;
    if (q && !state.topicEntrySearchIndexReady) {
      ensureTopicEntrySearchIndex()
        .then(() => {
          if (state.view !== 'topics') return;
          if (normalizeQuery(state.search) !== q) return;
          renderTopicsView();
        })
        .catch((err) => console.error('topic search index failed', err));
    }

    const topics = topicSource.filter((t) => {
      if (matchesTopic(t, q)) return true;
      if (!q || !state.topicEntrySearchIndexReady) return false;
      const entryHay = state.topicEntrySearchIndex.get(t.id) || '';
      return entryHay.includes(q);
    });

    const list = el('div', { class: 'list', id: 'topicsList' });

    if (topics.length === 0) {
      list.appendChild(renderEmpty('Keine Themen gefunden.', 'Tipp: Lege ein neues Thema an oder schalte „Archiv anzeigen“ ein.'));
    } else {
      for (const t of topics) {
        const statusHint = el('span', { class: 'item__meta topic__status' }, [t.archived ? 'Archiv' : '']);
        const updatedHint = el('span', { class: 'item__meta topic__updated' }, [formatDate(t.updatedAt || t.createdAt)]);
        const node = el('div', {
          class: 'item item--topic',
          draggable: 'true',
          dataset: { id: t.id, kind: 'topic' }
        }, [
          el('div', { class: 'item__row' }, [
            el('div', { class: 'item__title' }, [t.title]),
            statusHint,
            updatedHint
          ]),
          t.description ? el('div', { class: 'small', style: 'margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }, [t.description]) : null
        ]);

        node.addEventListener('click', () => openTopic(t.id));
        node.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openDropdown([
            {
              label: 'Bearbeiten',
              onClick: async () => {
                await editTopicFlow(t.id);
              }
            },
            {
              label: t.archived ? 'Wiederherstellen' : 'Archivieren',
              onClick: async () => {
                await archiveTopicFlow(t.id, !t.archived);
              }
            },
            {
              label: 'Löschen',
              danger: true,
              onClick: async () => {
                await deleteTopicFlow(t.id);
              }
            }
          ], {
            anchorX: ev.clientX,
            anchorY: ev.clientY
          });
        });

        // Topic reorder drag
        node.addEventListener('dragstart', (ev) => {
          closeDropdown();
          state.drag = { type: 'topic', id: t.id };
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', t.id);
        });
        node.addEventListener('dragend', () => {
          state.drag = { type: null, id: null };
        });

        node.addEventListener('dragover', (ev) => {
          if (state.drag.type === 'topic') {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            return;
          }
          if (hasDropEntryPayload(ev.dataTransfer)) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
          }
        });

        node.addEventListener('drop', async (ev) => {
          ev.preventDefault();
          if (state.drag.type === 'topic') {
            const draggedId = state.drag.id;
            const targetId = t.id;
            if (!draggedId || draggedId === targetId) return;

            const all = topicSource.filter(x => matchesTopic(x, q));
            const ids = all.map(x => x.id);
            const from = ids.indexOf(draggedId);
            const to = ids.indexOf(targetId);
            if (from < 0 || to < 0) return;
            ids.splice(from, 1);
            ids.splice(to, 0, draggedId);

            // Merge back into full list order: update positions for all non-archived visible topics.
            const nonArchived = state.topics.filter(x => !x.archived);
            const nonArchivedIds = nonArchived.map(x => x.id);

            // If archived topics are shown, we only reorder within the currently filtered list.
            // Practical: reorder all non-archived topics based on ids order if they contain them.
            const reordered = [...new Set(ids.concat(nonArchivedIds.filter(x => !ids.includes(x))))];

            await rbDB.reorderTopics(state.db, reordered);
            await refreshTopics();
            await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
            render();
            toast('Themen sortiert');
            return;
          }

          const created = await addEntryFromDrop(ev, t.id);
          if (created) {
            toast(`Zu „${t.title}“ hinzugefügt`);
          }
        });

        list.appendChild(node);
      }
    }

    ui.main.innerHTML = '';
    ui.main.appendChild(list);
    ui.main.appendChild(renderSidebarFooter());
    syncKbdActiveAfterRender();
  }

  function renderTopicView() {
    state.view = 'topic';
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    setHeaderForTopic(topic);

    const q = normalizeQuery(state.search);
    const entries = state.entries.filter(e => matchesEntry(e, q));

    const headerCard = el('div', { class: 'card section topic-detail-header' }, [
      topic?.description ? el('div', { class: 'small', style: 'margin-top:6px;' }, [topic.description]) : null,
      el('div', { class: 'toolbar topic-detail-add-toolbar', style: 'margin-top:10px;' }, [
        el('button', { class: 'btn', onclick: () => addEntryFlow('link') }, ['+ Link']),
        el('button', { class: 'btn', onclick: addCurrentPageFlow }, ['+ Aktuelle Seite']),
        el('button', { class: 'btn', onclick: () => addEntryFlow('quote') }, ['+ Textauszug']),
        el('button', { class: 'btn', onclick: () => addEntryFlow('note') }, ['+ Notiz'])
      ]),
      el('div', { class: 'dropzone', id: 'dropzone', style: 'margin-top:10px;' }, ['Drop here'])
    ]);

    const list = el('div', { class: 'list', id: 'entriesList' });

    if (entries.length === 0) {
      list.appendChild(el('div', { class: 'subtle' }, ['Nutze „Link“, „Aktuelle Seite“, „Textauszug“ oder „Notiz“, um den ersten Eintrag anzulegen.']));
    } else {
      for (const e of entries) {
        const isLink = e.type === 'link';
        const actions = el('div', { class: 'item__actions' }, [
          isLink && e.url
            ? el('button', { class: 'btn btn--xs btn--icon', title: 'Öffnen', 'aria-label': 'Öffnen', onclick: async (ev) => {
                ev.stopPropagation();
                await ext.runtime.sendMessage({ type: 'openUrlInTab', url: e.url }).catch(() => {});
              } }, ['🔗'])
            : null,
          (e.type === 'note' || e.type === 'quote')
            ? el('button', { class: 'btn btn--xs btn--icon', title: e.type === 'quote' ? 'Text-Popup' : 'Notiz-Popup', 'aria-label': e.type === 'quote' ? 'Text-Popup' : 'Notiz-Popup', onclick: (ev) => {
                ev.stopPropagation();
                openEntryNotePopupDirect(e, ev.currentTarget);
              } }, ['⤢'])
            : null
        ]);

        const node = el('div', {
          class: `item item--entry${isLink ? ' item--entry-link' : ''}`,
          draggable: 'true',
          dataset: { id: e.id, kind: 'entry' }
        }, [
          el('div', { class: 'item__hover-tools' }, [
            actions
          ]),
          el('div', { class: 'item__row' }, [
            el('span', { class: 'item__badge-wrap' }, [
              entryBadge(e.type)
            ]),
            el('div', { class: 'item__title' }, [e.title || (isLink ? e.url : e.excerpt) || '(ohne Titel)'])
          ])
        ]);

        node.addEventListener('click', () => openEntry(e));
        node.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openDropdown([
            {
              label: 'Bearbeiten',
              onClick: async () => {
                openEntry(e);
              }
            },
            {
              label: 'Verschieben',
              hint: 'In anderes Thema',
              onClick: async () => {
                await moveEntryFlow(e.id);
              }
            },
            {
              label: 'Löschen',
              hint: 'Mit Rückgängig-Option',
              danger: true,
              onClick: async () => {
                await deleteEntryWithUndo(e);
              }
            }
          ], {
            anchorX: ev.clientX,
            anchorY: ev.clientY
          });
        });

        // Reorder drag
        node.addEventListener('dragstart', (ev) => {
          closeDropdown();
          state.drag = { type: 'entry', id: e.id };
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', e.id);
        });
        node.addEventListener('dragend', () => {
          state.drag = { type: null, id: null };
        });

        node.addEventListener('dragover', (ev) => {
          if (state.drag.type !== 'entry') return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
        });

        node.addEventListener('drop', async (ev) => {
          if (state.drag.type !== 'entry') return;
          ev.preventDefault();
          const draggedId = state.drag.id;
          const targetId = e.id;
          if (!draggedId || draggedId === targetId) return;

          const visible = state.entries.filter(x => matchesEntry(x, q));
          const ids = visible.map(x => x.id);
          const from = ids.indexOf(draggedId);
          const to = ids.indexOf(targetId);
          if (from < 0 || to < 0) return;
          ids.splice(from, 1);
          ids.splice(to, 0, draggedId);

          // Apply reorder to all entries in topic by merging unchanged ones behind.
          const allIds = state.entries.map(x => x.id);
          const merged = [...new Set(ids.concat(allIds.filter(x => !ids.includes(x))))];

          await rbDB.reorderEntries(state.db, state.currentTopicId, merged);
          await refreshEntries();
          render();
          toast('Einträge sortiert');
        });

        list.appendChild(node);
      }
    }

    ui.main.innerHTML = '';
    ui.main.appendChild(headerCard);
    ui.main.appendChild(list);
    ui.main.appendChild(renderSidebarFooter());
    syncKbdActiveAfterRender();
    if (state.pendingFocusEntryId) {
      const id = state.pendingFocusEntryId;
      state.pendingFocusEntryId = null;
      setTimeout(() => {
        const node = document.querySelector(`#entriesList .item[data-id="${escapeSelectorAttr(id)}"]`);
        if (!node) return;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('item--focus-flash');
        setTimeout(() => node.classList.remove('item--focus-flash'), 2400);
      }, 20);
    }

    if (state.pendingOpenEntryId) {
      const id = state.pendingOpenEntryId;
      state.pendingOpenEntryId = null;
      const targetEntry = state.entries.find((entry) => entry.id === id);
      if (targetEntry) {
        setTimeout(() => openEntry(targetEntry), 40);
      }
    }

    // Drop capture
    const dz = $('#dropzone');
    dz.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      dz.classList.remove('dragover');
      const created = await addEntryFromDrop(ev);
      if (created) {
        await render();
        toast('Hinzugefügt');
      }
    });
  }

  async function render() {
    closeDropdown();
    if (state.view === 'topic') {
      await refreshEntries();
      renderTopicView();
    } else {
      renderTopicsView();
    }
  }

  async function openTopic(topicId, { preserveSearch = false, focusEntryId = null, openEntryId = null } = {}) {
    if (state.view === 'topics') {
      state.lastTopicsFocusId = topicId;
    }
    state.currentTopicId = topicId;
    await saveSettings({ lastTopicId: topicId });
    if (!preserveSearch) {
      state.search = '';
      ui.searchInput.value = '';
    }
    state.pendingFocusEntryId = focusEntryId || null;
    state.pendingOpenEntryId = openEntryId || null;
    await refreshEntries();
    renderTopicView();
  }

  function backToTopics() {
    state.search = '';
    ui.searchInput.value = '';
    state.pendingFocusEntryId = null;
    state.pendingOpenEntryId = null;
    if (state.lastTopicsFocusId) {
      state.kbdNav = { index: -1, id: state.lastTopicsFocusId };
    } else {
      state.kbdNav = { index: -1, id: null };
    }
    renderTopicsView();
  }

  async function createTopicFlow() {
    const titleInput = el('input', { class: 'input', value: '', placeholder: 'z.B. Blogpost: IndexedDB' });
    const descInput = el('textarea', { class: 'textarea', placeholder: 'Optional: kurze Beschreibung' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [
        el('div', { class: 'label' }, ['Titel']),
        titleInput
      ]),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('div', { class: 'label' }, ['Beschreibung (optional)']),
        descInput
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        const title = titleInput.value.trim() || 'Neues Thema';
        const desc = descInput.value.trim();
        const t = await rbDB.addTopic(state.db, { title, description: desc });
        await refreshTopics();
        await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
        closeModal();
        toast('Thema erstellt');
        openTopic(t.id);
      } }, ['Erstellen'])
    ]);

    openModal({ title: 'Neues Thema', body, footer });
    setTimeout(() => titleInput.focus(), 50);
  }

  async function editTopicFlow(topicId) {
    const topic = state.topics.find(t => t.id === topicId);
    if (!topic) return;

    const titleInput = el('input', { class: 'input', value: topic.title });
    const descInput = el('textarea', { class: 'textarea', value: topic.description || '' });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [
        el('div', { class: 'label' }, ['Titel']),
        titleInput
      ]),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('div', { class: 'label' }, ['Beschreibung (optional)']),
        descInput
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Schließen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        const updated = await rbDB.updateTopic(state.db, topicId, {
          title: titleInput.value.trim() || topic.title,
          description: descInput.value.trim()
        });
        await refreshTopics();
        await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
        if (state.view === 'topic' && state.currentTopicId === topicId) {
          ui.topTitle.textContent = updated.title;
        }
        closeModal();
        toast('Thema gespeichert');
        render();
      } }, ['Speichern'])
    ]);

    openModal({ title: 'Thema bearbeiten', body, footer });
    setTimeout(() => titleInput.focus(), 50);
  }

  async function archiveTopicFlow(topicId, archived) {
    await rbDB.updateTopic(state.db, topicId, { archived: !!archived });
    await refreshTopics();
    await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
    toast(archived ? 'Archiviert' : 'Wiederhergestellt');
    if (archived && state.currentTopicId === topicId) {
      backToTopics();
    } else {
      render();
    }
  }

  async function deleteTopicFlow(topicId) {
    const topic = state.topics.find(t => t.id === topicId);
    const confirmInput = el('input', { type: 'checkbox', id: 'confirmDeleteTopicCheckbox' });
    const confirmLabel = el('label', { class: 'checkbox-label', for: 'confirmDeleteTopicCheckbox' }, [
      confirmInput,
      el('span', {}, ['Verstanden: Dieses Thema und alle Einträge werden dauerhaft gelöscht.'])
    ]);

    const body = el('div', {}, [
      el('div', { class: 'item__title' }, ['Thema wirklich löschen?']),
      el('div', { class: 'subtle', style: 'margin-top:6px;' }, [
        '„', topic?.title || '', '“ und alle enthaltenen Einträge werden dauerhaft entfernt.'
      ]),
      el('div', { class: 'field', style: 'margin-top:12px;' }, [confirmLabel])
    ]);

    const confirmDeleteBtn = el('button', {
      class: 'btn btn--danger',
      disabled: true,
      onclick: async () => {
        closeModal();
        await deleteTopicWithUndo(topicId);
      }
    }, ['Löschen']);

    confirmInput.addEventListener('change', () => {
      confirmDeleteBtn.disabled = !confirmInput.checked;
    });

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      confirmDeleteBtn
    ]);
    openModal({ title: 'Löschen', body, footer });
  }

  async function moveEntryFlow(entryId) {
    const entry = state.entries.find((item) => item.id === entryId);
    if (!entry) return;

    const targetTopics = state.topicsAll.filter((topic) => topic.id !== entry.topicId);
    if (!targetTopics.length) {
      toast('Kein anderes Thema verfügbar');
      return;
    }

    const select = el('select', { class: 'select' }, [
      el('option', { value: '', selected: true, disabled: true }, ['Zielthema auswählen']),
      ...targetTopics.map((topic) => el('option', { value: topic.id }, [topic.archived ? `${topic.title} (Archiv)` : topic.title]))
    ]);
    let pending = false;

    select.addEventListener('change', async () => {
      const targetTopicId = select.value;
      if (!targetTopicId || pending) return;
      pending = true;
      select.disabled = true;
      try {
        const targetTopic = targetTopics.find((topic) => topic.id === targetTopicId);
        await rbDB.moveEntryToTopic(state.db, entry.id, targetTopicId);
        markTopicSearchIndexDirty();
        closeModal();
        await refreshTopics();
        await render();
        toast(`Verschoben nach „${targetTopic?.title || 'Thema'}“`);
      } catch (error) {
        console.error(error);
        select.disabled = false;
        pending = false;
        toast('Verschieben fehlgeschlagen');
      }
    });

    const body = el('div', {}, [
      el('div', { class: 'subtle' }, ['Eintrag verschieben:']),
      el('div', { class: 'item__title', style: 'margin-top:6px;' }, [entry.title || (entry.type === 'link' ? entry.url : entry.excerpt) || '(ohne Titel)']),
      el('div', { class: 'field', style: 'margin-top:12px;' }, [
        el('div', { class: 'label' }, ['Zielthema']),
        select
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen'])
    ]);

    openModal({ title: 'Eintrag verschieben', body, footer });
    setTimeout(() => select.focus(), 30);
  }

  async function addEntryFlow(type, preset = {}) {
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    if (!topic) return;

    let titleInput = null;
    let urlInput = null;
    let excerptInput = null;
    const noteInput = el('textarea', { class: 'textarea', placeholder: 'Optionale Notiz' });

    const fields = [];

    if (type === 'link') {
      titleInput = el('input', { class: 'input', placeholder: 'Titel (optional)', value: preset.title || '' });
      urlInput = el('input', { class: 'input mono', placeholder: 'https://…', value: preset.url || '' });
      fields.push(
        el('div', { class: 'field' }, [el('div', { class: 'label' }, ['URL']), urlInput]),
        el('div', { class: 'field', style: 'margin-top:10px;' }, [el('div', { class: 'label' }, ['Titel (optional)']), titleInput])
      );
    }

    if (type === 'quote') {
      titleInput = el('input', { class: 'input', placeholder: 'Kurztitel (optional)', value: preset.title || '' });
      excerptInput = el('textarea', { class: 'textarea', placeholder: 'Textauszug', value: preset.excerpt || '' });
      fields.push(
        el('div', { class: 'field' }, [el('div', { class: 'label' }, ['Textauszug']), makeZoomableTextarea(excerptInput, 'Textauszug bearbeiten')]),
        el('div', { class: 'field', style: 'margin-top:10px;' }, [el('div', { class: 'label' }, ['Titel (optional)']), titleInput])
      );
    }

    if (type === 'note') {
      titleInput = el('input', { class: 'input', placeholder: 'Titel (optional)', value: preset.title || '' });
      noteInput.className = 'textarea textarea--note-main';
      noteInput.placeholder = 'Notiz';
      noteInput.value = preset.excerpt || preset.note || '';
      fields.push(
        el('div', { class: 'field' }, [el('div', { class: 'label' }, ['Titel (optional)']), titleInput]),
        el('div', { class: 'field', style: 'margin-top:10px;' }, [el('div', { class: 'label' }, ['Notiz']), makeZoomableTextarea(noteInput, 'Notiz bearbeiten')])
      );
    } else if (type === 'link') {
      fields.push(
        el('div', { class: 'field', style: 'margin-top:10px;' }, [
          el('div', { class: 'label' }, ['Notiz (optional)']),
          makeZoomableTextarea(noteInput, 'Notiz bearbeiten')
        ])
      );
    }

    const body = el('div', {}, [
      el('div', { class: 'subtle' }, ['Zielthema: ', topic.title]),
      el('div', { style: 'margin-top:10px;' }, fields)
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        const entry = {
          type,
          title: titleInput ? titleInput.value.trim() : '',
          url: urlInput ? urlInput.value.trim() : '',
          excerpt: type === 'note' ? noteInput.value.trim() : (excerptInput ? excerptInput.value.trim() : ''),
          note: type === 'link' ? noteInput.value.trim() : '',
          sourcePageTitle: preset.sourcePageTitle || '',
          sourcePageUrl: preset.sourcePageUrl || ''
        };

        // Light auto title
        if (!entry.title) {
          if (type === 'link') entry.title = entry.url;
          if (type === 'quote') entry.title = (entry.excerpt || '').slice(0, 60);
          if (type === 'note') entry.title = (entry.excerpt || '').slice(0, 60);
        }

        // Duplicate hint for link URL
        if (type === 'link' && entry.url) {
          const dup = state.entries.some(e => (e.url || '') === entry.url);
          if (dup) toast('Hinweis: URL existiert bereits in diesem Thema');
        }

        await rbDB.addEntry(state.db, state.currentTopicId, entry);
        markTopicSearchIndexDirty();
        closeModal();
        await refreshEntries();
        render();
        toast('Eintrag erstellt');
      } }, ['Speichern'])
    ]);

    const title = type === 'link' ? 'Neuer Link' : type === 'quote' ? 'Neuer Textauszug' : 'Neue Notiz';
    openModal({ title, body, footer });

    setTimeout(() => {
      if (urlInput) urlInput.focus();
      else if (excerptInput) excerptInput.focus();
      else titleInput?.focus();
    }, 50);
  }

  async function addCurrentPageFlow() {
    if (!state.currentTopicId) return;
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      toast('Kein aktiver Tab');
      return;
    }
    const transformConfig = await rbUrlTransform.getConfig();
    const transformed = rbUrlTransform.applyToUrl(tab.url, tab.title || '', transformConfig);
    await rbDB.addEntry(state.db, state.currentTopicId, {
      type: 'link',
      url: transformed.url,
      title: tab.title || transformed.url,
      note: '',
      sourcePageUrl: tab.url,
      sourcePageTitle: tab.title || ''
    });
    markTopicSearchIndexDirty();
    await render();
    toast('Aktuelle Seite hinzugefügt');
  }

  async function openEntry(entry) {
    const urlInput = el('input', { class: 'input mono', value: entry.url || '', placeholder: '(keine URL)' });
    const titleInput = el('input', { class: 'input', value: entry.title || '' });
    const excerptInput = el('textarea', { class: 'textarea', value: entry.excerpt || '' });
    const noteInput = el('textarea', { class: 'textarea', value: entry.note || '' });

    const body = el('div', {}, [
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [
          el('div', { class: 'label' }, ['Typ']),
          el('div', {}, [entryBadge(entry.type)])
        ]),
        el('div', { class: 'field' }, [
          el('div', { class: 'label' }, ['Erstellt']),
          el('div', { class: 'small' }, [formatDate(entry.createdAt)]),
          el('div', { class: 'label', style: 'margin-top:8px;' }, ['Aktualisiert']),
          el('div', { class: 'small' }, [formatDate(entry.updatedAt || entry.createdAt)])
        ])
      ]),

      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('div', { class: 'label' }, ['Titel']),
        titleInput
      ]),

      entry.type === 'link'
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, ['URL']),
            urlInput
          ])
        : null,

      entry.type !== 'link'
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, [entry.type === 'quote' ? 'Textauszug' : 'Notiztext']),
            makeZoomableTextarea(excerptInput, entry.type === 'quote' ? 'Textauszug bearbeiten' : 'Notiz bearbeiten')
          ])
        : null,

      entry.type === 'link'
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, ['Optionale Notiz']),
            makeZoomableTextarea(noteInput, 'Notiz bearbeiten')
          ])
        : null,

      (entry.sourcePageUrl || entry.sourcePageTitle) ? el('div', { class: 'card', style: 'margin-top:12px; background: color-mix(in oklab, var(--surface) 75%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Quelle']),
        entry.sourcePageTitle ? el('div', { class: 'small' }, [entry.sourcePageTitle]) : null,
        entry.sourcePageUrl ? el('div', { class: 'small mono' }, [entry.sourcePageUrl]) : null
      ]) : null
    ]);

    const footer = el('div', { class: 'actions actions--split' }, [
      el('div', { class: 'actions__group actions__group--left' }, [
        el('button', { class: 'btn btn--danger', onclick: async () => {
          closeModal();
          await deleteEntryWithUndo(entry);
        } }, ['Löschen'])
      ]),
      el('div', { class: 'actions__group actions__group--right' }, [
        entry.type === 'link' && entry.url ? el('button', { class: 'btn', onclick: async () => {
          await ext.runtime.sendMessage({ type: 'openUrlInTab', url: entry.url }).catch(() => {});
        } }, ['Öffnen']) : null,
        el('button', { class: 'btn btn--primary', onclick: async () => {
          const keepModalOpen = state.popupKeepModalOpenOnNextSave;
          state.popupKeepModalOpenOnNextSave = false;
          const patch = {
            title: titleInput.value.trim(),
            url: entry.type === 'link' ? urlInput.value.trim() : entry.url,
            excerpt: entry.type !== 'link' ? excerptInput.value.trim() : entry.excerpt,
            note: entry.type === 'link' ? noteInput.value.trim() : entry.note
          };
          await rbDB.updateEntry(state.db, entry.id, patch);
          markTopicSearchIndexDirty();
          if (!keepModalOpen) closeModal();
          await refreshEntries();
          if (!keepModalOpen) render();
          toast('Gespeichert');
        } }, ['Speichern'])
      ])
    ]);

    openModal({ title: 'Eintrag', body, footer });
    ui.modal.dataset.popupSaveMode = 'update-entry';
  }

  async function showSwitchTopicModal() {
    const select = el('select', { class: 'select' });
    const available = state.topics.filter(t => !t.archived);
    for (const t of available) {
      select.appendChild(el('option', { value: t.id, selected: t.id === state.currentTopicId }, [t.title]));
    }

    const body = el('div', {}, [
      el('div', { class: 'field' }, [
        el('div', { class: 'label' }, ['Thema auswählen']),
        select
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        const id = select.value;
        closeModal();
        await openTopic(id);
      } }, ['Wechseln'])
    ]);

    openModal({ title: 'Thema wechseln', body, footer });
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  function ymdhms() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  async function exportAllFlow() {
    const data = await rbDB.exportAll(state.db);
    downloadJson(`research-board-backup-${ymdhms()}.json`, data);
    toast('Export erstellt');
  }

  async function exportTopicFlow() {
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    if (!topic) return;
    const data = await rbDB.exportTopic(state.db, state.currentTopicId);
    downloadJson(`research-board-topic-${topic.title.replace(/[^a-z0-9\-_]+/gi,'_').slice(0,40)}-${ymdhms()}.json`, data);
    toast('Thema exportiert');
  }

  async function importFlow() {
    const fileInput = el('input', { type: 'file', class: 'input', accept: 'application/json,.json' });
    const modeSelect = el('select', { class: 'select' }, [
      el('option', { value: 'merge' }, ['Zusammenführen (empfohlen)']),
      el('option', { value: 'replace' }, ['Ersetzen (alles löschen)'])
    ]);
    const importSettingsInput = el('input', { type: 'checkbox', checked: false, disabled: true });

    const status = el('div', { class: 'subtle', style: 'margin-top:10px;' }, ['Wähle eine Export-Datei (JSON).']);

    let parsed = null;

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        parsed = JSON.parse(text);
        const info = summarizeImport(parsed);
        status.textContent = info;
        importSettingsInput.checked = !!(parsed && parsed.settings && typeof parsed.settings === 'object');
        importSettingsInput.disabled = !(parsed && parsed.settings && typeof parsed.settings === 'object');
      } catch (e) {
        parsed = null;
        status.textContent = 'Fehler: Datei konnte nicht gelesen/parsebar gemacht werden.';
        importSettingsInput.checked = false;
        importSettingsInput.disabled = true;
      }
    });

    const body = el('div', {}, [
      el('div', { class: 'field' }, [
        el('div', { class: 'label' }, ['Datei']),
        fileInput
      ]),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('div', { class: 'label' }, ['Modus']),
        modeSelect
      ]),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('label', { class: 'checkbox-label' }, [
          importSettingsInput,
          el('span', {}, ['Einstellungen mit importieren'])
        ])
      ]),
      status,
      el('div', { class: 'card', style: 'margin-top:12px; background: color-mix(in oklab, var(--surface) 75%, var(--bg));' }, [
        el('div', { class: 'subtle' }, [
          'Hinweis: Bei „Zusammenführen“ werden importierte Themen/Einträge als neue Objekte hinzugefügt (IDs werden neu vergeben), sodass keine Kollisionen entstehen.'
        ])
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        if (!parsed) {
          toast('Bitte zuerst eine Datei wählen');
          return;
        }
        const mode = modeSelect.value;
        await importData(parsed, mode, { importSettings: importSettingsInput.checked });
        markTopicSearchIndexDirty();
        closeModal();
        toast('Import abgeschlossen');
        await refreshTopics();
        await ensureDefaultTopic();
        if (state.view === 'topic') await refreshEntries();
        render();
        await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
      } }, ['Importieren'])
    ]);

    openModal({ title: 'Import', body, footer });
  }

  function summarizeImport(obj) {
    if (!obj || typeof obj !== 'object') return 'Ungültiges Format.';
    if (obj.schemaVersion !== 1) return 'Hinweis: Unbekannte schemaVersion.';

    if (Array.isArray(obj.topics) && Array.isArray(obj.entries)) {
      return `Gefunden: ${obj.topics.length} Themen, ${obj.entries.length} Einträge${obj.settings ? ', Einstellungen vorhanden' : ''}.`;
    }
    if (obj.topic && Array.isArray(obj.entries)) {
      return `Gefunden: 1 Thema („${obj.topic.title || 'ohne Titel'}“), ${obj.entries.length} Einträge${obj.settings ? ', Einstellungen vorhanden' : ''}.`;
    }
    return 'Format erkannt, aber Inhalte sind unvollständig.';
  }

  async function importData(obj, mode, { importSettings = true } = {}) {
    if (!obj || typeof obj !== 'object') throw new Error('Invalid');

    // Normalize to full import shape.
    let topics = [];
    let entries = [];

    if (Array.isArray(obj.topics) && Array.isArray(obj.entries)) {
      topics = obj.topics;
      entries = obj.entries;
    } else if (obj.topic && Array.isArray(obj.entries)) {
      topics = [obj.topic];
      entries = obj.entries;
    } else {
      throw new Error('Unsupported import format');
    }

    if (mode === 'replace') {
      await rbDB.clearAll(state.db);
      await bulkInsert(topics, entries, { keepIds: true });
      const first = topics.find(t => !t.archived) || topics[0];
      if (importSettings && obj.settings && typeof obj.settings === 'object') {
        const importedSettings = rbDB.normalizeAppSettings(obj.settings);
        const nextTopicId = importedSettings.lastTopicId || first?.id || null;
        await rbDB.applyImportedSettings(importedSettings, { lastTopicId: nextTopicId });
        state.currentTopicId = nextTopicId;
        state.includeArchived = importedSettings.includeArchived;
        applyTheme(importedSettings.themeMode);
      } else {
        state.currentTopicId = first?.id ?? null;
        await saveSettings({ lastTopicId: state.currentTopicId });
      }
      return;
    }

    // merge: remap IDs to avoid collisions
    const existingTopicIds = new Set(state.topics.map(t => t.id));
    const idMapTopic = new Map();

    const newTopics = topics.map((t, idx) => {
      const newId = rbDB.uuid();
      idMapTopic.set(t.id, newId);
      return {
        ...t,
        id: newId,
        title: t.title || 'Import',
        position: state.topics.filter(x => !x.archived).length + idx + 1,
        createdAt: rbDB.nowIso(),
        updatedAt: rbDB.nowIso(),
        archived: !!t.archived
      };
    });

    const newEntries = entries
      .filter(e => idMapTopic.has(e.topicId))
      .map((e, idx) => {
        const newId = rbDB.uuid();
        return {
          ...e,
          id: newId,
          topicId: idMapTopic.get(e.topicId),
          position: idx + 1,
          createdAt: rbDB.nowIso(),
          updatedAt: rbDB.nowIso()
        };
      });

    await bulkInsert(newTopics, newEntries, { keepIds: true });

    if (importSettings && obj.settings && typeof obj.settings === 'object') {
      const importedSettings = rbDB.normalizeAppSettings(obj.settings);
      const mappedLastTopicId = importedSettings.lastTopicId
        ? (idMapTopic.get(importedSettings.lastTopicId) || null)
        : undefined;
      await rbDB.applyImportedSettings(importedSettings, { lastTopicId: mappedLastTopicId });
      state.includeArchived = importedSettings.includeArchived;
      if (mappedLastTopicId) state.currentTopicId = mappedLastTopicId;
      applyTheme(importedSettings.themeMode);
    }
  }

  async function bulkInsert(topics, entries, { keepIds }) {
    const tx = state.db.transaction(['topics', 'entries'], 'readwrite');
    const tStore = tx.objectStore('topics');
    const eStore = tx.objectStore('entries');

    for (const t of topics) {
      const item = keepIds ? t : { ...t, id: rbDB.uuid() };
      if (!item.createdAt) item.createdAt = rbDB.nowIso();
      if (!item.updatedAt) item.updatedAt = item.createdAt;
      if (typeof item.archived !== 'boolean') item.archived = !!item.archived;
      if (typeof item.position !== 'number') item.position = 1;
      tStore.put(item);
    }

    for (const e of entries) {
      const item = keepIds ? e : { ...e, id: rbDB.uuid() };
      if (!item.createdAt) item.createdAt = rbDB.nowIso();
      if (!item.updatedAt) item.updatedAt = item.createdAt;
      if (typeof item.position !== 'number') item.position = 1;
      eStore.put(item);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    await rbDB.touchChangeToken();
  }

  function parseUriList(text) {
    const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.startsWith('#')) continue;
      return l;
    }
    return '';
  }

  function looksLikeUrl(s) {
    if (!s) return false;
    const t = s.trim();
    return t.startsWith('http://') || t.startsWith('https://') || t.startsWith('www.');
  }

  function coerceUrl(s) {
    const t = (s || '').trim();
    if (t.startsWith('www.')) return 'https://' + t;
    return t;
  }

  function parseMozUrl(text) {
    const lines = (text || '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    return {
      url: lines[0] || '',
      title: lines[1] || ''
    };
  }

  function hasDropEntryPayload(dt) {
    if (!dt) return false;
    const types = dt.types || [];
    return types.includes('text/uri-list') || types.includes('text/x-moz-url') || types.includes('text/plain');
  }

  function buildEntryFromDropData(dt) {
    if (!dt) return null;

    let url = '';
    let title = '';
    let text = '';

    if (dt.types.includes('text/uri-list')) {
      url = parseUriList(dt.getData('text/uri-list'));
    }

    if (dt.types.includes('text/x-moz-url')) {
      const moz = parseMozUrl(dt.getData('text/x-moz-url'));
      if (!url && moz.url) url = moz.url;
      if (moz.title) title = moz.title;
    }

    text = dt.getData('text/plain') || '';

    if (url) {
      const finalTitle = title || (text && !looksLikeUrl(text) ? text.trim() : '') || url;
      return {
        type: 'link',
        url,
        title: finalTitle,
        note: ''
      };
    }

    if (text) {
      if (looksLikeUrl(text) && text.trim().length < 2048) {
        const u = coerceUrl(text);
        return { type: 'link', url: u, title: u, note: '' };
      }

      return {
        type: 'quote',
        excerpt: text,
        title: text.trim().slice(0, 60),
        note: ''
      };
    }

    return null;
  }

  async function addEntryFromDrop(ev, topicId = state.currentTopicId) {
    const entry = buildEntryFromDropData(ev.dataTransfer);
    if (!entry) return null;
    const created = await rbDB.addEntry(state.db, topicId, entry);
    markTopicSearchIndexDirty();
    return created;
  }

  async function checkPendingCapture() {
    const pending = await ext.runtime.sendMessage({ type: 'getPendingCapture' }).catch(() => null);
    if (!pending) return;

    const preview = buildCapturePreview(pending);
    const NEW_TOPIC_VALUE = '__new_topic__';

    const select = el('select', { class: 'select' });
    const available = state.topics.filter(t => !t.archived);
    const settings = await ext.storage.local.get({ lastTopicId: null });

    const preferredTopicId = settings.lastTopicId || state.currentTopicId;
    for (const t of available) {
      select.appendChild(el('option', { value: t.id, selected: t.id === preferredTopicId }, [t.title]));
    }
    select.appendChild(el('option', { value: NEW_TOPIC_VALUE, selected: available.length === 0 }, ['+ Neues Thema erstellen…']));

    const newTopicInput = el('input', {
      class: 'input',
      placeholder: 'Titel für neues Thema',
      value: ''
    });
    const newTopicField = el('div', { class: 'field hidden', style: 'margin-top:10px;' }, [
      el('div', { class: 'label' }, ['Neues Thema']),
      newTopicInput
    ]);

    const updateNewTopicVisibility = () => {
      const show = select.value === NEW_TOPIC_VALUE;
      newTopicField.classList.toggle('hidden', !show);
      if (show) {
        setTimeout(() => newTopicInput.focus(), 0);
      }
    };
    select.addEventListener('change', updateNewTopicVisibility);
    updateNewTopicVisibility();

    const body = el('div', {}, [
      el('div', { class: 'subtle' }, ['Es gibt ein Element aus dem Kontextmenü, das noch einem Thema zugeordnet werden soll.']),
      el('div', { class: 'card', style: 'margin-top:10px;' }, preview),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('div', { class: 'label' }, ['Zielthema']),
        select
      ]),
      newTopicField
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: async () => {
        await ext.runtime.sendMessage({ type: 'clearPendingCapture' }).catch(() => {});
        closeModal();
      } }, ['Verwerfen']),
      el('button', { class: 'btn btn--primary', onclick: async () => {
        let topicId = select.value;
        if (topicId === NEW_TOPIC_VALUE) {
          const title = (newTopicInput.value || '').trim();
          if (!title) {
            toast('Bitte einen Thementitel eingeben');
            newTopicInput.focus();
            return;
          }
          const createdTopic = await rbDB.addTopic(state.db, { title });
          topicId = createdTopic.id;
          await refreshTopics();
          await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
        }
        const res = await ext.runtime.sendMessage({ type: 'addPendingCaptureToTopic', topicId }).catch(() => ({ ok: false }));
        if (!res?.ok) {
          toast('Hinzufügen fehlgeschlagen');
          return;
        }
        closeModal();
        toast('Hinzugefügt');
        await refreshTopics();
        // If in topic view, refresh if same.
        if (state.currentTopicId === topicId) {
          await refreshEntries();
          render();
        } else if (state.view === 'topics') {
          renderTopicsView();
        }
      } }, ['Hinzufügen'])
    ]);

    openModal({ title: 'Capture zuordnen', body, footer });
  }

  function buildCapturePreview(pending) {
    const info = pending.info || {};
    const tab = pending.tab || {};

    if (info.linkUrl) {
      return el('div', {}, [
        el('div', { class: 'item__row' }, [entryBadge('link'), el('div', { class: 'item__title' }, [info.linkText || info.linkUrl])]),
        el('div', { class: 'small mono', style: 'margin-top:6px;' }, [info.linkUrl])
      ]);
    }

    if (info.selectionText) {
      const s = info.selectionText.trim();
      return el('div', {}, [
        el('div', { class: 'item__row' }, [entryBadge('quote'), el('div', { class: 'item__title' }, [s.slice(0, 60) + (s.length > 60 ? '…' : '')])]),
        el('div', { class: 'small', style: 'margin-top:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' }, [s])
      ]);
    }

    return el('div', {}, [
      el('div', { class: 'item__row' }, [entryBadge('link'), el('div', { class: 'item__title' }, [tab.title || tab.url || info.pageUrl || 'Seite'])]),
      el('div', { class: 'small mono', style: 'margin-top:6px;' }, [tab.url || info.pageUrl || ''])
    ]);
  }

  function showHelpModal() {
    const body = el('div', {}, [
      el('div', { class: 'label' }, ['Research Board - Kurzüberblick']),
      el('div', { class: 'subtle', style: 'margin-top:6px;' }, [
        'Mit der Sidebar sammelst und organisierst du Links, Textauszüge und Notizen in Themen.'
      ]),

      el('div', { class: 'card', style: 'margin-top:12px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Themen & Einträge']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Themen anlegen, sortieren, archivieren und löschen.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Einträge je Thema als Link, Text oder Notiz speichern.'])
      ]),

      el('div', { class: 'card', style: 'margin-top:10px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Suchen & Navigation']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Suche findet Themen und Inhalte aus den Einträgen.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Mit Pfeiltasten navigieren, mit Enter öffnen, mit Escape zurück.'])
      ]),

      el('div', { class: 'card', style: 'margin-top:10px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Import, Export & Sicherheit']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Komplette Daten oder einzelne Themen exportieren/importieren.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Löschaktionen bieten Rückgängig-Optionen, \"Alle Daten löschen\" entfernt alles dauerhaft.'])
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--primary', onclick: closeModal }, ['Verstanden'])
    ]);

    openModal({ title: 'Hilfe', body, footer });
  }

  async function showDangerResetModal() {
    const confirmInput = el('input', { type: 'checkbox', id: 'confirmResetCheckbox' });
    const confirmLabel = el('label', { class: 'checkbox-label', for: 'confirmResetCheckbox' }, [
      confirmInput,
      el('span', {}, ['Verstanden: Alle Daten werden dauerhaft gelöscht.'])
    ]);

    const body = el('div', {}, [
      el('div', { class: 'item__title' }, ['Alles löschen?']),
      el('div', { class: 'subtle', style: 'margin-top:6px;' }, ['Alle Themen und Einträge werden entfernt. Exportiere vorher, wenn du ein Backup willst.']),
      el('div', { class: 'field', style: 'margin-top:12px;' }, [confirmLabel])
    ]);
    const confirmDeleteBtn = el('button', {
      class: 'btn btn--danger',
      disabled: true,
      onclick: async () => {
        await rbDB.clearAll(state.db);
        await ext.storage.local.set({ lastTopicId: null });
        await refreshTopics();
        await ensureDefaultTopic();
        closeModal();
        toast('Gelöscht');
        renderTopicsView();
        await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
      }
    }, ['Alles löschen']);

    confirmInput.addEventListener('change', () => {
      confirmDeleteBtn.disabled = !confirmInput.checked;
    });

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--ghost', onclick: closeModal }, ['Abbrechen']),
      confirmDeleteBtn
    ]);
    openModal({ title: 'Zurücksetzen', body, footer });
  }

  // UI events
  ui.navBackBtn.addEventListener('click', backToTopics);

  ui.searchInput.addEventListener('input', () => {
    state.search = ui.searchInput.value;
    render();
  });

  ui.searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      ev.stopPropagation();
      moveKbdSelection(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      ev.stopPropagation();
      moveKbdSelection(-1);
      return;
    }
    if (ev.key === 'Home') {
      ev.preventDefault();
      ev.stopPropagation();
      setKbdActiveIndex(0);
      return;
    }
    if (ev.key === 'End') {
      ev.preventDefault();
      ev.stopPropagation();
      const nodes = getNavigableNodes();
      if (nodes.length) setKbdActiveIndex(nodes.length - 1);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      activateKbdSelection();
    }
  });

  ui.primaryBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await createTopicFlow();
  });

  ui.qaCreateTopicBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await createTopicFlow();
  });

  ui.qaExportBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await exportAllFlow();
  });

  ui.qaImportBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await importFlow();
  });

  ui.qaArchiveToggleBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    state.includeArchived = !state.includeArchived;
    await saveSettings({ includeArchived: state.includeArchived });
    await refreshTopics();
    updateArchiveToggleButton();
    if (state.view === 'topics') {
      renderTopicsView();
    } else {
      await render();
    }
  });

  ui.qaTopicExportBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    exportTopicFlow();
  });

  ui.qaTopicEditBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!state.currentTopicId) return;
    editTopicFlow(state.currentTopicId);
  });

  ui.qaTopicArchiveBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!state.currentTopicId) return;
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    archiveTopicFlow(state.currentTopicId, !topic?.archived);
  });

  ui.qaTopicDeleteBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!state.currentTopicId) return;
    deleteTopicFlow(state.currentTopicId);
  });

  document.addEventListener('click', (ev) => {
    const insideDrop =
      ui.dropdown.contains(ev.target) ||
      ui.menuBtn?.contains(ev.target) ||
      ui.primaryBtn.contains(ev.target);
    if (!insideDrop) closeDropdown();
  });

  ui.modalClose.addEventListener('click', closeModal);
  ui.modalOverlay.addEventListener('click', (ev) => {
    if (ev.target === ui.modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!ui.dropdown.classList.contains('hidden')) {
        closeDropdown();
        return;
      }
      if (!ui.modalOverlay.classList.contains('hidden')) {
        closeModal();
        return;
      }
      if (state.view === 'topic') {
        backToTopics();
      }
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(ev.key)) return;
    if (!ui.modalOverlay.classList.contains('hidden')) return;
    const target = ev.target;
    if (target !== ui.searchInput && isEditableTarget(target)) return;

    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveKbdSelection(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveKbdSelection(-1);
      return;
    }
    if (ev.key === 'Home') {
      ev.preventDefault();
      setKbdActiveIndex(0);
      return;
    }
    if (ev.key === 'End') {
      ev.preventDefault();
      const nodes = getNavigableNodes();
      if (nodes.length) setKbdActiveIndex(nodes.length - 1);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      activateKbdSelection();
    }
  });

  // Messages
  ext.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'entryAdded') {
      if (state.view === 'topic' && msg.topicId === state.currentTopicId) {
        refreshEntries().then(render);
      }
    }

    if (msg.type === 'pendingCaptureAvailable') {
      checkPendingCapture();
    }

    if (msg.type === 'dataRestored') {
      refreshTopics()
        .then(refreshEntries)
        .then(render)
        .catch((error) => {
          console.error(error);
          toast('Ansicht konnte nach Wiederherstellung nicht aktualisiert werden');
        });
    }
  });

  ext.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!Object.prototype.hasOwnProperty.call(changes, 'pendingCaptureSignal')) return;
    checkPendingCapture();
  });

  async function init() {
    let stage = 'db-open';
    try {
      stage = 'theme-init';
      await initTheme();

      stage = 'db-open';
      state.db = await rbDB.openDb();

      stage = 'load-settings';
      await loadSettings();
      updateArchiveToggleButton();

      stage = 'refresh-topics';
      await refreshTopics();

      stage = 'ensure-default-topic';
      await ensureDefaultTopic();

      // If we have a last topic, open it? Keep topics view as default for clarity.
      stage = 'render-topics';
      renderTopicsView();

      // Also check if a capture is pending.
      stage = 'check-pending-capture';
      await checkPendingCapture();

      // Request menu refresh once, so the context menu stays up to date.
      stage = 'request-menu-refresh';
      await ext.runtime.sendMessage({ type: 'requestMenuRefresh' }).catch(() => {});
    } catch (e) {
      if (e && typeof e === 'object' && !('stage' in e)) {
        e.stage = stage;
      }
      throw e;
    }
  }

  init().catch((e) => {
    console.error(e);
    ui.main.innerHTML = '';
    const detail = `${String(e?.message || e)}${e?.stage ? ` (stage: ${e.stage})` : ''}`;
    ui.main.appendChild(renderEmpty('Fehler beim Start', detail));
  });
})();
