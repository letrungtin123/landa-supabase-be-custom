// ═══════════════════════════════════════════════════════════════
// Express App — Middleware setup, routes, error handling
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { isShuttingDown } from './config/process-lifecycle.js';
import { errorHandler } from './middleware/error-handler.js';
import { errorBody } from './utils/errors.js';
import { authenticatedUserOrIpRateLimitKey } from './middleware/rate-limit-key.js';
import { apiLimiter } from './middleware/auth-rate-limit.js';
import { SharedRateLimitStore } from './middleware/rate-limit-store.js';
import { processRolePlan } from './config/process-role.js';
import { useJsonBodyParsers } from './middleware/body-limits.js';
import { mountMetrics } from './modules/metrics/metrics.routes.js';

// Routes
import authRoutes from './modules/auth/auth.routes.js';
import tenantsRoutes from './modules/tenants/tenants.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import modulesRoutes from './modules/modules/modules.routes.js';
import permissionsRoutes from './modules/permissions/permissions.routes.js';
import libraryRoutes from './modules/library/library.routes.js';
import coursesRoutes from './modules/courses/courses.routes.js';
import courseCategoriesRoutes from './modules/course-categories/course-categories.routes.js';
import groupsRoutes from './modules/groups/groups.routes.js';
import helpDocsRoutes from './modules/help-docs/help-docs.routes.js';
import newsRoutes from './modules/news/news.routes.js';
import auditLogsRoutes from './modules/audit-logs/audit-logs.routes.js';
import enrollmentsRoutes from './modules/enrollments/enrollments.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import courseAuthoringRoutes from './modules/course-authoring/course-authoring.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import assignmentsRoutes from './modules/assignments/assignments.routes.js';
import emailTemplatesRoutes from './modules/email-templates/email-templates.routes.js';
import learnerRoutes from './modules/learner/learner.routes.js';
import storageRoutes from './modules/storage/storage.routes.js';
import brandingRoutes from './modules/branding/branding.routes.js';
import dashboardContentRoutes from './modules/branding/dashboard-content.routes.js';
import aiChatbotRoutes from './modules/ai-chatbot/ai-chatbot.routes.js';
import promptTemplatesRoutes from './modules/prompt-templates/prompt-templates.routes.js';
import badgesRoutes from './modules/badges/badges.routes.js';
import tenantBadgesRoutes from './modules/tenant-badges/tenant-badges.routes.js';
import aiCreditsRoutes from './modules/ai-credits/ai-credit.routes.js';
import ssoRoutes from './modules/sso/sso.routes.js';
import demoLoginRoutes from './modules/demo-login/demo-login.routes.js';
import welcomeInitRoutes from './modules/welcome-init/welcome-init.routes.js';

const app = express();
// First, so every request is counted: GET /internal/metrics (loopback only)
// and the per-route-group request counters (modules/metrics). Each HTTP
// process reports its own numbers; the background process serves no HTTP.
if (processRolePlan.servesHttp) mountMetrics(app);
if (env.TRUSTED_PROXY_CIDRS.length > 0) {
  // A CIDR allowlist is safe even if the backend port is reachable directly:
  // forwarded addresses are considered only when every proxy hop belongs to
  // this explicitly trusted set. Do not replace this with `true` or a broad
  // hop count in production.
  app.set('trust proxy', env.TRUSTED_PROXY_CIDRS);
  console.log(`[Server] Trust proxy enabled with ${env.TRUSTED_PROXY_CIDRS.length} exact trusted CIDR(s)`);
} else if (env.TRUST_PROXY_HOPS > 0) {
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  console.warn(`[Server] Trust proxy enabled by legacy hop count: ${env.TRUST_PROXY_HOPS}. Configure TRUSTED_PROXY_CIDRS for production.`);
}

// The inline email outbox worker is started by the process startup
// (config/process-startup.ts), not by importing this file.

// ── Graceful shutdown ──
// While the process drains, answers on kept-alive connections tell the client
// (or the gateway) to open a new connection, which reaches the next process.
app.use(function closeConnectionWhileShuttingDown(_req, res, next) {
  if (isShuttingDown()) res.setHeader('Connection', 'close');
  next();
});

