/*
  Sidebar Init

  Responsibilities:
    - bind persistent event listeners
    - react to runtime and storage messages
    - bootstrap the sidebar on first load

  This file is the composition root for the sidebar runtime.
*/

  // Wire static UI controls once; dynamic list items attach their handlers during render.
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
    if (ui.qaArchiveToggleBtn.disabled) return;
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

  ui.qaTopicArchiveBtn?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!state.currentTopicId) return;
    if (ui.qaTopicArchiveBtn.disabled) return;
    state.includeArchivedEntries = !state.includeArchivedEntries;
    await saveSettings({ includeArchivedEntries: state.includeArchivedEntries });
    renderTopicView();
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

  /**
   * Open the item context menu via keyboard (Context Menu key / Shift+F10).
   *
   * Priority:
   * 1) currently keyboard-active list item
   * 2) currently focused element inside a list item
   * 3) first navigable list item
   *
   * @returns {boolean} `true` when a context menu target was found and triggered.
   */
  let suppressNativeContextMenuUntil = 0;

  function openKeyboardContextMenu() {
    let node = document.querySelector('.item--kbd-active');
    if (!node) {
      node = document.activeElement?.closest?.('.item') || null;
    }
    if (!node) {
      const nodes = getNavigableNodes();
      if (nodes.length) {
        setKbdActiveIndex(0);
        node = nodes[0];
      }
    }
    if (!node) return false;
    suppressNativeContextMenuUntil = Date.now() + 500;
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + Math.max(8, Math.min(24, rect.width - 8)));
    const y = Math.round(rect.top + Math.max(8, Math.min(20, rect.height - 8)));
    node.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y
    }));
    setTimeout(() => {
      const firstItem = ui.dropdown.querySelector('.dropitem');
      if (firstItem && typeof firstItem.focus === 'function') {
        for (const item of ui.dropdown.querySelectorAll('.dropitem')) {
          item.setAttribute('tabindex', item === firstItem ? '0' : '-1');
        }
        firstItem.focus();
      }
    }, 0);
    return true;
  }

  // Prevent the browser's native menu right after keyboard-triggered context-menu requests.
  // Our synthetic contextmenu event (isTrusted=false) still reaches the item handlers.
  document.addEventListener('contextmenu', (ev) => {
    if (Date.now() > suppressNativeContextMenuUntil) return;
    if (!ev.isTrusted) return;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);

  document.addEventListener('keydown', (ev) => {
    const isContextMenuKey = ev.key === 'ContextMenu' || ev.code === 'ContextMenu';
    const isShiftF10 = ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === 'F10';
    if (isContextMenuKey || isShiftF10) {
      if (!ui.modalOverlay.classList.contains('hidden')) return;
      ev.preventDefault();
      ev.stopPropagation();
      openKeyboardContextMenu();
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
      if (!ui.modalOverlay.classList.contains('hidden')) return;
      ev.preventDefault();
      ui.searchInput.focus();
      ui.searchInput.select();
      return;
    }

    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      if (!ui.modalOverlay.classList.contains('hidden')) return;
      const active = document.activeElement;
      if (active && document.contains(active) && isEditableTarget(active)) return;
      if (state.view !== 'topic') return;
      const tabs = Array.from(document.querySelectorAll('.topic-tabs .topic-tab'));
      if (tabs.length <= 1) return;
      const current = tabs.findIndex((node) => node.getAttribute('aria-selected') === 'true');
      if (current < 0) return;
      ev.preventDefault();
      const delta = ev.key === 'ArrowRight' ? 1 : -1;
      const next = (current + delta + tabs.length) % tabs.length;
      const nextTab = tabs[next];
      nextTab?.click();
      nextTab?.focus();
      return;
    }

    if (ev.key === 'Escape') {
      if (!ui.dropdown.classList.contains('hidden')) {
        closeDropdown();
        return;
      }
      if (!ui.modalOverlay.classList.contains('hidden')) {
        closeModal();
        setTimeout(() => {
          if (state.view !== 'topic') return;
          const activeTab = document.querySelector('.topic-tabs .topic-tab[aria-selected="true"]');
          if (activeTab && typeof activeTab.focus === 'function') {
            activeTab.focus();
          }
        }, 0);
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

  document.addEventListener('keyup', (ev) => {
    const isContextMenuKey = ev.key === 'ContextMenu' || ev.code === 'ContextMenu';
    const isShiftF10 = ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === 'F10';
    if (!(isContextMenuKey || isShiftF10)) return;
    if (!ui.modalOverlay.classList.contains('hidden')) return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  // React to background-originated messages that can arrive while the sidebar stays open.
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

  /**
   * Bootstrap the sidebar runtime by loading theme, database, settings, topics,
   * and deferred capture state before the first render.
   *
   * @returns {Promise<void>}
   */
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
