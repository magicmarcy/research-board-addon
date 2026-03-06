(() => {
  const MAX_TOPICS_IN_MENU = 15;
  let pendingCapture = null;

  const safe = (p) => p.catch(() => undefined);

  async function ensureDefaultTopic(db) {
    const topics = await rbDB.getAllTopics(db, { includeArchived: true });
    if (topics.length > 0) return topics[0];
    const t = await rbDB.addTopic(db, { title: 'Inbox', description: 'Schnellablage für neue Fundstücke' });
    await ext.storage.local.set({ lastTopicId: t.id });
    return t;
  }

  async function getMenuTopics(db) {
    const topics = await rbDB.getAllTopics(db, { includeArchived: false });
    return topics.slice(0, MAX_TOPICS_IN_MENU);
  }

  async function rebuildContextMenus() {
    const db = await rbDB.openDb();
    await ensureDefaultTopic(db);

    // Firefox (browser.*) returns Promises. Chrome (chrome.*) uses callbacks.
    await safe(new Promise((resolve) => {
      try {
        const r = ext.contextMenus.removeAll();
        if (r && typeof r.then === 'function') {
          r.then(() => resolve()).catch(() => resolve());
        } else {
          ext.contextMenus.removeAll(() => resolve());
        }
      } catch (_) {
        try {
          ext.contextMenus.removeAll(() => resolve());
        } catch (_) {
          resolve();
        }
      }
    }));

    ext.contextMenus.create({
      id: 'rb_root',
      title: 'Zum Research Board hinzufügen',
      contexts: ['page', 'selection', 'link']
    });

    ext.contextMenus.create({
      id: 'rb_open_sidebar',
      parentId: 'rb_root',
      title: 'In Sidebar auswählen…',
      contexts: ['page', 'selection', 'link']
    });

    ext.contextMenus.create({
      id: 'rb_sep1',
      parentId: 'rb_root',
      type: 'separator',
      contexts: ['page', 'selection', 'link']
    });

    const topics = await getMenuTopics(db);
    if (topics.length === 0) {
      ext.contextMenus.create({
        id: 'rb_no_topics',
        parentId: 'rb_root',
        title: '(Noch keine Themen — Sidebar öffnen)',
        enabled: false,
        contexts: ['page', 'selection', 'link']
      });
      return;
    }

    for (const t of topics) {
      ext.contextMenus.create({
        id: `rb_topic:${t.id}`,
        parentId: 'rb_root',
        title: t.title,
        contexts: ['page', 'selection', 'link']
      });
    }

    // If more topics exist, hint.
    const allTopics = await rbDB.getAllTopics(db, { includeArchived: false });
    if (allTopics.length > MAX_TOPICS_IN_MENU) {
      ext.contextMenus.create({
        id: 'rb_more_topics',
        parentId: 'rb_root',
        title: `(+${allTopics.length - MAX_TOPICS_IN_MENU} weitere — „In Sidebar auswählen…“ nutzen)`,
        enabled: false,
        contexts: ['page', 'selection', 'link']
      });
    }
  }

  function normalizeTitle(str, max = 80) {
    const s = (str ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function looksLikeUrl(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return true;
    if (t.startsWith('www.')) return true;
    return false;
  }

  function coerceUrl(s) {
    if (!s) return '';
    const t = s.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return t;
    if (t.startsWith('www.')) return 'https://' + t;
    return t;
  }

  async function addCapturedToTopic(topicId, info, tab) {
    const db = await rbDB.openDb();

    // Maintain lastTopicId.
    await ext.storage.local.set({ lastTopicId: topicId });

    const tabUrl = tab?.url || info?.pageUrl || '';
    const tabTitle = tab?.title || '';

    let entry;

    if (info?.linkUrl) {
      entry = {
        type: 'link',
        url: info.linkUrl,
        title: normalizeTitle(info.linkText || info.linkUrl),
        linkText: info.linkText || '',
        sourcePageUrl: tabUrl,
        sourcePageTitle: tabTitle
      };
    } else if (info?.selectionText) {
      const ex = info.selectionText;
      entry = {
        type: 'quote',
        excerpt: ex,
        title: normalizeTitle(ex, 60),
        sourcePageUrl: tabUrl,
        sourcePageTitle: tabTitle
      };
    } else {
      entry = {
        type: 'link',
        url: tabUrl,
        title: normalizeTitle(tabTitle || tabUrl),
        sourcePageUrl: tabUrl,
        sourcePageTitle: tabTitle
      };
    }

    const created = await rbDB.addEntry(db, topicId, entry);
    await safe(ext.runtime.sendMessage({ type: 'entryAdded', topicId, entryId: created.id }));
    return created;
  }

  ext.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
      const id = info.menuItemId;

      if (id === 'rb_open_sidebar') {
        pendingCapture = {
          info,
          tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null
        };
        await safe(ext.storage.local.set({ pendingCaptureSignal: Date.now() }));
        if (ext.sidebarAction?.open) {
          await safe(ext.sidebarAction.open());
        }
        await safe(ext.runtime.sendMessage({ type: 'pendingCaptureAvailable' }));
        return;
      }

      if (typeof id === 'string' && id.startsWith('rb_topic:')) {
        const topicId = id.slice('rb_topic:'.length);
        // Ensure we have tab title/url
        let fullTab = tab;
        if (!fullTab?.id && info.tabId != null) {
          fullTab = await ext.tabs.get(info.tabId);
        }
        await addCapturedToTopic(topicId, info, fullTab);
      }
    } catch (e) {
      console.error('Context menu error', e);
    }
  });

  if (ext.action?.onClicked) {
    ext.action.onClicked.addListener(async () => {
      try {
        if (ext.sidebarAction?.toggle) {
          await safe(ext.sidebarAction.toggle());
        } else if (ext.sidebarAction?.open) {
          await safe(ext.sidebarAction.open());
        }
      } catch (e) {
        console.error('Action click error', e);
      }
    });
  }

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!msg || typeof msg !== 'object') return undefined;

      if (msg.type === 'topicsChanged' || msg.type === 'requestMenuRefresh') {
        await rebuildContextMenus();
        return { ok: true };
      }

      if (msg.type === 'getPendingCapture') {
        return pendingCapture;
      }

      if (msg.type === 'clearPendingCapture') {
        pendingCapture = null;
        return { ok: true };
      }

      if (msg.type === 'addPendingCaptureToTopic') {
        if (!pendingCapture) return { ok: false, error: 'NO_PENDING' };
        const topicId = msg.topicId;
        const info = pendingCapture.info;
        const tab = pendingCapture.tab;
        pendingCapture = null;
        await addCapturedToTopic(topicId, info, tab);
        return { ok: true };
      }

      if (msg.type === 'addQuickEntry') {
        // Called from sidebar for "Add current page" convenience.
        const { topicId, entry } = msg;
        const db = await rbDB.openDb();
        await ext.storage.local.set({ lastTopicId: topicId });
        const created = await rbDB.addEntry(db, topicId, entry);
        await safe(ext.runtime.sendMessage({ type: 'entryAdded', topicId, entryId: created.id }));
        return { ok: true, entryId: created.id };
      }

      if (msg.type === 'openUrlInTab') {
        const url = msg.url;
        if (url) await safe(ext.tabs.create({ url }));
        return { ok: true };
      }

      if (msg.type === 'autoBackupGetState') {
        const config = await rbAutoBackup.getConfig();
        const backups = await rbAutoBackup.listBackupsMeta();
        return { ok: true, config, backups };
      }

      if (msg.type === 'autoBackupUpdateConfig') {
        const config = await rbAutoBackup.setConfig(msg.patch || {});
        await rbAutoBackup.scheduleAlarm();
        return { ok: true, config };
      }

      if (msg.type === 'autoBackupRunNow') {
        const result = await rbAutoBackup.createBackup({ reason: 'manual', force: false });
        const backups = await rbAutoBackup.listBackupsMeta();
        return { ok: true, result, backups };
      }

      if (msg.type === 'autoBackupDelete') {
        await rbAutoBackup.deleteBackup(msg.backupId);
        const backups = await rbAutoBackup.listBackupsMeta();
        return { ok: true, backups };
      }

      if (msg.type === 'autoBackupDeleteAll') {
        await rbAutoBackup.clearBackups();
        return { ok: true, backups: [] };
      }

      if (msg.type === 'autoBackupRestore') {
        await rbAutoBackup.restoreBackupById(msg.backupId);
        await safe(ext.runtime.sendMessage({ type: 'dataRestored' }));
        await rebuildContextMenus();
        return { ok: true };
      }

      return undefined;
    })()
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error('onMessage error', error);
        sendResponse({ ok: false, error: String(error?.message || error) });
      });

    // Keep the channel open for async responses.
    return true;
  });

  ext.runtime.onInstalled.addListener(async () => {
    await rebuildContextMenus();
    await rbAutoBackup.scheduleAlarm();
    await rbAutoBackup.createBackup({ reason: 'install-init' }).catch((error) => {
      console.error('Initial backup on install failed', error);
    });
  });

  ext.alarms?.onAlarm?.addListener((alarm) => {
    rbAutoBackup.onAlarm(alarm);
  });

  ext.runtime.onStartup?.addListener(async () => {
    await rbAutoBackup.scheduleAlarm();
    await rbAutoBackup.createBackup({ reason: 'startup' }).catch((error) => {
      console.error('Auto backup on startup failed', error);
    });
  });

  // Also attempt on startup (in case background persists).
  rebuildContextMenus();
  rbAutoBackup.scheduleAlarm().catch((error) => {
    console.error('Failed to schedule auto backup alarm', error);
  });
})();