// ── Security Headers ──
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // cho phép /uploads cross-origin
}));

// ── CORS — hỗ trợ nhiều origins (comma-separated trong env) ──
const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Cho phép requests không có Origin header (server-to-server, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'X-Tenant-Id', 'X-UI-Locale', 'X-Lesson-Author-Job-Key', 'X-Lesson-Author-Chapter-Key', 'Range', 'If-Range'],
  exposedHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified', 'Cache-Control'],
}));

// Small JSON limits on sign-in and learner routes, 10 MB elsewhere (middleware/body-limits.ts).
useJsonBodyParsers(app);
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting — brute-force protection ──
// Sign-in, refresh, password change, one-time links and profile updates have
// their own limits in modules/auth/auth.routes.ts (middleware/auth-rate-limit.ts).
// With several API processes these counters are shared through Redis (a
// per-process fallback when it is unavailable); with one, they stay in memory.
const sharedLimiterStore = (prefix: string) => (processRolePlan.severalApiInstances
  ? { store: new SharedRateLimitStore({ prefix }) }
  : {});
const demoLoginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  ...sharedLimiterStore('demo-login'),
  message: errorBody(429, 'Quá nhiều request demo login, vui lòng thử lại sau', 'DEMO_LOGIN_RATE_LIMITED'),
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Health Check ──
app.get('/api/health', async function healthCheck(_req, res) {
  const { checkDatabaseHealth } = await import('./config/database.js');
  const dbOk = await checkDatabaseHealth();
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? 'healthy' : 'unhealthy',
    database: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ──
// The general limit applies to the other auth endpoints too (me, profile,
// change-password, one-time links); auth.routes.ts adds the stricter
// per-endpoint limits. Sign-in, refresh and the SSO code exchange are not
// counted here (they have their own budgets). The '/api' mount below skips
// '/auth/*'.
app.use('/api/auth', apiLimiter);
app.use('/api/auth', authRoutes);

// Storage proxy — TRƯỚC apiLimiter, không cần auth (img tag không gửi Bearer)
app.use('/api/storage', storageRoutes);

// Branding — /by-domain/:domain is public (no auth), rest is protected
app.use('/api/branding', brandingRoutes);

// Dashboard Content — /by-domain/:domain is public, rest is protected
app.use('/api/dashboard-content', dashboardContentRoutes);

app.use('/api/demo-login', demoLoginLimiter);
app.use('/api/demo-login', demoLoginRoutes);

app.use('/api', apiLimiter);                     // general rate limit

// Study session — rate limit riêng (tránh spam từ FE study time tracker)
const studySessionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 phút
  max: 30,                    // 30 requests/phút — FE gửi max 7 entries khi đóng tab
  keyGenerator: authenticatedUserOrIpRateLimitKey,
  ...sharedLimiterStore('study-session'),
  message: errorBody(429, 'Quá nhiều request study session', 'STUDY_SESSION_RATE_LIMITED'),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/enrollments/study-session', studySessionLimiter);
app.use('/api/tenants', tenantsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/permission-groups', permissionsRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/course-categories', courseCategoriesRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/help-docs', helpDocsRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/enrollments', enrollmentsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/course-authoring', courseAuthoringRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/assignments', assignmentsRoutes);
app.use('/api/email-templates', emailTemplatesRoutes);
app.use('/api/learner', learnerRoutes);
app.use('/api/welcome-init', welcomeInitRoutes);
app.use('/api/ai-chatbot', aiChatbotRoutes);
app.use('/api/prompt-templates', promptTemplatesRoutes);
app.use('/api/badges', badgesRoutes);
app.use('/api/tenant-badges', tenantBadgesRoutes);
app.use('/api/ai-credits', aiCreditsRoutes);
app.use('/api/sso', ssoRoutes);

// ── 404 Handler ──
app.use(function notFoundHandler(_req, res) {
  res.status(404).json(errorBody(404, 'Endpoint không tồn tại', 'ROUTE_NOT_FOUND'));
});

// ── Global Error Handler (phải đặt cuối cùng) ──
app.use(errorHandler);

export default app;
