(() => {
  /**
   * Options page runtime.
   *
   * This file powers the addon's settings page. It is responsible for:
   * - loading and rendering auto-backup settings and backup metadata
   * - sending backup-related commands to the background script
   * - loading, validating, and persisting URL transformation settings
   * - keeping the options UI status feedback compact and explicit
   *
   * The options page intentionally stays thin: persistence and backup execution live
   * in shared/background modules, while this file focuses on form state and user actions.
   */
  const MIN_INTERVAL = 5;
  const MAX_INTERVAL = 10080;

  // Cache all static form elements once because the options page does not rerender dynamically.
  const els = {
    settingsForm: document.getElementById('settingsForm'),
    enabledInput: document.getElementById('enabledInput'),
    intervalInput: document.getElementById('intervalInput'),
    transformForm: document.getElementById('transformForm'),
    transformEnabledInput: document.getElementById('transformEnabledInput'),
    sourceUrlPatternInput: document.getElementById('sourceUrlPatternInput'),
    titleIdRegexInput: document.getElementById('titleIdRegexInput'),
    targetUrlTemplateInput: document.getElementById('targetUrlTemplateInput'),
    runBackupBtn: document.getElementById('runBackupBtn'),
    deleteAllBtn: document.getElementById('deleteAllBtn'),
    backupList: document.getElementById('backupList'),
    status: document.getElementById('status')
  };

  /**
   * Update the status message area.
   *
   * @param {string} message User-visible status text.
   * @param {boolean} [isError=false] Whether the status should be styled as an error.
   * @returns {void}
   */
  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('status--error', Boolean(isError));
  }

  /**
   * Format an ISO timestamp for the backup list.
   *
   * @param {string} iso ISO timestamp.
   * @returns {string} Localized date string.
   */
  function formatDate(iso) {
    if (!iso) return 'unbekannt';
    try {
      return new Date(iso).toLocaleString();
    } catch (_) {
      return iso;
    }
  }

  /**
   * Format a byte count into a compact human-readable label.
   *
   * @param {number} bytes Byte count.
   * @returns {string} Formatted size string.
   */
  function formatBytes(bytes) {
    const val = Number(bytes) || 0;
    if (val < 1024) return `${val} B`;
    if (val < 1024 * 1024) return `${(val / 1024).toFixed(1)} KB`;
    return `${(val / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Clamp and round the backup interval to the supported range.
   *
   * @param {string|number} raw Raw interval value.
   * @returns {number} Sanitized interval in minutes.
   */
  function sanitizeInterval(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return 60;
    return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Math.round(value)));
  }

  /**
   * Apply the auto-backup config to the options form controls.
   *
   * @param {{ enabled?: boolean, intervalMinutes?: number }} config Backup config.
   * @returns {void}
   */
  function setFormState(config) {
    els.enabledInput.checked = !!config.enabled;
    els.intervalInput.value = String(config.intervalMinutes || 60);
    els.intervalInput.disabled = !config.enabled;
  }

  /**
   * Apply the URL transformation config to the options form controls.
   *
   * @param {object} config URL transformation config.
   * @returns {void}
   */
  function setTransformFormState(config) {
    const c = rbUrlTransform.normalizeConfig(config);
    els.transformEnabledInput.checked = !!c.enabled;
    els.sourceUrlPatternInput.value = c.sourceUrlPattern;
    els.titleIdRegexInput.value = c.titleIdRegex;
    els.targetUrlTemplateInput.value = c.targetUrlTemplate;
  }

  /**
   * Convert an internal backup reason into a localized display label.
   *
   * @param {string} reason Backup reason key.
   * @returns {string} Human-readable label.
   */
  function backupReasonLabel(reason) {
    if (reason === 'interval') return 'Intervall';
    if (reason === 'change') return 'Änderung';
    if (reason === 'manual') return 'Manuell';
    if (reason === 'pre-restore') return 'Vor Wiederherstellung';
    if (reason === 'startup') return 'Start';
    if (reason === 'install-init') return 'Installation';
    return reason || 'Unbekannt';
  }

  /**
   * Request the current auto-backup state from the background script.
   *
   * @returns {Promise<object>} State payload containing config and backup metadata.
   */
  async function requestState() {
    const response = await ext.runtime.sendMessage({ type: 'autoBackupGetState' });
    if (!response?.ok) throw new Error(response?.error || 'Status konnte nicht geladen werden.');
    return response;
  }

  /**
   * Render the list of stored backups with restore and delete actions.
   *
   * @param {Array<object>} backups Backup metadata list.
   * @returns {void}
   */
  function renderBackups(backups) {
    els.backupList.innerHTML = '';
    if (!backups.length) {
      const empty = document.createElement('div');
      empty.className = 'backup';
      empty.textContent = 'Keine Backups vorhanden.';
      els.backupList.appendChild(empty);
      return;
    }

    for (const backup of backups) {
      const wrap = document.createElement('div');
      wrap.className = 'backup';

      const top = document.createElement('div');
      top.className = 'backup__top';
      const title = document.createElement('strong');
      title.textContent = formatDate(backup.createdAt);
      const actions = document.createElement('div');
      actions.className = 'backup__actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn btn--primary';
      restoreBtn.type = 'button';
      restoreBtn.textContent = 'Wiederherstellen';
      restoreBtn.addEventListener('click', async () => {
        const ok = confirm(
          'Dieses Backup wiederherstellen? Aktuelle Daten werden ersetzt. ' +
          'Es wird vorher automatisch ein Sicherheits-Backup erstellt.'
        );
        if (!ok) return;
        try {
          setStatus('Wiederherstellung läuft ...');
          const response = await ext.runtime.sendMessage({ type: 'autoBackupRestore', backupId: backup.id });
          if (!response?.ok) throw new Error(response?.error || 'Wiederherstellung fehlgeschlagen.');
          await load();
          setStatus('Backup wurde wiederhergestellt.');
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Löschen';
      deleteBtn.addEventListener('click', async () => {
        try {
          const response = await ext.runtime.sendMessage({ type: 'autoBackupDelete', backupId: backup.id });
          if (!response?.ok) throw new Error(response?.error || 'Löschen fehlgeschlagen.');
          renderBackups(response.backups || []);
          setStatus('Backup gelöscht.');
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      });

      actions.append(restoreBtn, deleteBtn);
      top.append(title, actions);

      const meta = document.createElement('div');
      meta.className = 'backup__meta';
      meta.textContent =
        `${backupReasonLabel(backup.reason)} | ${backup.topics} Themen | ${backup.entries} Einträge | ${formatBytes(backup.sizeBytes)}`;

      wrap.append(top, meta);
      els.backupList.appendChild(wrap);
    }
  }

  /**
   * Load the complete options-page state and push it into the UI.
   *
   * @returns {Promise<void>}
   */
  async function load() {
    const state = await requestState();
    setFormState(state.config || {});
    renderBackups(state.backups || []);
    const transformConfig = await rbUrlTransform.getConfig();
    setTransformFormState(transformConfig);
  }

  // Wire backup and URL transform forms once; the page itself stays static after load.
  els.enabledInput.addEventListener('change', () => {
    els.intervalInput.disabled = !els.enabledInput.checked;
  });

  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {
      enabled: els.enabledInput.checked,
      intervalMinutes: sanitizeInterval(els.intervalInput.value)
    };

    try {
      const response = await ext.runtime.sendMessage({ type: 'autoBackupUpdateConfig', patch });
      if (!response?.ok) throw new Error(response?.error || 'Einstellungen konnten nicht gespeichert werden.');
      setFormState(response.config || patch);
      setStatus('Einstellungen gespeichert.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });

  els.runBackupBtn.addEventListener('click', async () => {
    try {
      const response = await ext.runtime.sendMessage({ type: 'autoBackupRunNow' });
      if (!response?.ok) throw new Error(response?.error || 'Backup konnte nicht erstellt werden.');
      renderBackups(response.backups || []);
      const result = response.result || {};
      setStatus(result.saved ? 'Backup wurde erstellt.' : 'Keine Änderungen seit dem letzten Backup.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });

  els.deleteAllBtn.addEventListener('click', async () => {
    const ok = confirm('Alle gespeicherten Backups löschen?');
    if (!ok) return;
    try {
      const response = await ext.runtime.sendMessage({ type: 'autoBackupDeleteAll' });
      if (!response?.ok) throw new Error(response?.error || 'Backups konnten nicht gelöscht werden.');
      renderBackups([]);
      setStatus('Alle Backups gelöscht.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });

  els.transformForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {
      enabled: els.transformEnabledInput.checked,
      sourceUrlPattern: els.sourceUrlPatternInput.value,
      titleIdRegex: els.titleIdRegexInput.value,
      targetUrlTemplate: els.targetUrlTemplateInput.value
    };
    const check = rbUrlTransform.validateConfig(patch);
    if (!check.ok) {
      setStatus(check.error || 'URL-Umschreibung ist ungültig.', true);
      return;
    }
    try {
      const saved = await rbUrlTransform.setConfig(check.config);
      setTransformFormState(saved);
      setStatus('URL-Umschreibung gespeichert.');
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });

  load()
    .then(() => setStatus('Einstellungen geladen.'))
    .catch((error) => setStatus(error.message || String(error), true));
})();
