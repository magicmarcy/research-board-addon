(() => {
  const AUTO_BACKUP_ALARM = 'rb_auto_backup_alarm';
  const STORAGE_KEYS = {
    config: 'rbAutoBackupConfig',
    backups: 'rbAutoBackups',
    lastSignature: 'rbAutoBackupLastSignature',
    lastRunAt: 'rbAutoBackupLastRunAt'
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    intervalMinutes: 60
  };

  const LIMITS = {
    minIntervalMinutes: 5,
    maxIntervalMinutes: 10080,
    maxBackups: 20
  };

  function clamp(num, min, max) {
    return Math.max(min, Math.min(max, num));
  }

  function sanitizeConfig(input = {}) {
    const intervalRaw = Number(input.intervalMinutes);
    const intervalMinutes = Number.isFinite(intervalRaw)
      ? Math.round(clamp(intervalRaw, LIMITS.minIntervalMinutes, LIMITS.maxIntervalMinutes))
      : DEFAULT_CONFIG.intervalMinutes;
    return {
      enabled: Boolean(input.enabled),
      intervalMinutes
    };
  }

  async function getConfig() {
    const values = await ext.storage.local.get({ [STORAGE_KEYS.config]: DEFAULT_CONFIG });
    return sanitizeConfig(values?.[STORAGE_KEYS.config] || DEFAULT_CONFIG);
  }

  async function setConfig(patch = {}) {
    const current = await getConfig();
    const next = sanitizeConfig({ ...current, ...patch });
    await ext.storage.local.set({ [STORAGE_KEYS.config]: next });
    return next;
  }

  function toComparableTopic(topic = {}) {
    return {
      id: topic.id || '',
      title: topic.title || '',
      description: topic.description || '',
      color: topic.color || '',
      archived: !!topic.archived,
      position: Number.isFinite(topic.position) ? topic.position : 0,
      createdAt: topic.createdAt || '',
      updatedAt: topic.updatedAt || ''
    };
  }

  function toComparableEntry(entry = {}) {
    return {
      id: entry.id || '',
      topicId: entry.topicId || '',
      type: entry.type || '',
      title: entry.title || '',
      url: entry.url || '',
      sourcePageTitle: entry.sourcePageTitle || '',
      sourcePageUrl: entry.sourcePageUrl || '',
      linkText: entry.linkText || '',
      excerpt: entry.excerpt || '',
      note: entry.note || '',
      position: Number.isFinite(entry.position) ? entry.position : 0,
      createdAt: entry.createdAt || '',
      updatedAt: entry.updatedAt || ''
    };
  }

  function stableStringifySnapshot(snapshot = {}) {
    const topics = Array.isArray(snapshot.topics)
      ? snapshot.topics.map(toComparableTopic).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      : [];
    const entries = Array.isArray(snapshot.entries)
      ? snapshot.entries.map(toComparableEntry).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      : [];
    const settings = snapshot.settings && typeof snapshot.settings === 'object'
      ? {
        includeArchived: !!snapshot.settings.includeArchived,
        lastTopicId: snapshot.settings.lastTopicId || null
      }
      : { includeArchived: false, lastTopicId: null };

    return JSON.stringify({
      schemaVersion: Number(snapshot.schemaVersion) || 1,
      topics,
      entries,
      settings
    });
  }

  function fnv1aHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash +=
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function snapshotSignature(snapshot) {
    return fnv1aHash(stableStringifySnapshot(snapshot));
  }

  function snapshotByteSize(snapshot) {
    try {
      return new TextEncoder().encode(JSON.stringify(snapshot || {})).length;
    } catch (_) {
      return 0;
    }
  }

  async function getStoredBackups() {
    const values = await ext.storage.local.get({ [STORAGE_KEYS.backups]: [] });
    return Array.isArray(values?.[STORAGE_KEYS.backups]) ? values[STORAGE_KEYS.backups] : [];
  }

  async function putStoredBackups(backups) {
    await ext.storage.local.set({ [STORAGE_KEYS.backups]: backups });
  }

  async function createBackup({ reason = 'interval', force = false } = {}) {
    const db = await rbDB.openDb();
    const snapshot = await rbDB.exportAll(db);
    const signature = snapshotSignature(snapshot);
    const values = await ext.storage.local.get({
      [STORAGE_KEYS.lastSignature]: '',
      [STORAGE_KEYS.backups]: []
    });
    const lastSignature = String(values?.[STORAGE_KEYS.lastSignature] || '');
    const existingBackups = Array.isArray(values?.[STORAGE_KEYS.backups]) ? values[STORAGE_KEYS.backups] : [];

    if (!force && lastSignature && lastSignature === signature) {
      await ext.storage.local.set({ [STORAGE_KEYS.lastRunAt]: rbDB.nowIso() });
      return {
        ok: true,
        saved: false,
        reason: 'unchanged',
        signature
      };
    }

    const backupItem = {
      id: rbDB.uuid(),
      createdAt: rbDB.nowIso(),
      reason: String(reason || 'interval'),
      signature,
      snapshot
    };

    const next = [backupItem, ...existingBackups].slice(0, LIMITS.maxBackups);
    await ext.storage.local.set({
      [STORAGE_KEYS.backups]: next,
      [STORAGE_KEYS.lastSignature]: signature,
      [STORAGE_KEYS.lastRunAt]: backupItem.createdAt
    });

    return {
      ok: true,
      saved: true,
      backupId: backupItem.id,
      createdAt: backupItem.createdAt,
      signature
    };
  }

  async function listBackupsMeta() {
    const backups = await getStoredBackups();
    return backups.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      reason: item.reason || 'unknown',
      signature: item.signature || '',
      sizeBytes: snapshotByteSize(item.snapshot),
      topics: Array.isArray(item.snapshot?.topics) ? item.snapshot.topics.length : 0,
      entries: Array.isArray(item.snapshot?.entries) ? item.snapshot.entries.length : 0
    }));
  }

  async function deleteBackup(backupId) {
    const backups = await getStoredBackups();
    const next = backups.filter((b) => b?.id !== backupId);
    await putStoredBackups(next);
    return { ok: true, deleted: backups.length - next.length };
  }

  async function clearBackups() {
    await ext.storage.local.set({
      [STORAGE_KEYS.backups]: [],
      [STORAGE_KEYS.lastSignature]: ''
    });
    return { ok: true };
  }

  function isValidBackupSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    return Array.isArray(snapshot.topics) && Array.isArray(snapshot.entries);
  }

  async function replaceAllDataFromSnapshot(db, snapshot) {
    const tx = db.transaction(['topics', 'entries'], 'readwrite');
    const topicsStore = tx.objectStore('topics');
    const entriesStore = tx.objectStore('entries');

    await new Promise((resolve, reject) => {
      const clearTopics = topicsStore.clear();
      clearTopics.onsuccess = () => {
        const clearEntries = entriesStore.clear();
        clearEntries.onsuccess = resolve;
        clearEntries.onerror = () => reject(clearEntries.error);
      };
      clearTopics.onerror = () => reject(clearTopics.error);
    });

    for (const topic of snapshot.topics) {
      const normalizedTopic = {
        id: topic.id || rbDB.uuid(),
        title: topic.title || 'Import',
        description: topic.description || '',
        color: topic.color || '',
        archived: !!topic.archived,
        createdAt: topic.createdAt || rbDB.nowIso(),
        updatedAt: topic.updatedAt || rbDB.nowIso(),
        position: Number.isFinite(topic.position) ? topic.position : 1
      };
      topicsStore.put(normalizedTopic);
    }

    for (const entry of snapshot.entries) {
      const normalizedEntry = {
        id: entry.id || rbDB.uuid(),
        topicId: entry.topicId || '',
        type: entry.type || 'note',
        title: entry.title || '',
        url: entry.url || '',
        sourcePageTitle: entry.sourcePageTitle || '',
        sourcePageUrl: entry.sourcePageUrl || '',
        linkText: entry.linkText || '',
        excerpt: entry.excerpt || '',
        note: entry.note || '',
        createdAt: entry.createdAt || rbDB.nowIso(),
        updatedAt: entry.updatedAt || rbDB.nowIso(),
        position: Number.isFinite(entry.position) ? entry.position : 1
      };
      entriesStore.put(normalizedEntry);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function restoreBackupById(backupId) {
    const backups = await getStoredBackups();
    const backup = backups.find((b) => b?.id === backupId);
    if (!backup) {
      throw new Error('Backup nicht gefunden.');
    }
    if (!isValidBackupSnapshot(backup.snapshot)) {
      throw new Error('Backup-Daten sind ungueltig.');
    }

    await createBackup({ reason: 'pre-restore', force: true });

    const db = await rbDB.openDb();
    await replaceAllDataFromSnapshot(db, backup.snapshot);

    if (backup.snapshot.settings && typeof backup.snapshot.settings === 'object') {
      const includeArchived = !!backup.snapshot.settings.includeArchived;
      const lastTopicId = backup.snapshot.settings.lastTopicId || null;
      await ext.storage.local.set({ includeArchived, lastTopicId });
    }

    const newSignature = backup.signature || snapshotSignature(backup.snapshot);
    await ext.storage.local.set({
      [STORAGE_KEYS.lastSignature]: newSignature,
      [STORAGE_KEYS.lastRunAt]: rbDB.nowIso()
    });

    return { ok: true };
  }

  async function scheduleAlarm() {
    const alarmsApi = ext.alarms;
    if (!alarmsApi) return { ok: false, reason: 'no_alarms_api' };

    const config = await getConfig();
    await alarmsApi.clear(AUTO_BACKUP_ALARM);
    if (!config.enabled) {
      return { ok: true, scheduled: false };
    }

    alarmsApi.create(AUTO_BACKUP_ALARM, {
      periodInMinutes: config.intervalMinutes
    });

    return {
      ok: true,
      scheduled: true,
      intervalMinutes: config.intervalMinutes
    };
  }

  async function onAlarm(alarm) {
    if (!alarm || alarm.name !== AUTO_BACKUP_ALARM) return;
    try {
      await createBackup({ reason: 'interval' });
    } catch (error) {
      console.error('Auto backup failed', error);
    }
  }

  function alarmName() {
    return AUTO_BACKUP_ALARM;
  }

  globalThis.rbAutoBackup = {
    limits: LIMITS,
    alarmName,
    getConfig,
    setConfig,
    scheduleAlarm,
    createBackup,
    listBackupsMeta,
    deleteBackup,
    clearBackups,
    restoreBackupById,
    onAlarm
  };
})();
