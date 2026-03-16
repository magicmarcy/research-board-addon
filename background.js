(() => {
  /**
   * Research Board background runtime.
   *
   * This file acts as the extension's central coordinator for work that should
   * not live inside the sidebar UI:
   * - building and refreshing browser context menus
   * - storing "pending capture" payloads before the sidebar assigns them to a topic
   * - handling cross-context runtime messages from the sidebar and options pages
   * - creating quick entries from captured page context
   * - scheduling and triggering local auto-backups after data changes, install, and startup
   *
   * The background script intentionally owns orchestration concerns while the
   * sidebar remains focused on rendering and direct user interaction. This keeps
   * browser integration, persistence hand-off, and lifecycle events in one place.
   */
  const MAX_TOPICS_IN_MENU = 15;
  const PENDING_CAPTURE_KEY = 'rbPendingCapture';
  const DATA_CHANGE_SIGNAL_KEY = 'rbDataChangeSignal';
  const CHANGE_BACKUP_DEBOUNCE_MS = 60 * 1000;
  let pendingCapture = null;
  let changeBackupTimer = null;
  const MENU_CONTEXTS = ['page', 'frame', 'selection', 'link'];

  /**
   * Swallow extension API failures for operations that should not block the main flow.
   *
   * @template T
   * @param {Promise<T>} p Promise returned by an extension API call.
   * @returns {Promise<T|undefined>} The resolved value, or `undefined` if the promise rejects.
   */
  const safe = (p) => p.catch(() => undefined);

  /**
   * Persist the current pending capture payload and emit a lightweight change signal
   * so open sidebars can refresh their pending state.
   *
   * @param {object|null|undefined} value Capture payload collected from a context menu action.
   * @returns {Promise<void>}
   */
  async function setPendingCapture(value) {
    pendingCapture = value || null;
    if (pendingCapture) {
      await safe(ext.storage.local.set({
        [PENDING_CAPTURE_KEY]: pendingCapture,
        pendingCaptureSignal: Date.now()
      }));
      return;
    }
    await safe(ext.storage.local.remove(PENDING_CAPTURE_KEY));
    await safe(ext.storage.local.set({ pendingCaptureSignal: Date.now() }));
  }

  /**
   * Resolve the current pending capture payload from memory first, then storage.
   *
   * @returns {Promise<object|null>} The pending capture payload, if one exists.
   */
  async function getPendingCapture() {
    if (pendingCapture) return pendingCapture;
    const values = await safe(ext.storage.local.get({ [PENDING_CAPTURE_KEY]: null }));
    pendingCapture = values?.[PENDING_CAPTURE_KEY] || null;
    return pendingCapture;
  }

  /**
   * Clear the pending capture payload in memory and storage.
   *
   * @returns {Promise<void>}
   */
  async function clearPendingCapture() {
    await setPendingCapture(null);
  }

  /**
   * Debounce change-triggered auto-backups so multiple writes do not create backup noise.
   *
   * @returns {void}
   */
  function scheduleDebouncedChangeBackup() {
    if (changeBackupTimer) {
      clearTimeout(changeBackupTimer);
      changeBackupTimer = null;
    }
    changeBackupTimer = setTimeout(async () => {
      changeBackupTimer = null;
      try {
        const config = await rbAutoBackup.getConfig();
        if (!config.enabled) return;
        await rbAutoBackup.createBackup({ reason: 'change', force: false });
      } catch (error) {
        console.error('Debounced change backup failed', error);
      }
    }, CHANGE_BACKUP_DEBOUNCE_MS);
  }

  /**
   * Ensure the database contains at least one topic so the sidebar and context menu
   * always have a valid fallback destination.
   *
   * @param {IDBDatabase} db Open IndexedDB connection.
   * @returns {Promise<object>} The existing or newly created default topic.
   */
  async function ensureDefaultTopic(db) {
    const topics = await rbDB.getAllTopics(db, { includeArchived: true });
    if (topics.length > 0) return topics[0];
    const t = await rbDB.addTopic(db, { title: 'Inbox', description: 'Schnellablage für neue Fundstücke' });
    await ext.storage.local.set({ lastTopicId: t.id });
    return t;
  }

  /**
   * Load the visible topics used for direct context menu shortcuts.
   *
   * @param {IDBDatabase} db Open IndexedDB connection.
   * @returns {Promise<object[]>} Non-archived topics capped for menu rendering.
   */
  async function getMenuTopics(db) {
    const topics = await rbDB.getAllTopics(db, { includeArchived: false });
    return topics.slice(0, MAX_TOPICS_IN_MENU);
  }

  /**
   * Rebuild the browser context menu tree from current topic data.
   *
   * This keeps the menu aligned with topic creation, deletion, archive changes,
   * and startup/install lifecycle events.
   *
   * @returns {Promise<void>}
   */
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
      contexts: MENU_CONTEXTS
    });

    ext.contextMenus.create({
      id: 'rb_open_sidebar',
      parentId: 'rb_root',
      title: 'In Sidebar auswählen…',
      contexts: MENU_CONTEXTS
    });

    ext.contextMenus.create({
      id: 'rb_sep1',
      parentId: 'rb_root',
      type: 'separator',
      contexts: MENU_CONTEXTS
    });

    // Render quick topic targets directly beneath the root menu entry.
    const topics = await getMenuTopics(db);
    if (topics.length === 0) {
      ext.contextMenus.create({
        id: 'rb_no_topics',
        parentId: 'rb_root',
        title: '(Noch keine Themen — Sidebar öffnen)',
        enabled: false,
        contexts: MENU_CONTEXTS
      });
      return;
    }

    for (const t of topics) {
      ext.contextMenus.create({
        id: `rb_topic:${t.id}`,
        parentId: 'rb_root',
        title: t.title,
        contexts: MENU_CONTEXTS
      });
    }

    // Keep the menu compact and point the user to the sidebar chooser for overflow.
    const allTopics = await rbDB.getAllTopics(db, { includeArchived: false });
    if (allTopics.length > MAX_TOPICS_IN_MENU) {
      ext.contextMenus.create({
        id: 'rb_more_topics',
        parentId: 'rb_root',
        title: `(+${allTopics.length - MAX_TOPICS_IN_MENU} weitere — „In Sidebar auswählen…“ nutzen)`,
        enabled: false,
        contexts: MENU_CONTEXTS
      });
    }
  }

  /**
   * Normalize free-form text into a compact menu- or title-friendly string.
   *
   * @param {string|null|undefined} str Source text.
   * @param {number} [max=80] Maximum length before truncation.
   * @returns {string} Normalized and truncated text.
   */
  function normalizeTitle(str, max = 80) {
    const s = (str ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /**
   * Check whether a string looks like a directly openable URL.
   *
   * @param {string|null|undefined} s Source text.
   * @returns {boolean} `true` when the value resembles an HTTP(S) URL.
   */
  function looksLikeUrl(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return true;
    if (t.startsWith('www.')) return true;
    return false;
  }

  /**
   * Coerce plain `www.` URLs into absolute HTTPS URLs.
   *
   * @param {string|null|undefined} s Source text.
   * @returns {string} Normalized URL-like string.
   */
  function coerceUrl(s) {
    if (!s) return '';
    const t = s.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return t;
    if (t.startsWith('www.')) return 'https://' + t;
    return t;
  }

  /**
   * Convert a captured browser context into a Research Board entry and store it
   * in the target topic.
   *
   * @param {string} topicId Target topic identifier.
   * @param {object} info Context menu click metadata.
   * @param {object|null|undefined} tab Browser tab metadata, when available.
   * @returns {Promise<object>} The created entry record.
   */
  async function addCapturedToTopic(topicId, info, tab) {
    const db = await rbDB.openDb();

    // Keep the user's most recent destination topic in sync with capture actions.
    await ext.storage.local.set({ lastTopicId: topicId });

    const tabUrl = tab?.url || info?.pageUrl || '';
    const frameUrl = info?.frameUrl || '';
    const contextUrl = frameUrl || tabUrl;
    const tabTitle = tab?.title || '';
    const transformConfig = await rbUrlTransform.getConfig();

    let entry;

    // Link capture has the strongest signal and preserves link-specific metadata.
    if (info?.linkUrl) {
      const transformed = rbUrlTransform.applyToUrl(info.linkUrl, tabTitle, transformConfig);
      entry = {
        type: 'link',
        url: transformed.url,
        title: normalizeTitle(info.linkText || transformed.url),
        linkText: info.linkText || '',
        sourcePageUrl: contextUrl,
        sourcePageTitle: tabTitle
      };
    // Selection capture becomes a quote entry sourced from the current page context.
    } else if (info?.selectionText) {
      const ex = info.selectionText;
      entry = {
        type: 'quote',
        excerpt: ex,
        title: normalizeTitle(ex, 60),
        sourcePageUrl: contextUrl,
        sourcePageTitle: tabTitle
      };
    // Fallback capture stores the current page itself as a link.
    } else {
      const transformed = rbUrlTransform.applyToUrl(contextUrl, tabTitle, transformConfig);
      entry = {
        type: 'link',
        url: transformed.url,
        title: normalizeTitle(tabTitle || transformed.url),
        sourcePageUrl: contextUrl,
        sourcePageTitle: tabTitle
      };
    }

    const created = await rbDB.addEntry(db, topicId, entry);
    await safe(ext.runtime.sendMessage({ type: 'entryAdded', topicId, entryId: created.id }));
    return created;
  }

  /**
   * Handle browser context menu clicks for sidebar selection and direct topic capture.
   *
   * @param {object} info Browser-provided click information.
   * @param {object|null|undefined} tab Browser tab metadata, if provided.
   * @returns {Promise<void>}
   */
  ext.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
      const id = info.menuItemId;

      if (id === 'rb_open_sidebar') {
        await setPendingCapture({
          info,
          tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null
        });
        if (ext.sidebarAction?.open) {
          await safe(ext.sidebarAction.open());
        }
        // Notify already-open sidebars immediately instead of waiting for storage polling.
        await safe(ext.runtime.sendMessage({ type: 'pendingCaptureAvailable' }));
        return;
      }

      if (typeof id === 'string' && id.startsWith('rb_topic:')) {
        const topicId = id.slice('rb_topic:'.length);
        // Firefox can omit full tab details for some menu contexts, so recover them when possible.
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
    /**
     * Toggle or open the sidebar from the toolbar button, depending on browser support.
     *
     * @returns {Promise<void>}
     */
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

  /**
   * Runtime message gateway for sidebar and options page requests.
   *
   * The handler responds asynchronously and always returns `true` to keep the
   * message channel alive until `sendResponse` is invoked.
   *
   * @param {object} msg Message payload.
   * @param {browser.runtime.MessageSender} _sender Message sender metadata.
   * @param {(response?: any) => void} sendResponse Runtime response callback.
   * @returns {boolean} Always `true` to indicate asynchronous response handling.
   */
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!msg || typeof msg !== 'object') return undefined;

      if (msg.type === 'topicsChanged' || msg.type === 'requestMenuRefresh') {
        await rebuildContextMenus();
        return { ok: true };
      }

      if (msg.type === 'getPendingCapture') {
        return getPendingCapture();
      }

      if (msg.type === 'clearPendingCapture') {
        await clearPendingCapture();
        return { ok: true };
      }

      if (msg.type === 'addPendingCaptureToTopic') {
        const currentPending = await getPendingCapture();
        if (!currentPending) return { ok: false, error: 'NO_PENDING' };
        const topicId = msg.topicId;
        const info = currentPending.info;
        const tab = currentPending.tab;
        await clearPendingCapture();
        await addCapturedToTopic(topicId, info, tab);
        return { ok: true };
      }

      if (msg.type === 'addQuickEntry') {
        // This path is used by the sidebar convenience action for the current page.
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

    // Keep the channel open until the async branch resolves and replies.
    return true;
  });

  /**
   * Initialize browser integration when the add-on is installed or updated.
   *
   * @returns {Promise<void>}
   */
  ext.runtime.onInstalled.addListener(async () => {
    await rebuildContextMenus();
    await rbAutoBackup.scheduleAlarm();
    await rbAutoBackup.createBackup({ reason: 'install-init' }).catch((error) => {
      console.error('Initial backup on install failed', error);
    });
  });

  /**
   * Forward scheduled alarm events to the auto-backup subsystem.
   *
   * @param {object} alarm Browser alarm payload.
   * @returns {void}
   */
  ext.alarms?.onAlarm?.addListener((alarm) => {
    rbAutoBackup.onAlarm(alarm);
  });

  /**
   * Listen for storage-level data change signals and schedule a debounced backup.
   *
   * @param {object} changes Storage change map.
   * @param {string} areaName Storage area name.
   * @returns {void}
   */
  ext.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!Object.prototype.hasOwnProperty.call(changes, DATA_CHANGE_SIGNAL_KEY)) return;
    scheduleDebouncedChangeBackup();
  });

  /**
   * Restore recurring background services when Firefox starts the extension again.
   *
   * @returns {Promise<void>}
   */
  ext.runtime.onStartup?.addListener(async () => {
    await rbAutoBackup.scheduleAlarm();
    await rbAutoBackup.createBackup({ reason: 'startup' }).catch((error) => {
      console.error('Auto backup on startup failed', error);
    });
  });

  // Attempt a bootstrap refresh immediately as well, because persistent background
  // contexts may survive longer than install/startup events alone.
  rebuildContextMenus();
  rbAutoBackup.scheduleAlarm().catch((error) => {
    console.error('Failed to schedule auto backup alarm', error);
  });
})();
