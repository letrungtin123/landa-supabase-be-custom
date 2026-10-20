import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthUser } from '../../../../types/express.js';
import { AI_ID_AUTHOR_ROLES, AI_ID_COURSE_PERMISSION, isAiIdActor, isAiIdAuthorRole } from './lesson-author-ai-id-access.logic.js';

// One AI ID access rule (owner decision 2026-10-18): an author role in a
// normal session with UUID ids, plus courses.can_edit; never the ai_chatbot
// module. The predicates below are the copies the handlers used before; the
// shared rule must answer exactly like each of them.

const R = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['staff', 'superuser', 'superadmin']);
const ROLE_LIST = ['staff', 'superuser', 'superadmin'];
type U = AuthUser | null | undefined;
const replaced: Record<string, (u: U) => boolean> = {
  'session guards (courseEditorCandidate)': u => !!u && u.sessionMode === 'normal' && ROLES.has(u.role)
    && typeof u.tenantId === 'string' && R.test(u.tenantId) && R.test(u.id),
  'workspace authority validSubject': u => !!u && u.sessionMode === 'normal' && ROLE_LIST.includes(u.role)
    && R.test(u.id) && !!u.tenantId && R.test(u.tenantId),
  'launch / V2 admission controllers': u => !!u && !(u.sessionMode !== 'normal' || !u.tenantId
    || ![u.id, u.tenantId].every(id => R.test(id)) || !ROLE_LIST.includes(u.role)),
  'source stream / workspace stream controllers': u => !(!u || !u.tenantId || !R.test(u.tenantId) || !R.test(u.id)
    || !ROLES.has(u.role) || u.sessionMode !== 'normal'),
  'workspace apply / edit / read controllers': u => !!u && !(!u.tenantId || !ROLES.has(u.role) || u.sessionMode !== 'normal'
    || !R.test(u.id) || !R.test(u.tenantId)),
  'V2 launch validInput (actor part)': u => !!u && u.sessionMode === 'normal' && typeof u.tenantId === 'string'
    && ROLE_LIST.includes(u.role) && [u.id, u.tenantId].every(value => R.test(value)),
  'V1 runtime create (actor part)': u => !!u && !(u.sessionMode !== 'normal' || !u.tenantId || !ROLE_LIST.includes(u.role)
    || ![u.id, u.tenantId].every(id => R.test(id))),
};

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = 'a0000000-0000-4000-8000-0000000000aa';
function users(): U[] {
  const out: U[] = [null, undefined];
  for (const role of ['staff', 'superuser', 'superadmin', 'learner', 'learner_plus', 'admin', ''])
    for (const sessionMode of ['normal', 'demo_iframe'])
      for (const tenantId of [UUID_A, UUID_A.toUpperCase(), '', null, undefined, 'tenant-a', `${UUID_A} `])
        for (const id of [UUID_B, 'user-1', ''])
          out.push({ id, tenantId, role, username: 'u', sessionMode } as unknown as AuthUser);
  return out;
}

test('isAiIdActor answers exactly like every predicate it replaced', () => {
  const all = users();
  assert.equal(all.length, 296);
  for (const [name, before] of Object.entries(replaced)) {
    for (const user of all) assert.equal(isAiIdActor(user), before(user), `${name}: ${JSON.stringify(user)}`);
  }
});

test('authors pass in a normal session; learner_plus, learners and demo sessions never do', () => {
  const user = (role: string, sessionMode = 'normal') => ({ id: UUID_B, tenantId: UUID_A, role, username: 'u', sessionMode }) as AuthUser;
  for (const role of ['staff', 'superuser', 'superadmin']) assert.equal(isAiIdActor(user(role)), true, role);
  for (const role of ['learner', 'learner_plus']) assert.equal(isAiIdActor(user(role)), false, role);
  assert.equal(isAiIdActor(user('staff', 'demo_iframe')), false);
  assert.equal(isAiIdActor({ ...user('staff'), tenantId: null }), false);
});

test('isAiIdAuthorRole is the role list of the role-only checks (generation status, sessions, worker authority)', () => {
  assert.deepEqual([...AI_ID_AUTHOR_ROLES].sort(), ['staff', 'superadmin', 'superuser']);
  for (const role of ['staff', 'superuser', 'superadmin', 'learner', 'learner_plus', '', 'STAFF', null, undefined, 1, ['staff']]) {
    assert.equal(isAiIdAuthorRole(role), ROLE_LIST.includes(String(role)) && typeof role === 'string', String(role));
    if (typeof role === 'string') assert.equal(isAiIdAuthorRole(role), ROLES.has(role));
  }
});

test('the permission is the course data permission, never the ai_chatbot module', () => {
  assert.deepEqual(AI_ID_COURSE_PERMISSION, { moduleCode: 'courses', action: 'can_edit' });
});

test('hasAiIdCoursePermission: courses.can_edit decides, the ai_chatbot switch and grants do not', async (t) => {
  const TENANT = '33333333-3333-4333-8333-333333333333';
  let states: Record<string, boolean> = { ai_chatbot: false, courses: true };
  let grants: Record<string, Record<string, boolean>> = {};
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    if (text.includes('FROM modules m') && text.includes('LEFT JOIN tenant_modules tm')) {
      return { rows: Object.entries(states).map(([code, enabled]) => ({ code, enabled })), rowCount: 1 };
    }
    const action = /bool_or\(pgm\.(can_\w+)\)/.exec(text)?.[1];
    if (action) return { rows: [{ allowed: grants[String(params[1])]?.[action] === true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const { hasAiIdCoursePermission } = await import('./lesson-author-ai-id-access.service.js');
  let n = 0;
  const staff = () => ({ id: `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, tenantId: TENANT, role: 'staff' as const });

  grants = { courses: { can_edit: true } };
  assert.equal(await hasAiIdCoursePermission(staff()), true, 'courses.can_edit with the ai_chatbot module off');
  grants = { ai_chatbot: { can_edit: true, can_view: true, can_add: true } };
  assert.equal(await hasAiIdCoursePermission(staff()), false, 'ai_chatbot rights do not grant AI ID');
  states = { ai_chatbot: true, courses: true };
  grants = { courses: { can_edit: true } };
  assert.equal(await hasAiIdCoursePermission(staff()), true, 'the ai_chatbot switch changes nothing');
  assert.equal(await hasAiIdCoursePermission({ ...staff(), role: 'superadmin' }), true);
});
