(() => {
  const params = new URLSearchParams(location.search);
  const channelId = params.get('channel') || '';
  const title = params.get('title') || 'Notiz bearbeiten';
  const theme = params.get('theme') || 'light';

  const titleNode = document.getElementById('popupTitle');
  const editor = document.getElementById('editor');
  const closeBtn = document.getElementById('closeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const applyBtn = document.getElementById('applyBtn');

  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  document.title = title;
  if (titleNode) titleNode.textContent = title;

  if (!channelId || !editor) {
    return;
  }

  const channel = new BroadcastChannel(channelId);
  channel.postMessage({ type: 'popupReady' });

  const close = () => {
    try {
      channel.postMessage({ type: 'close' });
      channel.close();
    } catch (_) {}
    window.close();
  };

  const apply = () => {
    channel.postMessage({ type: 'apply', value: editor.value });
    close();
  };

  const saveWithoutClose = () => {
    channel.postMessage({ type: 'saveNoClose', value: editor.value });
  };

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

  window.addEventListener('beforeunload', () => {
    try {
      channel.postMessage({ type: 'close' });
      channel.close();
    } catch (_) {}
  });
})();
