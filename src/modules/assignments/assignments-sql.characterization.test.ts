import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/staff-sql-characterization.js';

// Characterization of the assignment routes (/api/assignments, without the
// email outbox, which has its own goldens): every SQL statement, every Storage
// request and the answer of every assignments handler, over a matrix of roles,
// bodies, files and empty results (src/test-support/staff-sql-characterization.ts).
// The golden file was written by the code before the assignments repository
// existed; moving SQL into repositories must keep every entry equal. Rewrite
// it only for an intended change:
//   ASSIGNMENTS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/assignments/assignments-sql.characterization.test.ts
// ASSIGNMENTS_SQL_FULL_OUT=<file> also writes every outcome in full.
//
// A download is exercised with HEAD (headers, no body pipe); the streamed body
// is covered by assignment-download-stream.test.ts.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k', path: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./assignments.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'a0000000-0000-4000-8000-000000000001';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';
const ASSIGNMENT = 'b0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_2 = 'b0000000-0000-4000-8000-000000000002';
const SUBMISSION = 'c0000000-0000-4000-8000-000000000001';
const ENROLLMENT = 'd0000000-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const NOTIFICATION = 'e0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+C1+2026';

const ATTACHMENT = {
  id: FILE, original_name: 'De bai.pdf', mime_type: 'application/pdf', size_bytes: 1024,
  storage_path: `${TENANT}/assignments/${COURSE}/${ASSIGNMENT}/attachment/${FILE}_de-bai.pdf`,
  created_at: '2026-02-01T00:00:00.000Z',
};
const SUBMISSION_FILE = { id: FILE, original_name: 'Bai lam.docx', mime_type: 'application/msword', size_bytes: 2048 };

/** One row with every column an assignments statement reads. */
const ROW = {
  id: ASSIGNMENT, tenant_id: TENANT, course_id: COURSE, title: 'Bài tập 1', question: 'Câu hỏi', sort_order: 0,
  allow_resubmission: true, deadline_enabled: true, deadline_at: null, deadline_mode: 'relative_to_enrollment',
  deadline_after_days: 7, attachment_file: ATTACHMENT, grading_enabled: true, submission_unlock_mode: 'anytime',
  created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z', submitted_count: 1, feedback_count: 0,
  is_published: true, display_name: 'Khóa học A', visible_to_staff_only: false, is_public: false, allowed: true,
  course_name: 'Khóa học A', count: '1', enrollment_id: ENROLLMENT, effective_deadline_at: '2026-12-01T00:00:00.000Z',
  is_deadline_expired: false, status: 'submitted', submission_id: SUBMISSION, answer_text: 'Bài làm',
  files: [SUBMISSION_FILE], submitted_at: '2026-03-01T00:00:00.000Z', submission_version: 1, score: 80,
  feedback_text: 'Tốt', feedback_files: [], feedback_by: USER, feedback_at: '2026-03-02T00:00:00.000Z',
  feedback_by_username: 'staff01', feedback_by_name: 'Nhân viên', feedback_by_email: 's@example.test',
  learner_id: LEARNER, learner_name: 'Học viên', learner_username: 'learner01', learner_email: 'l@example.test',
  learner_role: 'learner', assignment_id: ASSIGNMENT, assignment_title: 'Bài tập 1', assignment_question: 'Câu hỏi',
  name: 'Nhân viên', email: 's@example.test', recipient_count: 2, storage_path: ATTACHMENT.storage_path,
  original_name: 'De bai.pdf', mime_type: 'application/pdf', uploaded_by: LEARNER, kind: 'submission',
  total: 3, completed: 3, is_complete: true, exists: false, job_count: 1, inserted: 1, domain_learner: 'learn.example.test',
  template_key: 'assignment_feedback', subject_template: 'Phản hồi {{assignment_title}}', preheader_template: '',
  body_template: '<p>{{feedback_text}}</p>', is_enabled: true, updated_by: USER,
};

