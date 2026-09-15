import assert from 'node:assert/strict';
import test from 'node:test';
import { LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY } from './lesson-author-message.logic.js';

test('proposal hydration query uses the job tenant scope without an undeclared alias', () => {
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /FROM lesson_author_jobs laj/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.conversation_id = \$1/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.tenant_id = \$2/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.id = ANY\(\$3::uuid\[\]\)/);
  assert.doesNotMatch(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /\bc\.tenant_id\b/);
});
