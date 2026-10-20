import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATION_JOB_DEADLINE_MS, GENERATION_JOB_LEASE_MS, GENERATION_JOB_HEARTBEAT_MS,
  generationDispatchBudgetMs, generationJobStatusView, generationRecoveryAction, generationSnapshotHash, hasCompleteGenerationUsage,
  type GenerationJobRow,
} from './lesson-author-generation-job.logic.js';
import {
  createGenerationJobRepository, type GenerationJobSql, type GenerationJobDatabase,
  type PreparedGenerationJob,
} from './lesson-author-generation-job.repository.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25) + seconds * 1000);
const lease = { jobId: 'job', tenantId: 'tenant', leaseToken: 'lease' };
const owner = { tenantId: 'tenant', conversationId: 'conversation', userId: 'user' };
const input: PreparedGenerationJob = {
  ...owner, courseId: 'course-v1:ORG+COURSE+2026', botId: 'bot', kbId: 'kb',
  idempotencyKey: 'key', correlationId: 'original-correlation', requestHash: 'request-hash',
  sourceSnapshotHash: 'source-hash', courseOutlineHash: 'course-hash', runtimeConfigHash: 'config-hash',
  locale: 'vi', model: 'existing-model',
  sourceDocumentIds: ['document'], editorContext: null,
};
const grant = { userMessageId: 'new-message', reservationId: 'reservation', maxOutputTokens: 30_000, maxAttempts: 1 };
const dispatchAuthorization = { ...input, reservationId: 'reservation', maxOutputTokens: 65536, maxAttempts: 2 };
function row(overrides: Partial<GenerationJobRow> = {}): GenerationJobRow {
  return {
    id: 'job', tenant_id: 'tenant', conversation_id: 'conversation', requested_by: 'user',
    course_id: input.courseId, bot_id: 'bot', kb_id: 'kb', user_message_id: 'message',
    idempotency_key: 'key', correlation_id: 'original-correlation', request_hash: 'request-hash',
    source_snapshot_hash: 'source-hash', course_outline_hash: 'course-hash', runtime_config_hash: 'config-hash',
    contract_version: 1, operation: 'course_blueprint', engine: 'self_built_rag', locale: 'vi',
    model: 'existing-model', max_output_tokens: 65536, max_attempts: 2, source_document_ids: ['document'],
    editor_context: {}, status: 'running', claim_count: 1, lease_token: 'lease', lease_expires_at: at(45),
    heartbeat_at: at(0), started_at: at(0), dispatch_started_at: null, ai_reservation_id: 'reservation',
    result_blueprint_id: null, assistant_message_id: null, progress_code: 'PREPARING_BLUEPRINT',
    failure_stage: null, internal_failure_code: null, external_failure_code: null,
    created_at: at(0), updated_at: at(0), deadline_at: at(600), finished_at: null,
    ...overrides,
  };
}

/** Scripted SQL boundary. Tests orchestration/parameters, NOT PostgreSQL execution. */
function fixture(responses: Array<Record<string, unknown>[] | Error>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  let transaction = false;
  let stagedWrites: string[] = [];
  const committedWrites: string[] = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      assert.equal(transaction, true, 'all statements must use the current transaction');
      queries.push({ sql, params });
      assert.ok(responses.length, 'unexpected SQL');
      const response = responses.shift()!;
      if (response instanceof Error) throw response;
      return { rows: response as T[], rowCount: response.length };
    },
  };
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (sql: GenerationJobSql) => Promise<T>): Promise<T> {
      assert.equal(transaction, false);
      transaction = true;
      stagedWrites = [];
      events.push('BEGIN');
      try {
        const result = await work(tx);
        committedWrites.push(...stagedWrites);
        events.push('COMMIT');
        return result;
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      } finally { transaction = false; }
    },
  };
  return {
    repo: createGenerationJobRepository(db), queries, events, committedWrites, tx,
    write(label: string, sql: GenerationJobSql) {
      assert.equal(sql, tx);
      assert.equal(transaction, true);
      stagedWrites.push(label);
    },
    assertConsumed() { assert.equal(responses.length, 0); },
  };
}

