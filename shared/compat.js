(() => {
  /**
   * Shared extension API compatibility bridge.
   *
   * This module exposes a single global `ext` object that the rest of the addon can
   * use without caring whether it runs in a Firefox-style `browser.*` environment
   * or a Chrome-style `chrome.*` environment.
   *
   * Strategy:
   * - prefer `browser` when available because it is already Promise-based
   * - fall back to `chrome` and wrap the callback-style APIs used by this addon
   * - expose only the subset of APIs that the current codebase depends on
   *
   * The goal is to keep compatibility concerns isolated here so the application code
   * can consistently call `ext.*` without scattering browser-specific branching.
   */
  if (typeof globalThis.browser !== 'undefined') {
    // Firefox and some Chromium environments already provide the Promise-based API shape we want.
    globalThis.ext = globalThis.browser;
    return;
  }
  if (typeof globalThis.chrome === 'undefined') {
    throw new Error('No extension API found (browser/chrome).');
  }

  /**
   * Convert a callback-based Chrome extension API method into a Promise-returning function.
   *
   * @template T
   * @param {Function} fn Chrome API function.
   * @param {object} ctx Invocation context for the function.
   * @returns {(...args: any[]) => Promise<T>} Promise-returning wrapper.
   */
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

  // Build only the API surface currently needed by the addon runtime.
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
    // Alarms are optional in some contexts, so keep the adapter conditional.
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

  // Expose the normalized compatibility layer for all other scripts.
  globalThis.ext = ext;
})();