/** Every case: no account is the tenant's demo iframe learner. */
const NOT_DEMO = noRowsWhen(/tenant_demo_iframe_settings/);

interface CallOptions {
  role?: string;
  userId?: string;
  tenantId?: string | null;
  sessionMode?: string;
  method?: string;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  files?: unknown[];
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: {
      id: options.userId ?? USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'staff',
      username: 'staff01',
      sessionMode: options.sessionMode ?? 'normal',
    },
    method: options.method ?? 'GET',
    query: options.query ?? {},
    params: { courseId: COURSE, assignmentId: ASSIGNMENT, submissionId: SUBMISSION, fileId: FILE, ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    files: options.files,
    originalUrl: '/api/assignments',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) =>
  cases.push({ name, run, answer: answer ? answers(answer, NOT_DEMO) : NOT_DEMO });

const H = ctrl;
const UPLOAD = { originalname: 'Đề bài.pdf', mimetype: 'application/pdf', size: 1024, buffer: Buffer.from('pdf') };
const BIG_UPLOAD = { ...UPLOAD, size: 26 * 1024 * 1024 };
const learner = { role: 'learner', userId: LEARNER };

// ── Staff: list, create, update, delete, reorder ──
const noAssignmentYet = noRowsWhen(/FROM course_assignments\s+WHERE tenant_id = \$1::uuid\s+AND course_id = \$2::varchar/);
add('list', () => call(H.listCourseAssignments));
add('list no tenant', () => call(H.listCourseAssignments, { tenantId: null }));
add('list missing course', () => call(H.listCourseAssignments), noRowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2/));
add('list empty', () => call(H.listCourseAssignments), noRowsWhen(/FROM course_assignments ca/));
const CREATE = { title: ' Bài mới ', question: 'Hãy làm', allow_resubmission: 'true', grading_enabled: 'false' };
add('create', () => call(H.createAssignment, { body: CREATE }), noAssignmentYet);
add('create with attachment', () => call(H.createAssignment, { body: { ...CREATE, deadline_after_days: '14' }, file: UPLOAD }), noAssignmentYet);
add('create no deadline', () =>
  call(H.createAssignment, { body: { ...CREATE, deadline_mode: 'none', submission_unlock_mode: 'anytime' } }),
  answers(noAssignmentYet, rowsWhen(/INSERT INTO course_assignments/, [{ ...ROW, deadline_mode: 'none', deadline_after_days: null }])),
);
add('create staff-only course', () =>
  call(H.createAssignment, { body: CREATE }),
  answers(noAssignmentYet, rowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2/, [{ ...ROW, visible_to_staff_only: true }])),
);
add('create public course', () =>
  call(H.createAssignment, { body: CREATE }),
  answers(noAssignmentYet, rowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2/, [{ ...ROW, is_public: true }])),
);
add('create no recipients', () =>
  call(H.createAssignment, { body: CREATE }),
  answers(noAssignmentYet, rowsWhen(/RETURNING recipient_count/, [{ recipient_count: 0 }])),
);
add('create already one', () => call(H.createAssignment, { body: CREATE }));
add('create unique race', () => call(H.createAssignment, { body: CREATE, file: UPLOAD }), answers(noAssignmentYet, failWhen(/INSERT INTO course_assignments/, '23505')));
add('create attachment too big', () => call(H.createAssignment, { body: CREATE, file: BIG_UPLOAD }), noAssignmentYet);
add('create invalid', () => call(H.createAssignment, { body: { title: '', question: 'x' } }));
add('create absolute deadline', () => call(H.createAssignment, { body: { ...CREATE, deadline_mode: 'absolute' } }));
add('create missing course', () => call(H.createAssignment, { body: CREATE }), noRowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2/));
add('create no tenant', () => call(H.createAssignment, { tenantId: null, body: CREATE }));
add('update', () => call(H.updateAssignment, { body: { title: 'Tên mới', question: 'Q', allow_resubmission: 'false', submission_unlock_mode: 'after_content_complete' } }));
add('update attachment', () => call(H.updateAssignment, { body: {}, file: UPLOAD }));
add('update remove attachment', () => call(H.updateAssignment, { body: { remove_attachment: 'true' } }));
add('update remove missing attachment', () =>
  call(H.updateAssignment, { body: { remove_attachment: true } }),
  rowsWhen(/SELECT ca\.\*, c\.display_name AS course_name/, [{ ...ROW, attachment_file: null }]),
);
add('update nothing', () => call(H.updateAssignment, { body: {} }));
add('update deadline', () => call(H.updateAssignment, { body: { deadline_after_days: '3' } }));
add('update missing', () => call(H.updateAssignment, { body: { title: 'x' } }), noRowsWhen(/SELECT ca\.\*, c\.display_name AS course_name/));
add('update vanished', () => call(H.updateAssignment, { body: { title: 'x' }, file: UPLOAD }), noRowsWhen(/^\s*UPDATE course_assignments\s+SET title/));
add('delete', () => call(H.deleteAssignment));
add('delete missing', () => call(H.deleteAssignment), noRowsWhen(/SELECT ca\.\*, c\.display_name AS course_name/));
add('delete vanished', () => call(H.deleteAssignment), noRowsWhen(/SET deleted_at = now\(\)/));
add('reorder', () =>
  call(H.reorderAssignments, { body: { assignment_ids: [ASSIGNMENT_2, ASSIGNMENT] } }),
  rowsWhen(/SELECT id\s+FROM course_assignments\s+WHERE tenant_id = \$1 AND course_id = \$2/, [{ id: ASSIGNMENT }, { id: ASSIGNMENT_2 }]),
);
add('reorder unknown id', () => call(H.reorderAssignments, { body: { assignment_ids: [ASSIGNMENT_2] } }));
add('reorder invalid', () => call(H.reorderAssignments, { body: { assignment_ids: [] } }));