test('600s deadline and heartbeat/lease bounds; provider wait leaves commit margin', () => {
  assert.equal(GENERATION_JOB_DEADLINE_MS, 600_000);
  assert.ok(GENERATION_JOB_HEARTBEAT_MS < GENERATION_JOB_LEASE_MS);
  assert.equal(generationDispatchBudgetMs(at(600), at(0).getTime()), 595_000);
  assert.equal(generationDispatchBudgetMs(at(600), at(500).getTime()), 95_000);
  assert.throws(() => generationDispatchBudgetMs(at(600), at(595).getTime()), { code: 'GENERATION_WORKFLOW_TIMEOUT' });
  assert.throws(() => generationDispatchBudgetMs(new Date(NaN), 0), { code: 'GENERATION_WORKFLOW_TIMEOUT' });
});

test('recovery never replays dispatched work, including expired deadline', () => {
  assert.equal(generationRecoveryAction(row(), at(44)), 'none');
  assert.equal(generationRecoveryAction(row(), at(45)), 'requeue');
  assert.equal(generationRecoveryAction(row(), at(600)), 'timeout');
  assert.equal(generationRecoveryAction(row({ dispatch_started_at: at(1) }), at(45)), 'outcome_unknown');
  assert.equal(generationRecoveryAction(row({ dispatch_started_at: at(1) }), at(601)), 'outcome_unknown');
  for (const status of ['succeeded', 'failed', 'canceled'] as const) {
    assert.equal(generationRecoveryAction(row({ status }), at(999)), 'none');
  }
});

test('public projection excludes lease, internal errors, configuration, source/context and accounting', () => {
  const publicView = generationJobStatusView(row({ status: 'failed', internal_failure_code: 'PRIVATE_INTERNAL',
    external_failure_code: 'PROVIDER_ERROR', editor_context: { private: 'not for browser' } }));
  assert.equal(publicView.external_failure_code, 'PROVIDER_ERROR');
  assert.equal(publicView.correlation_id, 'original-correlation');
  for (const key of ['lease_token', 'editor_context', 'ai_reservation_id', 'request_hash', 'model',
    'source_document_ids', 'runtime_config_hash', 'internal_failure_code', 'tenant_id']) {
    assert.ok(!(key in publicView));
  }
  assert.equal(generationJobStatusView(row({ result_blueprint_id: 'not-yet-valid' })).blueprint_id, null);
  assert.equal(generationJobStatusView(row({ status: 'succeeded', result_blueprint_id: 'blueprint' })).blueprint_id, 'blueprint');
});

