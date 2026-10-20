import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../../../../middleware/error-handler.js';
import type { AuthUser } from '../../../../../types/express.js';
import type { LessonAuthorLaunchBrief } from '../../contracts/lesson-author-launch-brief.logic.js';
import {
  buildOrganizationContext, emptyOrgContextProfile, type OrganizationContextV1,
} from '../../contracts/lesson-author-org-context.contract.js';
import { createWorkspaceV2LaunchService } from './lesson-author-workspace-v2-launch.service.js';

// A Create with use_organization_context freezes the confirmed organization profile into the workspace in the
// same insert and makes it part of the request identity; without it nothing differs from before.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'staff', username: 'owner', sessionMode: 'normal' };
const designBrief: LessonAuthorLaunchBrief = { design_mode: 'instructional_design', learner_audience: 'Nhân viên mới',
  course_purpose: 'Giúp nhân viên mới hiểu công ty trong tuần đầu.' };
const input = { courseId: 'course-v1:test+1+2026', conversationId: uuid(3), operationId: uuid(4),
  sourceDocumentIds: [uuid(5)], locale: 'vi' as const, brief: designBrief };
const CONFIRMED = buildOrganizationContext(2, { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu.' });
const NEWER = buildOrganizationContext(3, { ...emptyOrgContextProfile(), organization_summary: 'Công ty mẫu đổi tên.' });

function fixture(options: { enabled?: boolean; idm?: boolean; confirmed?: OrganizationContextV1 | null;
  confirmedInTransaction?: OrganizationContextV1 | null; source?: 'absent' } = {}) {
  let workspace: Record<string, unknown> | null = null;
  const state = { sql: [] as string[], inserts: [] as unknown[][], options: [] as Record<string, unknown>[],
    confirmedCalls: [] as boolean[], admissions: 0, confirmed: options.confirmed === undefined ? CONFIRMED : options.confirmed };
  const rows = (sql: string, params: unknown[] = []) => {
    state.sql.push(sql);
    if (sql.includes('FROM courses')) return [{ id: input.courseId }];
    if (sql.includes('FROM users u JOIN tenants')) return [{ role: 'staff', tenant_id: user.tenantId, is_active: true,
      tenant_active: true }];
    if (sql.includes('FROM user_permission_groups')) return [{ can_edit: true }];
    if (sql.includes('FROM modules m WHERE')) return [{ id: uuid(50), is_active: true }];
    if (sql.includes('FROM tenant_modules tm')) return [{ is_enabled: true }];
    if (sql.includes('FROM lesson_author_session_deletion_jobs')) return [];
    if (sql.includes("status IN ('queued','designing','drafting')")) return [];
    if (sql.includes('FROM lesson_author_workspaces') && sql.includes('idempotency_key')) return workspace ? [workspace] : [];
    if (sql.includes('INSERT INTO lesson_author_workspaces')) {
      state.inserts.push(params);
      workspace = { id: uuid(8), conversation_id: input.conversationId, correlation_id: uuid(9), content_locale: 'vi',
        status: 'queued', request_hash: params[10], source_document_ids: input.sourceDocumentIds,
        launch_brief: JSON.parse(String(params[13])), organization_context: params[14] ? JSON.parse(String(params[14])) : null };
      return [workspace];
    }
    if (sql.includes("UPDATE lesson_author_workspaces SET status='designing'")) {
      workspace = { ...workspace!, status: 'designing' };
      return [workspace];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_events')) return [{ sequence: 1 }];
    if (sql.includes('FROM lesson_author_workspace_v2_runs')) return state.admissions ? [{ id: uuid(10) }] : [];
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  };
  const tx = { query: async (sql: string, params?: unknown[]) => ({ rows: rows(sql, params), rowCount: 1 }) };
  const launch = createWorkspaceV2LaunchService({
    query: async (sql, params) => ({ rows: rows(sql, params) }),
    db: { async transaction(work) {
      const before = structuredClone(workspace);
      try { return await work(tx as never); } catch (error) { workspace = before; throw error; }
    } },
    AppError,
    prepareDurableBlueprint: (async (_c: string, _a: string, _t: string, _content: string, prepareOptions: Record<string, unknown>) => {
      state.options.push(prepareOptions);
      return { identity: { tenantId: user.tenantId!, userId: user.id, conversationId: input.conversationId,
        courseId: input.courseId, botId: uuid(6), kbId: uuid(7), requestHash: 'a'.repeat(64), sourceSnapshotHash: 'b'.repeat(64),
        courseOutlineHash: 'c'.repeat(64), runtimeConfigHash: 'd'.repeat(64), locale: 'vi', model: 'model',
        sourceDocumentIds: input.sourceDocumentIds, editorContext: null }, embeddingModel: 'e',
        async filterInput() {}, markAccepted() {} };
    }) as never,
    withLessonAuthorConversationLock: async (_conversation, work) => work(),
    admit: async () => {
      state.admissions++;
      return { created: true, run_id: uuid(10), snapshot_id: uuid(11), task_id: uuid(12), outbox_id: uuid(13),
        bootstrap_hash: 'e'.repeat(64), source_snapshot_hash: 'b'.repeat(64) };
    },
    id: (() => { const ids = [uuid(9), uuid(8)]; return () => ids.shift() ?? uuid(99); })(),
    idmPipelineFor: () => options.idm !== false,
    ...(options.source === 'absent' ? {} : { organizationContext: {
      enabled: () => options.enabled !== false,
      confirmed: async (_tenant: string, lock: boolean) => {
        state.confirmedCalls.push(lock);
        return lock && options.confirmedInTransaction !== undefined ? options.confirmedInTransaction : state.confirmed;
      },
    } }),
  });
  return { launch, state, workspace: () => workspace };
}

test('without the switch the Create is exactly what it was: no context read, no column, no identity key', async () => {
  for (const useOrganizationContext of [undefined, false]) {
    const f = fixture();
    await f.launch(user, { ...input, ...(useOrganizationContext === undefined ? {} : { useOrganizationContext }) });
    assert.deepEqual(f.state.confirmedCalls, []);
    assert.equal(Object.hasOwn(f.state.options[0]!, 'organizationContext'), false, 'the request identity input is unchanged');
    const insert = f.state.sql.find(sql => sql.includes('INSERT INTO lesson_author_workspaces'))!;
    assert.doesNotMatch(insert, /organization_context|\$15/);
    assert.equal(f.state.inserts[0]!.length, 14);
    assert.equal(f.workspace()!.organization_context, null);
  }
});

test('with the switch the confirmed profile is frozen in the same insert and is part of the request identity', async () => {
  const f = fixture();
  const created = await f.launch(user, { ...input, useOrganizationContext: true });
  assert.equal(created.replayed, false);
  assert.deepEqual(f.state.options[0]!.organizationContext, CONFIRMED);
  const insert = f.state.sql.find(sql => sql.includes('INSERT INTO lesson_author_workspaces'))!;
  assert.match(insert, /launch_brief,organization_context\)[\s\S]*\$14::jsonb,\$15::jsonb\)/);
  assert.deepEqual(JSON.parse(String(f.state.inserts[0]![14])), CONFIRMED);
  // Read once to prepare, then again FOR SHARE inside the Create transaction.
  assert.deepEqual(f.state.confirmedCalls, [false, true]);
  // A replay uses what the workspace froze, even after a newer version was confirmed.
  f.state.confirmed = NEWER;
  const replay = await f.launch(user, { ...input, useOrganizationContext: true });
  assert.equal(replay.replayed, true);
  assert.deepEqual(f.state.options[1]!.organizationContext, CONFIRMED);
  assert.equal(f.state.inserts.length, 1);
  // The same operation without the switch is another request.
  await assert.rejects(f.launch(user, input), { code: 'WORKSPACE_CREATE_CONFLICT', statusCode: 409 });
});

test('refusals: not applicable (feature off, not IDM, keep-as-is, no source) and not confirmed — nothing prepared', async () => {
  const kept: LessonAuthorLaunchBrief = { design_mode: 'preserve_source', learner_audience: null, course_purpose: null };
  const cases: Array<[Parameters<typeof fixture>[0], LessonAuthorLaunchBrief, string]> = [
    [{ enabled: false }, designBrief, 'ORG_CONTEXT_NOT_APPLICABLE'],
    [{ idm: false }, designBrief, 'ORG_CONTEXT_NOT_APPLICABLE'],
    [{}, kept, 'ORG_CONTEXT_NOT_APPLICABLE'],
    [{ source: 'absent' }, designBrief, 'ORG_CONTEXT_NOT_APPLICABLE'],
    [{ confirmed: null }, designBrief, 'ORG_CONTEXT_NOT_CONFIRMED'],
  ];
  for (const [options, brief, code] of cases) {
    const f = fixture(options);
    await assert.rejects(f.launch(user, { ...input, brief, useOrganizationContext: true }), { code });
    assert.deepEqual([f.state.options.length, f.state.inserts.length, f.state.admissions], [0, 0, 0], JSON.stringify(options));
  }
});

test('a profile confirmed or withdrawn between preparation and the insert refuses the Create', async () => {
  const changed = fixture({ confirmedInTransaction: NEWER });
  await assert.rejects(changed.launch(user, { ...input, useOrganizationContext: true }), { code: 'WORKSPACE_CREATE_CONFLICT' });
  assert.deepEqual([changed.state.inserts.length, changed.state.admissions, changed.workspace()], [0, 0, null]);
  const withdrawn = fixture({ confirmedInTransaction: null });
  await assert.rejects(withdrawn.launch(user, { ...input, useOrganizationContext: true }), { code: 'ORG_CONTEXT_NOT_CONFIRMED' });
  assert.equal(withdrawn.state.inserts.length, 0);
});

test('a non-boolean switch is a caller bug', async () => {
  const f = fixture();
  await assert.rejects(f.launch(user, { ...input, useOrganizationContext: 'yes' as never }),
    { code: 'WORKSPACE_CREATE_INPUT_INVALID', statusCode: 400 });
  assert.equal(f.state.sql.length, 0);
});
