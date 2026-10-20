// Author recovery of an orchestration V2 run: feature gates, AI settings check
// and the calls into the recovery repository. No HTTP objects here.

import type { AuthUser } from '../../../types/express.js';
import {
  describeOrchestrationV2Recovery,
  OrchestrationV2RecoveryError,
  type OrchestrationV2RecoveryView,
} from './lesson-author-orchestration-v2-recovery.logic.js';
import type {
  OrchestrationV2RecoveryActionResult,
  createOrchestrationV2RecoveryRepository,
} from './lesson-author-orchestration-v2-recovery.repository.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';

type RecoveryRepository = ReturnType<typeof createOrchestrationV2RecoveryRepository>;

export interface OrchestrationV2RecoveryTarget {
  workspaceId: string;
  conversationId: string;
  courseId: string;
}

export interface OrchestrationV2RecoveryServiceDependencies {
  /** Repository bound to the authenticated author (its canEdit write fence). */
  repository(user: AuthUser): RecoveryRepository;
  /** Read permission of the caller for GET …/recovery (courses.can_edit, cached matrix). */
  canRead(user: AuthUser): Promise<boolean>;
  /** Stop gate: workspace read + edit + execution + LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED. */
  stopEnabled(): boolean;
  /** Resume/rewrite gate for this tenant (flag + tenant allow-list); false until the recovery schema ships. */
  recoveryEnabled(tenantId: string): boolean;
  /** True when the tenant AI settings still execute the stored run. */
  runtimeCurrent(tenantId: string, run: { runtime_config_hash: string; model: string }): Promise<boolean>;
}

function owner(user: AuthUser & { tenantId: string }, target: OrchestrationV2RecoveryTarget): WorkspaceReadOwner {
  return { tenantId: user.tenantId, userId: user.id, conversationId: target.conversationId, courseId: target.courseId };
}

export function createOrchestrationV2RecoveryService(deps: OrchestrationV2RecoveryServiceDependencies) {
  const anyEnabled = (tenantId: string) => deps.stopEnabled() || deps.recoveryEnabled(tenantId);

  async function describe(user: AuthUser & { tenantId: string }, target: OrchestrationV2RecoveryTarget)
    : Promise<OrchestrationV2RecoveryView> {
    if (!anyEnabled(user.tenantId)) throw new OrchestrationV2RecoveryError('RECOVERY_DISABLED');
    if (!await deps.canRead(user)) throw new OrchestrationV2RecoveryError('RECOVERY_FORBIDDEN');
    const snapshot = await deps.repository(user).snapshot(owner(user, target), target.workspaceId);
    const recoveryEnabled = deps.recoveryEnabled(user.tenantId);
    const needsRuntime = recoveryEnabled && snapshot.run?.status === 'needs_action' && snapshot.runtime !== null;
    const runtimeChanged = needsRuntime ? !await deps.runtimeCurrent(user.tenantId, snapshot.runtime!) : false;
    return describeOrchestrationV2Recovery({ run: snapshot.run, workspace_status: snapshot.workspace_status,
      event_head: snapshot.event_head, tasks: snapshot.tasks, course_node: snapshot.course_node,
      stop_enabled: deps.stopEnabled(), recovery_enabled: recoveryEnabled, runtime_changed: runtimeChanged });
  }

  async function stop(user: AuthUser & { tenantId: string }, target: OrchestrationV2RecoveryTarget, operationId: string)
    : Promise<OrchestrationV2RecoveryActionResult> {
    if (!deps.stopEnabled()) throw new OrchestrationV2RecoveryError('RECOVERY_DISABLED');
    return deps.repository(user).stop(owner(user, target), target.workspaceId, operationId);
  }

  return { describe, stop };
}
