// In-memory imitation of the learner/report API surface the load test uses. It mirrors the response shapes and the
// rules that matter for the script (origin check on sign-in, single-use rotating refresh tokens, access expiry -> 401,
// hidden answer keys, enrollment needed for completion), never the real backend's performance.
import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import { LOADTEST_TENANT, learnerUsername, adminUsername } from './config.mjs';
import { createRng, sleep } from './session.mjs';

const OUTLINE = { chapters: 3, lessons: 4, units: 3 };

function buildCourse() {
  const blocks = [];
  const root = { id: randomUUID(), parent_id: null, block_type: 'course', display_name: 'Khoá bắt buộc: An toàn thông tin cơ bản', sort_order: 0, data: {}, metadata: {} };
  blocks.push(root);
  const correct = new Map();
  let position = 0;
  for (let c = 1; c <= OUTLINE.chapters; c += 1) {
    const chapter = { id: randomUUID(), parent_id: root.id, block_type: 'chapter', display_name: `Chương ${c}`, sort_order: c, data: {}, metadata: {} };
    blocks.push(chapter);
    for (let l = 1; l <= OUTLINE.lessons; l += 1) {
      const lesson = { id: randomUUID(), parent_id: chapter.id, block_type: 'sequential', display_name: `Bài ${c}.${l}`, sort_order: l, data: {}, metadata: {} };
      blocks.push(lesson);
      for (let u = 1; u <= OUTLINE.units; u += 1) {
        const unit = { id: randomUUID(), parent_id: lesson.id, block_type: 'vertical', display_name: `Phần ${u}`, sort_order: u, data: {}, metadata: {} };
        const html = { id: randomUUID(), parent_id: unit.id, block_type: 'html', display_name: 'Nội dung', sort_order: 1, data: '<section><p>…</p></section>', metadata: {} };
        const choices = [0, 1, 2, 3].map((k) => `<choice>Lựa chọn ${k + 1}</choice>`).join('');
        const quiz = { id: randomUUID(), parent_id: unit.id, block_type: 'problem', display_name: 'Câu hỏi kiểm tra', sort_order: 2, data: `<problem><multiplechoiceresponse><label>?</label><choicegroup type="MultipleChoice">${choices}</choicegroup></multiplechoiceresponse></problem>`, metadata: { weight: 1 } };
        correct.set(quiz.id, position % 4);
        position += 1;
        blocks.push(unit, html, quiz);
      }
    }
  }
  const leaves = blocks.filter((b) => b.block_type === 'html' || b.block_type === 'problem').map((b) => b.id);
  return { root, blocks, correct, leaves, byId: new Map(blocks.map((b) => [b.id, b])) };
}

