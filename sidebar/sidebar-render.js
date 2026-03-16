/*
  Sidebar Render

  Responsibilities:
    - render the topic overview
    - render the active topic detail view
    - render the active screen based on current state

  This file should stay focused on translating current application state into DOM.
*/

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
              el('div', { class: 'item__title' }, [getEntryDisplayTitle(e)])
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

  /**
   * Render the active topic detail screen including add actions, tabs, and entry list.
   *
   * @returns {void}
   */
  function renderTopicView() {
    state.view = 'topic';
    const topic = state.topicsAll.find(t => t.id === state.currentTopicId) || state.topics.find(t => t.id === state.currentTopicId);
    const tabs = getAvailableTopicEntryTabs(state.entries);
    if (!tabs.some((tab) => tab.key === state.currentTopicEntryTab)) {
      state.currentTopicEntryTab = 'all';
    }
    const topicSortMode = getEffectiveEntrySortMode(topic, state.currentTopicEntryTab);
    const isCustomOrder = topicSortMode === 'custom';
    setHeaderForTopic(topic);

    const q = normalizeQuery(state.search);
    const entries = getVisibleTopicEntries(state.entries, q, state.currentTopicEntryTab);
    const sortBtn = el('button', {
      class: 'btn btn--icon',
      type: 'button',
      title: `Sortierung: ${getEntrySortLabel(topicSortMode)}`,
      'aria-label': `Sortierung: ${getEntrySortLabel(topicSortMode)}`,
      onclick: (ev) => {
        ev.stopPropagation();
        openTopicSortMenu(topic, ev.currentTarget, { entryTab: state.currentTopicEntryTab });
      }
    }, ['⇅']);

    const tabsBar = tabs.length > 1
      ? el('div', { class: 'topic-tabs', role: 'tablist', 'aria-label': 'Eintragstypen' }, tabs.map((tab) => (
        el('button', {
          class: `topic-tab${tab.key === 'all' ? '' : ` topic-tab--${tab.key}`}${tab.key === state.currentTopicEntryTab ? ' topic-tab--active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': tab.key === state.currentTopicEntryTab ? 'true' : 'false',
          onclick: () => {
            if (state.currentTopicEntryTab === tab.key) return;
            state.currentTopicEntryTab = tab.key;
            renderTopicView();
          }
        }, [tab.label])
      )))
      : null;

    const headerCard = el('div', { class: 'card section topic-detail-header' }, [
      topic?.description ? el('div', { class: 'small', style: 'margin-top:6px;' }, [topic.description]) : null,
      el('div', { class: 'toolbar topic-detail-add-toolbar', style: 'margin-top:10px;' }, [
        el('button', { class: 'btn', onclick: () => addEntryFlow('link') }, ['+ Link']),
        el('button', { class: 'btn', onclick: addCurrentPageFlow }, ['+ Aktuelle Seite']),
        el('button', { class: 'btn', onclick: () => addEntryFlow('note') }, ['+ Notiz']),
        el('button', { class: 'btn', onclick: () => addEntryFlow('todo') }, ['+ Todo']),
        sortBtn
      ]),
      el('div', { class: 'dropzone', id: 'dropzone', style: 'margin-top:10px;' }, ['Drop here'])
    ]);

    const list = el('div', { class: `list${tabsBar ? ' list--tabbed' : ''}`, id: 'entriesList' });

    if (entries.length === 0) {
      const emptyText = state.entries.length === 0
        ? 'Nutze „Link“, „Aktuelle Seite“, „Textauszug“ oder „Notiz“, um den ersten Eintrag anzulegen.'
        : 'Keine Einträge für den gewählten Tab gefunden.';
      list.appendChild(el('div', { class: 'subtle' }, [emptyText]));
    } else {
      for (const e of entries) {
        const isLink = e.type === 'link';
        const isTodo = e.type === 'todo';
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
          draggable: isCustomOrder ? 'true' : 'false',
          dataset: { id: e.id, kind: 'entry' }
        }, [
          el('div', { class: 'item__hover-tools' }, [
            actions
          ]),
          el('div', { class: 'item__row' }, [
            el('span', { class: 'item__badge-wrap' }, [
              entryBadge(e.type)
            ]),
            el('div', { class: 'item__title' }, [getEntryDisplayTitle(e)]),
            isTodo ? el('div', { class: 'item__meta' }, [getTodoSummary(e)]) : null
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
          if (!isCustomOrder) {
            ev.preventDefault();
            return;
          }
          closeDropdown();
          state.drag = { type: 'entry', id: e.id };
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', e.id);
        });
        node.addEventListener('dragend', () => {
          state.drag = { type: null, id: null };
        });

        node.addEventListener('dragover', (ev) => {
          if (!isCustomOrder) return;
          if (state.drag.type !== 'entry') return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
        });

        node.addEventListener('drop', async (ev) => {
          if (!isCustomOrder) return;
          if (state.drag.type !== 'entry') return;
          ev.preventDefault();
          const draggedId = state.drag.id;
          const targetId = e.id;
          if (!draggedId || draggedId === targetId) return;

          const visible = getVisibleTopicEntries(state.entries, q, state.currentTopicEntryTab);
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
    if (tabsBar) ui.main.appendChild(tabsBar);
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

  /**
   * Render whichever sidebar view is currently active.
   *
   * @returns {Promise<void>}
   */
  async function render() {
    closeDropdown();
    if (state.view === 'topic') {
      await refreshEntries();
      renderTopicView();
    } else {
      renderTopicsView();
    }
  }

  /**
   * Open a topic detail view and optionally focus or open a specific entry.
   *
   * @param {string} topicId Topic identifier.
   * @param {{ preserveSearch?: boolean, focusEntryId?: string|null, openEntryId?: string|null }} [options={}] Open behavior.
   * @returns {Promise<void>}
   */
