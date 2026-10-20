// Routes of the author recovery actions on an AI course design run, mounted on
// the workspace path of ai-chatbot.routes.ts (after authenticate + tenantContext).
// Every route is owner-only: other course editors of a shared session get the
// localized NOT_OWNER refusal from the session guard.

import type { Router } from 'express';
import { withDatabaseTransaction } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { hasPermission } from '../../../middleware/authorize.js';
import { isOrchestrationV2RunRuntimeCurrent } from './lesson-author-orchestration-v2-execution.config.js';
import {
  createOrchestrationV2RecoveryHandlers,
  orchestrationV2RecoveryRoute,
  type OrchestrationV2AsyncMiddleware,
} from './lesson-author-orchestration-v2-recovery.controller.js';
import { createOrchestrationV2RecoveryRepository } from './lesson-author-orchestration-v2-recovery.repository.js';
import { createOrchestrationV2RecoveryService } from './lesson-author-orchestration-v2-recovery.service.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';

/** Stop and recovery act on durable V2 work: the workspace read, edit and execution gates must all be on. */
function workspaceWritesEnabled(): boolean {
  return env.LESSON_AUTHOR_WORKSPACE_READ_ENABLED && env.LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED
    && env.LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED;
}

export function mountOrchestrationV2RecoveryRoutes(router: Router, input: {
  workspacePath: string;
  ownerOnly: OrchestrationV2AsyncMiddleware;
}): void {
  const handlers = createOrchestrationV2RecoveryHandlers({
    service: createOrchestrationV2RecoveryService({
      repository: user => createOrchestrationV2RecoveryRepository({
        db: { transaction: withDatabaseTransaction },
        canEdit: (tx, owner) => createWorkspaceAuthority(user).canEdit(tx, owner),
      }),
      canRead: user => hasPermission(user, 'courses', 'can_edit'),
      stopEnabled: () => workspaceWritesEnabled() && env.LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED,
      // Continue/rewrite ship with SQL 20261020_1500 (recovery log + guards).
      recoveryEnabled: () => false,
      runtimeCurrent: (tenantId, run) => isOrchestrationV2RunRuntimeCurrent(tenantId, run),
    }),
    report: record => {
      const line = '[LessonAuthorWorkspaceRecovery] ' + JSON.stringify(record);
      if (record.event === 'workspace_recovery_failed') console.warn(line); else console.info(line);
    },
  });
  const ownerOnly = orchestrationV2RecoveryRoute(input.ownerOnly);
  router.get(`${input.workspacePath}/recovery`, ownerOnly, orchestrationV2RecoveryRoute(handlers.describe));
  router.post(`${input.workspacePath}/stop`, ownerOnly, orchestrationV2RecoveryRoute(handlers.stop));
}
