import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import { isNormalizedLaunchBrief, type LessonAuthorLaunchBrief } from '../../contracts/lesson-author-launch-brief.logic.js';
import {
  readOrganizationContext, withOrganizationContextIdentity, type OrganizationContextV1,
} from '../../contracts/lesson-author-org-context.contract.js';
import type { OrchestrationV2RunPipeline } from '../../contracts/lesson-author-idm.contract.js';
import { UUID_PATTERN } from '../../../../../utils/uuid.js';

export interface OrchestrationV2AdmissionAuthority {
  workspace_id: string;
  tenant_id: string;
  course_id: string;
  source_snapshot_hash: string;
  source_document_ids: readonly string[];
  /** QLT-6: the workspace's launch brief (null for a workspace created before it). */
  launch_brief?: LessonAuthorLaunchBrief | null;
  /** The organization context the workspace froze (null or absent without one). */
  organization_context?: OrganizationContextV1 | null;
}

export interface OrchestrationV2AdmissionConfig {
  runtime_config_hash: string;
  model: string;
  source_snapshot_budget_ms: number;
  tenant_concurrency_limit: number;
  workspace_concurrency_limit: number;
  routing_shard_count: number;
  /**
   * QLT-6: the pipeline the runtime hash selects. Not part of the bootstrap hash (the
   * runtime hash already is); admission refuses a kept-document brief outside IDM.
   */
  pipeline?: OrchestrationV2RunPipeline;
}

export interface PreparedOrchestrationV2Admission {
  bootstrap_hash: string;
  source_task_contract_hash: string;
  routing_shard: number;
  source_document_ids: readonly string[];
}

export class OrchestrationV2AdmissionContractError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_ADMISSION_INVALID') {
    super(code);
    this.name = 'OrchestrationV2AdmissionContractError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const fail = (): never => { throw new OrchestrationV2AdmissionContractError('ORCHESTRATION_V2_ADMISSION_INVALID'); };
const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;

/** Freeze the complete authority needed before the first durable task exists. */
export function prepareOrchestrationV2Admission(
  authority: OrchestrationV2AdmissionAuthority,
  config: OrchestrationV2AdmissionConfig,
): PreparedOrchestrationV2Admission {
  if (!authority || !config || !UUID_PATTERN.test(authority.workspace_id) || !UUID_PATTERN.test(authority.tenant_id)
    || !authority.course_id.trim() || authority.course_id.length > 255 || !HASH.test(authority.source_snapshot_hash)
    || !Array.isArray(authority.source_document_ids) || authority.source_document_ids.length < 1
    || authority.source_document_ids.length > 5 || authority.source_document_ids.some(id => !UUID_PATTERN.test(id))
    || new Set(authority.source_document_ids).size !== authority.source_document_ids.length
    || !HASH.test(config.runtime_config_hash) || !config.model.trim() || config.model.length > 128
    || !integer(config.source_snapshot_budget_ms, 1, 600_000)
    || !integer(config.tenant_concurrency_limit, 1, 1_024)
    || !integer(config.workspace_concurrency_limit, 1, 128)
    || config.workspace_concurrency_limit > config.tenant_concurrency_limit
    || !integer(config.routing_shard_count, 1, 4_096)
    || (authority.launch_brief != null && !isNormalizedLaunchBrief(authority.launch_brief))) fail();
  if (authority.organization_context != null) readOrganizationContext(authority.organization_context, 'organization_context', fail);
  const source_document_ids = Object.freeze([...authority.source_document_ids].sort());
  // The run is also bound to the organization context it was admitted with (absent without one, so every
  // bootstrap hash taken before the feature is unchanged).
  const bootstrap = withOrganizationContextIdentity({
    contract_version: 2,
    workspace_id: authority.workspace_id,
    tenant_id: authority.tenant_id,
    course_id: authority.course_id,
    source_snapshot_hash: authority.source_snapshot_hash,
    source_document_ids,
    runtime_config_hash: config.runtime_config_hash,
    model: config.model,
    tenant_concurrency_limit: config.tenant_concurrency_limit,
    workspace_concurrency_limit: config.workspace_concurrency_limit,
    // QLT-6: the run is bound to the brief it was admitted with; absent for a workspace without one, so the
    // bootstrap hash of a run admitted before QLT-6 is unchanged.
    ...(authority.launch_brief ? { launch_brief: { design_mode: authority.launch_brief.design_mode,
      learner_audience: authority.launch_brief.learner_audience, course_purpose: authority.launch_brief.course_purpose } }
      : {}),
  }, authority.organization_context);
  const sourceTask = {
    contract_version: 2,
    task_key: 'source:snapshot',
    kind: 'source_snapshot',
    source_snapshot_hash: authority.source_snapshot_hash,
    execution_budget_ms: config.source_snapshot_budget_ms,
    provider_max_attempts: 0,
  };
  const routingHash = orchestrationV2Hash({ tenant_id: authority.tenant_id, workspace_id: authority.workspace_id });
  return Object.freeze({
    bootstrap_hash: orchestrationV2Hash(bootstrap),
    source_task_contract_hash: orchestrationV2Hash(sourceTask),
    routing_shard: Number.parseInt(routingHash.slice(0, 12), 16) % config.routing_shard_count,
    source_document_ids,
  });
}
