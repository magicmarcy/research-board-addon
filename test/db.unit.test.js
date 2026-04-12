const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Unit tests for shared/db.js
 *
 * Scope of this file:
 * - pure normalization helpers
 * - lightweight storage-local related helpers using a mock
 *
 * Out of scope:
 * - IndexedDB CRUD/integration flows (covered by separate integration tests later)
 */

function createStorageLocalMock(initialState = {}) {
  let state = { ...initialState };

  return {
    async get(defaults) {
      if (defaults === undefined) return { ...state };
      if (typeof defaults === 'string') {
        return { [defaults]: state[defaults] };
      }
      if (Array.isArray(defaults)) {
        const result = {};
        for (const key of defaults) result[key] = state[key];
        return result;
      }
      if (defaults && typeof defaults === 'object') {
        const result = { ...defaults };
        for (const key of Object.keys(defaults)) {
          if (Object.prototype.hasOwnProperty.call(state, key)) {
            result[key] = state[key];
          }
        }
        return result;
      }
      return { ...state };
    },
    async set(patch) {
      state = { ...state, ...(patch || {}) };
    },
    snapshot() {
      return { ...state };
    }
  };
}

let storageLocal;

beforeEach(() => {
  storageLocal = createStorageLocalMock();
  globalThis.ext = { storage: { local: storageLocal } };
});

require('../shared/db.js');

const {
  normalizeTodoItems,
  normalizeEntrySortMode,
  normalizeAppSettings,
  appSettingsKeys,
  appSettingsDefaults,
  exportAppSettings,
  applyImportedSettings,
  getChangeState,
  touchChangeToken,
  changeStateKeys
} = globalThis.rbDB;

describe('normalizeTodoItems', () => {
  test('returns empty list for non-array input', () => {
    assert.deepEqual(normalizeTodoItems(null), []);
    assert.deepEqual(normalizeTodoItems(undefined), []);
    assert.deepEqual(normalizeTodoItems('not-an-array'), []);
  });

  test('trims text, filters empty todos, and applies defaults', () => {
    const input = [
      { text: '  first task  ', done: 1 },
      { text: '   ' },
      { id: 'keep-me', text: 'second task', done: false }
    ];

    const result = normalizeTodoItems(input);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      id: 'todo-1',
      text: 'first task',
      done: true
    });
    assert.deepEqual(result[1], {
      id: 'keep-me',
      text: 'second task',
      done: false
    });
  });
});

describe('normalizeEntrySortMode', () => {
  test('keeps allowed values and falls back to custom', () => {
    assert.equal(normalizeEntrySortMode('custom'), 'custom');
    assert.equal(normalizeEntrySortMode('type'), 'type');
    assert.equal(normalizeEntrySortMode('title'), 'title');
    assert.equal(normalizeEntrySortMode('type_then_title'), 'type_then_title');
    assert.equal(normalizeEntrySortMode('unknown-mode'), 'custom');
    assert.equal(normalizeEntrySortMode(undefined), 'custom');
  });
});