export function createStub(options = {}) {
  const config = {
    password: 'stub-password',
    tenantId: LOADTEST_TENANT.id,
    brandingTenantId: undefined,
    accessTtlS: 900,
    fault429Rate: 0,
    fault500Rate: 0,
    retryAfterS: 1,
    faultAfterRequests: 0,
    latencyMs: [0, 0],
    metrics: false,
    seed: 7,
    ...options,
  };
  const rng = createRng(config.seed);
  const course = buildCourse();
  const users = new Map();
  for (let n = 1; n <= LOADTEST_TENANT.learnerCount; n += 1) users.set(learnerUsername(n), { id: randomUUID(), username: learnerUsername(n), role: 'learner' });
  for (let n = 1; n <= LOADTEST_TENANT.adminCount; n += 1) users.set(adminUsername(n), { id: randomUUID(), username: adminUsername(n), role: 'superuser' });
  const usersById = new Map([...users.values()].map((u) => [u.id, u]));
  const access = new Map();
  const refresh = new Map();
  const learner = new Map();
  const counts = new Map();
  let served = 0;
  const events = { refreshReuse: 0, expiredAccess: 0, loginOriginRefused: 0, injected429: 0, injected500: 0 };

  const learnerState = (userId) => {
    let s = learner.get(userId);
    if (!s) {
      s = { done: new Set(), modal: { welcome_shown: false, confirm_shown: false, complete_shown: false }, badges: new Map(), welcomeSeen: false,
        notifications: [1, 2, 3].map((k) => ({ id: randomUUID(), title: `Thông báo ${k}`, is_read: false })), enrolled: true, minutes: 0 };
      learner.set(userId, s);
    }
    return s;
  };

  const ok = (data, status = 200) => ({ status, json: { success: true, data } });
  const fail = (status, message, extra = {}) => ({ status, json: { success: false, message, ...extra } });

  function issueTokens(user) {
    const accessToken = randomBytes(24).toString('hex');
    const refreshToken = randomUUID();
    access.set(accessToken, { userId: user.id, exp: Date.now() + config.accessTtlS * 1000 });
    refresh.set(refreshToken, { userId: user.id, usedAt: 0 });
    return {
      access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: config.accessTtlS, session_mode: 'normal',
      user: { id: user.id, username: user.username, email: `${user.username}@loadtest.test`, role: user.role, tenant_id: config.tenantId, tenant_name: 'Thử tải' },
      permissions: {}, tenant_modules: ['courses', 'badge_management', 'report_summary', 'groups'], managed_tenants: [], role_labels: {},
    };
  }

  function progressOf(s) {
    const done = course.leaves.filter((id) => s.done.has(id)).length;
    return { progress: Math.round((done * 10_000) / course.leaves.length) / 100, is_completed: done === course.leaves.length };
  }

  function authUser(headers) {
    const token = String(headers?.authorization || headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    const entry = access.get(token);
    if (!entry) return null;
    if (entry.exp < Date.now()) { events.expiredAccess += 1; return null; }
    return usersById.get(entry.userId) || null;
  }

  const routes = [];
  const route = (method, pattern, handler, { auth = true, admin = false, faults = true } = {}) => routes.push({ method, pattern, handler, auth, admin, faults });
  const U = LOADTEST_TENANT.hostname;

  route('GET', /^\/api\/health$/, () => ok({ status: 'healthy' }), { auth: false, faults: false });
  route('GET', /^\/internal\/metrics$/, () => (config.metrics ? ok({ uptime_s: 1, requests: 0 }) : fail(404, 'Not found')), { auth: false, faults: false });
  route('GET', /^\/api\/branding\/by-domain\/([^/?]+)$/, (m) => ok({ tenant_id: m[1] === U ? (config.brandingTenantId ?? config.tenantId) : null, tenant_name: 'Thử tải', images: {}, carousels: [] }), { auth: false });
  route('GET', /^\/api\/dashboard-content\/by-domain\/([^/?]+)$/, (m) => ok({ tenant_id: m[1] === U ? config.tenantId : null, tips: [] }), { auth: false });
  route('GET', /^\/api\/sso\/public\/by-domain\/([^/?]+)$/, (m) => ok({ tenant_id: m[1] === U ? config.tenantId : null, providers: [] }), { auth: false });

  route('POST', /^\/api\/auth\/login$/, (m, req) => {
    const user = users.get(req.json?.username);
    const expectedOrigin = req.json?.client_app === 'admin' ? LOADTEST_TENANT.adminOrigin : LOADTEST_TENANT.learnerOrigin;
    if (req.json?.origin !== expectedOrigin) { events.loginOriginRefused += 1; return fail(401, 'Thông tin đăng nhập không đúng', { code: 'INVALID_CREDENTIALS' }); }
    if (!user || req.json?.password !== config.password) return fail(401, 'Thông tin đăng nhập không đúng', { code: 'INVALID_CREDENTIALS' });
    if (req.json?.client_app === 'admin' && user.role === 'learner') return fail(403, 'Learner', { code: 'AUTH_LEARNER_ADMIN_FORBIDDEN' });
    return ok(issueTokens(user));
  }, { auth: false, faults: false });
  route('POST', /^\/api\/auth\/refresh$/, (m, req) => {
    const entry = refresh.get(req.json?.refresh_token);
    if (!entry) return fail(401, 'Refresh token không hợp lệ');
    if (entry.usedAt) { events.refreshReuse += 1; return fail(401, 'Refresh token đã được sử dụng'); }
    entry.usedAt = Date.now();
    return ok(issueTokens(usersById.get(entry.userId)));
  }, { auth: false, faults: false });
  route('POST', /^\/api\/auth\/logout$/, (m, req) => { refresh.delete(req.json?.refresh_token); return ok({}); }, { auth: false, faults: false });
  route('GET', /^\/api\/auth\/me$/, (m, req, user) => ok({ user: { id: user.id, username: user.username, role: user.role, tenant_id: config.tenantId }, tenant_modules: [] }));

  route('GET', /^\/api\/welcome-init\/state$/, (m, req, user) => ok({ should_show: !learnerState(user.id).welcomeSeen, has_seen: learnerState(user.id).welcomeSeen }));
  route('POST', /^\/api\/welcome-init\/seen$/, (m, req, user) => { learnerState(user.id).welcomeSeen = true; return ok({}); });
  route('POST', /^\/api\/learner\/badges\/evaluate$/, (m, req, user) => {
    const s = learnerState(user.id);
    const newly = [];
    if (progressOf(s).is_completed && !s.badges.has('onboarding_warrior')) { s.badges.set('onboarding_warrior', false); newly.push({ badge_id: 'onboarding_warrior' }); }
    const pending = [...s.badges.entries()].filter(([, shown]) => !shown).map(([id]) => ({ badge_id: id }));
    return ok({ badge_definitions: [{ id: 'onboarding_warrior' }, { id: 'perfect_profile' }, { id: 'speed_scholar' }], earned_badges: [...s.badges.keys()].map((id) => ({ badge_id: id })), newly_earned: newly, pending_popups: pending, progress: {} });
  });
  route('PATCH', /^\/api\/learner\/badges\/([^/]+)\/shown$/, (m, req, user) => { const s = learnerState(user.id); if (s.badges.has(m[1])) s.badges.set(m[1], true); return ok({}); });
  route('GET', /^\/api\/enrollments\/weekly-study-time$/, (m, req, user) => ok({ entries: [{ date: '2026-10-18', minutes: learnerState(user.id).minutes }] }));
  route('POST', /^\/api\/enrollments\/study-session$/, (m, req, user) => {
    const entries = Array.isArray(req.json?.entries) ? req.json.entries : [];
    if (entries.length) learnerState(user.id).minutes = Math.max(...entries.map((e) => Number(e.minutes) || 0));
    return ok({ synced: entries.length });
  });
  route('GET', /^\/api\/ai-chatbot\/chat\/active-bot$/, () => ok(null));
  route('GET', /^\/api\/learner\/notifications\/unread-count$/, (m, req, user) => ok({ count: learnerState(user.id).notifications.filter((n) => !n.is_read).length }));
  route('GET', /^\/api\/learner\/notifications$/, (m, req, user) => { const list = learnerState(user.id).notifications; return ok({ data: list, total: list.length, unread_count: list.filter((n) => !n.is_read).length }); });
  route('PATCH', /^\/api\/learner\/notifications\/([^/]+)\/read$/, (m, req, user) => { const n = learnerState(user.id).notifications.find((x) => x.id === m[1]); if (!n) return fail(404, 'Not found'); n.is_read = true; return ok({}); });
  route('GET', /^\/api\/learner\/enrollments$/, (m, req, user) => ok([{ course_id: LOADTEST_TENANT.courseId, display_name: course.root.display_name, ...progressOf(learnerState(user.id)) }]));
  route('GET', /^\/api\/learner\/courses$/, () => ok({ data: [{ id: LOADTEST_TENANT.courseId, display_name: course.root.display_name }], categories: [], total: 1, page: 1, page_size: 200, total_pages: 1 }));
  route('GET', /^\/api\/learner\/progress-batch$/, (m, req, user) => ok({ progress: { [LOADTEST_TENANT.courseId]: progressOf(learnerState(user.id)) } }));

  const courseRoute = (suffix) => new RegExp(`^/api/learner/courses/([^/]+)${suffix}$`);
  const sameCourse = (m) => decodeURIComponent(m[1]) === LOADTEST_TENANT.courseId;
  route('GET', /^\/api\/learner\/progress\/([^/]+)$/, (m, req, user) => (sameCourse(m) ? ok(progressOf(learnerState(user.id))) : fail(403, 'Không có quyền')));
  route('GET', courseRoute('/modal-config'), (m) => (sameCourse(m) ? ok({ welcome_enabled: true, confirm_enabled: true, completion_enabled: true }) : fail(403, 'x')));
  route('GET', courseRoute('/modal-state'), (m, req, user) => (sameCourse(m) ? ok({ ...learnerState(user.id).modal }) : fail(403, 'x')));
  route('PATCH', courseRoute('/modal-state'), (m, req, user) => { Object.assign(learnerState(user.id).modal, req.json || {}); return ok({ ...learnerState(user.id).modal }); });
  route('GET', courseRoute('/blocks'), (m, req, user) => {
    if (!sameCourse(m)) return fail(403, 'x');
    const s = learnerState(user.id);
    if (!s.enrolled) return fail(403, 'Chưa ghi danh');
    // Answer keys stay hidden, as answer-keys-hidden-v1 of the real API.
    return ok({ root_id: course.root.id, blocks: course.blocks.map((b) => ({ ...b, completed: s.done.has(b.id) })) });
  });
  route('GET', courseRoute('/files'), () => ok({ files: [] }));
  route('GET', courseRoute('/section-modal-configs'), () => ok([]));
  route('GET', courseRoute('/section-modal-shown'), () => ok({ shown_sections: [] }));
  route('GET', courseRoute(''), (m) => (sameCourse(m) ? ok({ id: LOADTEST_TENANT.courseId, mentors: [], mentor_section: null }) : fail(404, 'x')));
  route('GET', /^\/api\/assignments\/learner\/courses\/([^/]+)$/, () => ok([]));
  route('GET', /^\/api\/learner\/blocks\/([^/]+)$/, (m, req, user) => {
    const block = course.byId.get(m[1]);
    return block ? ok({ ...block, completed: learnerState(user.id).done.has(block.id) }) : fail(404, 'Block không tồn tại');
  });
  route('POST', /^\/api\/learner\/blocks\/([^/]+)\/submit$/, (m, req) => {
    if (!course.correct.has(m[1])) return fail(404, 'Block không tồn tại');
    const answer = Object.values(req.json?.answers || {})[0];
    const right = answer === `choice_${course.correct.get(m[1])}`;
    return ok({ status: right ? 'correct' : 'incorrect', score: right ? 100 : 0, feedback: { code: right ? 'correct' : 'incorrect' } });
  });
  route('POST', /^\/api\/learner\/complete-blocks$/, (m, req, user) => {
    if (req.json?.course_id !== LOADTEST_TENANT.courseId) return fail(400, 'Chưa ghi danh khóa học này');
    const ids = Array.isArray(req.json?.block_ids) ? req.json.block_ids : [];
    if (ids.length === 0 || ids.length > 200) return fail(400, 'block_ids');
    const s = learnerState(user.id);
    const before = progressOf(s).is_completed;
    const newly = ids.filter((id) => course.byId.has(id) && !s.done.has(id));
    for (const id of newly) s.done.add(id);
    const after = progressOf(s);
    return ok({ marked: newly.length, newly_completed: newly, ...after, completion_changed: before !== after.is_completed });
  });
  route('POST', /^\/api\/learner\/enroll$/, (m, req, user) => { learnerState(user.id).enrolled = true; return ok({ enrollment_id: randomUUID(), already_enrolled: true }); });

  const report = (data) => (m, req, user) => (user.role === 'learner' ? fail(403, 'Không có quyền') : ok(data));
  route('GET', /^\/api\/reports\/groups$/, report({ groups: [{ id: 'g1', name: 'Khối thử tải', subgroup_count: 1 }], total: 1 }), { admin: true });
  route('GET', /^\/api\/reports\/summary$/, report({ overview: { total_learners: 2000, active_learners: 0 } }), { admin: true });
  route('GET', /^\/api\/reports\/chart$/, report({ series: [], meta: {} }), { admin: true });
  route('GET', /^\/api\/reports\/course-completion-ranking$/, report({ results: [], total: 0 }), { admin: true });
  route('GET', /^\/api\/reports\/learners$/, report({ results: [], total: 0 }), { admin: true });
  route('GET', /^\/api\/reports\/export\.xlsx$/, (m, req, user) => (user.role === 'learner' ? fail(403, 'x') : { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, raw: Buffer.alloc(4096, 1) }), { admin: true });

  route('GET', /^\/__stub\/stats$/, () => ({ status: 200, json: stats() }), { auth: false, faults: false });

  function stats() {
    return { counts: Object.fromEntries([...counts.entries()].sort()), events: { ...events }, learners_touched: learner.size };
  }

  async function handle({ method, path, headers, json }) {
    const [pathname] = path.split('?');
    const match = routes.find((r) => r.method === method && r.pattern.test(pathname));
    const key = match ? `${method} ${match.pattern.source}` : `${method} ${pathname}`;
    const result = await (async () => {
      if (!match) return fail(404, `No stub route for ${method} ${pathname}`);
      const [lo, hi] = config.latencyMs;
      if (hi > 0) await sleep(lo + (hi - lo) * rng.next());
      served += 1;
      if (match.faults && pathname !== '/__stub/stats' && served > config.faultAfterRequests) {
        if (rng.chance(config.fault429Rate)) { events.injected429 += 1; return { status: 429, headers: { 'retry-after': String(config.retryAfterS) }, json: { success: false, message: 'Too many requests' } }; }
        if (rng.chance(config.fault500Rate)) { events.injected500 += 1; return fail(500, 'Injected stub error'); }
      }
      let user = null;
      if (match.auth) {
        user = authUser(headers);
        if (!user) return fail(401, 'Token không hợp lệ hoặc đã hết hạn');
      }
      return match.handler(pathname.match(match.pattern), { json, headers }, user);
    })();
    if (pathname !== '/__stub/stats') {
      const entry = counts.get(key) || {};
      entry[result.status] = (entry[result.status] || 0) + 1;
      counts.set(key, entry);
    }
    return result;
  }

  return { handle, stats, config, course };
}

/** HTTP wrapper around the stub, bound to loopback. */
export function startStubServer(options = {}) {
  const stub = createStub(options);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let json;
      try { json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { json = undefined; }
      const result = await stub.handle({ method: req.method, path: req.url, headers: req.headers, json });
      const body = result.raw !== undefined ? result.raw : Buffer.from(JSON.stringify(result.json ?? {}));
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', ...(result.headers || {}), 'content-length': body.length });
      res.end(body);
    });
  });
  server.keepAliveTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ stub, server, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
