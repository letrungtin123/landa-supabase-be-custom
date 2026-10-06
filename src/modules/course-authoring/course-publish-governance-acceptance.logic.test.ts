import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COURSE_PUBLISH_ACCEPTANCE_CONFIRMATION,
  requireDisposableAcceptanceDatabase,
} from './course-publish-governance-acceptance.logic.js';

const safe = {
  NODE_ENV: 'test',
  COURSE_PUBLISH_ACCEPTANCE_CONFIRM: COURSE_PUBLISH_ACCEPTANCE_CONFIRMATION,
  COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL: 'postgresql://runner:secret@127.0.0.1:5432/landa_publish_acceptance',
  DATABASE_URL: 'postgresql://app:secret@127.0.0.1:5432/landa_dev',
};

test('acceptance database guard admits only an explicit separate disposable PostgreSQL database', () => {
  assert.equal(requireDisposableAcceptanceDatabase(safe), safe.COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL);
});

test('acceptance database guard rejects production, Supabase, ordinary names and the runtime database', () => {
  const rejected = [
    { ...safe, NODE_ENV: 'production' },
    { ...safe, COURSE_PUBLISH_ACCEPTANCE_CONFIRM: 'yes' },
    { ...safe, COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL: 'postgresql://x:y@db.example.supabase.co:5432/acceptance' },
    { ...safe, COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/landa_prod' },
    { ...safe, DATABASE_URL: safe.COURSE_PUBLISH_ACCEPTANCE_DATABASE_URL },
  ];
  for (const environment of rejected) assert.throws(() => requireDisposableAcceptanceDatabase(environment));
});
