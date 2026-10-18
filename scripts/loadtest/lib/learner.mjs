// One synthetic learner: the requests fe-5173 makes from the sign-in page to the last unit (see README for sources).
import { LOADTEST_TENANT, learnerUsername, scaledRange } from './config.mjs';
import { ApiSession, StopError, createRng, sleep } from './session.mjs';

const C = LOADTEST_TENANT.courseId;
const CE = encodeURIComponent(C);
const STRUCTURAL = new Set(['course', 'chapter', 'sequential', 'vertical']);
const PASSIVE = new Set(['html', 'video', 'la_diagram', 'la_faq', 'la_pdf']);

/** React Query stale times of the course page (fe-5173 LessonDetailPage / CourseLayout / CourseSidebar). */
const COURSE_QUERIES = [
  { key: 'progress', staleMs: 300_000, name: 'GET /api/learner/progress/:courseId', path: `/api/learner/progress/${CE}` },
  { key: 'modal-config', staleMs: 600_000, name: 'GET /api/learner/courses/:courseId/modal-config', path: `/api/learner/courses/${CE}/modal-config` },
  { key: 'blocks', staleMs: 300_000, name: 'GET /api/learner/courses/:courseId/blocks', path: `/api/learner/courses/${CE}/blocks`, retries: 2 },
  { key: 'detail', staleMs: 600_000, name: 'GET /api/learner/courses/:courseId', path: `/api/learner/courses/${CE}`, retries: 2 },
  { key: 'files', staleMs: 300_000, name: 'GET /api/learner/courses/:courseId/files', path: `/api/learner/courses/${CE}/files` },
  { key: 'assignments', staleMs: 60_000, name: 'GET /api/assignments/learner/courses/:courseId', path: `/api/assignments/learner/courses/${CE}`, retries: 2 },
];
const LATE_QUERIES = [
  { key: 'section-configs', staleMs: 300_000, name: 'GET /api/learner/courses/:courseId/section-modal-configs', path: `/api/learner/courses/${CE}/section-modal-configs`, retries: 2 },
  { key: 'section-shown', staleMs: 120_000, name: 'GET /api/learner/courses/:courseId/section-modal-shown', path: `/api/learner/courses/${CE}/section-modal-shown`, retries: 2 },
];

