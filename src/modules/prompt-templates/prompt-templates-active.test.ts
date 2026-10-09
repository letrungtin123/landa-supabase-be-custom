import assert from 'node:assert/strict';
import test from 'node:test';

// S2: any signed-in user can list the active mascots for the persona picker;
// the system prompts are never part of that answer.

test('the active mascot list selects display fields only', async (t) => {
  const pg = await import('pg');
  const sqls: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    sqls.push(text);
    return { rows: [{ id: 't1', name: 'Mascot', description: 'd', avatar_url: null, fullbody_url: null, sort_order: 1 }], rowCount: 1 };
  });
  const service = await import('./prompt-templates.service.js');
  const rows = await service.listActiveTemplates();
  assert.equal(sqls.length, 1);
  assert.match(sqls[0], /SELECT id, name, description, avatar_url, fullbody_url, sort_order\s+FROM system_prompt_templates/);
  assert.doesNotMatch(sqls[0], /\*|prompt\b|voice_prompt|created_by/);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['avatar_url', 'description', 'fullbody_url', 'id', 'name', 'sort_order']);
});