describe('normalizeAppSettings', () => {
  test('returns defaults for invalid/empty input', () => {
    const settings = normalizeAppSettings();

    assert.equal(settings[appSettingsKeys.lastTopicId], null);
    assert.equal(settings[appSettingsKeys.includeArchived], false);
    assert.equal(settings[appSettingsKeys.includeArchivedEntries], false);
    assert.equal(settings[appSettingsKeys.themeMode], 'light');
    assert.deepEqual(settings[appSettingsKeys.autoBackupConfig], appSettingsDefaults[appSettingsKeys.autoBackupConfig]);
    assert.deepEqual(settings[appSettingsKeys.urlTransformConfig], {
      enabled: false,
      sourceUrlPattern: '',
      titleIdRegex: appSettingsDefaults[appSettingsKeys.urlTransformConfig].titleIdRegex,
      targetUrlTemplate: '',
      idPlaceholder: appSettingsDefaults[appSettingsKeys.urlTransformConfig].idPlaceholder
    });
  });

  test('clamps and rounds auto backup interval', () => {
    const low = normalizeAppSettings({
      [appSettingsKeys.autoBackupConfig]: { enabled: true, intervalMinutes: 1.2 }
    });
    assert.deepEqual(low[appSettingsKeys.autoBackupConfig], { enabled: true, intervalMinutes: 5 });

    const high = normalizeAppSettings({
      [appSettingsKeys.autoBackupConfig]: { enabled: false, intervalMinutes: 500000 }
    });
    assert.deepEqual(high[appSettingsKeys.autoBackupConfig], { enabled: false, intervalMinutes: 10080 });

    const rounded = normalizeAppSettings({
      [appSettingsKeys.autoBackupConfig]: { enabled: true, intervalMinutes: '59.7' }
    });
    assert.deepEqual(rounded[appSettingsKeys.autoBackupConfig], { enabled: true, intervalMinutes: 60 });
  });

  test('normalizes theme and url transform fields', () => {
    const settings = normalizeAppSettings({
      [appSettingsKeys.themeMode]: 'dark',
      [appSettingsKeys.urlTransformConfig]: {
        enabled: 1,
        sourceUrlPattern: 123,
        titleIdRegex: '',
        targetUrlTemplate: null,
        idPlaceholder: 42
      }
    });

    assert.equal(settings[appSettingsKeys.themeMode], 'dark');
    assert.deepEqual(settings[appSettingsKeys.urlTransformConfig], {
      enabled: true,
      sourceUrlPattern: '123',
      titleIdRegex: appSettingsDefaults[appSettingsKeys.urlTransformConfig].titleIdRegex,
      targetUrlTemplate: '',
      idPlaceholder: '42'
    });
  });

  test('normalizes lastTopicId empty values to null', () => {
    const settings = normalizeAppSettings({ [appSettingsKeys.lastTopicId]: '' });
    assert.equal(settings[appSettingsKeys.lastTopicId], null);
  });
});

describe('storage helper functions', () => {
  test('applyImportedSettings persists normalized values and supports lastTopicId override', async () => {
    const persisted = await applyImportedSettings(
      {
        [appSettingsKeys.themeMode]: 'invalid-theme',
        [appSettingsKeys.includeArchived]: 1,
        [appSettingsKeys.autoBackupConfig]: { enabled: true, intervalMinutes: 2 }
      },
      { lastTopicId: 'topic-123' }
    );

    assert.equal(persisted[appSettingsKeys.themeMode], 'light');
    assert.equal(persisted[appSettingsKeys.includeArchived], true);
    assert.equal(persisted[appSettingsKeys.autoBackupConfig].intervalMinutes, 5);
    assert.equal(persisted[appSettingsKeys.lastTopicId], 'topic-123');

    const snapshot = storageLocal.snapshot();
    assert.equal(snapshot[appSettingsKeys.lastTopicId], 'topic-123');
    assert.equal(snapshot[appSettingsKeys.themeMode], 'light');
  });

  test('exportAppSettings returns normalized settings from storage.local', async () => {
    await storageLocal.set({
      [appSettingsKeys.themeMode]: 'dark',
      [appSettingsKeys.urlTransformConfig]: {
        enabled: true,
        sourceUrlPattern: 'https://example.com/',
        titleIdRegex: '#(\\d+)',
        targetUrlTemplate: 'https://target/{value}',
        idPlaceholder: '{value}'
      }
    });

    const exported = await exportAppSettings();

    assert.equal(exported[appSettingsKeys.themeMode], 'dark');
    assert.equal(exported[appSettingsKeys.urlTransformConfig].enabled, true);
    assert.equal(exported[appSettingsKeys.urlTransformConfig].sourceUrlPattern, 'https://example.com/');
  });

  test('getChangeState returns empty defaults when no token exists', async () => {
    const state = await getChangeState();
    assert.deepEqual(state, { token: '', changedAt: '' });
  });

  test('touchChangeToken writes token metadata into storage.local', async () => {
    const state = await touchChangeToken();
    const snapshot = storageLocal.snapshot();

    assert.equal(typeof state.token, 'string');
    assert.equal(state.token.length > 0, true);
    assert.equal(typeof state.changedAt, 'string');
    assert.equal(state.changedAt.length > 0, true);

    assert.equal(snapshot[changeStateKeys.token], state.token);
    assert.equal(snapshot[changeStateKeys.changedAt], state.changedAt);
    assert.equal(typeof snapshot[changeStateKeys.signal], 'number');
  });
});
