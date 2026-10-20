// Author recovery of an orchestration V2 run: feature gates, AI settings and
// AI points checks, and the calls into the recovery repository. No HTTP objects.

import type { AuthUser } from '../../../types/express.js';
import {
  describeOrchestrationV2Recovery,
  orchestrationV2RecoveryErrorFor,
  OrchestrationV2RecoveryError,
  planOrchestrationV2Recovery,
  type OrchestrationV2RecoveryView,
} from './lesson-author-orchestration-v2-recovery.logic.js';
import type {
  OrchestrationV2RecoveryActionResult,
  OrchestrationV2RecoveryRequestInput,
  createOrchestrationV2RecoveryRepository,
} from './lesson-author-orchestration-v2-recovery.repository.js';
import type { ReconcileUnknown } from './lesson-author-orchestration-v2-worker-repository.types.js';
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
  /** Continue/rewrite gate for this tenant: the three workspace gates + flag + tenant allow-list. */
  recoveryEnabled(tenantId: string): boolean;
  /** True when the tenant AI settings still execute the stored run. */
  runtimeCurrent(tenantId: string, run: { runtime_config_hash: string; model: string }): Promise<boolean>;
  /** Refuses (AI_CREDIT_INSUFFICIENT_FOR_RECOVERY) when the month cannot cover the rewrite; returns the estimate. */
  assertAffordable(tenantId: string, unitCount: number): Promise<number>;
  /** Settles a held unknown outcome at its upper bound inside the recovery transaction. */
  reconcileUnknown: ReconcileUnknown;
}

export interface OrchestrationV2RecoveryCommand {
  operation_id: string;
  expected_workspace_revision: number;
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

  /**
   * Continue (free re-validation) or rewrite (missing lessons; AI points). The
   * read-only pre-check plans the request, refuses a changed AI setup and checks
   * AI points without holding a lock; the transaction plans again under the
   * row locks and refuses if the run changed in between. A recorded operation
   * id skips the pre-check and replays its stored result.
   */
  async function recover(user: AuthUser & { tenantId: string }, target: OrchestrationV2RecoveryTarget,
    request: OrchestrationV2RecoveryRequestInput, command: OrchestrationV2RecoveryCommand)
    : Promise<OrchestrationV2RecoveryActionResult> {
    if (!deps.recoveryEnabled(user.tenantId)) throw new OrchestrationV2RecoveryError('RECOVERY_DISABLED');
    const repository = deps.repository(user);
    const scopeNodeId = request.action === 'regenerate' ? request.node_id : undefined;
    const snapshot = await repository.snapshot(owner(user, target), target.workspaceId,
      { operationId: command.operation_id, ...(scopeNodeId ? { scopeNodeId } : {}) });
    let aiUnits = 0, estimate = 0;
    if (!snapshot.recorded) {
      const scope = scopeNodeId ? snapshot.scope_node : null;
      if (scopeNodeId && !scope) throw new OrchestrationV2RecoveryError('RECOVERY_NOT_FOUND');
      if (snapshot.event_head !== command.expected_workspace_revision) {
        throw new OrchestrationV2RecoveryError('RECOVERY_STATE_CHANGED');
      }
      const planned = planOrchestrationV2Recovery({ run: snapshot.run, tasks: snapshot.tasks,
        request: scope ? { action: 'regenerate', scope } : { action: 'resume' } });
      if (!planned.ok) throw new OrchestrationV2RecoveryError(orchestrationV2RecoveryErrorFor(planned.reason));
      if (!snapshot.runtime || !await deps.runtimeCurrent(user.tenantId, snapshot.runtime)) {
        throw new OrchestrationV2RecoveryError('RECOVERY_RUNTIME_CHANGED');
      }
      aiUnits = planned.plan.ai_unit_count;
      if (aiUnits > 0) estimate = await deps.assertAffordable(user.tenantId, aiUnits);
    }
    return repository.recover(owner(user, target), target.workspaceId, {
      operation_id: command.operation_id, expected_workspace_revision: command.expected_workspace_revision,
      request, max_ai_unit_count: aiUnits, estimated_cost_usd: estimate, reconcileUnknown: deps.reconcileUnknown,
    });
  }

  return { describe, stop, recover };
}