export function vnDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Units (verticals) in course order with their leaf blocks, from GET .../blocks. */
export function unitsFromBlocks(payload) {
  const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
  const children = new Map();
  for (const block of blocks) {
    const list = children.get(block.parent_id ?? null) || [];
    list.push(block);
    children.set(block.parent_id ?? null, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const units = [];
  const walk = (parentId, path) => {
    for (const block of children.get(parentId) || []) {
      if (block.block_type === 'vertical') {
        const leaves = (children.get(block.id) || []).filter((b) => !STRUCTURAL.has(b.block_type));
        units.push({ id: block.id, lessonId: path.sequential, chapterId: path.chapter, position: units.length, leaves });
      } else if (STRUCTURAL.has(block.block_type)) {
        walk(block.id, { ...path, [block.block_type]: block.id });
      }
    }
  };
  walk(payload?.root_id ?? null, {});
  return units;
}

/** Index of the right choice in the seeded course: (chapter*12 + lesson*3 + unit) % 4, i.e. unit position % 4. */
export const seededCorrectChoice = (unitPosition) => unitPosition % 4;

export async function runLearner({ index, options, transport, recorder, password, stop }) {
  const rng = createRng((options.seed * 100_003 + index) >>> 0);
  const think = async (kind) => {
    const [min, max] = scaledRange(options, kind);
    return sleep(rng.between(min, max), stop);
  };
  const username = learnerUsername(index);
  const session = new ApiSession({
    transport, recorder, options, username, password, rng, signal: stop,
    clientApp: 'learner', origin: LOADTEST_TENANT.learnerOrigin, label: `learner ${username}`,
    forwardedFor: options.forwardedFor ? `10.77.${(index >> 8) & 255}.${index & 255}` : undefined,
  });
  const get = (name, path, opts) => session.request(name, 'GET', path, opts);
  const send = (name, method, path, body) => session.request(name, method, path, { body });
  const host = LOADTEST_TENANT.hostname;
  const fetchedAt = new Map();
  const state = { progress: 0, completed: false, unreadCount: null, sessionStartedAt: 0 };
  const sessionEnd = new AbortController();
  const background = [];

  recorder.vuStarted();
  try {
    // ── Sign-in page (public, parallel) ──
    await Promise.all([
      // Raw fetch / plain axios in the app: outside the apiClient queue, no auth, no retries.
      get('GET /api/branding/by-domain/:domain', `/api/branding/by-domain/${host}`, { auth: false, apiClient: false }),
      get('GET /api/dashboard-content/by-domain/:domain', `/api/dashboard-content/by-domain/${host}`, { auth: false, apiClient: false }),
      get('GET /api/sso/public/by-domain/:domain', `/api/sso/public/by-domain/${host}`, { auth: false, apiClient: false }),
    ]);
    if (!(await think('loginPage'))) return;
    const login = await session.login();
    if (!login.ok) return;
    state.sessionStartedAt = Date.now();
    await get('GET /api/auth/me', '/api/auth/me');

    // ── Session-wide components (parallel), then the header's progress batch ──
    const badgesOn = session.tenantModules.includes('badge_management');
    const [welcome, , , , unread, , enrollments] = await Promise.all([
      get('GET /api/welcome-init/state', '/api/welcome-init/state', { queryRetries: 1 }),
      badgesOn ? evaluateBadges() : null,
      get('GET /api/enrollments/weekly-study-time', '/api/enrollments/weekly-study-time'),
      get('GET /api/ai-chatbot/chat/active-bot', '/api/ai-chatbot/chat/active-bot?target=learner'),
      get('GET /api/learner/notifications/unread-count', '/api/learner/notifications/unread-count'),
      get('GET /api/learner/notifications', '/api/learner/notifications?page_size=20'),
      get('GET /api/learner/enrollments', '/api/learner/enrollments', { queryRetries: 2 }),
      get('GET /api/learner/courses', '/api/learner/courses?page_size=200', { queryRetries: 2 }),
    ]);
    state.unreadCount = unread?.json?.data?.count ?? null;
    const enrolled = (enrollments?.json?.data || []).map((e) => e.course_id).filter(Boolean);
    if (enrolled.length) await get('GET /api/learner/progress-batch', `/api/learner/progress-batch?courseIds=${enrolled.map(encodeURIComponent).join(',')}`);

    background.push(pollNotifications(), syncStudyTime(), keepTokenFresh());

    if (welcome?.json?.data?.should_show) {
      if (!(await think('modal'))) return;
      await send('POST /api/welcome-init/seen', 'POST', '/api/welcome-init/seen');
    }
    if (!(await think('dashboard'))) return;

    // ── Course page ──
    const opened = await openCoursePage(true);
    if (!opened) return;
    let { units, modalConfig, modalState } = opened;
    state.progress = Number(opened.progress ?? 0);

    if (modalConfig?.welcome_enabled && !modalState?.welcome_shown && state.progress === 0) {
      if (!(await think('modal'))) return;
      await send('PATCH /api/learner/courses/:courseId/modal-state', 'PATCH', `/api/learner/courses/${CE}/modal-state`, { welcome_shown: true });
      if (badgesOn && (await sleep(1000 * options.appDelayScale, stop))) await evaluateBadges();
    }

    let currentLesson = null;
    let studied = 0;
    for (const unit of units) {
      if (stop.aborted || session.loggedOut) break;
      if (studied >= options.unitsPerSession) break;
      if (unit.leaves.every((leaf) => leaf.completed)) continue;
      if (currentLesson !== null && unit.lessonId !== currentLesson) {
        recorder.count('lesson_changes');
        await refetchStale(COURSE_QUERIES);
        await refetchStale(LATE_QUERIES);
      }
      currentLesson = unit.lessonId;

      // Passive leaves are completed as soon as the unit is current; quiz components fetch their block.
      const passive = unit.leaves.filter((leaf) => PASSIVE.has(leaf.block_type) && !leaf.completed).map((leaf) => leaf.id);
      const quizzes = unit.leaves.filter((leaf) => leaf.block_type === 'problem' && !leaf.completed);
      await Promise.all([
        passive.length ? complete(passive) : null,
        ...quizzes.map((quiz) => get('GET /api/learner/blocks/:blockId', `/api/learner/blocks/${quiz.id}`)),
      ]);
      for (const leaf of unit.leaves) if (passive.includes(leaf.id)) leaf.completed = true;
      if (!(await think('unitRead'))) break;

      for (const quiz of quizzes) {
        if (!(await think('quizAnswer'))) break;
        const correct = await answerQuiz(quiz, unit);
        if (correct) {
          await complete([quiz.id]);
          quiz.completed = true;
        }
      }
      if (stop.aborted) break;
      studied += 1;
      recorder.count('units_studied');
      if (!(await think('betweenUnits'))) break;
    }

    if (state.completed && !stop.aborted) {
      recorder.count('courses_completed');
      if (modalConfig?.confirm_enabled && !modalState?.confirm_shown && (await think('modal'))) {
        await send('PATCH /api/learner/courses/:courseId/modal-state', 'PATCH', `/api/learner/courses/${CE}/modal-state`, { confirm_shown: true });
      }
      if (modalConfig?.completion_enabled && !modalState?.complete_shown && !stop.aborted) {
        await send('PATCH /api/learner/courses/:courseId/modal-state', 'PATCH', `/api/learner/courses/${CE}/modal-state`, { complete_shown: true });
        if (badgesOn && (await sleep(1000 * options.appDelayScale, stop))) await evaluateBadges();
      }
    }

    await think('linger');
  } catch (err) {
    if (err instanceof StopError) throw err;
    recorder.count('learner_crashed');
    if (!options.quiet) console.error(`[${username}] ${err?.stack || err}`);
  } finally {
    sessionEnd.abort();
    await Promise.allSettled(background);
    if (session.accessToken && !session.loggedOut) {
      await finalStudySync();
      if (options.logout) await session.logout();
    }
    recorder.vuEnded();
    recorder.count('learners_finished');
  }

  // ── helpers (hoisted function declarations share the closure above) ──

  async function openCoursePage(first) {
    const results = await Promise.all(COURSE_QUERIES.map((q) => fetchQuery(q)));
    const byKey = Object.fromEntries(COURSE_QUERIES.map((q, i) => [q.key, results[i]]));
    let blocksRes = byKey.blocks;
    if (blocksRes.status === 403 || blocksRes.status === 400) {
      const enroll = await send('POST /api/learner/enroll', 'POST', '/api/learner/enroll', { course_id: C });
      if (enroll.status !== 200 && enroll.status !== 201) return null;
      blocksRes = await fetchQuery(COURSE_QUERIES.find((q) => q.key === 'blocks'), true);
      await get('GET /api/learner/enrollments', '/api/learner/enrollments');
    }
    if (blocksRes.status !== 200) { recorder.count('course_open_failed'); return null; }
    const modalStateRes = await get('GET /api/learner/courses/:courseId/modal-state', `/api/learner/courses/${CE}/modal-state`, { queryRetries: 2 });
    if (first && (await sleep(800 * options.appDelayScale, stop))) await Promise.all(LATE_QUERIES.map((q) => fetchQuery(q)));
    const units = unitsFromBlocks(blocksRes.json?.data);
    if (first) recorder.count('course_opens');
    if (units.length === 0) recorder.count('course_without_units');
    return {
      units,
      progress: byKey.progress?.json?.data?.progress,
      modalConfig: byKey['modal-config']?.json?.data,
      modalState: modalStateRes?.json?.data,
    };
  }

  async function fetchQuery(query, force = false) {
    const res = await get(query.name, query.path, { queryRetries: query.retries || 0 });
    if (res.status === 200 || force) fetchedAt.set(query.key, Date.now());
    return res;
  }

  async function refetchStale(queries) {
    const now = Date.now();
    await Promise.all(queries.filter((q) => now - (fetchedAt.get(q.key) || 0) > q.staleMs).map((q) => fetchQuery(q)));
  }

  async function complete(blockIds, enrollRetried = false) {
    const res = await send('POST /api/learner/complete-blocks', 'POST', '/api/learner/complete-blocks', { course_id: C, block_ids: blockIds });
    if (res.status === 400 && !enrollRetried) {
      // The app enrolls and retries once (fe-5173 src/api/progress.ts).
      const enroll = await send('POST /api/learner/enroll', 'POST', '/api/learner/enroll', { course_id: C });
      if (enroll.status === 200 || enroll.status === 201) return complete(blockIds, true);
      return res;
    }
    const data = res.json?.data;
    if (res.status !== 200 || !data) return res;
    recorder.count('blocks_marked', Number(data.marked) || 0);
    if (data.progress !== undefined) state.progress = Number(data.progress);
    if (data.is_completed) state.completed = true;
    // Debounced follow-up refetches of the app (fe-5173 src/lib/completionSync.logic.ts).
    const refetchBlocks = data.newly_completed === undefined || (typeof data.marked === 'number' && data.marked < blockIds.length);
    if ((refetchBlocks || data.progress === undefined) && (await sleep(500 * options.appDelayScale, stop))) {
      await Promise.all([
        refetchBlocks ? fetchQuery(COURSE_QUERIES.find((q) => q.key === 'blocks')) : null,
        data.progress === undefined ? fetchQuery(COURSE_QUERIES[0]) : null,
      ]);
    }
    if (data.completion_changed === true && (await sleep(500 * options.appDelayScale, stop))) {
      await Promise.all([
        session.tenantModules.includes('badge_management') ? evaluateBadges() : null,
        data.is_completed ? get('GET /api/learner/progress-batch', `/api/learner/progress-batch?courseIds=${CE}`) : null,
        data.is_completed ? get('GET /api/learner/enrollments', '/api/learner/enrollments') : null,
        data.is_completed ? get('GET /api/assignments/learner/courses/:courseId', `/api/assignments/learner/courses/${CE}`) : null,
      ]);
    }
    return res;
  }

  /**
   * Right at the first try with --quiz-first-try-correct, otherwise one or two wrong choices first. The answer key is
   * hidden from learners, so the seeded rule is used; any other choice order is tried if the rule does not hold.
   */
  async function answerQuiz(quiz, unit) {
    const right = seededCorrectChoice(unit.position);
    const wrong = [0, 1, 2, 3].filter((c) => c !== right).sort(() => rng.next() - 0.5);
    const plan = rng.chance(options.quizFirstTryCorrect) ? [right] : [...wrong.slice(0, rng.chance(0.7) ? 1 : 2), right];
    const order = [...plan, 0, 1, 2, 3];
    const tried = new Set();
    for (const choice of order) {
      if (tried.has(choice)) continue;
      tried.add(choice);
      if (tried.size > 1 && !(await think('quizRetry'))) return false;
      const res = await send('POST /api/learner/blocks/:blockId/submit', 'POST', `/api/learner/blocks/${quiz.id}/submit`, { answers: { olx_mcq_0: `choice_${choice}` } });
      const status = res.json?.data?.status;
      recorder.count('quiz_submits');
      if (status === 'correct') { recorder.count(tried.size === 1 ? 'quiz_first_try_correct' : 'quiz_correct_after_retry'); return true; }
      if (res.status !== 200) return false;
    }
    recorder.count('quiz_never_correct');
    return false;
  }

  async function evaluateBadges() {
    const res = await send('POST /api/learner/badges/evaluate', 'POST', '/api/learner/badges/evaluate');
    const popups = res.json?.data?.pending_popups || [];
    const newly = res.json?.data?.newly_earned || [];
    if (newly.length) recorder.count('badges_earned', newly.length);
    for (const popup of popups) {
      const badgeId = popup?.badge_id || popup?.id;
      if (!badgeId) continue;
      if (!(await sleep(8000 * options.thinkScale, stop))) break;
      await send('PATCH /api/learner/badges/:badgeId/shown', 'PATCH', `/api/learner/badges/${encodeURIComponent(badgeId)}/shown`);
      await send('POST /api/learner/badges/evaluate', 'POST', '/api/learner/badges/evaluate');
    }
    return res;
  }

  async function pollNotifications() {
    const interval = options.notificationPollS * 1000;
    if (!interval) return;
    let readOne = rng.chance(0.3);
    while (await sleep(interval * (0.9 + 0.2 * rng.next()), sessionEnd.signal)) {
      const res = await get('GET /api/learner/notifications/unread-count', '/api/learner/notifications/unread-count');
      const count = res.json?.data?.count ?? null;
      if (count !== null && count !== state.unreadCount) {
        state.unreadCount = count;
        const list = await get('GET /api/learner/notifications', '/api/learner/notifications?page_size=20');
        const unreadItem = (list.json?.data?.data || list.json?.data || []).find?.((n) => n && n.is_read === false);
        if (readOne && unreadItem?.id) {
          readOne = false;
          await send('PATCH /api/learner/notifications/:id/read', 'PATCH', `/api/learner/notifications/${unreadItem.id}/read`);
        }
      }
    }
  }

  function studyEntries() {
    const minutes = Math.round((Date.now() - state.sessionStartedAt) / 60_000);
    return minutes > 0 ? [{ date: vnDate(), minutes }] : [];
  }

  async function syncStudyTime() {
    if (!options.studySyncS) return;
    let wait = options.studyFirstSyncS * 1000;
    while (await sleep(wait, sessionEnd.signal)) {
      const entries = studyEntries();
      if (entries.length) await send('POST /api/enrollments/study-session', 'POST', '/api/enrollments/study-session', { entries });
      wait = options.studySyncS * 1000;
    }
  }

  async function finalStudySync() {
    const entries = studyEntries();
    if (entries.length) await send('POST /api/enrollments/study-session', 'POST', '/api/enrollments/study-session', { entries });
  }

  async function keepTokenFresh() {
    while (await sleep(session.nextRefreshDelayMs(), sessionEnd.signal)) {
      if (!(await session.refresh('scheduled'))) break;
    }
  }
}
