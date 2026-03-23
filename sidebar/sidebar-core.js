/*
  Sidebar Core

  Responsibilities:
    - shared DOM helpers and common UI primitives
    - runtime state and cached DOM references
    - theme handling, toast handling, modal/dropdown helpers
    - popup editor helpers
    - keyboard navigation helpers
    - search helpers, sorting helpers, and data refresh helpers

  This file intentionally contains the low-level building blocks that the other
  sidebar files depend on.
*/

  /**
   * Resolve a single DOM node from the current sidebar document.
   *
   * @param {string} sel CSS selector.
   * @returns {Element|null} Matching DOM node, if found.
   */
  const $ = (sel) => document.querySelector(sel);
  /**
   * Small DOM factory used throughout the sidebar to keep rendering imperative but compact.
   *
   * Supported special attributes:
   * - `class`
   * - `dataset`
   * - `value`
   * - `checked`
   * - `selected`
   * - event handlers via `on*`
   *
   * @param {string} tag HTML tag name.
   * @param {object} [attrs={}] Element attributes and event handlers.
   * @param {Array<Node|string>|Node|string|null} [children=[]] Child nodes or text.
   * @returns {HTMLElement} Constructed DOM node.
   */
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

  // Central in-memory application state for the sidebar runtime.
  const state = {
    db: null,
    includeArchived: false,
    includeArchivedEntries: false,
    archivedEntryCountByTopic: new Map(),
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
    currentTopicEntryTab: 'all',
    lastTopicsFocusId: null,
    pendingFocusEntryId: null,
    pendingOpenEntryId: null,
    search: '',
    drag: { type: null, id: null },
    kbdNav: { index: -1, id: null },
    popupKeepModalOpenOnNextSave: false
  };
  const THEME_MODE_KEY = 'themeMode';

  // Cached DOM references used across renders and event handlers.
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

  /**
   * Apply the requested light/dark theme to the sidebar root and update the toggle affordance.
   *
   * @param {string} mode Requested theme mode.
   * @returns {string} Normalized theme mode that was applied.
   */
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

  /**
   * Load the persisted theme setting and bind the theme toggle button.
   *
   * @returns {Promise<void>}
   */
  async function initTheme() {
    const settings = await ext.storage.local.get({ [THEME_MODE_KEY]: 'light' });
    let mode = applyTheme(settings?.[THEME_MODE_KEY]);
    ui.themeToggleBtn?.addEventListener('click', async () => {
      mode = applyTheme(mode === 'dark' ? 'light' : 'dark');
      await ext.storage.local.set({ [THEME_MODE_KEY]: mode });
      toast(mode === 'dark' ? 'Dunkles Theme aktiv' : 'Helles Theme aktiv');
    });
  }

  /**
   * Show a short-lived toast message.
   *
   * @param {string} msg User-visible message text.
   * @returns {void}
   */
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

  /**
   * Immediately remove any currently visible toast.
   *
   * @returns {void}
   */
  function hideToastNow() {
    if (toastTimerId) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    ui.toast.classList.remove('show', 'toast--undo');
    ui.toast.innerHTML = '';
  }

  /**
   * Show an undo-capable toast with a timeout and progress indicator.
   *
   * @param {string} message User-visible message text.
   * @param {{ durationMs?: number, onUndo?: (() => Promise<void>|void) }} [options={}] Undo configuration.
   * @returns {void}
   */
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

  /**
   * Delete an entry and offer an undo action that recreates its previous snapshot.
   *
   * @param {object} entry Entry record to delete.
   * @returns {Promise<void>}
   */
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
          todos: snapshot.todos,
          archived: snapshot.archived,
          highlighted: snapshot.highlighted,
          pinned: snapshot.pinned,
          position: snapshot.position
        });
        markTopicSearchIndexDirty();
        await refreshEntries();
        render();
        toast('Löschen rückgängig gemacht');
      }
    });
  }

  /**
   * Delete a topic and all of its entries, then offer an undo action that restores both.
   *
   * @param {string} topicId Topic identifier.
   * @returns {Promise<void>}
   */
  async function deleteTopicWithUndo(topicId) {
    const topic = await rbDB.getTopic(state.db, topicId);
    if (!topic) return;
    const entries = await rbDB.getEntriesByTopic(state.db, topicId, { includeArchived: true });

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

  /**
   * Hide and clear the shared dropdown menu.
   *
   * @returns {void}
   */
  function closeDropdown() {
    ui.dropdown.classList.add('hidden');
    ui.dropdown.innerHTML = '';
    ui.dropdown.style.left = '';
    ui.dropdown.style.top = '';
    ui.dropdown.style.right = '';
  }

  /**
   * Render and position the shared dropdown menu.
   *
   * @param {Array<{ label: string, hint?: string, danger?: boolean, onClick?: Function }>} items Dropdown items.
   * @param {{ anchorX?: number|null, anchorY?: number|null }} [options={}] Screen anchor coordinates.
   * @returns {void}
   */
  function openDropdown(items, { anchorX = null, anchorY = null } = {}) {
    ui.dropdown.innerHTML = '';
    const nodes = [];
    const focusAt = (index) => {
      if (!nodes.length) return;
      const next = ((index % nodes.length) + nodes.length) % nodes.length;
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].setAttribute('tabindex', i === next ? '0' : '-1');
      }
      nodes[next].focus();
    };

    for (const it of items) {
      const node = el('div', { class: `dropitem${it.danger ? ' dropitem--danger' : ''}`, role: 'menuitem', tabindex: '-1' }, [
        el('div', {}, [it.label]),
        it.hint ? el('div', { class: 'dropitem__hint' }, [it.hint]) : null
      ]);
      node.addEventListener('click', async () => {
        closeDropdown();
        await it.onClick?.();
      });
      node.addEventListener('keydown', async (ev) => {
        const current = nodes.indexOf(node);
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          focusAt(current + 1);
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          focusAt(current - 1);
          return;
        }
        if (ev.key === 'Home') {
          ev.preventDefault();
          focusAt(0);
          return;
        }
        if (ev.key === 'End') {
          ev.preventDefault();
          focusAt(nodes.length - 1);
          return;
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeDropdown();
          return;
        }
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          closeDropdown();
          await it.onClick?.();
        }
      });
      nodes.push(node);
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

  /**
   * Open the shared modal shell with provided content fragments.
   *
   * @param {{ title: string, body?: Node|null, footer?: Node|null }} config Modal fragments.
   * @returns {void}
   */
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

  /**
   * Wrap a textarea with the sidebar's popup-expansion affordance.
   *
   * @param {HTMLTextAreaElement} textarea Source textarea.
   * @param {string} popupTitle Popup window title.
   * @returns {HTMLDivElement} Wrapper containing textarea and zoom button.
   */
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

  /**
   * Open a detached popup editor for a textarea used inside the sidebar or a modal dialog.
   *
   * @param {{ title?: string, sourceTextarea: HTMLTextAreaElement }} config Popup configuration.
   * @returns {void}
   */
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

  /**
   * Open the dedicated note/quote popup editor directly from an entry row.
   *
   * @param {object} entry Entry record to edit.
   * @param {HTMLElement|null} triggerButton Source control used to launch the popup.
   * @returns {void}
   */
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

  /**
   * Close and reset the shared modal shell.
   *
   * @returns {void}
   */
  function closeModal() {
    ui.modalOverlay.classList.add('hidden');
    ui.modalOverlay.setAttribute('aria-hidden', 'true');
    ui.modalBody.innerHTML = '';
    ui.modalFooter.innerHTML = '';
    ui.modal.dataset.popupSaveMode = '';
    state.popupKeepModalOpenOnNextSave = false;
  }

  /**
   * Detect whether a keyboard event target is an editable control that should keep native key handling.
   *
   * @param {EventTarget|null} target Event target.
   * @returns {boolean} `true` when the target should suppress global keyboard navigation.
   */
  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = String(target.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
  }

  /**
   * Return the list nodes currently participating in keyboard navigation.
   *
   * @returns {HTMLElement[]} Navigable sidebar items for the active screen.
   */
  function getNavigableNodes() {
    let selector = '#topicsList .item';
    if (state.view === 'topic') {
      selector = '#entriesList .item';
    }
    return Array.from(document.querySelectorAll(selector));
  }

  /**
   * Remove the keyboard-active state from all navigable items.
   *
   * @returns {void}
   */
  function clearKbdActive() {
    for (const node of document.querySelectorAll('.item--kbd-active')) {
      node.classList.remove('item--kbd-active');
    }
  }

  /**
   * Resolve the currently active keyboard-navigation index against the rendered node list.
   *
   * @param {HTMLElement[]} nodes Navigable nodes.
   * @returns {number} Active index, or `-1` when no valid active item exists.
   */
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

  /**
   * Mark a navigable item as keyboard-active and optionally scroll it into view.
   *
   * @param {number} nextIndex Target index.
   * @param {{ scroll?: boolean }} [options={}] Scroll behavior.
   * @returns {boolean} `true` when an item was activated.
   */
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

  /**
   * Reconcile keyboard-navigation state with the latest render output.
   *
   * @returns {void}
   */
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

  /**
   * Move keyboard selection by a relative offset.
   *
   * @param {number} delta Relative movement.
   * @returns {boolean} `true` when selection changed.
   */
  function moveKbdSelection(delta) {
    const nodes = getNavigableNodes();
    if (!nodes.length) return false;
    const current = resolveKbdIndex(nodes);
    const base = current < 0 ? (delta > 0 ? -1 : nodes.length) : current;
    return setKbdActiveIndex(base + delta);
  }

  /**
   * Activate the currently keyboard-selected item.
   *
   * @returns {boolean} `true` when a node was activated.
   */
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

  /**
   * Format an ISO timestamp for compact display in the sidebar.
   *
   * @param {string} iso ISO timestamp.
   * @returns {string} Localized date/time string.
   */
  function formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  /**
   * Create the badge element used to visualize an entry type.
   *
   * @param {string} type Entry type.
   * @returns {HTMLElement} Badge element.
   */
  function entryBadge(type) {
    if (type === 'link') return el('span', { class: 'badge badge--link' }, ['Link']);
    if (type === 'quote') return el('span', { class: 'badge badge--quote' }, ['Text']);
    if (type === 'todo') return el('span', { class: 'badge badge--todo' }, ['Todo']);
    return el('span', { class: 'badge badge--note' }, ['Notiz']);
  }

  /**
   * Normalize todo items through the shared database helper to keep sidebar behavior aligned.
   *
   * @param {Array<object>|undefined|null} items Raw todo items.
   * @returns {Array<object>} Normalized todo items.
   */
  function normalizeTodoItems(items) {
    return rbDB.normalizeTodoItems(items);
  }

  /**
   * Calculate aggregate todo progress metadata.
   *
   * @param {Array<object>|undefined|null} items Todo items.
   * @returns {{ total: number, done: number, open: number, items: Array<object> }} Todo stats.
   */
  function getTodoStats(items) {
    const todos = normalizeTodoItems(items);
    const done = todos.filter((item) => item.done).length;
    return { total: todos.length, done, open: todos.length - done, items: todos };
  }

  /**
   * Build the compact todo progress label shown in entry rows.
   *
   * @param {object} entry Entry record.
   * @returns {string} Progress summary.
   */
  function getTodoSummary(entry) {
    const stats = getTodoStats(entry?.todos);
    if (!stats.total) return '0/0 erledigt';
    return `${stats.done}/${stats.total} erledigt`;
  }

  /**
   * Resolve the primary display title for an entry independent of its concrete type.
   *
   * @param {object|null|undefined} entry Entry record.
   * @returns {string} Best-effort display title.
   */
  function getEntryDisplayTitle(entry) {
    if (!entry) return '(ohne Titel)';
    if (entry.type === 'link') return entry.title || entry.url || '(ohne Titel)';
    if (entry.type === 'todo') return entry.title || normalizeTodoItems(entry.todos)[0]?.text || 'Todo-Liste';
    return entry.title || entry.excerpt || '(ohne Titel)';
  }

  /**
   * Resolve and normalize the persisted sort mode for a topic.
   *
   * @param {object|null|undefined} topic Topic record.
   * @returns {string} Normalized sort mode.
   */
  function getTopicEntrySortMode(topic) {
    return rbDB.normalizeEntrySortMode(topic?.entrySortMode);
  }

  /**
   * Determine the effective sort mode for the active entry tab.
   *
   * Type-based sorts are collapsed inside single-type tabs because the result would
   * otherwise be redundant or confusing.
   *
   * @param {object|null|undefined} topic Topic record.
   * @param {string} [entryTab='all'] Active tab key.
   * @returns {string} Effective sort mode.
   */
  function getEffectiveEntrySortMode(topic, entryTab = 'all') {
    const mode = getTopicEntrySortMode(topic);
    if (entryTab === 'all') return mode;
    if (mode === 'type') return 'custom';
    if (mode === 'type_then_title') return 'title';
    return mode;
  }

  /**
   * Map entry types to a stable rank used by type-based sorting.
   *
   * @param {string} type Entry type.
   * @returns {number} Sort rank.
   */
  function getEntryTypeRank(type) {
    return type === 'link' ? 0 : (type === 'quote' ? 1 : (type === 'todo' ? 2 : 3));
  }

  /**
   * Resolve the localized tab label for a single entry type.
   *
   * @param {string} type Entry type.
   * @returns {string} Tab label.
   */
  function getEntryTypeTabLabel(type) {
    if (type === 'link') return 'Links';
    if (type === 'quote') return 'Textauszüge';
    if (type === 'todo') return 'Todos';
    return 'Notizen';
  }

  /**
   * Build the visible type-tab list for a topic.
   *
   * Tabs are hidden completely when the topic only contains one entry type,
   * because the filtered view would not add meaningful navigation value.
   *
   * @param {Array<object>} entries Topic entries.
   * @returns {Array<{ key: string, label: string }>} Available tabs.
   */
  function getAvailableTopicEntryTabs(entries) {
    const types = ['link', 'note', 'quote', 'todo'];
    const availableTypes = types.filter((type) => entries.some((entry) => entry.type === type));
    if (availableTypes.length <= 1) {
      return [{ key: 'all', label: 'Alle' }];
    }

    const tabs = [{ key: 'all', label: 'Alle' }];
    for (const type of availableTypes) {
      tabs.push({ key: type, label: getEntryTypeTabLabel(type) });
    }
    return tabs;
  }

  /**
   * Filter topic entries by both search query and active type tab.
   *
   * @param {Array<object>} entries Topic entries.
   * @param {string} query Normalized query.
   * @param {string} [entryTab='all'] Active tab key.
   * @returns {Array<object>} Visible entries.
   */
  function getVisibleTopicEntries(entries, query, entryTab = 'all', includeArchived = false) {
    return entries.filter((entry) => {
      if (!includeArchived && entry?.archived) return false;
      if (entryTab !== 'all' && entry.type !== entryTab) return false;
      return matchesEntry(entry, query);
    });
  }

  /**
   * Return a new list with pinned items first while preserving relative order within both groups.
   *
   * @param {Array<object>} items Source list.
   * @returns {Array<object>} Reordered list with pinned items first.
   */
  function prioritizePinned(items) {
    const list = Array.isArray(items) ? items : [];
    const pinned = [];
    const rest = [];
    for (const item of list) {
      if (item?.pinned) pinned.push(item);
      else rest.push(item);
    }
    return pinned.concat(rest);
  }

  /**
   * Resolve the localized label for an entry sort mode.
   *
   * @param {string} mode Sort mode key.
   * @returns {string} Human-readable label.
   */
  function getEntrySortLabel(mode) {
    if (mode === 'type') return 'Typ';
    if (mode === 'title') return 'Name';
    if (mode === 'type_then_title') return 'Typ, dann Name';
    return 'Benutzerdefiniert';
  }

  /**
   * Persist a topic sort mode change, refresh sidebar state, and surface a toast.
   *
   * @param {string} topicId Topic identifier.
   * @param {string} nextMode New sort mode.
   * @param {{ entryTab?: string }} [options={}] Active tab metadata for toast context.
   * @returns {Promise<void>}
   */
  async function updateTopicEntrySortMode(topicId, nextMode, { entryTab = 'all' } = {}) {
    await rbDB.updateTopic(state.db, topicId, { entrySortMode: nextMode });
    await refreshTopics();
    await refreshEntries();
    render();
    const tabSuffix = entryTab === 'all' ? '' : ` (${getEntryTypeTabLabel(entryTab)})`;
    toast(`Sortierung${tabSuffix}: ${getEntrySortLabel(nextMode)}`);
  }

  /**
   * Open the sort-mode dropdown for the current topic view.
   *
   * @param {object|null|undefined} topic Topic record.
   * @param {HTMLElement} anchorEl Button used as dropdown anchor.
   * @param {{ entryTab?: string }} [options={}] Active tab metadata.
   * @returns {void}
   */
  function openTopicSortMenu(topic, anchorEl, { entryTab = 'all' } = {}) {
    if (!topic) return;
    const currentMode = getEffectiveEntrySortMode(topic, entryTab);
    const rect = anchorEl?.getBoundingClientRect?.();
    const items = [
      {
        label: currentMode === 'custom' ? 'Benutzerdefiniert ✓' : 'Benutzerdefiniert',
        onClick: async () => updateTopicEntrySortMode(topic.id, 'custom', { entryTab })
      },
      {
        label: currentMode === 'title' ? 'Name ✓' : 'Name',
        onClick: async () => updateTopicEntrySortMode(topic.id, 'title', { entryTab })
      }
    ];

    if (entryTab === 'all') {
      items.splice(1, 0, {
        label: currentMode === 'type' ? 'Typ ✓' : 'Typ',
        onClick: async () => updateTopicEntrySortMode(topic.id, 'type', { entryTab })
      });
      items.push({
        label: currentMode === 'type_then_title' ? 'Typ, dann Name ✓' : 'Typ, dann Name',
        onClick: async () => updateTopicEntrySortMode(topic.id, 'type_then_title', { entryTab })
      });
    }

    openDropdown(items, rect ? {
      anchorX: rect.right - 220,
      anchorY: rect.bottom + 6
    } : {});
  }

  /**
   * Sort entries for a topic according to the persisted topic sort mode.
   *
   * @param {Array<object>} entries Topic entries.
   * @param {object|null|undefined} topic Topic record.
   * @returns {Array<object>} Sorted entries.
   */
  function sortEntriesForTopic(entries, topic) {
    const mode = getTopicEntrySortMode(topic);
    const list = Array.isArray(entries) ? [...entries] : [];
    const pinned = list.filter((item) => !!item?.pinned);
    const sortable = list.filter((item) => !item?.pinned);
    if (mode === 'custom') return pinned.concat(sortable);

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const byDisplayName = (a, b) => {
      const nameA = getEntryDisplayTitle(a);
      const nameB = getEntryDisplayTitle(b);
      const cmp = collator.compare(nameA, nameB);
      if (cmp !== 0) return cmp;
      return String(a.id || '').localeCompare(String(b.id || ''));
    };

    sortable.sort((a, b) => {
      if (mode === 'title') return byDisplayName(a, b);
      const typeCmp = getEntryTypeRank(a.type) - getEntryTypeRank(b.type);
      if (typeCmp !== 0) return typeCmp;
      if (mode === 'type_then_title') return byDisplayName(a, b);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    return pinned.concat(sortable);
  }

  /**
   * Collect text fragments used for entry indexing and search matching.
   *
   * @param {object} entry Entry record.
   * @returns {Array<string|undefined>} Searchable text fragments.
   */
  function collectEntrySearchParts(entry) {
    return [
      entry.title,
      entry.url,
      entry.excerpt,
      entry.note,
      entry.sourcePageTitle,
      entry.sourcePageUrl,
      entry.linkText,
      ...normalizeTodoItems(entry.todos).map((item) => item.text)
    ];
  }

  /**
   * Create the interactive todo editor used in create/edit entry dialogs.
   *
   * @param {Array<object>} [initialItems=[]] Initial todo items.
   * @returns {{ root: HTMLElement, getItems: () => Array<object>, focusFirstInput: () => void }} Todo editor API.
   */
  function createTodoEditor(initialItems = []) {
    let items = normalizeTodoItems(initialItems);
    const list = el('div', { class: 'todo-editor__list' });

    const renderItems = () => {
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el('div', { class: 'subtle' }, ['Noch keine Punkte.']));
        return;
      }
      for (const item of items) {
        const row = el('div', { class: 'todo-editor__item' });
        const check = el('input', { type: 'checkbox', checked: item.done });
        const textInput = el('input', {
          class: 'input todo-editor__text',
          type: 'text',
          value: item.text,
          placeholder: 'Todo-Punkt'
        });
        const deleteBtn = el('button', { class: 'btn btn--xs btn--icon btn--quiet-danger', type: 'button', title: 'Punkt löschen', 'aria-label': 'Punkt löschen' }, ['✕']);

        check.addEventListener('change', () => {
          item.done = check.checked;
        });
        textInput.addEventListener('input', () => {
          item.text = textInput.value;
        });
        textInput.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          addItem('', item.id);
        });
        deleteBtn.addEventListener('click', () => {
          items = items.filter((candidate) => candidate.id !== item.id);
          renderItems();
        });

        row.append(check, textInput, deleteBtn);
        list.appendChild(row);
      }
    };

    const addItem = (text = '', afterId = null) => {
      const next = { id: rbDB.uuid(), text: String(text || ''), done: false };
      if (!afterId) items.push(next);
      else {
        const index = items.findIndex((item) => item.id === afterId);
        if (index < 0) items.push(next);
        else items.splice(index + 1, 0, next);
      }
      renderItems();
      const inputs = list.querySelectorAll('.todo-editor__text');
      inputs[inputs.length - 1]?.focus();
    };

    const addBtn = el('button', { class: 'btn', type: 'button', onclick: () => addItem() }, ['+ Punkt']);
    const root = el('div', { class: 'todo-editor' }, [list, el('div', { class: 'todo-editor__actions' }, [addBtn])]);
    renderItems();

    return {
      root,
      getItems: () => normalizeTodoItems(items),
      focusFirst() {
        const firstInput = list.querySelector('.todo-editor__text');
        if (firstInput) {
          firstInput.focus();
          return;
        }
        addItem();
      }
    };
  }

  /**
   * Normalize free-form search input for matching.
   *
   * @param {string} q Raw query.
   * @returns {string} Normalized query string.
   */
  function normalizeQuery(q) {
    return (q ?? '').trim().toLowerCase();
  }

  /**
   * Escape a dynamic string so it can safely be embedded inside a CSS attribute selector.
   *
   * @param {string} value Selector value.
   * @returns {string} Escaped selector fragment.
   */
  function escapeSelectorAttr(value) {
    const raw = String(value ?? '');
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(raw);
    return raw.replace(/["\\]/g, '\\$&');
  }

  /**
   * Check whether an entry matches the active normalized query.
   *
   * @param {object} e Entry record.
   * @param {string} q Normalized query.
   * @returns {boolean} `true` when the entry matches.
   */
  function matchesEntry(e, q) {
    if (!q) return true;
    const hay = collectEntrySearchParts(e).join(' ').toLowerCase();
    return hay.includes(q);
  }

  /**
   * Check whether a topic matches the active normalized query.
   *
   * @param {object} t Topic record.
   * @param {string} q Normalized query.
   * @returns {boolean} `true` when the topic matches.
   */
  function matchesTopic(t, q) {
    if (!q) return true;
    const hay = [t.title, t.description].join(' ').toLowerCase();
    return hay.includes(q);
  }

  /**
   * Invalidate the cached topic-entry search index after topic or entry mutations.
   *
   * @returns {void}
   */
  function markTopicSearchIndexDirty() {
    state.topicEntrySearchIndex.clear();
    state.topicEntrySearchIndexReady = false;
    state.topicEntrySearchIndexPromise = null;
    state.globalSearchQuery = '';
    state.globalSearchResults = [];
    state.globalSearchPromise = null;
  }

  /**
   * Build a ranked search-match descriptor for a single entry.
   *
   * @param {object} entry Entry record.
   * @param {string} q Normalized query.
   * @returns {{ matched: boolean, key?: string, label?: string, value?: string }} Match descriptor.
   */
  function getEntryMatchInfo(entry, q) {
    if (!q) return null;
    const checks = [
      { key: 'title', label: 'Titel', value: entry.title || '' },
      { key: 'excerpt', label: 'Text/Notiz', value: entry.excerpt || '' },
      { key: 'note', label: 'Notiz', value: entry.note || '' },
      { key: 'todos', label: 'Todo', value: normalizeTodoItems(entry.todos).map((item) => item.text).join(' ') },
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

  /**
   * Compute and cache global search results spanning topics and entries.
   *
   * @param {string} q Normalized query.
   * @returns {Promise<void>}
   */
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

      const matchRank = (key) => key === 'title' ? 0 : (key === 'excerpt' ? 1 : (key === 'todos' ? 2 : (key === 'note' ? 3 : 4)));
      results.sort((a, b) => {
        const mr = matchRank(a.match.key) - matchRank(b.match.key);
        if (mr !== 0) return mr;
        const tr = getEntryTypeRank(a.entry.type) - getEntryTypeRank(b.entry.type);
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

  /**
   * Build the lazy topic-entry search index used by global search.
   *
   * @returns {Promise<void>}
   */
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
        const part = normalizeQuery(collectEntrySearchParts(e).join(' '));
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

  /**
   * Load persisted sidebar settings into runtime state.
   *
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    const settings = await ext.storage.local.get({ lastTopicId: null, includeArchived: false, includeArchivedEntries: false });
    state.includeArchived = !!settings.includeArchived;
    state.includeArchivedEntries = !!settings.includeArchivedEntries;
    state.currentTopicId = settings.lastTopicId;
  }

  /**
   * Persist a partial settings update to local storage.
   *
   * @param {object} patch Partial settings object.
   * @returns {Promise<void>}
   */
  async function saveSettings(patch) {
    await ext.storage.local.set(patch);
  }

  /**
   * Reload topic data from IndexedDB and reconcile the current selection.
   *
   * @returns {Promise<void>}
   */
  async function refreshTopics() {
    state.topicsAll = await rbDB.getAllTopics(state.db, { includeArchived: true });
    state.topics = await rbDB.getAllTopics(state.db, { includeArchived: state.includeArchived });
    const allEntries = await rbDB.getAllEntries(state.db);
    const archivedEntryCountByTopic = new Map();
    for (const entry of allEntries) {
      if (!entry?.topicId || !entry?.archived) continue;
      archivedEntryCountByTopic.set(entry.topicId, (archivedEntryCountByTopic.get(entry.topicId) || 0) + 1);
    }
    state.archivedEntryCountByTopic = archivedEntryCountByTopic;
    // If last selected topic is archived and we're not including archived, pick first non-archived.
    const exists = state.topics.some(t => t.id === state.currentTopicId);
    if (!exists) {
      const first = state.topics.find(t => !t.archived) || state.topics[0] || null;
      state.currentTopicId = first?.id ?? null;
      await saveSettings({ lastTopicId: state.currentTopicId });
    }
    markTopicSearchIndexDirty();
  }

  /**
   * Reload entries for the active topic and apply the current topic sort mode.
   *
   * @returns {Promise<void>}
   */
  async function refreshEntries() {
    if (!state.currentTopicId) {
      state.entries = [];
      return;
    }
    const topic = state.topicsAll.find((item) => item.id === state.currentTopicId) || state.topics.find((item) => item.id === state.currentTopicId) || null;
    const rawEntries = await rbDB.getEntriesByTopic(state.db, state.currentTopicId, { includeArchived: true });
    state.entries = sortEntriesForTopic(rawEntries, topic);
  }

  /**
   * Ensure at least one topic exists and migrate legacy Inbox descriptions if needed.
   *
   * @returns {Promise<void>}
   */
  async function ensureDefaultTopic() {
    const legacyInbox = state.topicsAll.find((topic) => (
      topic?.title === 'Inbox' && topic?.description === 'Schnellablage für neue Fundstücke'
    ));
    if (legacyInbox) {
      await rbDB.updateTopic(state.db, legacyInbox.id, { description: '' });
      await refreshTopics();
    }

    if (state.topics.length > 0) return;
    const t = await rbDB.addTopic(state.db, { title: 'Inbox', description: '' });
    state.currentTopicId = t.id;
    await saveSettings({ lastTopicId: t.id });
    await ext.runtime.sendMessage({ type: 'topicsChanged' }).catch(() => {});
    await refreshTopics();
  }

  /**
   * Configure the top bar for the topic overview screen.
   *
   * @returns {void}
   */
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
    updateArchiveToggleButton();
  }

  /**
   * Configure the top bar for a single topic detail screen.
   *
   * @param {object|null|undefined} topic Active topic record.
   * @returns {void}
   */
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
      const hasArchivedEntries = (state.archivedEntryCountByTopic.get(topic?.id) || 0) > 0;
      const label = hasArchivedEntries
        ? (state.includeArchivedEntries ? 'Archivierte Einträge ausblenden' : 'Archivierte Einträge anzeigen')
        : 'Keine archivierten Einträge vorhanden';
      archiveBtn.title = label;
      archiveBtn.setAttribute('aria-label', label);
      archiveBtn.disabled = !hasArchivedEntries;
      archiveBtn.classList.toggle('iconbtn--alert', hasArchivedEntries && !state.includeArchivedEntries);
      const iconNode = archiveBtn.querySelector('.icon');
      if (iconNode) iconNode.textContent = state.includeArchivedEntries ? '🗂' : '🗃';
    }
  }

  /**
   * Refresh the archive toggle button label and accessibility text.
   *
   * @returns {void}
   */
  function updateArchiveToggleButton() {
    const btn = ui.qaArchiveToggleBtn;
    if (!btn) return;
    const hasArchivedTopics = state.topicsAll.some((topic) => !!topic?.archived);
    const label = hasArchivedTopics
      ? (state.includeArchived ? 'Archiv ausblenden' : 'Archiv anzeigen')
      : 'Keine archivierten Themen vorhanden';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.disabled = !hasArchivedTopics;
    btn.classList.toggle('iconbtn--alert', hasArchivedTopics && !state.includeArchived);
    const iconNode = btn.querySelector('.icon');
    if (iconNode) iconNode.textContent = state.includeArchived ? '🗂' : '🗃';
  }

  /**
   * Render an empty-state card.
   *
   * @param {string} message Primary message.
   * @param {string} [hint=''] Optional helper text.
   * @returns {HTMLElement} Empty-state node.
   */
  function renderEmpty(message, hint = '') {
    return el('div', { class: 'card' }, [
      el('div', { class: 'item__title' }, [message]),
      hint ? el('div', { class: 'subtle', style: 'margin-top:6px;' }, [hint]) : null
    ]);
  }

  /**
   * Render the persistent footer actions shown at the bottom of the sidebar.
   *
   * @returns {HTMLElement} Footer node.
   */
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

  /**
   * Open the extension options page using the best available browser API.
   *
   * @returns {Promise<void>}
   */
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
