(() => {
  /**
   * Detached note popup runtime.
   *
   * This script powers the standalone popup window used to edit long note or quote
   * content outside the constrained sidebar layout. It is intentionally minimal:
   * - read popup configuration from query parameters
   * - mirror the sidebar theme and title
   * - establish a `BroadcastChannel` connection back to the sidebar
   * - initialize the editor content
   * - report apply/save/close actions back to the opener
   *
   * The popup does not persist data itself. It only acts as a focused editing
   * surface while the sidebar remains the owner of storage and mutation logic.
   */
  const params = new URLSearchParams(location.search);
  const channelId = params.get('channel') || '';
  const baseTitle = params.get('title') || 'Notiz bearbeiten';
  const theme = params.get('theme') || 'light';
  const showTitleEditor = params.get('showTitleEditor') === '1';

  // Cache the popup DOM nodes once; there is no dynamic rerendering in this window.
  const titleNode = document.getElementById('popupTitle');
  const titleFieldWrap = document.getElementById('titleFieldWrap');
  const titleEditor = document.getElementById('titleEditor');
  const editor = document.getElementById('editor');
  const closeBtn = document.getElementById('closeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const applyBtn = document.getElementById('applyBtn');

  /**
   * Keep the browser window title aligned with the note title when available.
   *
   * @returns {void}
   */
  const syncWindowTitle = () => {
    const currentTitle = showTitleEditor ? String(titleEditor?.value || '').trim() : '';
    document.title = currentTitle || baseTitle;
  };

  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  if (titleNode) titleNode.textContent = baseTitle;
  if (showTitleEditor) {
    titleFieldWrap?.classList.remove('hidden');
    titleEditor?.addEventListener('input', syncWindowTitle);
  } else {
    titleFieldWrap?.classList.add('hidden');
  }
  syncWindowTitle();

  // Abort early if the popup cannot communicate with its opener or the editor is missing.
  if (!channelId || !editor) {
    return;
  }

  const channel = new BroadcastChannel(channelId);
  channel.postMessage({ type: 'popupReady' });
  let saveRequestSeq = 0;
  let lastAckedSaveSeq = 0;

  /**
   * Notify the opener that the popup is closing and then close the popup window.
   *
   * @returns {void}
   */
  const close = async () => {
    if (saveRequestSeq > lastAckedSaveSeq) {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    try {
      channel.postMessage({ type: 'close' });
      channel.close();
    } catch (_) {}
    window.close();
  };

  /**
   * Submit the current editor content and close the popup.
   *
   * @returns {void}
   */
  const apply = () => {
    channel.postMessage({
      type: 'apply',
      value: editor.value,
      entryTitle: showTitleEditor ? String(titleEditor?.value ?? '') : undefined
    });
    close();
  };

  /**
   * Submit the current editor content without closing the popup.
   *
   * @returns {void}
   */
  const saveWithoutClose = () => {
    saveRequestSeq += 1;
    channel.postMessage({
      type: 'saveNoClose',
      value: editor.value,
      entryTitle: showTitleEditor ? String(titleEditor?.value ?? '') : undefined,
      requestId: saveRequestSeq
    });
  };

  /**
   * Receive initialization messages from the sidebar and seed the editor value.
   *
   * @param {MessageEvent} ev BroadcastChannel message event.
   * @returns {void}
   */
  channel.onmessage = (ev) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'initValue') {
      editor.value = String(msg.value ?? '');
      if (showTitleEditor && titleEditor && Object.prototype.hasOwnProperty.call(msg, 'entryTitle')) {
        titleEditor.value = String(msg.entryTitle ?? '');
      }
      syncWindowTitle();
      editor.focus();
      return;
    }
    if (msg.type === 'saveNoCloseAck') {
      const ackId = Number(msg.requestId);
      if (Number.isFinite(ackId) && ackId > lastAckedSaveSeq) {
        lastAckedSaveSeq = ackId;
      }
    }
  };

  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);
  applyBtn?.addEventListener('click', apply);

  // Mirror the primary popup shortcuts used by the sidebar integration.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      void close();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      saveWithoutClose();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'enter') {
      ev.preventDefault();
      apply();
    }
  });

  // Ensure the channel is closed even when the user dismisses the window directly.
  window.addEventListener('beforeunload', () => {
    try {
      channel.postMessage({ type: 'close' });
      channel.close();
    } catch (_) {}
  });
})();
