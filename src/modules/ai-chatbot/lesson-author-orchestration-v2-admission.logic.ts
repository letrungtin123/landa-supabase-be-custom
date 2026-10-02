import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';

export interface OrchestrationV2AdmissionAuthority {
  workspace_id: string;
  tenant_id: string;
  course_id: string;
  source_snapshot_hash: string;
  source_document_ids: readonly string[];
}

export interface OrchestrationV2AdmissionConfig {
  runtime_config_hash: string;
  model: string;
  source_snapshot_budget_ms: number;
  tenant_concurrency_limit: number;
  workspace_concurrency_limit: number;
  routing_shard_count: number;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (): never => { throw new OrchestrationV2AdmissionContractError('ORCHESTRATION_V2_ADMISSION_INVALID'); };
const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;

/** Freeze the complete authority needed before the first durable task exists. */
export function prepareOrchestrationV2Admission(
  authority: OrchestrationV2AdmissionAuthority,
  config: OrchestrationV2AdmissionConfig,
): PreparedOrchestrationV2Admission {
  if (!authority || !config || !UUID.test(authority.workspace_id) || !UUID.test(authority.tenant_id)
    || !authority.course_id.trim() || authority.course_id.length > 255 || !HASH.test(authority.source_snapshot_hash)
    || !Array.isArray(authority.source_document_ids) || authority.source_document_ids.length < 1
    || authority.source_document_ids.length > 5 || authority.source_document_ids.some(id => !UUID.test(id))
    || new Set(authority.source_document_ids).size !== authority.source_document_ids.length
    || !HASH.test(config.runtime_config_hash) || !config.model.trim() || config.model.length > 128
    || !integer(config.source_snapshot_budget_ms, 1, 600_000)
    || !integer(config.tenant_concurrency_limit, 1, 1_024)
    || !integer(config.workspace_concurrency_limit, 1, 128)
    || config.workspace_concurrency_limit > config.tenant_concurrency_limit
    || !integer(config.routing_shard_count, 1, 4_096)) fail();
  const source_document_ids = Object.freeze([...authority.source_document_ids].sort());
  const bootstrap = {
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
  };
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