// ── Staff: submissions, feedback ──
add('submissions', () => call(H.listCourseSubmissions));
add('submissions not submitted search', () =>
  call(H.listCourseSubmissions, { query: { status: 'not_submitted', search: 'an', assignment_id: ASSIGNMENT, page: '2', page_size: '5' } }),
);
add('submissions submitted', () => call(H.listCourseSubmissions, { query: { status: 'submitted', search: 'an', assignment_id: ASSIGNMENT } }));
add('submissions feedback given', () => call(H.listCourseSubmissions, { query: { status: 'feedback_given' } }));
add('submissions odd query', () => call(H.listCourseSubmissions, { query: { status: ['submitted'], assignment_id: ['x'], page_size: '1000' } }));
add('submissions staff-only course', () =>
  call(H.listCourseSubmissions),
  rowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2/, [{ ...ROW, visible_to_staff_only: true, is_public: true }]),
);
add('submissions empty', () => call(H.listCourseSubmissions, { query: { status: 'submitted' } }), noRowsWhen(/FROM assignment_submissions s/));
add('feedback', () => call(H.feedbackSubmission, { body: { feedback_text: ' Tốt lắm ', score: '90' }, files: [UPLOAD] }));
add('feedback keeps files', () => call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 70 } }));
add('feedback no grading', () =>
  call(H.feedbackSubmission, { body: { feedback_text: 'Tốt' } }),
  rowsWhen(/s\.status::text AS status, s\.feedback_at/, [{ ...ROW, grading_enabled: false }]),
);
add('feedback score missing', () => call(H.feedbackSubmission, { body: { feedback_text: 'Tốt' } }));
add('feedback score not graded', () =>
  call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 10 } }),
  rowsWhen(/s\.status::text AS status, s\.feedback_at/, [{ ...ROW, grading_enabled: false }]),
);
add('feedback missing', () => call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 } }), noRowsWhen(/s\.status::text AS status, s\.feedback_at/));
add('feedback vanished', () => call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 } }), noRowsWhen(/FOR UPDATE/));
add('feedback not ready', () =>
  call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 } }),
  rowsWhen(/FOR UPDATE/, [{ status: 'draft', feedback_files: [], score: null }]),
);
add('feedback not updated', () =>
  call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 }, files: [UPLOAD] }),
  noRowsWhen(/RETURNING feedback_at/),
);
add('feedback no admin name', () => call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 } }), noRowsWhen(/AS name,\s+email/));
add('feedback too many files', () =>
  call(H.feedbackSubmission, { body: { feedback_text: 'Tốt', score: 1 }, files: [UPLOAD, UPLOAD, UPLOAD, UPLOAD, UPLOAD, UPLOAD] }),
);
add('feedback invalid', () => call(H.feedbackSubmission, { body: { feedback_text: '', score: 101 } }));
add('feedback history', () => call(H.listSubmissionFeedbackHistory));
add('feedback history missing', () => call(H.listSubmissionFeedbackHistory), noRowsWhen(/^\s*SELECT id\s+FROM assignment_submissions/));
add('feedback history no tenant', () => call(H.listSubmissionFeedbackHistory, { tenantId: null }));

