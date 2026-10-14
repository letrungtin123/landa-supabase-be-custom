import assert from 'node:assert/strict';
import test from 'node:test';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import {
  isLaunchBriefErrorCode,
  isNormalizedLaunchBrief,
  LAUNCH_BRIEF_AUDIENCE_MAX_CHARS,
  LAUNCH_BRIEF_ERROR_MESSAGES,
  LAUNCH_BRIEF_PURPOSE_MAX_CHARS,
  LaunchBriefError,
  LaunchBriefStoredInvalidError,
  parseLaunchBrief,
  readStoredLaunchBrief,
  sameLaunchBrief,
  storedLaunchBrief,
  withLaunchBriefIdentity,
  type LessonAuthorLaunchBrief,
} from './lesson-author-launch-brief.logic.js';

const design = { design_mode: 'instructional_design', learner_audience: 'Nhân viên mới',
  course_purpose: 'Giúp nhân viên mới hiểu công ty và biết cần liên hệ ai.' } as const;
const preserve: LessonAuthorLaunchBrief = { design_mode: 'preserve_source', learner_audience: null, course_purpose: null };
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof LaunchBriefError);
  assert.equal(error.code, expected);
  return true;
};

test('QLT-6: a design-mode brief needs both texts; preserve_source must not send them', () => {
  assert.deepEqual(parseLaunchBrief(design), design);
  assert.deepEqual(parseLaunchBrief({ design_mode: 'preserve_source' }), preserve);
  assert.throws(() => parseLaunchBrief({}), code('LESSON_AUTHOR_LAUNCH_MODE_INVALID'));
  for (const mode of ['', 'INSTRUCTIONAL_DESIGN', 'verbatim', null, 1, ['preserve_source']]) {
    assert.throws(() => parseLaunchBrief({ ...design, design_mode: mode }), code('LESSON_AUTHOR_LAUNCH_MODE_INVALID'));
  }
  for (const audience of [undefined, null, '', '   ', '\n\t', '<br/>', '<script>x</script>', '<!-- -->', 7, ['x']]) {
    assert.throws(() => parseLaunchBrief({ ...design, learner_audience: audience }),
      code('LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'));
  }
  const { course_purpose: _purpose, ...noPurpose } = design;
  assert.throws(() => parseLaunchBrief(noPurpose), code('LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED'));
  assert.throws(() => parseLaunchBrief({ ...design, course_purpose: ' <p></p> ' }),
    code('LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED'));
  // Audience is checked first.
  assert.throws(() => parseLaunchBrief({ design_mode: 'instructional_design' }), code('LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED'));
  for (const extra of [{ learner_audience: 'Nhân viên' }, { course_purpose: 'Mục đích' }, { learner_audience: null },
    { course_purpose: '' }, { learner_audience: undefined }]) {
    assert.throws(() => parseLaunchBrief({ design_mode: 'preserve_source', ...extra }),
      code('LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'));
  }
});

test('QLT-6: limits are 300 / 500 code points on the trimmed text, so every panel-accepted value passes', () => {
  const audience = 'a'.repeat(LAUNCH_BRIEF_AUDIENCE_MAX_CHARS), purpose = 'ệ'.repeat(LAUNCH_BRIEF_PURPOSE_MAX_CHARS);
  assert.deepEqual(parseLaunchBrief({ ...design, learner_audience: `  ${audience}\n`, course_purpose: purpose }),
    { design_mode: 'instructional_design', learner_audience: audience, course_purpose: purpose });
  assert.throws(() => parseLaunchBrief({ ...design, learner_audience: `${audience}a` }),
    code('LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG'));
  assert.throws(() => parseLaunchBrief({ ...design, course_purpose: `${purpose}ệ` }),
    code('LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG'));
  // The panel counts UTF-16 units: 150 emoji are 300 units there and 150 code points here.
  const emoji = '😀'.repeat(150);
  assert.equal(emoji.length, 300);
  assert.equal(parseLaunchBrief({ ...design, learner_audience: emoji }).learner_audience, emoji);
  // An over-long text is rejected even when it is only markup, before any cleaning runs.
  assert.throws(() => parseLaunchBrief({ ...design, course_purpose: '<b></b>'.repeat(100) }),
    code('LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG'));
});

test('QLT-6: texts are cleaned like the QLT-5 author intent (data, never markup or control characters)', () => {
  const parsed = parseLaunchBrief({ ...design,
    learner_audience: '<p>Nhân&nbsp;viên <b>mới</b></p><script>alert(1)</script>\u0007  ở chi nhánh &amp; HQ',
    course_purpose: 'Giúp nhóm < 5 người > hiểu công ty\r\n\r\nvà <i>quy định</i>' });
  assert.equal(parsed.learner_audience, 'Nhân viên mới ở chi nhánh & HQ');
  assert.equal(parsed.course_purpose, 'Giúp nhóm ‹ 5 người › hiểu công ty và quy định');
  assert.ok(isNormalizedLaunchBrief(parsed));
});

