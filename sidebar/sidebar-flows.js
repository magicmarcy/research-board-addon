/*
  Sidebar Flows

  Responsibilities:
    - topic create/edit/archive/delete flows
    - entry create/edit/move/delete flows
    - import/export helpers
    - drag-and-drop conversion and pending capture assignment
    - modal-driven user workflows

  This file owns higher-level user actions that mutate data or open dialogs.
*/

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
    if (focusEntryId || openEntryId) {
      const targetEntryId = focusEntryId || openEntryId;
      const targetEntry = state.entries.find((entry) => entry.id === targetEntryId) || null;
      state.currentTopicEntryTab = targetEntry?.type || 'all';
    } else {
      state.currentTopicEntryTab = 'all';
    }
    renderTopicView();
  }

  /**
   * Return from topic detail view to the topic overview.
   *
   * @returns {void}
   */
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

  /**
   * Open the create-topic flow and persist a new topic after confirmation.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Open the edit-topic flow for an existing topic.
   *
   * @param {string} topicId Topic identifier.
   * @returns {Promise<void>}
   */
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

  /**
   * Archive or restore a topic.
   *
   * @param {string} topicId Topic identifier.
   * @param {boolean} archived Target archive state.
   * @returns {Promise<void>}
   */
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

  /**
   * Confirm and delete a topic through the undo-enabled delete flow.
   *
   * @param {string} topicId Topic identifier.
   * @returns {Promise<void>}
   */
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

  /**
   * Move an entry from its current topic into another topic selected by the user.
   *
   * @param {string} entryId Entry identifier.
   * @returns {Promise<void>}
   */
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
      el('div', { class: 'item__title', style: 'margin-top:6px;' }, [getEntryDisplayTitle(entry)]),
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

  /**
   * Open the create-entry flow for a specific entry type.
   *
   * @param {string} type Entry type to create.
   * @param {object} [preset={}] Preset values used to seed the form.
   * @returns {Promise<void>}
   */
  async function addEntryFlow(type, preset = {}) {
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    if (!topic) return;

    let titleInput = null;
    let urlInput = null;
    let excerptInput = null;
    let todoEditor = null;
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
    } else if (type === 'todo') {
      titleInput = el('input', { class: 'input', placeholder: 'Titel (optional)', value: preset.title || '' });
      todoEditor = createTodoEditor(preset.todos || []);
      fields.push(
        el('div', { class: 'field' }, [el('div', { class: 'label' }, ['Titel (optional)']), titleInput]),
        el('div', { class: 'field', style: 'margin-top:10px;' }, [el('div', { class: 'label' }, ['Todo-Liste']), todoEditor.root])
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
          todos: type === 'todo' ? todoEditor?.getItems() || [] : [],
          sourcePageTitle: preset.sourcePageTitle || '',
          sourcePageUrl: preset.sourcePageUrl || ''
        };

        // Light auto title
        if (!entry.title) {
          if (type === 'link') entry.title = entry.url;
          if (type === 'quote') entry.title = (entry.excerpt || '').slice(0, 60);
          if (type === 'note') entry.title = (entry.excerpt || '').slice(0, 60);
          if (type === 'todo') entry.title = entry.todos[0]?.text || 'Todo-Liste';
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

    const title = type === 'link' ? 'Neuer Link' : type === 'quote' ? 'Neuer Textauszug' : type === 'todo' ? 'Neue Todo-Liste' : 'Neue Notiz';
    openModal({ title, body, footer });

    setTimeout(() => {
      if (urlInput) urlInput.focus();
      else if (excerptInput) excerptInput.focus();
      else if (todoEditor) todoEditor.focusFirst();
      else titleInput?.focus();
    }, 50);
  }

  /**
   * Add the currently active page to the current topic through the background convenience API.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Open the edit dialog for an existing entry.
   *
   * @param {object} entry Entry record.
   * @returns {Promise<void>}
   */
  async function openEntry(entry) {
    const urlInput = el('input', { class: 'input mono', value: entry.url || '', placeholder: '(keine URL)' });
    const titleInput = el('input', { class: 'input', value: entry.title || '' });
    const excerptInput = el('textarea', { class: 'textarea', value: entry.excerpt || '' });
    const noteInput = el('textarea', { class: 'textarea', value: entry.note || '' });
    const todoEditor = entry.type === 'todo' ? createTodoEditor(entry.todos || []) : null;
    const sourceUrl = String(entry.sourcePageUrl || '').trim();

    const copySourceUrl = async () => {
      if (!sourceUrl) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(sourceUrl);
          toast('Quell-URL kopiert');
          return;
        }
        throw new Error('clipboard api unavailable');
      } catch (error) {
        try {
          const ta = el('textarea', { value: sourceUrl });
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.top = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const copied = document.execCommand('copy');
          ta.remove();
          if (!copied) throw new Error('execCommand copy failed');
          toast('Quell-URL kopiert');
        } catch (fallbackError) {
          console.error('copy source url failed', error, fallbackError);
          toast('Quell-URL konnte nicht kopiert werden');
        }
      }
    };

    const body = el('div', {}, [
      el('div', { class: 'entry-meta' }, [
        el('div', { class: 'entry-meta__item entry-meta__item--badge' }, [entryBadge(entry.type)]),
        el('div', { class: 'entry-meta__dates' }, [
          el('div', { class: 'entry-meta__item', title: 'Erstellt' }, [
            el('span', { class: 'entry-meta__icon', 'aria-hidden': 'true' }, ['◷']),
            el('span', { class: 'small' }, [formatDate(entry.createdAt)])
          ]),
          el('div', { class: 'entry-meta__item', title: 'Aktualisiert' }, [
            el('span', { class: 'entry-meta__icon', 'aria-hidden': 'true' }, ['↻']),
            el('span', { class: 'small' }, [formatDate(entry.updatedAt || entry.createdAt)])
          ])
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

      (entry.type !== 'link' && entry.type !== 'todo')
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, [entry.type === 'quote' ? 'Textauszug' : 'Notiztext']),
            makeZoomableTextarea(excerptInput, entry.type === 'quote' ? 'Textauszug bearbeiten' : 'Notiz bearbeiten')
          ])
        : null,

      entry.type === 'todo'
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, ['Todo-Liste']),
            todoEditor.root
          ])
        : null,

      entry.type === 'link'
        ? el('div', { class: 'field', style: 'margin-top:10px;' }, [
            el('div', { class: 'label' }, ['Optionale Notiz']),
            makeZoomableTextarea(noteInput, 'Notiz bearbeiten')
          ])
        : null,

      (sourceUrl || entry.sourcePageTitle) ? el('div', { class: 'card source-card', style: 'margin-top:12px; background: color-mix(in oklab, var(--surface) 75%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Quelle']),
        entry.sourcePageTitle ? el('div', { class: 'small' }, [entry.sourcePageTitle]) : null,
        sourceUrl ? el('div', { class: 'small mono source-card__url', title: sourceUrl }, [sourceUrl]) : null,
        sourceUrl ? el('div', { class: 'actions source-card__actions' }, [
          el('button', { class: 'btn btn--xs', onclick: async () => {
            await ext.runtime.sendMessage({ type: 'openUrlInTab', url: sourceUrl }).catch(() => {});
          } }, ['Quelle öffnen']),
          el('button', { class: 'btn btn--xs btn--quiet', onclick: copySourceUrl }, ['URL kopieren'])
        ]) : null
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
            excerpt: (entry.type !== 'link' && entry.type !== 'todo') ? excerptInput.value.trim() : entry.excerpt,
            note: entry.type === 'link' ? noteInput.value.trim() : entry.note,
            todos: entry.type === 'todo' ? todoEditor.getItems() : entry.todos
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

  /**
   * Show a compact modal that lets the user jump directly to another topic.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Download a JSON object as a local file.
   *
   * @param {string} filename Target file name.
   * @param {object} obj JSON-serializable payload.
   * @returns {void}
   */
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

  /**
   * Generate a compact timestamp string used in export file names.
   *
   * @returns {string} Timestamp in `YYYYMMDD-HHMMSS` format.
   */
  function ymdhms() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /**
   * Export the full application dataset and settings as JSON.
   *
   * @returns {Promise<void>}
   */
  async function exportAllFlow() {
    const data = await rbDB.exportAll(state.db);
    downloadJson(`research-board-backup-${ymdhms()}.json`, data);
    toast('Export erstellt');
  }

  /**
   * Export the currently selected topic and its entries as JSON.
   *
   * @returns {Promise<void>}
   */
  async function exportTopicFlow() {
    const topic = state.topics.find(t => t.id === state.currentTopicId);
    if (!topic) return;
    const data = await rbDB.exportTopic(state.db, state.currentTopicId);
    downloadJson(`research-board-topic-${topic.title.replace(/[^a-z0-9\-_]+/gi,'_').slice(0,40)}-${ymdhms()}.json`, data);
    toast('Thema exportiert');
  }

  /**
   * Open the import flow and let the user merge or replace local data from a JSON file.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Build a human-readable summary of an import payload.
   *
   * @param {object} obj Parsed import payload.
   * @returns {string} Summary string.
   */
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

  /**
   * Apply imported data in either replace or merge mode.
   *
   * @param {object} obj Parsed import payload.
   * @param {'replace'|'merge'} mode Import mode.
   * @param {{ importSettings?: boolean }} [options={}] Settings import behavior.
   * @returns {Promise<void>}
   */
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

  /**
   * Insert topics and entries in a single IndexedDB transaction.
   *
   * @param {Array<object>} topics Topic records.
   * @param {Array<object>} entries Entry records.
   * @param {{ keepIds: boolean }} options Insert behavior.
   * @returns {Promise<void>}
   */
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

  /**
   * Extract the first usable URL from a `text/uri-list` payload.
   *
   * @param {string} text Raw URI list payload.
   * @returns {string} First usable URL, if any.
   */
  function parseUriList(text) {
    const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.startsWith('#')) continue;
      return l;
    }
    return '';
  }

  /**
   * Check whether plain text resembles an HTTP(S) URL.
   *
   * @param {string} s Source text.
   * @returns {boolean} `true` when the text looks like a URL.
   */
  function looksLikeUrl(s) {
    if (!s) return false;
    const t = s.trim();
    return t.startsWith('http://') || t.startsWith('https://') || t.startsWith('www.');
  }

  /**
   * Coerce plain `www.` text into an absolute HTTPS URL.
   *
   * @param {string} s Source text.
   * @returns {string} URL-like string.
   */
  function coerceUrl(s) {
    const t = (s || '').trim();
    if (t.startsWith('www.')) return 'https://' + t;
    return t;
  }

  /**
   * Parse Firefox's `text/x-moz-url` drag payload into URL and title parts.
   *
   * @param {string} text Raw Firefox drag payload.
   * @returns {{ url: string, title: string }} Parsed payload.
   */
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

  /**
   * Check whether a drag payload can be converted into a sidebar entry.
   *
   * @param {DataTransfer|null|undefined} dt Drag payload.
   * @returns {boolean} `true` when the payload contains supported formats.
   */
  function hasDropEntryPayload(dt) {
    if (!dt) return false;
    const types = dt.types || [];
    return types.includes('text/uri-list') || types.includes('text/x-moz-url') || types.includes('text/plain');
  }

  /**
   * Convert supported drag payload data into a sidebar entry candidate.
   *
   * @param {DataTransfer|null|undefined} dt Drag payload.
   * @returns {object|null} Entry candidate, or `null` when the payload is unsupported.
   */
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

  /**
   * Persist an entry created from a drag-and-drop payload.
   *
   * @param {DragEvent} ev Drop event.
   * @param {string} [topicId=state.currentTopicId] Target topic identifier.
   * @returns {Promise<object|null>} Created entry, if the payload was supported.
   */
  async function addEntryFromDrop(ev, topicId = state.currentTopicId) {
    const entry = buildEntryFromDropData(ev.dataTransfer);
    if (!entry) return null;
    const created = await rbDB.addEntry(state.db, topicId, entry);
    markTopicSearchIndexDirty();
    return created;
  }

  /**
   * Query the background script for a pending capture and, if present, prompt the
   * user to assign it to an existing or newly created topic.
   *
   * @returns {Promise<void>}
   */
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

  /**
   * Build the visual preview shown before assigning a pending capture to a topic.
   *
   * @param {object} pending Pending capture payload.
   * @returns {HTMLElement} Preview node.
   */
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

  /**
   * Show the sidebar help/overview modal.
   *
   * @returns {void}
   */
  function showHelpModal() {
    const body = el('div', {}, [
      el('div', { class: 'label' }, ['Research Board - Kurzüberblick']),
      el('div', { class: 'subtle', style: 'margin-top:6px;' }, [
        'Mit der Sidebar sammelst und organisierst du Links, Textauszüge, Notizen und Todos in Themen.'
      ]),

      el('div', { class: 'card', style: 'margin-top:12px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Themen & Einträge']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Themen anlegen, sortieren, archivieren und löschen.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Einträge je Thema als Link, Textauszug, Notiz oder Todo speichern.'])
      ]),

      el('div', { class: 'card', style: 'margin-top:10px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Ansicht & Sortierung']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Innerhalb eines Themas kannst du Einträge sortieren und bei mehreren Typen über Tabs filtern.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Der Tab „Alle“ zeigt immer alles, weitere Tabs erscheinen nur bei vorhandenen Einträgen.'])
      ]),

      el('div', { class: 'card', style: 'margin-top:10px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Suchen & Navigation']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Suche findet Themen und Inhalte aus den Einträgen.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Mit Pfeiltasten navigieren, mit Enter öffnen, mit Escape zurück.'])
      ]),

      el('div', { class: 'card', style: 'margin-top:10px; background: color-mix(in oklab, var(--surface) 78%, var(--bg));' }, [
        el('div', { class: 'label' }, ['Import, Export & Sicherheit']),
        el('div', { class: 'small', style: 'margin-top:6px;' }, ['Komplette Daten oder einzelne Themen exportieren/importieren.']),
        el('div', { class: 'small', style: 'margin-top:4px;' }, ['Auto-Backups, Rückgängig-Optionen und Sicherheits-Backups vor Wiederherstellungen helfen beim Schutz deiner Daten.'])
      ])
    ]);

    const footer = el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn--primary', onclick: closeModal }, ['Verstanden'])
    ]);

    openModal({ title: 'Hilfe', body, footer });
  }

  /**
   * Show the destructive reset modal used to wipe all local sidebar data.
   *
   * @returns {Promise<void>}
   */
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

