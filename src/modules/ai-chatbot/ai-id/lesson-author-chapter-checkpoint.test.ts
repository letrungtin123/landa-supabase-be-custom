import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertChapterCheckpoints, assertChapterResume, assertChapterSnapshot, assertChapterUnitInventory,
  assertChapterUnitPayload, chapterAttemptExpiry, chapterCheckpointStatus,
  type ChapterAttemptRow, type ChapterDraftRow, type ChapterUnitRow,
} from './lesson-author-chapter-checkpoint.logic.js';
import { createChapterCheckpointRepository, type ChapterExecutionLease, type ChapterAdmission } from './lesson-author-chapter-checkpoint.repository.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { GENERATION_JOB_DEADLINE_MS, generationSnapshotHash } from './lesson-author-generation-job.logic.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 26) + seconds * 1000);
const lease: ChapterExecutionLease = { draftId: 'draft', attemptId: 'attempt', leaseToken: 'private-lease',
  tenantId: 'tenant', conversationId: 'conversation', userId: 'user', courseId: 'course-v1:HSE+ID+2026' };
const snapshot = { request_hash: hash(1), blueprint_hash: hash(2), source_snapshot_hash: hash(3),
  course_outline_hash: hash(4), runtime_config_hash: hash(5) };
function draft(overrides: Partial<ChapterDraftRow> = {}): ChapterDraftRow {
  return { ...snapshot, id: 'draft', tenant_id: 'tenant', conversation_id: 'conversation', requested_by: 'user',
    course_id: lease.courseId, blueprint_id: 'blueprint', chapter_index: 2, contract_version: 1,
    total_units: 5, unit_contracts: Array.from({ length: 5 }, (_, index) => ({ index, lesson_index: index,
      unit_index: 0, contract_hash: hash(10 + index), evidence_hash: hash(20 + index) })),
    status: 'open', result_job_id: null, expires_at: at(604800), ...overrides };
}
function attempt(overrides: Partial<ChapterAttemptRow> = {}): ChapterAttemptRow {
  return { id: 'attempt', draft_id: 'draft', tenant_id: 'tenant', course_id: lease.courseId,
    correlation_id: 'correlation', lease_token: 'private-lease', lease_expires_at: at(45), deadline_at: at(600),
    status: 'running', dispatch_started_at: null, in_flight_unit_index: null, accounting_state: 'reserved',
    external_failure_code: null, ...overrides };
}
function unit(index: number, overrides: Partial<ChapterUnitRow> = {}): ChapterUnitRow {
  const payload = { components: [{ type: 'html', content: `<p>Fixture ${index}</p>` }] };
  return { draft_id: 'draft', tenant_id: 'tenant', course_id: lease.courseId, unit_index: index,
    attempt_id: 'previous-attempt', contract_hash: hash(10 + index), evidence_hash: hash(20 + index),
    validation_contract: 'node-test-1', payload, payload_hash: generationSnapshotHash(payload), ...overrides };
}
const failure = { stage: 'stage_two_content', internalCode: 'AI_PROVIDER_TIMEOUT', externalCode: 'PROVIDER_ERROR' };

/** Scripted boundary only: no DB, triggers, provider, HTTP or quota calls. */
function fixture(responses: Array<Record<string, unknown>[] | Error>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  let inside = false;
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      assert.equal(inside, true);
      queries.push({ sql, params });
      assert.ok(responses.length, `unexpected query: ${sql}`);
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return { rows: next as T[], rowCount: next.length };
    },
  };
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (q: GenerationJobSql) => Promise<T>) {
      assert.equal(inside, false);
      inside = true;
      events.push('BEGIN');
      try { const result = await work(tx); events.push('COMMIT'); return result; }
      catch (error) { events.push('ROLLBACK'); throw error; }
      finally { inside = false; }
    },
  };
  return { repo: createChapterCheckpointRepository(db), queries, events, tx,
    consumed() { assert.equal(responses.length, 0); } };
}
const locked = (a = attempt(), d = draft(), now = at(1)): Record<string, unknown>[][] => [[d], [a], [{ now }]];
const ok = () => [{ id: 'written' }];
const admission:ChapterAdmission={...lease,...snapshot,botId:'bot',kbId:'kb',blueprintId:'blueprint',chapterIndex:2,
  idempotencyKey:'key',correlationId:'correlation',locale:'en',model:'existing-model',sourceDocumentIds:['source'],unitContracts:draft().unit_contracts};