test('QLT-6: normalized-brief check accepts only what the parser produces', () => {
  assert.ok(isNormalizedLaunchBrief(design));
  assert.ok(isNormalizedLaunchBrief(preserve));
  for (const value of [null, [], 'brief', { ...design, version: 1 }, { ...design, learner_audience: ' Nhân viên' },
    { ...design, learner_audience: 'Nhân  viên' }, { ...design, learner_audience: 'Nhân\nviên' },
    { ...design, learner_audience: '<b>x</b>' }, { ...design, learner_audience: '' },
    { ...design, course_purpose: 'x'.repeat(501) }, { ...preserve, learner_audience: '' },
    { ...preserve, course_purpose: 'Mục đích' }, { design_mode: 'instructional_design', learner_audience: 'x' }]) {
    assert.equal(isNormalizedLaunchBrief(value), false, JSON.stringify(value));
  }
});

test('QLT-6: the stored jsonb is exactly the brief plus version 1; reads drop the version, NULL reads null', () => {
  assert.deepEqual(storedLaunchBrief(design), { ...design, version: 1 });
  assert.deepEqual(Object.keys(storedLaunchBrief(preserve)), ['design_mode', 'learner_audience', 'course_purpose', 'version']);
  assert.deepEqual(readStoredLaunchBrief(storedLaunchBrief(design)), design);
  assert.deepEqual(readStoredLaunchBrief(JSON.parse(JSON.stringify(storedLaunchBrief(preserve)))), preserve);
  assert.equal(readStoredLaunchBrief(null), null);
  assert.equal(readStoredLaunchBrief(undefined), null);
  for (const value of [design, { ...design, version: 2 }, { ...design, version: '1' }, { ...design, version: 1, extra: true },
    { ...preserve, version: 1, learner_audience: '' }, [], 'x', 1]) {
    assert.throws(() => readStoredLaunchBrief(value), LaunchBriefStoredInvalidError);
  }
  // What is written always satisfies the SQL CHECK: trimmed non-empty strings within 1..300 / 1..500, or nulls.
  for (const brief of [design, preserve, parseLaunchBrief({ ...design, learner_audience: ` ${'x'.repeat(300)} ` })]) {
    const stored = storedLaunchBrief(brief);
    for (const [key, max] of [['learner_audience', 300], ['course_purpose', 500]] as const) {
      const text = stored[key];
      if (stored.design_mode === 'preserve_source') assert.equal(text, null);
      else assert.ok(typeof text === 'string' && text === text.trim() && [...text].length >= 1 && [...text].length <= max);
    }
  }
});

test('QLT-6: replay identity: the same brief matches, another brief or a NULL row never does', () => {
  assert.ok(sameLaunchBrief(storedLaunchBrief(design), design));
  assert.ok(sameLaunchBrief(storedLaunchBrief(preserve), preserve));
  assert.equal(sameLaunchBrief(null, design), false);
  assert.equal(sameLaunchBrief(storedLaunchBrief(design), preserve), false);
  assert.equal(sameLaunchBrief(storedLaunchBrief(design), { ...design, course_purpose: 'Mục đích khác.' }), false);
  assert.equal(sameLaunchBrief({ ...design }, design), false);
  assert.equal(sameLaunchBrief({ ...design, version: 1, learner_audience: ' Nhân viên mới' }, design), false);

  const base = { content: 'Tạo nội dung bài học từ tài liệu đã chọn.', locale: 'vi', sources: ['d1'] };
  // Without a brief the request identity is unchanged (pre-QLT-6 hashes stay valid).
  assert.equal(withLaunchBriefIdentity(base, undefined), base);
  assert.equal(withLaunchBriefIdentity(base, null), base);
  const hashes = [design, preserve, { ...design, learner_audience: 'Quản lý' }]
    .map(brief => generationSnapshotHash(withLaunchBriefIdentity(base, brief)));
  assert.equal(new Set([generationSnapshotHash(base), ...hashes]).size, 4);
  assert.equal(generationSnapshotHash(withLaunchBriefIdentity(base, { ...design })), hashes[0]);
});

test('QLT-6: every launch brief code has a plain message in both languages', () => {
  const codes = ['LESSON_AUTHOR_LAUNCH_MODE_INVALID', 'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED',
    'LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED', 'LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG', 'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED'];
  assert.deepEqual(Object.keys(LAUNCH_BRIEF_ERROR_MESSAGES).sort(), [...codes].sort());
  for (const value of codes) {
    assert.ok(isLaunchBriefErrorCode(value));
    const [vi, en] = LAUNCH_BRIEF_ERROR_MESSAGES[value as keyof typeof LAUNCH_BRIEF_ERROR_MESSAGES];
    assert.ok(vi.length > 10 && en.length > 10 && vi !== en);
    assert.doesNotMatch(`${vi} ${en}`, /[A-Z]{2,}_[A-Z]|undefined/);
  }
  assert.equal(isLaunchBriefErrorCode('WORKSPACE_CREATE_INPUT_INVALID'), false);
  assert.equal(isLaunchBriefErrorCode('toString'), false);
});
