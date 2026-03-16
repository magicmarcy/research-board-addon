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
  const title = params.get('title') || 'Notiz bearbeiten';
  const theme = params.get('theme') || 'light';

  // Cache the popup DOM nodes once; there is no dynamic rerendering in this window.
  const titleNode = document.getElementById('popupTitle');
  const editor = document.getElementById('editor');
  const closeBtn = document.getElementById('closeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const applyBtn = document.getElementById('applyBtn');

  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  document.title = title;
  if (titleNode) titleNode.textContent = title;

  // Abort early if the popup cannot communicate with its opener or the editor is missing.
  if (!channelId || !editor) {
    return;
  }

  const channel = new BroadcastChannel(channelId);
  channel.postMessage({ type: 'popupReady' });

  /**
   * Notify the opener that the popup is closing and then close the popup window.
   *
   * @returns {void}
   */
  const close = () => {
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
    channel.postMessage({ type: 'apply', value: editor.value });
    close();
  };

  /**
   * Submit the current editor content without closing the popup.
   *
   * @returns {void}
   */
  const saveWithoutClose = () => {
    channel.postMessage({ type: 'saveNoClose', value: editor.value });
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
      editor.focus();
    }
  };

  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);
  applyBtn?.addEventListener('click', apply);

  // Mirror the primary popup shortcuts used by the sidebar integration.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
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