const admissionDraft=()=>draft({model:admission.model,locale:'en'});
const grant={userMessageId:'new-message',reservationId:'new-reservation',maxOutputTokens:30000,maxAttempts:1};

test('admission commits draft/new user turn/reservation/attempt together after owner + idempotency checks',async()=>{
  const f=fixture([ok(),[],[],[admissionDraft()],[],[{now:at(1)}],[attempt()],[]]);
  const result=await f.repo.admit(admission,async(tx,draftId,attemptId)=>{
    assert.equal(tx,f.tx);assert.equal(draftId,'draft');assert.match(attemptId,/^[0-9a-f-]{36}$/);
    f.events.push('reserve-and-message');return grant;
  });
  assert.equal(result.created,true);assert.deepEqual(f.events,['BEGIN','reserve-and-message','COMMIT']);
  assert.match(f.queries[0].sql,/user_id=\$3 AND course_id=\$4 FOR UPDATE/);
  assert.match(f.queries[6].sql,/INSERT INTO lesson_author_chapter_attempts/);
  assert.equal(f.queries[6].params[8],grant.userMessageId);assert.equal(f.queries[6].params[9],grant.reservationId);
  f.consumed();
});
test('admission rollback includes token/user-turn callback on attempt insert failure',async()=>{
  const f=fixture([ok(),[],[],[admissionDraft()],[],[{now:at(1)}],new Error('ATTEMPT_INSERT_FAILED')]);
  await assert.rejects(f.repo.admit(admission,async()=>grant),/ATTEMPT_INSERT_FAILED/);
  assert.deepEqual(f.events,['BEGIN','ROLLBACK']);
});
test('idempotent admission returns existing attempt, never reserves or dispatches again',async()=>{
  const existing=attempt({idempotency_key:'key',previous_attempt_id:null});
  const f=fixture([ok(),[admissionDraft()],[existing],[unit(0)]]);
  const result=await f.repo.admit(admission,async()=>assert.fail('must not reserve'));
  assert.equal(result.created,false);assert.equal(result.units.length,1);
  assert.ok(f.queries.every(q=>!q.sql.includes('INSERT')));f.consumed();
});
test('new admission cannot create competing draft; wrong owner fails before grant',async()=>{
  const busy=fixture([ok(),[],ok()]);
  await assert.rejects(busy.repo.admit(admission,async()=>assert.fail()),{code:'CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED'});
  const missing=fixture([[]]);
  await assert.rejects(missing.repo.admit(admission,async()=>assert.fail()),{code:'CHAPTER_CHECKPOINT_NOT_FOUND'});
});
test('explicit resume binds latest timeout, new attempt/reservation and immutable snapshots',async()=>{
  const ended=attempt({attempt_number:1,status:'timed_out',idempotency_key:'old-key'});
  const input={...admission,resume:{draftId:'draft',previousAttemptId:'attempt'}};
  const f=fixture([ok(),[admissionDraft()],[ended],[{now:at(60)}],[attempt({id:'new-attempt'})],[unit(0),unit(1),unit(2)]]);
  const result=await f.repo.admit(input,async()=>grant);
  assert.equal(result.created,true);assert.equal(result.units.length,3);
  assert.equal(f.queries[4].params[4],2);assert.equal(f.queries[4].params[5],'attempt');f.consumed();
  for(const status of ['running','failed','completed'] as const){
    const rejected=fixture([ok(),[admissionDraft()],[{...ended,status}],[{now:at(60)}]]);
    await assert.rejects(rejected.repo.admit(input,async()=>assert.fail()),{code:'CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED'});
  }
  const stale=fixture([ok(),[admissionDraft()]]);
  await assert.rejects(stale.repo.admit({...input,source_snapshot_hash:hash(999)},async()=>assert.fail()),{code:'CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED'});
});
test('final evidence validation has durable dispatch marker, including final-only resume',async()=>{
  const f=fixture([...locked(),[0,1,2,3,4].map(i=>unit(i)),ok()]);
  await f.repo.markFinalValidation(lease,snapshot);
  assert.match(f.queries.at(-1)!.sql,/dispatch_started_at=COALESCE/);
  const incomplete=fixture([...locked(),[unit(0)]]);
  await assert.rejects(incomplete.repo.markFinalValidation(lease,snapshot),{code:'CHAPTER_CHECKPOINT_INCOMPLETE'});
});