test('same key/hash returns existing job and ORIGINAL correlation without new message', async () => {
  const f = fixture([[{ id: 'conversation' }], [row()]]);
  const result = await f.repo.enqueue({ ...input, correlationId: 'new-attempt-correlation' }, async () => {
    assert.fail('idempotent replay cannot insert another user message');
  });
  assert.equal(result.created, false);
  assert.equal(result.job.correlation_id, 'original-correlation');
  assert.match(f.queries[0].sql, /FOR UPDATE/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
  f.assertConsumed();
});

test('same key/different hash conflicts; no overwrite or duplicate message', async () => {
  const f = fixture([[{ id: 'conversation' }], [row()]]);
  await assert.rejects(f.repo.enqueue({ ...input, requestHash: 'different' }, async () => {
    assert.fail('must not insert');
  }), { code: 'GENERATION_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('new key cannot enqueue while another job is active', async () => {
  const f = fixture([[{ id: 'conversation' }], [], [{ id: 'active-job' }]]);
  await assert.rejects(f.repo.enqueue(input, async () => { assert.fail('must not insert'); }),
    { code: 'GENERATION_ALREADY_ACTIVE' });
});

test('enqueue denies missing owned conversation before creating message', async () => {
  const f = fixture([[]]);
  await assert.rejects(f.repo.enqueue(input, async () => { assert.fail('must not insert'); }),
    { code: 'GENERATION_JOB_NOT_FOUND' });
  assert.deepEqual(f.queries[0].params, ['conversation', 'tenant', 'user', input.courseId, 'bot']);
  assert.match(f.queries[0].sql, /target = 'lesson_author'/);
});

test('enqueue grant, message and job share one transaction; actual partial grant is frozen', async () => {
  const f = fixture([[{ id: 'conversation' }], [], [], [row({ status: 'queued' })]]);
  const result = await f.repo.enqueue(input, async tx => {
    f.write('reservation', tx); f.write('user-message', tx); return grant;
  });
  assert.equal(result.created, true);
  assert.deepEqual(f.committedWrites, ['reservation', 'user-message']);
  assert.equal(f.queries[3].params[1], input.courseId);
  assert.equal(f.queries[3].params[6], 'new-message');
  assert.equal(f.queries[3].params[8], 'original-correlation');
  assert.equal(f.queries[3].params[15], 30_000);
  assert.equal(f.queries[3].params[16], 1);
  assert.equal(f.queries[3].params[19], 'reservation');
  assert.match(f.queries[3].sql, /ai_reservation_id/);
  assert.doesNotMatch(f.queries[3].sql, /ON CONFLICT DO UPDATE/);
});

test('job insert failure rolls back both reservation and user-message creation', async () => {
  const f = fixture([[{ id: 'conversation' }], [], [], new Error('DB_CONSTRAINT')]);
  await assert.rejects(f.repo.enqueue(input, async tx => {
    f.write('reservation', tx); f.write('user-message', tx); return grant;
  }));
  assert.deepEqual(f.committedWrites, []);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('owned read includes tenant/user/conversation joins; missing returns null', async () => {
  const f = fixture([[]]);
  assert.equal(await f.repo.findOwned(owner, 'job'), null);
  assert.deepEqual(f.queries[0].params, ['job', 'tenant', 'conversation', 'user']);
  assert.match(f.queries[0].sql, /c.user_id = j.requested_by/);
  assert.match(f.queries[0].sql, /c.course_id = j.course_id/);
  assert.match(f.queries[0].sql, /course.tenant_id = j.tenant_id/);
  assert.match(f.queries[0].sql, /course.deleted_at IS NULL/);
  assert.match(f.queries[0].sql, /bot_assignment.bot_id = j.bot_id/);
  assert.match(f.queries[0].sql, /kb_assignment.kb_id = j.kb_id/);
  assert.match(f.queries[0].sql, /bot.tenant_id = j.tenant_id/);
  assert.match(f.queries[0].sql, /kb.tenant_id = j.tenant_id/);
});

test('claim SQL uses skip-locked, fresh UUID lease, deadline clamp and only undispatched queued jobs', async () => {
  const f = fixture([[row()], []]);
  await f.repo.claimNext();
  assert.equal(await f.repo.claimNext(), null);
  const sql = f.queries[0].sql;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /status = 'queued' AND dispatch_started_at IS NULL/);
  assert.match(sql, /claim_count = j.claim_count \+ 1/);
  assert.match(sql, /LEAST\(j.deadline_at/);
  assert.match(sql, /COALESCE\(j.started_at/);
  assert.match(String(f.queries[0].params[0]), /^[0-9a-f-]{36}$/);
  assert.notEqual(f.queries[0].params[0], f.queries[1].params[0]);
});

test('renew fences owner and never revives expired lease/deadline', async () => {
  const f = fixture([[]]);
  assert.equal(await f.repo.renew(lease), false);
  assert.deepEqual(f.queries[0].params.slice(0, 3), ['job', 'tenant', 'lease']);
  assert.match(f.queries[0].sql, /lease_token = \$3 AND lease_expires_at > clock_timestamp\(\)/);
  assert.match(f.queries[0].sql, /deadline_at > clock_timestamp\(\)/);
});

test('dispatch marker commits after verification of the existing reservation, before provider', async () => {
  const f = fixture([[row()], [row({ dispatch_started_at: at(1), ai_reservation_id: 'reservation' })]]);
  await f.repo.prepareDispatch(lease, async (_, job) => {
    assert.equal(job.ai_reservation_id, 'reservation'); return dispatchAuthorization;
  });
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
  assert.deepEqual(f.committedWrites, []);
  assert.match(f.queries[1].sql, /dispatch_started_at IS NULL/);
  assert.equal(f.queries[1].params[3], 'reservation');
});

test('duplicate dispatch and stale lease do not reserve again', async () => {
  for (const response of [[row({ dispatch_started_at: at(1) })], []]) {
    const f = fixture([response]);
    await assert.rejects(f.repo.prepareDispatch(lease, async () => { assert.fail('must not reserve'); }),
      { code: response.length ? 'GENERATION_ALREADY_DISPATCHED' : 'GENERATION_LEASE_LOST' });
  }
});

test('dispatch CAS loss rolls back reservation; no implicit retry', async () => {
  const f = fixture([[row()], []]);
  await assert.rejects(f.repo.prepareDispatch(lease, async tx => { f.write('reservation', tx); return dispatchAuthorization; }),
    { code: 'GENERATION_LEASE_LOST' });
  assert.deepEqual(f.committedWrites, []);
  assert.equal(f.queries.length, 2);
});

test('changed request/source/course/config/model fails before dispatch and rolls back reservation', async () => {
  for (const field of ['requestHash', 'sourceSnapshotHash', 'courseOutlineHash', 'runtimeConfigHash', 'model'] as const) {
    const f = fixture([[row()]]);
    await assert.rejects(f.repo.prepareDispatch(lease, async tx => {
      f.write('reservation', tx);
      return { ...dispatchAuthorization, [field]: 'changed' };
    }), { code: 'GENERATION_SNAPSHOT_CHANGED' });
    assert.deepEqual(f.committedWrites, []);
    assert.equal(f.queries.length, 1);
  }
});

test('partial quota grant cannot silently change frozen output/retry budget', async () => {
  for (const changed of [{ maxOutputTokens: 30000 }, { maxAttempts: 1 }]) {
    const f = fixture([[row()]]);
    await assert.rejects(f.repo.prepareDispatch(lease, async tx => {
      f.write('reservation', tx);
      return { ...dispatchAuthorization, ...changed };
    }), { code: 'GENERATION_BUDGET_CHANGED' });
    assert.deepEqual(f.committedWrites, []);
    assert.equal(f.queries.length, 1);
  }
});

test('successful result/accounting transaction commits once; missing/expired lease cannot persist', async () => {
  const dispatched = row({ dispatch_started_at: at(1), ai_reservation_id: 'reservation' });
  const f = fixture([[dispatched], [row({ status: 'succeeded' })]]);
  await f.repo.succeed(lease, async tx => {
    for (const artifact of ['blueprint', 'assistant-message', 'accounting']) f.write(artifact, tx);
    return { blueprintId: 'blueprint', assistantMessageId: 'assistant' };
  });
  assert.deepEqual(f.committedWrites, ['blueprint', 'assistant-message', 'accounting']);
  assert.match(f.queries[0].sql, /dispatch_started_at IS NOT NULL FOR UPDATE/);
  assert.match(f.queries[1].sql, /lease_expires_at > clock_timestamp\(\)/);
  const stale = fixture([[]]);
  await assert.rejects(stale.repo.succeed(lease, async () => { assert.fail('must not persist'); }),
    { code: 'GENERATION_LEASE_LOST' });
});

test('late result cannot leave orphan Blueprint/message/accounting when final CAS fails', async () => {
  const f = fixture([[row({ dispatch_started_at: at(1) })], []]);
  await assert.rejects(f.repo.succeed(lease, async tx => {
    for (const artifact of ['blueprint', 'assistant-message', 'accounting']) f.write(artifact, tx);
    return { blueprintId: 'blueprint', assistantMessageId: 'assistant' };
  }), { code: 'GENERATION_LEASE_LOST' });
  assert.deepEqual(f.committedWrites, []);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('authoritative validation failure rolls back and cannot mark succeeded', async () => {
  const f = fixture([[row({ dispatch_started_at: at(1) })]]);
  await assert.rejects(f.repo.succeed(lease, async () => { throw new Error('NODE_VALIDATION_FAILED'); }));
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('failure stores bounded typed codes only; no arbitrary source/provider message', async () => {
  const f = fixture([[row()], [row({ status: 'failed' })]]);
  await f.repo.fail(lease, { stage: 'provider_wait', internalCode: 'AI_PROVIDER_TIMEOUT', externalCode: 'PROVIDER_ERROR' },
    async tx => { f.write('accounting', tx); });
  assert.deepEqual(f.queries[1].params.slice(3), ['provider_wait', 'AI_PROVIDER_TIMEOUT', 'PROVIDER_ERROR', null]);
  const bad = fixture([]);
  await assert.rejects(bad.repo.fail(lease, { stage: 'provider_wait', internalCode: 'raw private message', externalCode: 'PROVIDER_ERROR' },
    async () => {}), { code: 'GENERATION_JOB_CONTRACT_INVALID' });
  assert.deepEqual(bad.events, []);
});

test('JSONB key reordering preserves snapshot hash, semantic change does not', () => {
  assert.equal(generationSnapshotHash({ z: [{ b: 2, a: 1 }], a: 3 }), generationSnapshotHash({ a: 3, z: [{ a: 1, b: 2 }] }));
  assert.notEqual(generationSnapshotHash({ values: [1, 2] }), generationSnapshotHash({ values: [2, 1] }));
});

test('missing/partial/invalid usage cannot be finalized as known zero', () => {
  for (const usage of [undefined, null, {}, { totalTokens: 0 }, { inputTokens: 2, outputTokens: 1, embeddingTokens: 1, totalTokens: 3 }]) {
    assert.equal(hasCompleteGenerationUsage(usage), false);
  }
  assert.equal(hasCompleteGenerationUsage({ inputTokens: 2, outputTokens: 1, embeddingTokens: 1, totalTokens: 4 }), true);
  assert.equal(hasCompleteGenerationUsage({ inputTokens: 0, outputTokens: 0, embeddingTokens: 0, totalTokens: 0 }), true);
});

test('enqueue rejects absent reservation or invalid granted limits and rolls back', async () => {
  for (const changed of [{ reservationId: '' }, { maxOutputTokens: 0 }, { maxOutputTokens: 65_537 }, { maxAttempts: 3 }]) {
    const f = fixture([[{ id: 'conversation' }], [], []]);
    await assert.rejects(f.repo.enqueue(input, async tx => {
      f.write('reservation', tx); return { ...grant, ...changed };
    }), { code: 'GENERATION_JOB_CONTRACT_INVALID' });
    assert.deepEqual(f.committedWrites, []);
  }
});

test('dispatch rejects absent or substituted enqueue reservation', async () => {
  const absent = fixture([[row({ ai_reservation_id: null })]]);
  await assert.rejects(absent.repo.prepareDispatch(lease, async () => { assert.fail('must not reserve'); }),
    { code: 'GENERATION_JOB_CONTRACT_INVALID' });
  const substitute = fixture([[row()]]);
  await assert.rejects(substitute.repo.prepareDispatch(lease, async () => ({ ...dispatchAuthorization, reservationId: 'new' })),
    { code: 'GENERATION_JOB_CONTRACT_INVALID' });
});

test('expired undispatched job requeues without clearing immutable first start or increasing retry count', async () => {
  const f = fixture([[row()], [{ database_now: at(46) }], [row({ status: 'queued' })]]);
  await f.repo.recoverOne(async () => { assert.fail('no accounting action during safe requeue'); });
  assert.match(f.queries[2].sql, /dispatch_started_at IS NULL/);
  const assignments = f.queries[2].sql.split('SET')[1].split('WHERE')[0];
  assert.doesNotMatch(assignments, /\b(?:started_at|claim_count|max_attempts)\b/);
});

test('expired dispatched job is terminal unknown, never requeued or automatically released', async () => {
  const f = fixture([[row({ dispatch_started_at: at(1), ai_reservation_id: 'reservation' })],
    [{ database_now: at(46) }], [row({ status: 'failed' })]]);
  let reconciliations = 0;
  await f.repo.recoverOne(async (tx, job, outcome) => {
    assert.equal(outcome, 'outcome_unknown');
    assert.equal(job.ai_reservation_id, 'reservation');
    f.write('unknown-usage-reconciliation', tx);
    reconciliations++;
  });
  assert.equal(reconciliations, 1);
  assert.equal(f.queries[2].params[3], 'GENERATION_OUTCOME_UNKNOWN');
  assert.match(f.queries[2].sql, /status = 'failed'/);
  assert.doesNotMatch(f.queries[2].sql, /status = 'queued'/);
  assert.deepEqual(f.committedWrites, ['unknown-usage-reconciliation']);
});

test('queued deadline timeout reconciles without dispatch; accounting failure leaves no terminal write', async () => {
  const queued = row({ status: 'queued', lease_token: null, lease_expires_at: null });
  const f = fixture([[queued], [{ database_now: at(601) }], [row({ status: 'failed' })]]);
  await f.repo.recoverOne(async (_, __, outcome) => { assert.equal(outcome, 'timeout'); });
  assert.equal(f.queries[2].params[3], 'GENERATION_WORKFLOW_TIMEOUT');
  const blocked = fixture([[row({ dispatch_started_at: at(1) })], [{ database_now: at(601) }]]);
  await assert.rejects(blocked.repo.recoverOne(async () => { throw new Error('ACCOUNTING_NOT_RECONCILED'); }));
  assert.equal(blocked.queries.length, 2);
  assert.deepEqual(blocked.events, ['BEGIN', 'ROLLBACK']);
});
