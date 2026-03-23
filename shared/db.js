/*
  Research Board DB (IndexedDB)
  Stores:
    - topics: { id, title, description?, color?, createdAt, updatedAt, archived, highlighted?, pinned?, position }
    - entries: { id, topicId, type, title?, url?, sourcePageTitle?, sourcePageUrl?, linkText?, excerpt?, note?, todos?, archived?, highlighted?, pinned?, createdAt, updatedAt, position }
    - backups: { id, createdAt, reason, signature, snapshot }
*/

(() => {
  /**
   * Shared IndexedDB and persistence helper for Research Board.
   *
   * This module is the canonical data-access layer for the addon. It encapsulates:
   * - database opening and schema creation
   * - CRUD operations for topics, entries, and backups
   * - ordering helpers for topics and entries
   * - application-level import/export helpers
   * - storage-backed change-token signaling used by other extension contexts
   *
   * The goal is to keep all persistence rules in one place so sidebar, background,
   * and options code can stay focused on UI and orchestration rather than IndexedDB
   * details. Functions in this file are therefore intentionally explicit even when
   * they are somewhat verbose.
   */
  const DB_NAME = 'research_board_db';
  const DB_VERSION = 4;
  const MIN_POSITION = 0;
  const MAX_POSITION = Number.MAX_SAFE_INTEGER;
  const CHANGE_STATE_KEYS = {
    token: 'rbDataChangeToken',
    changedAt: 'rbDataLastChangedAt',
    signal: 'rbDataChangeSignal'
  };
  const APP_SETTINGS_KEYS = {
    lastTopicId: 'lastTopicId',
    includeArchived: 'includeArchived',
    includeArchivedEntries: 'includeArchivedEntries',
    themeMode: 'themeMode',
    autoBackupConfig: 'rbAutoBackupConfig',
    urlTransformConfig: 'urlTransformConfig'
  };
  const APP_SETTINGS_DEFAULTS = {
    [APP_SETTINGS_KEYS.lastTopicId]: null,
    [APP_SETTINGS_KEYS.includeArchived]: false,
    [APP_SETTINGS_KEYS.includeArchivedEntries]: false,
    [APP_SETTINGS_KEYS.themeMode]: 'light',
    [APP_SETTINGS_KEYS.autoBackupConfig]: {
      enabled: true,
      intervalMinutes: 60
    },
    [APP_SETTINGS_KEYS.urlTransformConfig]: {
      enabled: false,
      sourceUrlPattern: '',
      titleIdRegex: '#(\\d+)',
      targetUrlTemplate: '',
      idPlaceholder: '{value}'
    }
  };

  /**
   * Return the current timestamp in ISO format.
   *
   * @returns {string} ISO timestamp.
   */
  const nowIso = () => new Date().toISOString();

  /**
   * Normalize todo items into the persisted internal representation.
   *
   * @param {Array<object>|undefined|null} items Raw todo items.
   * @returns {Array<{ id: string, text: string, done: boolean }>} Normalized todo items.
   */
  function normalizeTodoItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item, index) => ({
        id: item?.id || `todo-${index + 1}`,
        text: String(item?.text || '').trim(),
        done: !!item?.done
      }))
      .filter((item) => item.text);
  }

  /**
   * Generate a local identifier for topics, entries, and backups.
   *
   * @returns {string} Identifier string.
   */
  const uuid = () => {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch (_) {}
    // Fallback: not cryptographically strong, but sufficient for local-only records.
    return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
  };

  /**
   * Open the IndexedDB database and create stores/indexes during schema upgrades.
   *
   * @returns {Promise<IDBDatabase>} Open IndexedDB database connection.
   */
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        const oldVersion = Number(event.oldVersion || 0);

        if (!db.objectStoreNames.contains('topics')) {
          const topics = db.createObjectStore('topics', { keyPath: 'id' });
          topics.createIndex('by_position', 'position', { unique: false });
          topics.createIndex('by_updatedAt', 'updatedAt', { unique: false });
          topics.createIndex('by_archived_position', ['archived', 'position'], { unique: false });
          topics.createIndex('by_title', 'title', { unique: false });
        }

        if (!db.objectStoreNames.contains('entries')) {
          const entries = db.createObjectStore('entries', { keyPath: 'id' });
          entries.createIndex('by_topic', 'topicId', { unique: false });
          entries.createIndex('by_topic_position', ['topicId', 'position'], { unique: false });
          entries.createIndex('by_topic_archived_position', ['topicId', 'archived', 'position'], { unique: false });
          entries.createIndex('by_updatedAt', 'updatedAt', { unique: false });
          entries.createIndex('by_type', 'type', { unique: false });
          entries.createIndex('by_url', 'url', { unique: false });
        } else if (oldVersion < 4 && tx) {
          const entries = tx.objectStore('entries');
          if (!entries.indexNames.contains('by_topic_archived_position')) {
            entries.createIndex('by_topic_archived_position', ['topicId', 'archived', 'position'], { unique: false });
          }

          entries.openCursor().onsuccess = (cursorEvent) => {
            const cur = cursorEvent.target.result;
            if (!cur) return;
            const value = cur.value || {};
            let changed = false;
            if (typeof value.archived !== 'boolean') {
              value.archived = !!value.archived;
              changed = true;
            }
            if (changed) cur.update(value);
            cur.continue();
          };
        }

        if (!db.objectStoreNames.contains('backups')) {
          const backups = db.createObjectStore('backups', { keyPath: 'id' });
          backups.createIndex('by_createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Execute work inside a transaction and resolve when the transaction completes.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string[]} stores Object store names.
   * @param {'readonly'|'readwrite'} mode Transaction mode.
   * @param {(tx: IDBTransaction) => void} fn Transaction body.
   * @returns {Promise<void>}
   */
  function withTx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      fn(tx);
    });
  }

  /**
   * Convert an IndexedDB request into a promise.
   *
   * @template T
   * @param {IDBRequest<T>} req IndexedDB request.
   * @returns {Promise<T>} Request result.
   */
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Update the storage-backed data change token used by other extension contexts.
   *
   * @returns {Promise<{ token: string, changedAt: string }>} New change-state snapshot.
   */
  async function touchChangeToken() {
    const token = uuid();
    const changedAt = nowIso();
    try {
      await ext.storage.local.set({
        [CHANGE_STATE_KEYS.token]: token,
        [CHANGE_STATE_KEYS.changedAt]: changedAt,
        [CHANGE_STATE_KEYS.signal]: Date.now()
      });
    } catch (error) {
      console.error('Failed to touch change token', error);
    }
    return { token, changedAt };
  }

  /**
   * Read the current data change token from extension storage.
   *
   * @returns {Promise<{ token: string, changedAt: string }>} Current change-state snapshot.
   */
  async function getChangeState() {
    const values = await ext.storage.local.get({
      [CHANGE_STATE_KEYS.token]: '',
      [CHANGE_STATE_KEYS.changedAt]: ''
    });
    return {
      token: String(values?.[CHANGE_STATE_KEYS.token] || ''),
      changedAt: String(values?.[CHANGE_STATE_KEYS.changedAt] || '')
    };
  }

  /**
   * Detect IndexedDB data errors that can happen with old or inconsistent local data.
   *
   * @param {any} error Error object.
   * @returns {boolean} `true` when the error should trigger a fallback path.
   */
  function isDataError(error) {
    if (!error) return false;
    if (error.name === 'DataError') return true;
    const msg = String(error.message || error);
    return /does not meet requirements|Data provided/i.test(msg);
  }

  /**
   * Fallback topic loader that uses `getAll()` and client-side sorting when an index lookup fails.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {boolean} includeArchived Whether archived topics should be included.
   * @returns {Promise<object[]>} Topic list.
   */
  async function getAllTopicsFallback(db, includeArchived) {
    const tx = db.transaction(['topics'], 'readonly');
    const store = tx.objectStore('topics');
    const all = await reqToPromise(store.getAll());
    return all
      .filter((t) => includeArchived ? true : !t?.archived)
      .sort((a, b) => {
        if (!!a?.archived !== !!b?.archived) return (a?.archived ? 1 : 0) - (b?.archived ? 1 : 0);
        const ap = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
        const bp = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
      });
  }

  /**
   * Fallback entry loader that uses `getAll()` and client-side sorting when an index lookup fails.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Topic identifier.
   * @returns {Promise<object[]>} Entry list for the topic.
   */
  async function getEntriesByTopicFallback(db, topicId, includeArchived = false) {
    if (!topicId) return [];
    const tx = db.transaction(['entries'], 'readonly');
    const store = tx.objectStore('entries');
    const all = await reqToPromise(store.getAll());
    return all
      .filter((e) => e?.topicId === topicId && (includeArchived ? true : !e?.archived))
      .sort((a, b) => {
        if (!!a?.archived !== !!b?.archived) return (a?.archived ? 1 : 0) - (b?.archived ? 1 : 0);
        const ap = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
        const bp = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''));
      });
  }

  /**
   * Compute the next topic position within either the active or archived topic bucket.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {boolean} [archived=false] Target archive bucket.
   * @returns {Promise<number>} Next position value.
   */
  async function getNextTopicPosition(db, archived = false) {
    try {
      const tx = db.transaction(['topics'], 'readonly');
      const store = tx.objectStore('topics');
      const idx = store.index('by_archived_position');
      const range = IDBKeyRange.bound([!!archived, MIN_POSITION], [!!archived, MAX_POSITION]);

      return await new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(range, 'prev');
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur) {
            resolve(1);
            return;
          }
          const pos = Number.isFinite(cur.value?.position) ? cur.value.position : 0;
          resolve(pos + 1);
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    } catch (error) {
      if (!isDataError(error)) throw error;
      const topics = await getAllTopicsFallback(db, true);
      let maxPos = 0;
      for (const t of topics) {
        if (!!t?.archived !== !!archived) continue;
        if (Number.isFinite(t?.position) && t.position > maxPos) maxPos = t.position;
      }
      return maxPos + 1;
    }
  }

  /**
   * Compute the next entry position inside a topic.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Topic identifier.
   * @returns {Promise<number>} Next position value.
   */
  async function getNextEntryPosition(db, topicId, archived = false) {
    if (!topicId) return 1;
    try {
      const tx = db.transaction(['entries'], 'readonly');
      const store = tx.objectStore('entries');
      const idx = store.index('by_topic_archived_position');
      const range = IDBKeyRange.bound([topicId, !!archived, MIN_POSITION], [topicId, !!archived, MAX_POSITION]);

      return await new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(range, 'prev');
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur) {
            resolve(1);
            return;
          }
          const pos = Number.isFinite(cur.value?.position) ? cur.value.position : 0;
          resolve(pos + 1);
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    } catch (error) {
      if (!isDataError(error)) throw error;
      const entries = await getEntriesByTopicFallback(db, topicId, true);
      const bucketEntries = entries.filter((entry) => !!entry?.archived === !!archived);
      const last = bucketEntries[bucketEntries.length - 1];
      const lastPos = Number.isFinite(last?.position) ? last.position : 0;
      return lastPos + 1;
    }
  }

  /**
   * Load all topics in persisted order.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {{ includeArchived?: boolean }} [options={}] Query options.
   * @returns {Promise<object[]>} Topic list.
   */
  async function getAllTopics(db, { includeArchived = false } = {}) {
    try {
      const tx = db.transaction(['topics'], 'readonly');
      const store = tx.objectStore('topics');
      const idx = store.index('by_archived_position');
      const archivedVals = includeArchived ? [false, true] : [false];
      const results = [];

      for (const archived of archivedVals) {
        const range = IDBKeyRange.bound([archived, MIN_POSITION], [archived, MAX_POSITION]);
        await new Promise((resolve, reject) => {
          const cursorReq = idx.openCursor(range, 'next');
          cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (!cur) {
              resolve();
              return;
            }
            results.push(cur.value);
            cur.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      }

      return results;
    } catch (error) {
      if (!isDataError(error)) throw error;
      return getAllTopicsFallback(db, includeArchived);
    }
  }

  /**
   * Load a single topic by id.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Topic identifier.
   * @returns {Promise<object|undefined>} Topic record, if found.
   */
  async function getTopic(db, id) {
    const tx = db.transaction(['topics'], 'readonly');
    const store = tx.objectStore('topics');
    return reqToPromise(store.get(id));
  }

  /**
   * Normalize the persisted entry sort mode.
   *
   * @param {string} mode Raw sort mode.
   * @returns {'custom'|'type'|'title'|'type_then_title'} Normalized sort mode.
   */
  function normalizeEntrySortMode(mode) {
    if (mode === 'type') return 'type';
    if (mode === 'title') return 'title';
    if (mode === 'type_then_title') return 'type_then_title';
    return 'custom';
  }

  /**
   * Create and persist a new topic.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {{ title?: string, description?: string, color?: string, entrySortMode?: string, highlighted?: boolean, pinned?: boolean }} [topicInput={}] Topic input.
   * @returns {Promise<object>} Created topic record.
   */
  async function addTopic(db, { title, description = '', color = '', entrySortMode = 'custom', highlighted = false, pinned = false } = {}) {
    const createdAt = nowIso();
    const topic = {
      id: uuid(),
      title: (title ?? 'Neues Thema').trim() || 'Neues Thema',
      description: description ?? '',
      color: color ?? '',
      entrySortMode: normalizeEntrySortMode(entrySortMode),
      archived: false,
      highlighted: !!highlighted,
      pinned: !!pinned,
      createdAt,
      updatedAt: createdAt,
      position: await getNextTopicPosition(db, false)
    };

    await withTx(db, ['topics'], 'readwrite', (tx) => {
      tx.objectStore('topics').add(topic);
    });
    await touchChangeToken();

    return topic;
  }

  /**
   * Update a topic record.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Topic identifier.
   * @param {object} patch Partial topic update.
   * @returns {Promise<object>} Updated topic record.
   */
  async function updateTopic(db, id, patch) {
    const tx = db.transaction(['topics'], 'readwrite');
    const store = tx.objectStore('topics');
    const cur = await reqToPromise(store.get(id));
    if (!cur) throw new Error('Topic not found');

    const updated = {
      ...cur,
      ...patch,
      entrySortMode: Object.prototype.hasOwnProperty.call(patch || {}, 'entrySortMode')
        ? normalizeEntrySortMode(patch.entrySortMode)
        : normalizeEntrySortMode(cur.entrySortMode),
      highlighted: Object.prototype.hasOwnProperty.call(patch || {}, 'highlighted')
        ? !!patch.highlighted
        : !!cur.highlighted,
      pinned: Object.prototype.hasOwnProperty.call(patch || {}, 'pinned')
        ? !!patch.pinned
        : !!cur.pinned,
      updatedAt: nowIso()
    };

    await reqToPromise(store.put(updated));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();

    return updated;
  }

  /**
   * Delete a topic and all entries assigned to it.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Topic identifier.
   * @returns {Promise<void>}
   */
  async function deleteTopic(db, id) {
    // Delete the topic and its dependent entries in one transaction to avoid orphaned rows.
    const tx = db.transaction(['topics', 'entries'], 'readwrite');
    const topics = tx.objectStore('topics');
    const entries = tx.objectStore('entries');
    const idx = entries.index('by_topic');

    await new Promise((resolve, reject) => {
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          cur.delete();
          cur.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    await reqToPromise(topics.delete(id));

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();
  }

  /**
   * Load all entries for a topic in persisted order.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Topic identifier.
   * @returns {Promise<object[]>} Entry list.
   */
  async function getEntriesByTopic(db, topicId, { includeArchived = false } = {}) {
    if (!topicId) return [];
    try {
      const tx = db.transaction(['entries'], 'readonly');
      const store = tx.objectStore('entries');
      const results = [];
      const idx = store.index('by_topic_archived_position');
      const archivedVals = includeArchived ? [false, true] : [false];
      for (const archived of archivedVals) {
        const range = IDBKeyRange.bound([topicId, archived, MIN_POSITION], [topicId, archived, MAX_POSITION]);
        await new Promise((resolve, reject) => {
          const cursorReq = idx.openCursor(range, 'next');
          cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (!cur) {
              resolve();
              return;
            }
            results.push(cur.value);
            cur.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      }
      return results;
    } catch (error) {
      if (!isDataError(error)) throw error;
      return getEntriesByTopicFallback(db, topicId, includeArchived);
    }
  }

  /**
   * Load all entries across all topics.
   *
   * @param {IDBDatabase} db Open database connection.
   * @returns {Promise<object[]>} Entry list.
   */
  async function getAllEntries(db) {
    const tx = db.transaction(['entries'], 'readonly');
    const store = tx.objectStore('entries');
    return reqToPromise(store.getAll());
  }

  /**
   * Create and persist a new entry inside a topic.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Target topic identifier.
   * @param {object} entryInput Raw entry input.
   * @returns {Promise<object>} Created entry record.
   */
  async function addEntry(db, topicId, entryInput) {
    const createdAt = nowIso();
    const entry = {
      id: uuid(),
      topicId,
      type: entryInput.type,
      title: entryInput.title ?? '',
      url: entryInput.url ?? '',
      sourcePageTitle: entryInput.sourcePageTitle ?? '',
      sourcePageUrl: entryInput.sourcePageUrl ?? '',
      linkText: entryInput.linkText ?? '',
      excerpt: entryInput.excerpt ?? '',
      note: entryInput.note ?? '',
      todos: normalizeTodoItems(entryInput.todos),
      archived: !!entryInput.archived,
      highlighted: !!entryInput.highlighted,
      pinned: !!entryInput.pinned,
      createdAt,
      updatedAt: createdAt,
      position: typeof entryInput.position === 'number' ? entryInput.position : await getNextEntryPosition(db, topicId, !!entryInput.archived)
    };

    await withTx(db, ['entries'], 'readwrite', (tx) => {
      tx.objectStore('entries').add(entry);
    });
    await touchChangeToken();

    return entry;
  }

  /**
   * Update an existing entry.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Entry identifier.
   * @param {object} patch Partial entry update.
   * @returns {Promise<object>} Updated entry record.
   */
  async function updateEntry(db, id, patch) {
    const tx = db.transaction(['entries'], 'readwrite');
    const store = tx.objectStore('entries');
    const cur = await reqToPromise(store.get(id));
    if (!cur) throw new Error('Entry not found');

    const updated = {
      ...cur,
      ...patch,
      todos: Object.prototype.hasOwnProperty.call(patch || {}, 'todos') ? normalizeTodoItems(patch.todos) : normalizeTodoItems(cur.todos),
      archived: Object.prototype.hasOwnProperty.call(patch || {}, 'archived')
        ? !!patch.archived
        : !!cur.archived,
      highlighted: Object.prototype.hasOwnProperty.call(patch || {}, 'highlighted')
        ? !!patch.highlighted
        : !!cur.highlighted,
      pinned: Object.prototype.hasOwnProperty.call(patch || {}, 'pinned')
        ? !!patch.pinned
        : !!cur.pinned,
      updatedAt: nowIso()
    };

    await reqToPromise(store.put(updated));

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();

    return updated;
  }

  /**
   * Archive or restore an entry and move it to the end of the target archive bucket.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Entry identifier.
   * @param {boolean} archived Target archive state.
   * @returns {Promise<object>} Updated entry record.
   */
  async function setEntryArchived(db, id, archived) {
    const txRead = db.transaction(['entries'], 'readonly');
    const current = await reqToPromise(txRead.objectStore('entries').get(id));
    if (!current) throw new Error('Entry not found');

    const nextArchived = !!archived;
    if (!!current.archived === nextArchived) return current;

    const updated = {
      ...current,
      archived: nextArchived,
      position: await getNextEntryPosition(db, current.topicId, nextArchived),
      updatedAt: nowIso()
    };

    await withTx(db, ['entries'], 'readwrite', (tx) => {
      tx.objectStore('entries').put(updated);
    });
    await touchChangeToken();

    return updated;
  }

  /**
   * Delete an entry by id.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Entry identifier.
   * @returns {Promise<void>}
   */
  async function deleteEntry(db, id) {
    await withTx(db, ['entries'], 'readwrite', (tx) => {
      tx.objectStore('entries').delete(id);
    });
    await touchChangeToken();
  }

  /**
   * Move an entry into another topic and append it at the end of the target ordering.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} entryId Entry identifier.
   * @param {string} targetTopicId Target topic identifier.
   * @returns {Promise<object>} Updated entry record.
   */
  async function moveEntryToTopic(db, entryId, targetTopicId) {
    if (!entryId) throw new Error('Entry id required');
    if (!targetTopicId) throw new Error('Target topic id required');

    const tx = db.transaction(['entries', 'topics'], 'readwrite');
    const entriesStore = tx.objectStore('entries');
    const topicsStore = tx.objectStore('topics');
    const entry = await reqToPromise(entriesStore.get(entryId));
    if (!entry) throw new Error('Entry not found');
    if (entry.topicId === targetTopicId) throw new Error('Entry already in target topic');

    const targetTopic = await reqToPromise(topicsStore.get(targetTopicId));
    if (!targetTopic) throw new Error('Target topic not found');

    let nextPosition = 1;
    try {
      const idx = entriesStore.index('by_topic_archived_position');
      const range = IDBKeyRange.bound(
        [targetTopicId, !!entry.archived, MIN_POSITION],
        [targetTopicId, !!entry.archived, MAX_POSITION]
      );
      nextPosition = await new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(range, 'prev');
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur) {
            resolve(1);
            return;
          }
          const pos = Number.isFinite(cur.value?.position) ? cur.value.position : 0;
          resolve(pos + 1);
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    } catch (error) {
      if (!isDataError(error)) throw error;
      // Fall back to scanning all entries if the compound index cannot be used.
      const all = await reqToPromise(entriesStore.getAll());
      const targetEntries = all.filter((item) => item?.topicId === targetTopicId && !!item?.archived === !!entry?.archived);
      const maxPos = targetEntries.reduce((max, item) => (
        Number.isFinite(item?.position) && item.position > max ? item.position : max
      ), 0);
      nextPosition = maxPos + 1;
    }

    const updated = {
      ...entry,
      topicId: targetTopicId,
      position: nextPosition,
      updatedAt: nowIso()
    };

    await reqToPromise(entriesStore.put(updated));

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();

    return updated;
  }

  /**
   * Persist a custom topic ordering.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string[]} orderedTopicIds Topic ids in desired order.
   * @returns {Promise<void>}
   */
  async function reorderTopics(db, orderedTopicIds) {
    const tx = db.transaction(['topics'], 'readwrite');
    const store = tx.objectStore('topics');

    for (let i = 0; i < orderedTopicIds.length; i++) {
      const id = orderedTopicIds[i];
      const topic = await reqToPromise(store.get(id));
      if (!topic) continue;
      topic.position = i + 1;
      topic.updatedAt = nowIso();
      store.put(topic);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();
  }

  /**
   * Persist a custom entry ordering for one topic.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Topic identifier.
   * @param {string[]} orderedEntryIds Entry ids in desired order.
   * @returns {Promise<void>}
   */
  async function reorderEntries(db, topicId, orderedEntryIds, { archived = false } = {}) {
    const tx = db.transaction(['entries'], 'readwrite');
    const store = tx.objectStore('entries');

    for (let i = 0; i < orderedEntryIds.length; i++) {
      const id = orderedEntryIds[i];
      const entry = await reqToPromise(store.get(id));
      if (!entry) continue;
      if (entry.topicId !== topicId) continue;
      if (!!entry.archived !== !!archived) continue;
      entry.position = i + 1;
      entry.updatedAt = nowIso();
      store.put(entry);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();
  }

  /**
   * Remove all topics and entries from the database.
   *
   * @param {IDBDatabase} db Open database connection.
   * @returns {Promise<void>}
   */
  async function clearAll(db) {
    const tx = db.transaction(['topics', 'entries'], 'readwrite');
    tx.objectStore('topics').clear();
    tx.objectStore('entries').clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await touchChangeToken();
  }

  /**
   * Normalize the subset of extension settings that belongs to exported application state.
   *
   * @param {object} [raw={}] Raw settings object.
   * @returns {object} Normalized settings object.
   */
  function normalizeAppSettings(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const autoBackupConfigRaw = input[APP_SETTINGS_KEYS.autoBackupConfig];
    const urlTransformConfigRaw = input[APP_SETTINGS_KEYS.urlTransformConfig];
    return {
      [APP_SETTINGS_KEYS.lastTopicId]: input[APP_SETTINGS_KEYS.lastTopicId] || null,
      [APP_SETTINGS_KEYS.includeArchived]: !!input[APP_SETTINGS_KEYS.includeArchived],
      [APP_SETTINGS_KEYS.includeArchivedEntries]: !!input[APP_SETTINGS_KEYS.includeArchivedEntries],
      [APP_SETTINGS_KEYS.themeMode]: input[APP_SETTINGS_KEYS.themeMode] === 'dark' ? 'dark' : 'light',
      [APP_SETTINGS_KEYS.autoBackupConfig]: {
        enabled: autoBackupConfigRaw?.enabled ?? APP_SETTINGS_DEFAULTS[APP_SETTINGS_KEYS.autoBackupConfig].enabled,
        intervalMinutes: Number.isFinite(Number(autoBackupConfigRaw?.intervalMinutes))
          ? Math.max(5, Math.min(10080, Math.round(Number(autoBackupConfigRaw.intervalMinutes))))
          : APP_SETTINGS_DEFAULTS[APP_SETTINGS_KEYS.autoBackupConfig].intervalMinutes
      },
      [APP_SETTINGS_KEYS.urlTransformConfig]: {
        enabled: !!urlTransformConfigRaw?.enabled,
        sourceUrlPattern: String(urlTransformConfigRaw?.sourceUrlPattern || ''),
        titleIdRegex: String(
          urlTransformConfigRaw?.titleIdRegex ||
          APP_SETTINGS_DEFAULTS[APP_SETTINGS_KEYS.urlTransformConfig].titleIdRegex
        ),
        targetUrlTemplate: String(urlTransformConfigRaw?.targetUrlTemplate || ''),
        idPlaceholder: String(
          urlTransformConfigRaw?.idPlaceholder ||
          APP_SETTINGS_DEFAULTS[APP_SETTINGS_KEYS.urlTransformConfig].idPlaceholder
        )
      }
    };
  }

  /**
   * Export the application settings stored in `storage.local`.
   *
   * @returns {Promise<object>} Normalized settings snapshot.
   */
  async function exportAppSettings() {
    const values = await ext.storage.local.get(APP_SETTINGS_DEFAULTS);
    return normalizeAppSettings(values);
  }

  /**
   * Apply imported application settings and optionally override the restored last topic id.
   *
   * @param {object} [rawSettings={}] Imported settings.
   * @param {{ lastTopicId?: string|undefined }} [options={}] Override options.
   * @returns {Promise<object>} Persisted normalized settings.
   */
  async function applyImportedSettings(rawSettings = {}, { lastTopicId = undefined } = {}) {
    const settings = normalizeAppSettings(rawSettings);
    if (lastTopicId !== undefined) {
      settings[APP_SETTINGS_KEYS.lastTopicId] = lastTopicId || null;
    }
    await ext.storage.local.set(settings);
    return settings;
  }

  /**
   * Export the complete application dataset.
   *
   * @param {IDBDatabase} db Open database connection.
   * @returns {Promise<object>} Export payload.
   */
  async function exportAll(db) {
    const topics = await getAllTopics(db, { includeArchived: true });
    const entries = await (async () => {
      const tx = db.transaction(['entries'], 'readonly');
      const store = tx.objectStore('entries');
      return reqToPromise(store.getAll());
    })();

    const settings = await exportAppSettings();

    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      app: { name: 'Research Board (Local)', version: '1.0.0' },
      settings,
      topics,
      entries
    };
  }

  /**
   * Export a single topic and its entries.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} topicId Topic identifier.
   * @returns {Promise<object>} Export payload.
   */
  async function exportTopic(db, topicId) {
    const topic = await getTopic(db, topicId);
    if (!topic) throw new Error('Topic not found');
    const entries = await getEntriesByTopic(db, topicId, { includeArchived: true });
    const settings = await exportAppSettings();

    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      app: { name: 'Research Board (Local)', version: '1.0.0' },
      settings,
      topic,
      entries
    };
  }

  /**
   * Load all stored backups ordered from newest to oldest.
   *
   * @param {IDBDatabase} db Open database connection.
   * @returns {Promise<object[]>} Backup records.
   */
  async function getAllBackups(db) {
    try {
      const tx = db.transaction(['backups'], 'readonly');
      const store = tx.objectStore('backups');
      const idx = store.index('by_createdAt');
      const results = [];
      await new Promise((resolve, reject) => {
        const cursorReq = idx.openCursor(null, 'prev');
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur) {
            resolve();
            return;
          }
          results.push(cur.value);
          cur.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      return results;
    } catch (_) {
      const tx = db.transaction(['backups'], 'readonly');
      const store = tx.objectStore('backups');
      const all = await reqToPromise(store.getAll());
      return all.sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
    }
  }

  /**
   * Load a single backup by id.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Backup identifier.
   * @returns {Promise<object|undefined>} Backup record, if found.
   */
  async function getBackup(db, id) {
    const tx = db.transaction(['backups'], 'readonly');
    const store = tx.objectStore('backups');
    return reqToPromise(store.get(id));
  }

  /**
   * Insert or replace a single backup.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {object} backupItem Backup record.
   * @returns {Promise<void>}
   */
  async function putBackup(db, backupItem) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').put(backupItem);
    });
  }

  /**
   * Insert or replace multiple backups in one transaction.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {object[]} backupItems Backup records.
   * @returns {Promise<void>}
   */
  async function putBackups(db, backupItems) {
    if (!Array.isArray(backupItems) || backupItems.length === 0) return;
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      const store = tx.objectStore('backups');
      for (const item of backupItems) {
        store.put(item);
      }
    });
  }

  /**
   * Delete a backup by id.
   *
   * @param {IDBDatabase} db Open database connection.
   * @param {string} id Backup identifier.
   * @returns {Promise<void>}
   */
  async function deleteBackup(db, id) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').delete(id);
    });
  }

  /**
   * Remove all backups from the backup store.
   *
   * @param {IDBDatabase} db Open database connection.
   * @returns {Promise<void>}
   */
  async function clearBackups(db) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').clear();
    });
  }

  // Expose persistence helpers as a shared global for all extension contexts.
  globalThis.rbDB = {
    openDb,
    uuid,
    nowIso,
    changeStateKeys: CHANGE_STATE_KEYS,
    touchChangeToken,
    getChangeState,
    getAllTopics,
    getTopic,
    addTopic,
    updateTopic,
    deleteTopic,
    getEntriesByTopic,
    getAllEntries,
    addEntry,
    updateEntry,
    setEntryArchived,
    deleteEntry,
    moveEntryToTopic,
    reorderTopics,
    reorderEntries,
    clearAll,
    getAllBackups,
    getBackup,
    putBackup,
    putBackups,
    deleteBackup,
    clearBackups,
    appSettingsKeys: APP_SETTINGS_KEYS,
    appSettingsDefaults: APP_SETTINGS_DEFAULTS,
    normalizeAppSettings,
    normalizeEntrySortMode,
    normalizeTodoItems,
    exportAppSettings,
    applyImportedSettings,
    exportAll,
    exportTopic
  };
})();
