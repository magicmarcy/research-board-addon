(() => {
  const AUTO_BACKUP_ALARM = 'rb_auto_backup_alarm';
  const STORAGE_KEYS = {
    config: 'rbAutoBackupConfig',
    legacyBackups: 'rbAutoBackups',
    lastSignature: 'rbAutoBackupLastSignature',
    lastRunAt: 'rbAutoBackupLastRunAt',
    lastSavedAt: 'rbAutoBackupLastSavedAt',
    lastBackedUpChangeToken: 'rbAutoBackupLastBackedUpChangeToken'
  };
  const PERIODIC_VERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

  function normalizeBackupItem(item) {
    if (!item || typeof item !== 'object') return null;
    const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : null;
    if (!snapshot) return null;
    const createdAt = typeof item.createdAt === 'string' && item.createdAt
      ? item.createdAt
      : rbDB.nowIso();
    return {
      id: item.id || rbDB.uuid(),
      createdAt,
      reason: String(item.reason || 'unknown'),
      signature: String(item.signature || snapshotSignature(snapshot)),
      snapshot
    };
  }

  async function migrateLegacyBackupsIfNeeded(db) {
    const values = await ext.storage.local.get({ [STORAGE_KEYS.legacyBackups]: [] });
    const legacyBackups = Array.isArray(values?.[STORAGE_KEYS.legacyBackups]) ? values[STORAGE_KEYS.legacyBackups] : [];
    if (!legacyBackups.length) return;

    const existing = await rbDB.getAllBackups(db);
    if (!existing.length) {
      const migrated = legacyBackups
        .map(normalizeBackupItem)
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, LIMITS.maxBackups);
      if (migrated.length) {
        await rbDB.putBackups(db, migrated);
      }
    }

    // Remove legacy payload from storage.local to avoid hitting quota.
    await ext.storage.local.remove(STORAGE_KEYS.legacyBackups);
  }

  async function getStoredBackups(db) {
    await migrateLegacyBackupsIfNeeded(db);
    return rbDB.getAllBackups(db);
  }

  async function createBackup({ reason = 'interval', force = false } = {}) {
    const db = await rbDB.openDb();
    const changeState = await rbDB.getChangeState();
    const currentChangeToken = String(changeState?.token || '');
    const values = await ext.storage.local.get({
      [STORAGE_KEYS.lastSignature]: '',
      [STORAGE_KEYS.lastSavedAt]: '',
      [STORAGE_KEYS.lastBackedUpChangeToken]: ''
    });
    const lastSignature = String(values?.[STORAGE_KEYS.lastSignature] || '');
    const lastSavedAt = String(values?.[STORAGE_KEYS.lastSavedAt] || '');
    const lastBackedUpChangeToken = String(values?.[STORAGE_KEYS.lastBackedUpChangeToken] || '');
    const effectiveChangeToken = currentChangeToken || `legacy:${lastSignature || 'none'}`;

    const nowMs = Date.now();
    const lastSavedMs = lastSavedAt ? Date.parse(lastSavedAt) : NaN;
    const needsPeriodicVerify = !Number.isFinite(lastSavedMs) || (nowMs - lastSavedMs >= PERIODIC_VERIFY_INTERVAL_MS);
    const tokenUnchanged = effectiveChangeToken === lastBackedUpChangeToken;

    if (!force && tokenUnchanged && !needsPeriodicVerify) {
      await ext.storage.local.set({ [STORAGE_KEYS.lastRunAt]: rbDB.nowIso() });
      return {
        ok: true,
        saved: false,
        reason: 'unchanged-token',
        signature: lastSignature
      };
    }

    const snapshot = await rbDB.exportAll(db);
    const signature = snapshotSignature(snapshot);

    if (!force && lastSignature && lastSignature === signature) {
      await ext.storage.local.set({
        [STORAGE_KEYS.lastRunAt]: rbDB.nowIso(),
        [STORAGE_KEYS.lastBackedUpChangeToken]: effectiveChangeToken
      });
      return {
        ok: true,
        saved: false,
        reason: tokenUnchanged ? 'unchanged-signature-verify' : 'unchanged-signature',
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

    const existingBackups = await getStoredBackups(db);
    await rbDB.putBackup(db, backupItem);

    const overflow = existingBackups.slice(Math.max(0, LIMITS.maxBackups - 1));
    for (const item of overflow) {
      if (!item?.id) continue;
      await rbDB.deleteBackup(db, item.id);
    }

    await ext.storage.local.set({
      [STORAGE_KEYS.lastSignature]: signature,
      [STORAGE_KEYS.lastRunAt]: backupItem.createdAt,
      [STORAGE_KEYS.lastSavedAt]: backupItem.createdAt,
      [STORAGE_KEYS.lastBackedUpChangeToken]: effectiveChangeToken
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
    const db = await rbDB.openDb();
    const backups = await getStoredBackups(db);
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
    const db = await rbDB.openDb();
    await migrateLegacyBackupsIfNeeded(db);
    const existing = await rbDB.getBackup(db, backupId);
    if (!existing) return { ok: true, deleted: 0 };
    await rbDB.deleteBackup(db, backupId);
    return { ok: true, deleted: 1 };
  }

  async function clearBackups() {
    const db = await rbDB.openDb();
    await migrateLegacyBackupsIfNeeded(db);
    await rbDB.clearBackups(db);
    await ext.storage.local.set({
      [STORAGE_KEYS.lastSignature]: '',
      [STORAGE_KEYS.lastSavedAt]: '',
      [STORAGE_KEYS.lastBackedUpChangeToken]: ''
    });
    await ext.storage.local.remove(STORAGE_KEYS.legacyBackups);
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
    await rbDB.touchChangeToken();
  }

  async function restoreBackupById(backupId) {
    const db = await rbDB.openDb();
    await migrateLegacyBackupsIfNeeded(db);
    const backup = await rbDB.getBackup(db, backupId);
    if (!backup) {
      throw new Error('Backup nicht gefunden.');
    }
    if (!isValidBackupSnapshot(backup.snapshot)) {
      throw new Error('Backup-Daten sind ungueltig.');
    }

    await createBackup({ reason: 'pre-restore', force: true });

    await replaceAllDataFromSnapshot(db, backup.snapshot);

    if (backup.snapshot.settings && typeof backup.snapshot.settings === 'object') {
      const includeArchived = !!backup.snapshot.settings.includeArchived;
      const lastTopicId = backup.snapshot.settings.lastTopicId || null;
      await ext.storage.local.set({ includeArchived, lastTopicId });
    }

    const newSignature = backup.signature || snapshotSignature(backup.snapshot);
    const changeState = await rbDB.getChangeState();
    await ext.storage.local.set({
      [STORAGE_KEYS.lastSignature]: newSignature,
      [STORAGE_KEYS.lastRunAt]: rbDB.nowIso(),
      [STORAGE_KEYS.lastSavedAt]: rbDB.nowIso(),
      [STORAGE_KEYS.lastBackedUpChangeToken]: String(changeState?.token || '')
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