// ── Learner ──
add('learner list', () => call(H.listLearnerCourseAssignments, learner));
add('learner list staff', () => call(H.listLearnerCourseAssignments));
add('learner list not enrolled', () =>
  call(H.listLearnerCourseAssignments, learner),
  rowsWhen(/SELECT e\.id AS enrollment_id/, [{ enrollment_id: null }]),
);
add('learner list content locked', () =>
  call(H.listLearnerCourseAssignments, learner),
  answers(
    rowsWhen(/FROM course_assignments ca\s+LEFT JOIN enrollments e/, [{ ...ROW, submission_unlock_mode: 'after_content_complete', submission_id: null }]),
    text => (/course_progress|course_blocks|block_progress/.test(text) ? { rows: [{ ...ROW, total: 3, completed: 1, is_complete: false }] } : undefined),
  ),
);
add('learner list expired', () =>
  call(H.listLearnerCourseAssignments, learner),
  rowsWhen(/FROM course_assignments ca\s+LEFT JOIN enrollments e/, [{ ...ROW, is_deadline_expired: true, deadline_mode: 'x' }]),
);
add('learner list no access', () => call(H.listLearnerCourseAssignments, learner), noRowsWhen(/SELECT e\.id AS enrollment_id/));
add('learner list no tenant', () => call(H.listLearnerCourseAssignments, { ...learner, tenantId: null }));
add('learner get', () => call(H.getLearnerAssignment, learner));
add('learner get missing', () => call(H.getLearnerAssignment, learner), noRowsWhen(/SELECT course_id\s+FROM course_assignments/));
add('learner get not listed', () => call(H.getLearnerAssignment, { ...learner, params: { assignmentId: ASSIGNMENT_2 } }));
const firstSubmission = noRowsWhen(/SELECT id, status\s+FROM assignment_submissions/);
add('submit', () => call(H.submitAssignment, { ...learner, body: { answer_text: ' Bài làm ' }, files: [UPLOAD] }), firstSubmission);
add('submit again', () => call(H.submitAssignment, { ...learner, body: { answer_text: 'Lần 2' } }));
add('submit no resubmission', () =>
  call(H.submitAssignment, { ...learner, body: {} }),
  rowsWhen(/AS effective_deadline_at,\s+COALESCE\(ca\.submission_unlock_mode/, [{ ...ROW, allow_resubmission: false }]),
);
add('submit after feedback', () =>
  call(H.submitAssignment, { ...learner, body: {} }),
  rowsWhen(/SELECT id, status\s+FROM assignment_submissions/, [{ id: SUBMISSION, status: 'feedback_given' }]),
);
add('submit expired', () =>
  call(H.submitAssignment, { ...learner, body: {} }),
  rowsWhen(/AS effective_deadline_at,\s+COALESCE\(ca\.submission_unlock_mode/, [{ ...ROW, effective_deadline_at: '2026-01-01T00:00:00.000Z' }]),
);
add('submit content locked', () =>
  call(H.submitAssignment, { ...learner, body: {} }),
  answers(
    rowsWhen(/AS effective_deadline_at,\s+COALESCE\(ca\.submission_unlock_mode/, [{ ...ROW, submission_unlock_mode: 'after_content_complete' }]),
    text => (/course_progress|course_blocks|block_progress/.test(text) ? { rows: [{ ...ROW, total: 3, completed: 1, is_complete: false }] } : undefined),
  ),
);
add('submit no access', () => call(H.submitAssignment, { ...learner, body: {} }), noRowsWhen(/AS effective_deadline_at,\s+COALESCE\(ca\.submission_unlock_mode/));
add('submit staff', () => call(H.submitAssignment, { body: {} }));
add('submit demo session', () => call(H.submitAssignment, { ...learner, sessionMode: 'demo_iframe', body: {} }));
add('submit demo account', () => call(H.submitAssignment, { ...learner, body: {} }), rowsWhen(/tenant_demo_iframe_settings/, [{ exists: true }]));
add('submit fails', () =>
  call(H.submitAssignment, { ...learner, body: {}, files: [UPLOAD] }),
  answers(firstSubmission, failWhen(/INSERT INTO assignment_submissions/, '23503')),
);
add('submit invalid', () => call(H.submitAssignment, { ...learner, body: { answer_text: 5 } }));

// ── Downloads (HEAD) ──
const noAttachment = noRowsWhen(/ca\.attachment_file ->> 'id' = \$1/);
add('download attachment staff', () => call(H.downloadFile, { method: 'HEAD' }));
add('download attachment superuser', () => call(H.downloadFile, { method: 'HEAD', role: 'superuser' }));
add('download attachment learner', () => call(H.downloadFile, { ...learner, method: 'HEAD' }));
add('download attachment learner no access', () => call(H.downloadFile, { ...learner, method: 'HEAD' }), noRowsWhen(/SELECT true AS allowed/));
add('download attachment other tenant', () => call(H.downloadFile, { method: 'HEAD', tenantId: OTHER_TENANT }));
add('download attachment staff no permission', () => call(H.downloadFile, { method: 'HEAD' }), rowsWhen(/AS allowed\s+FROM user_permission_groups/, [{ allowed: false }]));
add('download submission file learner', () => call(H.downloadFile, { ...learner, method: 'HEAD' }), noAttachment);
add('download feedback file learner', () =>
  call(H.downloadFile, { ...learner, method: 'HEAD' }),
  answers(noAttachment, rowsWhen(/FROM assignment_files af/, [{ ...ROW, id: FILE, kind: 'feedback', feedback_files: [SUBMISSION_FILE] }])),
);
add('download stale feedback file learner', () =>
  call(H.downloadFile, { ...learner, method: 'HEAD' }),
  answers(noAttachment, rowsWhen(/FROM assignment_files af/, [{ ...ROW, id: FILE, kind: 'feedback', feedback_files: [] }])),
);
add('download other learner file', () => call(H.downloadFile, { role: 'learner', userId: USER, method: 'HEAD' }), noAttachment);
add('download submission file superadmin', () => call(H.downloadFile, { role: 'superadmin', tenantId: null, method: 'HEAD' }), noAttachment);
add('download missing file', () => call(H.downloadFile, { method: 'HEAD' }), answers(noAttachment, noRowsWhen(/FROM assignment_files af/)));

runCharacterization({
  label: 'assignments characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'assignments-sql.characterization.golden.json'),
  writeGolden: process.env.ASSIGNMENTS_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.ASSIGNMENTS_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, OTHER_TENANT, USER, LEARNER, ASSIGNMENT, ASSIGNMENT_2, SUBMISSION, ENROLLMENT, FILE, NOTIFICATION],
  sideRequests: storageRequests,
  scrubEmbeddedIds: true,
});
