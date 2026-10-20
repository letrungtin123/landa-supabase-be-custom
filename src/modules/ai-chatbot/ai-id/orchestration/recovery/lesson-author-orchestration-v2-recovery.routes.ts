// Routes of the author recovery actions on an AI course design run, mounted on
// the workspace path of ai-chatbot.routes.ts (after authenticate + tenantContext).
// Every route is owner-only: other course editors of a shared session get the
// localized NOT_OWNER refusal from the session guard.

import type { Router } from 'express';
import { withDatabaseTransaction } from '../../../../../config/database.js';
import { env } from '../../../../../config/env.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../../../../middleware/audit-log.js';
import { hasPermission } from '../../../../../middleware/authorize.js';
import { orchestrationV2QuotaAccounting } from '../worker/lesson-author-orchestration-v2-accounting.service.js';
import { isOrchestrationV2RunRuntimeCurrent } from '../lesson-author-orchestration-v2-execution.config.js';
import { createOrchestrationV2RecoveryCredit } from './lesson-author-orchestration-v2-recovery-credit.service.js';
import {
  createOrchestrationV2RecoveryHandlers,
  orchestrationV2RecoveryRoute,
  type OrchestrationV2AsyncMiddleware,
} from './lesson-author-orchestration-v2-recovery.controller.js';
import {
  createOrchestrationV2RecoveryRepository,
  type OrchestrationV2RecoveryAuditEvent,
} from './lesson-author-orchestration-v2-recovery.repository.js';
import { createOrchestrationV2RecoveryService } from './lesson-author-orchestration-v2-recovery.service.js';
import { createWorkspaceAuthority } from '../../workspace/edit/lesson-author-workspace-authority.repository.js';

/** Stop and recovery act on durable V2 work: the workspace read, edit and execution gates must all be on. */
function workspaceWritesEnabled(): boolean {
  return env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED && env.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED
    && env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED;
}

/** Continue/rewrite gate (SQL 20261020_1500): empty allow-list = every tenant, like the IDM pipeline switch. */
export function orchestrationV2RecoveryEnabled(tenantId: string, settings: {
  writes: boolean; enabled: boolean; tenant_allowlist: readonly string[];
}): boolean {
  if (!settings.writes || !settings.enabled) return false;
  const tenant = tenantId.trim().toLowerCase();
  return !settings.tenant_allowlist.length
    || settings.tenant_allowlist.some(candidate => candidate.trim().toLowerCase() === tenant);
}

const AUDIT_EVENT_CODES = {
  stop: 'lesson_author.workspace.run_stopped',
  resume: 'lesson_author.workspace.run_resumed',
  regenerate: 'lesson_author.workspace.lessons_rewritten',
} as const;

/** Tenant audit row of a stop/continue/rewrite, in the shape of the other AI course design session events. */
export function orchestrationV2RecoveryAuditEntry(event: OrchestrationV2RecoveryAuditEvent, actorUsername: string)
  : TransactionalAuditEntry {
  return { tenantId: event.tenantId, actorId: event.actorId, actorUsername, action: 'UPDATE',
    entityType: 'lesson_author_session', entityId: event.conversationId, entityName: event.sessionTitle || event.courseName,
    event: { code: AUDIT_EVENT_CODES[event.action], context: { course_id: event.courseId, course_name: event.courseName,
      ...(event.affectedCount === null ? {} : { affected_count: event.affectedCount }) } } };
}

export function mountOrchestrationV2RecoveryRoutes(router: Router, input: {
  workspacePath: string;
  ownerOnly: OrchestrationV2AsyncMiddleware;
}): void {
  const credit = createOrchestrationV2RecoveryCredit({
    fallbackUnitCostUsd: () => env.LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_UNIT_COST_FALLBACK_CENTS / 100,
  });
  const handlers = createOrchestrationV2RecoveryHandlers({
    service: createOrchestrationV2RecoveryService({
      repository: user => createOrchestrationV2RecoveryRepository({
        db: { transaction: withDatabaseTransaction },
        canEdit: (tx, owner) => createWorkspaceAuthority(user).canEdit(tx, owner),
        // Nested withDatabaseTransaction reuses the stop/continue/rewrite transaction's client.
        audit: event => withDatabaseTransaction(client => appendAuditLog(client,
          orchestrationV2RecoveryAuditEntry(event, user.username))),
      }),
      canRead: user => hasPermission(user, 'courses', 'can_edit'),
      stopEnabled: () => workspaceWritesEnabled() && env.LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED,
      recoveryEnabled: tenantId => orchestrationV2RecoveryEnabled(tenantId, { writes: workspaceWritesEnabled(),
        enabled: env.LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_ENABLED,
        tenant_allowlist: env.LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_TENANT_ALLOWLIST }),
      runtimeCurrent: (tenantId, run) => isOrchestrationV2RunRuntimeCurrent(tenantId, run),
      assertAffordable: (tenantId, unitCount) => credit.assertAffordable(tenantId, unitCount),
      reconcileUnknown: orchestrationV2QuotaAccounting.reconcileUnknownAsBudget,
    }),
    report: record => {
      const line = '[LessonAuthorWorkspaceRecovery] ' + JSON.stringify(record);
      if (record.event === 'workspace_recovery_failed') console.warn(line); else console.info(line);
    },
  });
  const ownerOnly = orchestrationV2RecoveryRoute(input.ownerOnly);
  router.get(`${input.workspacePath}/recovery`, ownerOnly, orchestrationV2RecoveryRoute(handlers.describe));
  router.post(`${input.workspacePath}/stop`, ownerOnly, orchestrationV2RecoveryRoute(handlers.stop));
  router.post(`${input.workspacePath}/resume`, ownerOnly, orchestrationV2RecoveryRoute(handlers.resume));
  router.post(`${input.workspacePath}/nodes/:nodeId/regenerate`, ownerOnly,
    orchestrationV2RecoveryRoute(handlers.regenerate));
}
