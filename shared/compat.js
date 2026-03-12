// Compatibility helper for Firefox/Chrome style extension APIs.
// Prefer `browser` (Promise-based). Fallback to `chrome` (callback-based) with small wrappers.
(() => {
  if (typeof globalThis.browser !== 'undefined') {
    globalThis.ext = globalThis.browser;
    return;
  }
  if (typeof globalThis.chrome === 'undefined') {
    throw new Error('No extension API found (browser/chrome).');
  }

  // Minimal Promise wrapper for the bits we use.
  const promisify = (fn, ctx) => (...args) => new Promise((resolve, reject) => {
    try {
      fn.call(ctx, ...args, (result) => {
        const err = globalThis.chrome.runtime?.lastError;
        if (err) reject(err);
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });

  const chromeApi = globalThis.chrome;
  const ext = {
    runtime: {
      getURL: chromeApi.runtime.getURL.bind(chromeApi.runtime),
      sendMessage: promisify(chromeApi.runtime.sendMessage, chromeApi.runtime),
      onMessage: chromeApi.runtime.onMessage,
      onInstalled: chromeApi.runtime.onInstalled,
      onStartup: chromeApi.runtime.onStartup
    },
    storage: {
      onChanged: chromeApi.storage.onChanged,
      local: {
        get: promisify(chromeApi.storage.local.get, chromeApi.storage.local),
        set: promisify(chromeApi.storage.local.set, chromeApi.storage.local),
        remove: promisify(chromeApi.storage.local.remove, chromeApi.storage.local)
      }
    },
    tabs: {
      query: promisify(chromeApi.tabs.query, chromeApi.tabs),
      get: promisify(chromeApi.tabs.get, chromeApi.tabs),
      create: promisify(chromeApi.tabs.create, chromeApi.tabs)
    },
    alarms: chromeApi.alarms
      ? {
        create: (name, alarmInfo) => chromeApi.alarms.create(name, alarmInfo),
        clear: promisify(chromeApi.alarms.clear, chromeApi.alarms),
        onAlarm: chromeApi.alarms.onAlarm
      }
      : undefined,
    contextMenus: chromeApi.contextMenus,
    menus: chromeApi.contextMenus,
    sidebarAction: chromeApi.sidebarAction,
    action: chromeApi.action || chromeApi.browserAction
  };

  globalThis.ext = ext;
})();
