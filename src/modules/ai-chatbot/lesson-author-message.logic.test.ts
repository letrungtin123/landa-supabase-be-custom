import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLessonAuthorApprovalMessage,
  LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY,
} from './lesson-author-message.logic.js';

test('proposal hydration query uses the job tenant scope without an undeclared alias', () => {
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /FROM lesson_author_jobs laj/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.conversation_id = \$1/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.tenant_id = \$2/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /laj\.id = ANY\(\$3::uuid\[\]\)/);
  assert.doesNotMatch(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /\bc\.tenant_id\b/);
});

test('proposal hydration retrieves the persisted proposal locale for approved messages', () => {
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /AS proposal_locale/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /proposal_message\.metadata ->> 'locale'/);
  assert.match(LESSON_AUTHOR_PROPOSAL_HYDRATION_QUERY, /proposal_message\.metadata ->> 'lesson_author_job_id' = laj\.id::text/);
});

test('formats English approval confirmations from the proposal locale', () => {
  assert.equal(
    formatLessonAuthorApprovalMessage('create', 9, 0, 'en'),
    'The proposal has been applied to the course structure.\n\nCreated 9 content item(s) and updated 0 item(s).',
  );
  assert.equal(
    formatLessonAuthorApprovalMessage('rename', 0, 1, 'en'),
    'The selected outline item title has been updated.',
  );
  assert.equal(
    formatLessonAuthorApprovalMessage('delete', 0, 1, 'en'),
    'The selected outline item has been queued for deletion.',
  );
});
