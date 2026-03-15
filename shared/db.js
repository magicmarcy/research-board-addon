/*
  Research Board DB (IndexedDB)
  Stores:
    - topics: { id, title, description?, color?, createdAt, updatedAt, archived, position }
    - entries: { id, topicId, type, title?, url?, sourcePageTitle?, sourcePageUrl?, linkText?, excerpt?, note?, createdAt, updatedAt, position }
    - backups: { id, createdAt, reason, signature, snapshot }
*/

(() => {
  const DB_NAME = 'research_board_db';
  const DB_VERSION = 3;
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
    themeMode: 'themeMode',
    autoBackupConfig: 'rbAutoBackupConfig',
    urlTransformConfig: 'urlTransformConfig'
  };
  const APP_SETTINGS_DEFAULTS = {
    [APP_SETTINGS_KEYS.lastTopicId]: null,
    [APP_SETTINGS_KEYS.includeArchived]: false,
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

  const nowIso = () => new Date().toISOString();

  const uuid = () => {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch (_) {}
    // Fallback: not cryptographically strong, but fine for local IDs.
    return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;

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
          entries.createIndex('by_updatedAt', 'updatedAt', { unique: false });
          entries.createIndex('by_type', 'type', { unique: false });
          entries.createIndex('by_url', 'url', { unique: false });
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

  function withTx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      fn(tx);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

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

  function isDataError(error) {
    if (!error) return false;
    if (error.name === 'DataError') return true;
    const msg = String(error.message || error);
    return /does not meet requirements|Data provided/i.test(msg);
  }

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

  async function getEntriesByTopicFallback(db, topicId) {
    if (!topicId) return [];
    const tx = db.transaction(['entries'], 'readonly');
    const store = tx.objectStore('entries');
    const all = await reqToPromise(store.getAll());
    return all
      .filter((e) => e?.topicId === topicId)
      .sort((a, b) => {
        const ap = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
        const bp = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''));
      });
  }

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

  async function getNextEntryPosition(db, topicId) {
    if (!topicId) return 1;
    try {
      const tx = db.transaction(['entries'], 'readonly');
      const store = tx.objectStore('entries');
      const idx = store.index('by_topic_position');
      const range = IDBKeyRange.bound([topicId, MIN_POSITION], [topicId, MAX_POSITION]);

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
      const entries = await getEntriesByTopicFallback(db, topicId);
      const last = entries[entries.length - 1];
      const lastPos = Number.isFinite(last?.position) ? last.position : 0;
      return lastPos + 1;
    }
  }

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

  async function getTopic(db, id) {
    const tx = db.transaction(['topics'], 'readonly');
    const store = tx.objectStore('topics');
    return reqToPromise(store.get(id));
  }

  async function addTopic(db, { title, description = '', color = '' } = {}) {
    const createdAt = nowIso();
    const topic = {
      id: uuid(),
      title: (title ?? 'Neues Thema').trim() || 'Neues Thema',
      description: description ?? '',
      color: color ?? '',
      archived: false,
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

  async function updateTopic(db, id, patch) {
    const tx = db.transaction(['topics'], 'readwrite');
    const store = tx.objectStore('topics');
    const cur = await reqToPromise(store.get(id));
    if (!cur) throw new Error('Topic not found');

    const updated = {
      ...cur,
      ...patch,
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

  async function deleteTopic(db, id) {
    // Delete topic + its entries in one transaction.
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

  async function getEntriesByTopic(db, topicId) {
    if (!topicId) return [];
    try {
      const tx = db.transaction(['entries'], 'readonly');
      const store = tx.objectStore('entries');
      const idx = store.index('by_topic_position');
      const range = IDBKeyRange.bound([topicId, MIN_POSITION], [topicId, MAX_POSITION]);

      const results = [];
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
      return results;
    } catch (error) {
      if (!isDataError(error)) throw error;
      return getEntriesByTopicFallback(db, topicId);
    }
  }

  async function getAllEntries(db) {
    const tx = db.transaction(['entries'], 'readonly');
    const store = tx.objectStore('entries');
    return reqToPromise(store.getAll());
  }

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
      createdAt,
      updatedAt: createdAt,
      position: typeof entryInput.position === 'number' ? entryInput.position : await getNextEntryPosition(db, topicId)
    };

    await withTx(db, ['entries'], 'readwrite', (tx) => {
      tx.objectStore('entries').add(entry);
    });
    await touchChangeToken();

    return entry;
  }

  async function updateEntry(db, id, patch) {
    const tx = db.transaction(['entries'], 'readwrite');
    const store = tx.objectStore('entries');
    const cur = await reqToPromise(store.get(id));
    if (!cur) throw new Error('Entry not found');

    const updated = {
      ...cur,
      ...patch,
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

  async function deleteEntry(db, id) {
    await withTx(db, ['entries'], 'readwrite', (tx) => {
      tx.objectStore('entries').delete(id);
    });
    await touchChangeToken();
  }

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

  async function reorderEntries(db, topicId, orderedEntryIds) {
    const tx = db.transaction(['entries'], 'readwrite');
    const store = tx.objectStore('entries');

    for (let i = 0; i < orderedEntryIds.length; i++) {
      const id = orderedEntryIds[i];
      const entry = await reqToPromise(store.get(id));
      if (!entry) continue;
      if (entry.topicId !== topicId) continue;
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

  function normalizeAppSettings(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const autoBackupConfigRaw = input[APP_SETTINGS_KEYS.autoBackupConfig];
    const urlTransformConfigRaw = input[APP_SETTINGS_KEYS.urlTransformConfig];
    return {
      [APP_SETTINGS_KEYS.lastTopicId]: input[APP_SETTINGS_KEYS.lastTopicId] || null,
      [APP_SETTINGS_KEYS.includeArchived]: !!input[APP_SETTINGS_KEYS.includeArchived],
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

  async function exportAppSettings() {
    const values = await ext.storage.local.get(APP_SETTINGS_DEFAULTS);
    return normalizeAppSettings(values);
  }

  async function applyImportedSettings(rawSettings = {}, { lastTopicId = undefined } = {}) {
    const settings = normalizeAppSettings(rawSettings);
    if (lastTopicId !== undefined) {
      settings[APP_SETTINGS_KEYS.lastTopicId] = lastTopicId || null;
    }
    await ext.storage.local.set(settings);
    return settings;
  }

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

  async function exportTopic(db, topicId) {
    const topic = await getTopic(db, topicId);
    if (!topic) throw new Error('Topic not found');
    const entries = await getEntriesByTopic(db, topicId);
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

  async function getBackup(db, id) {
    const tx = db.transaction(['backups'], 'readonly');
    const store = tx.objectStore('backups');
    return reqToPromise(store.get(id));
  }

  async function putBackup(db, backupItem) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').put(backupItem);
    });
  }

  async function putBackups(db, backupItems) {
    if (!Array.isArray(backupItems) || backupItems.length === 0) return;
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      const store = tx.objectStore('backups');
      for (const item of backupItems) {
        store.put(item);
      }
    });
  }

  async function deleteBackup(db, id) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').delete(id);
    });
  }

  async function clearBackups(db) {
    await withTx(db, ['backups'], 'readwrite', (tx) => {
      tx.objectStore('backups').clear();
    });
  }

  // Expose
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
    deleteEntry,
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
    exportAppSettings,
    applyImportedSettings,
    exportAll,
    exportTopic
  };
})();