test('inventory has exact unique server coordinates; does not truncate oversized chapters', () => {
  assertChapterUnitInventory(draft().unit_contracts);
  for (const values of [[], draft().unit_contracts.slice(1), [draft().unit_contracts[0], { ...draft().unit_contracts[0], index: 1 }],
    Array.from({ length: 513 }, (_, index) => ({ index, lesson_index: index, unit_index: 0, contract_hash: hash(1), evidence_hash: hash(2) }))]) {
    assert.throws(() => assertChapterUnitInventory(values), { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
  }
  assert.throws(() => assertChapterUnitInventory([{ ...draft().unit_contracts[0], contract_hash: 'provider-id' }]),
    { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
});

test('every frozen snapshot dimension is checked', () => {
  assertChapterSnapshot(draft(), snapshot);
  for (const key of Object.keys(snapshot)) {
    assert.throws(() => assertChapterSnapshot(draft(), { ...snapshot, [key]: hash(999) }),
      { code: 'CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED' });
  }
});

test('cached unit integrity binds source/contract/tenant/course/index and content hash', () => {
  assertChapterCheckpoints(draft(), [unit(2), unit(0)]);
  for (const overrides of [{ tenant_id: 'other' }, { course_id: 'other' }, { draft_id: 'other' },
    { unit_index: 9 }, { contract_hash: hash(999) }, { evidence_hash: hash(999) }, { validation_contract: '' }]) {
    assert.throws(() => assertChapterCheckpoints(draft(), [unit(0, overrides)]), { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
  }
  assert.throws(() => assertChapterCheckpoints(draft(), [unit(0), unit(0)]), { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
  assert.throws(() => assertChapterCheckpoints(draft(), [unit(0, { payload_hash: hash(0) })]), { code: 'CHAPTER_CHECKPOINT_PAYLOAD_INVALID' });
});

test('empty, oversized and non-JSON payloads fail before persistence', () => {
  for (const payload of [{ components: [] }, { components: [undefined] }, { components: [NaN] },
    { components: ['x'.repeat(2 * 1024 * 1024)] }]) {
    assert.throws(() => assertChapterUnitPayload(payload), { code: 'CHAPTER_CHECKPOINT_PAYLOAD_INVALID' });
  }
});

test('explicit resume requires exact latest interrupted attempt and unexpired open draft', () => {
  assertChapterResume(draft(), attempt({ status: 'timed_out' }), 'attempt', at(60));
  assertChapterResume(draft(), attempt({ status: 'outcome_unknown' }), 'attempt', at(60));
  for (const status of ['running', 'completed', 'failed'] as const) {
    assert.throws(() => assertChapterResume(draft(), attempt({ status }), 'attempt', at(60)),
      { code: 'CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED' });
  }
  for (const d of [draft({ status: 'failed' }), draft({ expires_at: at(1) })]) {
    assert.throws(() => assertChapterResume(d, attempt({ status: 'timed_out' }), 'attempt', at(60)),
      { code: 'CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED' });
  }
  assert.throws(() => assertChapterResume(draft(), attempt({ status: 'timed_out' }), 'older-attempt', at(60)));
});

test('expiry never auto-requeues and dispatched unknown usage is not zero', () => {
  assert.equal(chapterAttemptExpiry(attempt(), at(44)), 'none');
  assert.equal(chapterAttemptExpiry(attempt(), at(45)), 'timed_out');
  assert.equal(chapterAttemptExpiry(attempt({ dispatch_started_at: at(1) }), at(45)), 'outcome_unknown');
  assert.equal(chapterAttemptExpiry(attempt({ status: 'completed' }), at(601)), 'none');
  assert.equal(GENERATION_JOB_DEADLINE_MS, 600_000);
});

test('public progress is timeout-only; running/success/failure disclose no counters or private payload', () => {
  for (const status of ['running', 'completed', 'failed'] as const) {
    assert.equal(chapterCheckpointStatus(draft(), attempt({ status }), 3, at(60)).interruption, null);
  }
  const view = chapterCheckpointStatus(draft(), attempt({ status: 'timed_out', accounting_state: 'pending_reconciliation' }), 3, at(60));
  assert.deepEqual(view.interruption, { completed_units: 3, total_units: 5, can_continue: true,
    previous_attempt_id: 'attempt', usage_pending_reconciliation: true });
  for (const privateKey of ['private-lease', 'payload', 'source_snapshot', 'runtime_config', 'tenant_id', 'components']) {
    assert.ok(!JSON.stringify(view).includes(privateKey));
  }
  assert.equal(chapterCheckpointStatus(draft({ expires_at: at(60) }), attempt({ status: 'timed_out' }), 3, at(60)).interruption, null);
  assert.throws(() => chapterCheckpointStatus(draft(), attempt(), 6, at(60)));
});

test('status uses one owner-scoped snapshot query, no units/prompt payload projection', async () => {
  const f = fixture([[{ ...draft(), latest: attempt({ status: 'timed_out' }), completed: 3, database_now: at(60) }]]);
  assert.equal((await f.repo.status(lease, 'draft')).interruption?.completed_units, 3);
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.queries[0].params, ['draft', 'tenant', 'conversation', 'user', lease.courseId]);
  assert.doesNotMatch(f.queries[0].sql, /SELECT \* FROM lesson_author_chapter_units/);
  f.consumed();
});

test('wrong owner fails before attempt lookup, callbacks or writes', async () => {
  const f = fixture([[]]);
  await assert.rejects(f.repo.markDispatched(lease, snapshot, 0), { code: 'CHAPTER_CHECKPOINT_NOT_FOUND' });
  assert.deepEqual(f.queries[0].params, ['draft', 'tenant', 'conversation', 'user', lease.courseId]);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('parent locks before attempt; renew uses one timestamp so 45s SQL lease bound cannot drift', async () => {
  const f = fixture([...locked(), ok()]);
  await f.repo.renew(lease);
  assert.match(f.queries[0].sql, /lesson_author_chapter_drafts[\s\S]*FOR UPDATE/);
  assert.match(f.queries[1].sql, /lesson_author_chapter_attempts[\s\S]*FOR UPDATE/);
  assert.match(f.queries[3].sql, /MATERIALIZED[\s\S]*heartbeat_at=tick.ts[\s\S]*deadline_at,tick.ts/);
  assert.equal(f.queries[3].params[5], 45_000);
});

test('unit 4 dispatch resumes after stored 1-3 only; marker commits before caller can send provider request', async () => {
  const f = fixture([...locked(), [unit(0), unit(1), unit(2)], ok()]);
  await f.repo.markDispatched(lease, snapshot, 3);
  assert.doesNotMatch(f.queries[3].sql, /SELECT \*|payload/);
  assert.equal(f.queries.at(-1)!.params[5], 3);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
  f.consumed();
});

test('same in-flight index is not idempotent permission to dispatch a paid request again', async () => {
  const f = fixture(locked(attempt({ dispatch_started_at: at(0), in_flight_unit_index: 3 })));
  await assert.rejects(f.repo.markDispatched(lease, snapshot, 3), { code: 'CHAPTER_CHECKPOINT_ALREADY_DISPATCHED' });
  f.consumed();
});

test('completed unit is not regenerated; cannot skip past pending pedagogical unit', async () => {
  const f = fixture([...locked(), [unit(0)]]);
  await assert.rejects(f.repo.markDispatched(lease, snapshot, 0), { code: 'CHAPTER_CHECKPOINT_ALREADY_COMMITTED' });
  const g = fixture([...locked(), [unit(0)]]);
  await assert.rejects(g.repo.markDispatched(lease, snapshot, 3), { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
});

test('snapshot changes deny dispatch before any marker or provider side effect', async () => {
  const f = fixture(locked());
  await assert.rejects(f.repo.markDispatched(lease, { ...snapshot, blueprint_hash: hash(0) }, 0),
    { code: 'CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED' });
  f.consumed();
});

test('unit acceptance is awaited; hashes are server-derived, insert and clearing marker share commit', async () => {
  const f = fixture([...locked(attempt({ dispatch_started_at: at(0), in_flight_unit_index: 3 })),
    [unit(0), unit(1), unit(2)], ok(), ok()]);
  let validated = false;
  await f.repo.commitUnit(lease, snapshot, 3, unit(3).payload, 'node-test-1', async (payload, contract) => {
    await Promise.resolve();
    assert.equal(contract.index, 3);
    assert.deepEqual(payload, unit(3).payload);
    assert.equal(f.queries.length, 4, 'nothing inserted before acceptance');
    validated = true;
  });
  assert.equal(validated, true);
  assert.match(f.queries[4].sql, /INSERT INTO lesson_author_chapter_units/);
  assert.equal(f.queries[4].params[8], generationSnapshotHash(unit(3).payload));
  assert.match(f.queries[5].sql, /in_flight_unit_index=NULL/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('async acceptance failure cannot insert or clear checkpoint', async () => {
  const f = fixture([...locked(attempt({ dispatch_started_at: at(0), in_flight_unit_index: 0 })), []]);
  await assert.rejects(f.repo.commitUnit(lease, snapshot, 0, unit(0).payload, 'node-test-1', async () => {
    throw new Error('SOURCE_SCOPE_REJECTED');
  }), /SOURCE_SCOPE_REJECTED/);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
  f.consumed();
});

test('late response is fenced before validation/storage when lease or deadline expired', async () => {
  for (const a of [attempt({ lease_expires_at: at(1) }), attempt({ deadline_at: at(1) }), attempt({ status: 'timed_out' })]) {
    const f = fixture(locked(a));
    await assert.rejects(f.repo.commitUnit(lease, snapshot, 0, unit(0).payload, 'node-test-1', () => assert.fail('fenced')),
      { code: 'CHAPTER_CHECKPOINT_LEASE_LOST' });
    f.consumed();
  }
});

test('lease loss while saving rolls back checkpoint and cannot advance', async () => {
  const f = fixture([...locked(attempt({ dispatch_started_at: at(0), in_flight_unit_index: 0 })), [], ok(), []]);
  await assert.rejects(f.repo.commitUnit(lease, snapshot, 0, unit(0).payload, 'node-test-1', () => {}),
    { code: 'CHAPTER_CHECKPOINT_LEASE_LOST' });
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
});

test('timeout requires hold acknowledgement in the same transaction, never zero settlement', async () => {
  const a = attempt({ dispatch_started_at: at(0), in_flight_unit_index: 3 });
  const f = fixture([...locked(a), ok()]);
  await f.repo.interrupt(lease, 'timed_out', failure, async (tx, _attempt, requiresHold) => {
    assert.equal(tx, f.tx); assert.equal(requiresHold, true); return 'pending_reconciliation';
  });
  assert.equal(f.queries[3].params[9], 'pending_reconciliation');
  assert.ok(f.queries.every(q => !/DELETE|UPDATE lesson_author_chapter_units/.test(q.sql)));
  const g = fixture(locked(a));
  await assert.rejects(g.repo.interrupt(lease, 'timed_out', failure, async () => 'settled'),
    { code: 'CHAPTER_CHECKPOINT_CONTRACT_INVALID' });
  assert.deepEqual(g.events, ['BEGIN', 'ROLLBACK']);
});

test('recovery cannot mark live attempt outcome_unknown; expired attempt may retain holds', async () => {
  const f = fixture(locked());
  await assert.rejects(f.repo.interrupt(lease, 'outcome_unknown', failure, async () => assert.fail('still live')),
    { code: 'CHAPTER_CHECKPOINT_LEASE_LOST' });
  const g = fixture([...locked(attempt({ dispatch_started_at: at(0) }), draft(), at(46)), ok()]);
  await g.repo.interrupt(lease, 'outcome_unknown', failure, async () => 'pending_reconciliation');
  assert.deepEqual(g.events, ['BEGIN', 'COMMIT']);
});

test('non-timeout terminal failure closes parent; timeout keeps checkpoints open for explicit resume', async () => {
  const f = fixture([...locked(), ok(), ok()]);
  await f.repo.interrupt(lease, 'failed', { ...failure, internalCode: 'CONTENT_INVALID' }, async () => 'settled');
  assert.match(f.queries.at(-1)!.sql, /drafts SET status='failed'/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('partial chapter cannot call full-proposal publication', async () => {
  const f = fixture([...locked(), [unit(0), unit(1), unit(2)]]);
  await assert.rejects(f.repo.publish(lease, snapshot, async () => assert.fail('no partial proposal')),
    { code: 'CHAPTER_CHECKPOINT_INCOMPLETE' });
});

test('full proposal acceptance/accounting/attempt/draft publication use one transaction', async () => {
  const f = fixture([...locked(), Array.from({ length: 5 }, (_, i) => unit(i)), ok(), ok()]);
  const jobId = 'a1196507-6f4a-422c-9cbd-8229727aa001';
  const returned = await f.repo.publish(lease, snapshot, async (tx, _draft, units) => {
    assert.equal(tx, f.tx); assert.deepEqual(units.map(u => u.unit_index), [0, 1, 2, 3, 4]);
    return { jobId, accounting: 'settled' };
  });
  assert.equal(returned, jobId);
  assert.match(f.queries[4].sql, /status='completed'/);
  assert.match(f.queries[5].sql, /status='ready'/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('failed full acceptance rolls back without publishing; failed final update also rolls back', async () => {
  const f = fixture([...locked(), Array.from({ length: 5 }, (_, i) => unit(i))]);
  await assert.rejects(f.repo.publish(lease, snapshot, async () => { throw new Error('PEDAGOGY_INVALID'); }), /PEDAGOGY_INVALID/);
  assert.deepEqual(f.events, ['BEGIN', 'ROLLBACK']);
  const g = fixture([...locked(), Array.from({ length: 5 }, (_, i) => unit(i)), ok(), []]);
  await assert.rejects(g.repo.publish(lease, snapshot, async () => ({ jobId: 'a1196507-6f4a-422c-9cbd-8229727aa001', accounting: 'settled' })),
    { code: 'CHAPTER_CHECKPOINT_LEASE_LOST' });
  assert.deepEqual(g.events, ['BEGIN', 'ROLLBACK']);
});
