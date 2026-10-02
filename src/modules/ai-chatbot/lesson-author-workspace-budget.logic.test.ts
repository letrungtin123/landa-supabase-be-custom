import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceBudgetManifest, workspaceBudgetForNextItem } from './lesson-author-workspace-budget.logic.js';
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function chapter(index = 0, units = 3) {
  return { chapter_node_id: uuid(index * 1000 + 1), chapter_contract_hash: 'a'.repeat(64),
    units: Array.from({ length: units }, (_, i) => ({ node_id: uuid(index * 1000 + i + 2), contract_hash: 'b'.repeat(64) })),
    fixed_input_tokens: 1000, embedding_tokens: 100, output_tokens: 30000, max_provider_attempts: 2 };
}
test('split work items conserve existing chapter reservation formula, final validation has no generated output budget', () => {
  const b = buildWorkspaceBudgetManifest([chapter()]);
  assert.equal(b.token_ceiling, 1000 * 7 + 100 * 4 + 30000 * 3 * 2);
  assert.equal(b.manifest.entries.length, 4); assert.equal(b.execution_budget_ms, 4 * 600000);
  assert.equal(b.usage_source, 'local_estimate');
  assert.equal(b.manifest.entries[0].max_output_tokens, 30000);
  assert.equal(b.manifest.entries[0].max_provider_attempts, 2);
  assert.equal(b.manifest.entries.at(-1)?.kind, 'validate_chapter');
  assert.equal(b.manifest.entries.at(-1)?.output_tokens, 0);
  assert.equal(b.manifest.entries.at(-1)?.max_provider_attempts, 0);
});
test('each chapter retains 2m cap; workspace total is frozen sum not one expiring reservation', () => {
  const b = buildWorkspaceBudgetManifest([chapter(0, 20), chapter(1, 20)]);
  assert.ok(b.token_ceiling > 2_000_000); assert.equal(b.manifest.entries.length, 42);
  assert.throws(() => buildWorkspaceBudgetManifest([chapter(0, 40)]), /WORKSPACE_CHAPTER_BUDGET_CAPACITY_EXCEEDED/);
});
test('invalid numbers, duplicate targets, oversized inventory and overflow reject without silent reserve cap', () => {
  for (const patch of [{ output_tokens: 0 }, { output_tokens: 65537 }, { max_provider_attempts: 3 }, { max_provider_attempts: NaN }, { fixed_input_tokens: -1 }, { embedding_tokens: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => buildWorkspaceBudgetManifest([{ ...chapter(), ...patch }]), /WORKSPACE_BUDGET_INVALID/);
  }
  assert.throws(() => buildWorkspaceBudgetManifest([chapter(), chapter()]), /WORKSPACE_BUDGET_INVALID/);
  assert.throws(() => buildWorkspaceBudgetManifest([chapter(0, 513)]), /WORKSPACE_BUDGET_INVALID/);
});
test('next item follows persisted completion order; holds and savings never authorize implicit retries', () => {
  const b = buildWorkspaceBudgetManifest([chapter()]);
  assert.equal(workspaceBudgetForNextItem(b.manifest, b.manifest_hash, [], null).ordinal, 0);
  assert.equal(workspaceBudgetForNextItem(b.manifest, b.manifest_hash, [0, 1], null).ordinal, 2);
  for (const completed of [[1], [0, 0], [0, 2]]) assert.throws(() => workspaceBudgetForNextItem(b.manifest, b.manifest_hash, completed, null));
  assert.throws(() => workspaceBudgetForNextItem(b.manifest, b.manifest_hash, [], 0));
  assert.throws(() => workspaceBudgetForNextItem(b.manifest, b.manifest_hash, [0, 1, 2, 3], null), /WORKSPACE_BUDGET_EXHAUSTED/);
  const changed = structuredClone(b.manifest); changed.entries[0].max_output_tokens++;
  assert.throws(() => workspaceBudgetForNextItem(changed, b.manifest_hash, [], null));
});
