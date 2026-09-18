import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeOptionalHistoryState } from './permission-group-history.service.js';

const state = {
  group: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Nhóm quyền', description: '' },
  matrix: [],
};

test('permission group history writes an absent before or after snapshot as SQL NULL', () => {
  assert.equal(serializeOptionalHistoryState(undefined), null);
  assert.equal(serializeOptionalHistoryState(null), null);
});

test('permission group history serializes an existing snapshot as a JSON object', () => {
  const serialized = serializeOptionalHistoryState(state);
  assert.ok(serialized);
  assert.deepEqual(JSON.parse(serialized), state);
});
