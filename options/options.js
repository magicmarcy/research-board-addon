(() => {
  const MIN_INTERVAL = 5;
  const MAX_INTERVAL = 10080;

  const els = {
    settingsForm: document.getElementById('settingsForm'),
    enabledInput: document.getElementById('enabledInput'),
    intervalInput: document.getElementById('intervalInput'),
    runBackupBtn: document.getElementById('runBackupBtn'),
    deleteAllBtn: document.getElementById('deleteAllBtn'),
    backupList: document.getElementById('backupList'),
    status: document.getElementById('status')
  };

  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('status--error', Boolean(isError));
  }

  function formatDate(iso) {
    if (!iso) return 'unbekannt';
    try {
      return new Date(iso).toLocaleString();
    } catch (_) {
      return iso;
    }
  }

  function formatBytes(bytes) {
    const val = Number(bytes) || 0;
    if (val < 1024) return `${val} B`;
    if (val < 1024 * 1024) return `${(val / 1024).toFixed(1)} KB`;
    return `${(val / (1024 * 1024)).toFixed(2)} MB`;
  }

  function sanitizeInterval(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return 60;
    return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Math.round(value)));
  }

  function setFormState(config) {
    els.enabledInput.checked = !!config.enabled;
    els.intervalInput.value = String(config.intervalMinutes || 60);
    els.intervalInput.disabled = !config.enabled;
  }

  function backupReasonLabel(reason) {
    if (reason === 'interval') return 'Intervall';
    if (reason === 'manual') return 'Manuell';
    if (reason === 'pre-restore') return 'Vor Wiederherstellung';
    if (reason === 'startup') return 'Start';
    if (reason === 'install-init') return 'Installation';
    return reason || 'Unbekannt';
  }

  async function requestState() {
    const response = await ext.runtime.sendMessage({ type: 'autoBackupGetState' });
    if (!response?.ok) throw new Error(response?.error || 'Status konnte nicht geladen werden.');
    return response;
  }

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

  async function load() {
    const state = await requestState();
    setFormState(state.config || {});
    renderBackups(state.backups || []);
  }

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

  load()
    .then(() => setStatus('Einstellungen geladen.'))
    .catch((error) => setStatus(error.message || String(error), true));
})();
