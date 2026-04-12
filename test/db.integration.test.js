const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('fake-indexeddb/auto');

/**
 * Integration tests for shared/db.js
 *
 * Scope of this file:
 * - exercises real IndexedDB operations (via fake-indexeddb)
 * - validates behavior across multiple persistence helpers together
 *
 * Not in scope:
 * - sidebar/UI rendering
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
    reset() {
      state = {};
    }
  };
}

const storageLocal = createStorageLocalMock();
globalThis.ext = { storage: { local: storageLocal } };

require('../shared/db.js');

const {
  openDb,
  addTopic,
  getAllTopics,
  addEntry,
  getEntriesByTopic,
  setEntryArchived,
  moveEntryToTopic,
  reorderEntries,
  deleteTopic,
  getTopic,
  getAllEntries,
  clearAll,
  clearBackups
} = globalThis.rbDB;

let db;

beforeEach(async () => {
  storageLocal.reset();
  db = await openDb();
  await clearAll(db);
  await clearBackups(db);
});

describe('topic and entry persistence integration', () => {
  test('addTopic stores normalized values and stable position ordering', async () => {
    const topicA = await addTopic(db, { title: '  Alpha  ', entrySortMode: 'invalid-mode' });
    const topicB = await addTopic(db, { title: 'Beta', entrySortMode: 'title' });

    const topics = await getAllTopics(db, { includeArchived: true });

    assert.equal(topicA.title, 'Alpha');
    assert.equal(topicA.entrySortMode, 'custom');
    assert.equal(topicA.position, 1);
    assert.equal(topicB.position, 2);
    assert.deepEqual(topics.map((t) => t.id), [topicA.id, topicB.id]);
  });

  test('setEntryArchived moves entry to archived bucket and appends at bucket end', async () => {
    const topic = await addTopic(db, { title: 'Main' });

    const activeA = await addEntry(db, topic.id, { type: 'note', title: 'active-a' });
    const activeB = await addEntry(db, topic.id, { type: 'note', title: 'active-b' });
    const archivedExisting = await addEntry(db, topic.id, {
      type: 'note',
      title: 'archived-existing',
      archived: true
    });

    const updated = await setEntryArchived(db, activeA.id, true);
    const allEntries = await getEntriesByTopic(db, topic.id, { includeArchived: true });

    assert.equal(updated.archived, true);
    assert.equal(updated.position, 2);

    // Expected grouped order: active bucket first, then archived bucket.
    assert.deepEqual(allEntries.map((entry) => entry.id), [
      activeB.id,
      archivedExisting.id,
      activeA.id
    ]);
  });

  test('reorderEntries updates only matching topic + archive bucket', async () => {
    const topic = await addTopic(db, { title: 'Order' });

    const activeA = await addEntry(db, topic.id, { type: 'note', title: 'A' });
    const activeB = await addEntry(db, topic.id, { type: 'note', title: 'B' });
    const archivedC = await addEntry(db, topic.id, { type: 'note', title: 'C', archived: true });

    await reorderEntries(db, topic.id, [activeB.id, activeA.id, archivedC.id], { archived: false });

    const allEntries = await getEntriesByTopic(db, topic.id, { includeArchived: true });

    assert.deepEqual(allEntries.map((entry) => entry.id), [
      activeB.id,
      activeA.id,
      archivedC.id
    ]);

    assert.equal(allEntries[0].position, 1);
    assert.equal(allEntries[1].position, 2);
    // Archived entry remains in its own bucket ordering.
    assert.equal(allEntries[2].position, 1);
  });

  test('moveEntryToTopic appends to target topic ordering', async () => {
    const sourceTopic = await addTopic(db, { title: 'Source' });
    const targetTopic = await addTopic(db, { title: 'Target' });

    const targetExisting = await addEntry(db, targetTopic.id, { type: 'note', title: 'target-existing' });
    const sourceEntry = await addEntry(db, sourceTopic.id, { type: 'note', title: 'source-entry' });

    const moved = await moveEntryToTopic(db, sourceEntry.id, targetTopic.id);
    const targetEntries = await getEntriesByTopic(db, targetTopic.id, { includeArchived: true });

    assert.equal(moved.topicId, targetTopic.id);
    assert.equal(moved.position, 2);
    assert.deepEqual(targetEntries.map((entry) => entry.id), [targetExisting.id, sourceEntry.id]);
  });

  test('deleteTopic removes dependent entries (cascade behavior)', async () => {
    const topicA = await addTopic(db, { title: 'Delete me' });
    const topicB = await addTopic(db, { title: 'Keep me' });

    await addEntry(db, topicA.id, { type: 'note', title: 'a-1' });
    const keepEntry = await addEntry(db, topicB.id, { type: 'note', title: 'b-1' });

    await deleteTopic(db, topicA.id);

    const deletedTopic = await getTopic(db, topicA.id);
    const remainingEntries = await getAllEntries(db);

    assert.equal(deletedTopic, undefined);
    assert.deepEqual(remainingEntries.map((entry) => entry.id), [keepEntry.id]);
  });
});
