// ═══════════════════════════════════════════════════════════════
// Express App — Middleware setup, routes, error handling
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';

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
import auditLogsRoutes from './modules/audit-logs/audit-logs.routes.js';
import enrollmentsRoutes from './modules/enrollments/enrollments.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import courseAuthoringRoutes from './modules/course-authoring/course-authoring.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import learnerRoutes from './modules/learner/learner.routes.js';
import path from 'path';

const app = express();

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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting — brute-force protection ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 20,                   // tối đa 20 requests login/refresh per IP
  message: { success: false, message: 'Quá nhiều lần thử, vui lòng đợi 15 phút' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 phút
  max: 200,                  // 200 requests per IP
  message: { success: false, message: 'Quá nhiều request, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Static files (uploaded course assets) ──
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

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
// authLimiter CHỈ áp cho login/refresh (brute-force protection)
// Các auth endpoint khác (me, profile, change-password) dùng apiLimiter chung
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api', apiLimiter);                     // general rate limit
app.use('/api/tenants', tenantsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/modules', modulesRoutes);
app.use('/api/permission-groups', permissionsRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/course-categories', courseCategoriesRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/help-docs', helpDocsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/enrollments', enrollmentsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/course-authoring', courseAuthoringRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/learner', learnerRoutes);

// ── 404 Handler ──
app.use(function notFoundHandler(_req, res) {
  res.status(404).json({ success: false, message: 'Endpoint không tồn tại' });
});

// ── Global Error Handler (phải đặt cuối cùng) ──
app.use(errorHandler);

export default app;
