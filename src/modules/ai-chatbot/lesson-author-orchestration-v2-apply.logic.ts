import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { readOrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { ORCHESTRATION_V2_CHAPTER_CONTRACT } from './lesson-author-orchestration-v2-chapter.logic.js';
import { orchestrationV2QualityPolicy } from './lesson-author-orchestration-v2-quality.logic.js';
import { orchestrationV2OriginSummary, workspaceDraftQualityChecks } from './lesson-author-quality-receipt.logic.js';
import { orchestrationV2UnitArtifactHash } from './lesson-author-orchestration-v2-unit.logic.js';
import { editWorkspaceComponent } from './lesson-author-workspace-component.logic.js';
import { workspaceApplyScopeChapter, workspaceApplyTargetHash, WorkspaceApplyCompileError, type WorkspaceApplyMapping,
  type WorkspaceApplyNode, type WorkspaceApplyRevision, type WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import { editWorkspaceStoryboard, workspaceStoryboardBoundSeed } from './lesson-author-workspace-storyboard.logic.js';
import { assertWorkspaceDraftApplyReady, readWorkspaceContent, type WorkspaceContent } from './lesson-author-workspace.logic.js';

export const ORCHESTRATION_V2_APPLY_CONTRACT = 'workspace-scoped-apply-2';
export const ORCHESTRATION_V2_QUALITY_CANONICALIZATION = 'workspace-quality-subject-1';
export const ORCHESTRATION_V2_QUALITY_EVALUATOR = 'workspace-v2-draft-compiler-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_NODES = 32_768;
const MAX_BYTES = 64 * 1024 * 1024;
const same = (a: unknown, b: unknown) => orchestrationV2Hash(a) === orchestrationV2Hash(b);
const within = (path: string, scope: string) => path === scope || path.startsWith(`${scope}.`);
const fail = (code: ConstructorParameters<typeof WorkspaceApplyCompileError>[0], path = ''): never => {
  throw new WorkspaceApplyCompileError(code, path ? [{ code, path }] : []);
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringArray = (value: unknown): string[] | null => Array.isArray(value)
  && value.every(item => typeof item === 'string') && new Set(value).size === value.length ? value as string[] : null;
const sortedRevisions = (entries: readonly WorkspaceApplyRevision[]) => [...entries]
  .sort((a, b) => a.node_id.localeCompare(b.node_id));

export interface OrchestrationV2ApplyArtifact {
  task_id: string;
  task_key: string;
  node_id: string;
  chapter_key: string;
  artifact_hash: string;
  payload: unknown;
}

export interface OrchestrationV2ApplyChapterReceipt {
  chapter_key: string;
  artifact_hash: string;
  payload: unknown;
}

export interface OrchestrationV2ApplyInput {
  workspace_id: string;
  course_node_id: string;
  run_id: string;
  content_locale: 'vi' | 'en';
  event_head: number;
  source_snapshot_hash: string;
  runtime_config_hash: string;
  architecture: unknown;
  architecture_hash: string;
  inventory_hash: string;
  nodes: readonly WorkspaceApplyNode[];
  unit_artifacts: readonly OrchestrationV2ApplyArtifact[];
  chapter_receipts: readonly OrchestrationV2ApplyChapterReceipt[];
  allowed: ReadonlySet<CourseComponentType>;
  targets: { course_root_id: string; course_root_hash: string; mappings: WorkspaceApplyMapping[] };
  request: {
    scope_node_id: string;
    expected_workspace_revision: number;
    expected_revision_manifest: readonly WorkspaceApplyRevision[];
    expected_target_snapshot_hash: string;
  };
}

function checkedContent(row: WorkspaceApplyNode, baseline: boolean): WorkspaceContent {
  const revision = baseline ? row.baseline : row.current;
  if (row.content_state !== 'content_ready' || row.current_revision === null || !revision) {
    fail('WORKSPACE_APPLY_CONTEXT_INCOMPLETE', row.canonical_path);
  }
  const content = readWorkspaceContent(revision!.content);
  if (orchestrationV2Hash(content) !== revision!.content_hash) fail('WORKSPACE_APPLY_HASH_INVALID', row.canonical_path);
  return content;
}

function blockType(node: WorkspaceApplyNode): string {
  if (node.kind === 'component') return String(node.protected_contract.component_type ?? '');
  return ({ chapter: 'chapter', lesson: 'sequential', unit: 'vertical', media_brief: '' })[node.kind];
}

function readChapterReceipt(input: OrchestrationV2ApplyChapterReceipt, assembly: OrchestrationV2ArchitectureAssembly,
  inventoryHash: string, expectedArtifactHashes: readonly string[]) {
  const payload = record(input.payload);
  if (!payload) fail('WORKSPACE_APPLY_VALIDATION_FAILED', input.chapter_key);
  const accepted = payload!;
  if (accepted.contract_version !== 2 || accepted.contract !== ORCHESTRATION_V2_CHAPTER_CONTRACT
    || accepted.chapter_key !== input.chapter_key || accepted.source_snapshot_hash !== assembly.source_snapshot_hash
    || accepted.assembly_hash !== assembly.assembly_hash || accepted.inventory_hash !== inventoryHash
    || accepted.receipt_hash !== input.artifact_hash || !HASH.test(input.artifact_hash)) {
    fail('WORKSPACE_APPLY_VALIDATION_FAILED', input.chapter_key);
  }
  const { contract_version: _version, receipt_hash: _receiptHash, ...base } = accepted;
  if (orchestrationV2Hash(base) !== input.artifact_hash
    || !same(accepted.unit_artifact_hashes, expectedArtifactHashes)
    || accepted.duplicate_fact_count !== 0 || accepted.unresolved_fact_count !== 0
    || accepted.admitted_fact_count !== accepted.allocated_fact_count
    || accepted.allocated_fact_count !== accepted.covered_fact_count) {
    fail('WORKSPACE_APPLY_VALIDATION_FAILED', input.chapter_key);
  }
}

/** Compile a V2 workspace into the same draft-only writes as the legacy Apply
 * transaction. Every identity comes from the accepted architecture, immutable
 * inventory, successful unit artifacts and chapter receipts; browser content
 * is never accepted as authority. */
export function compileOrchestrationV2WorkspaceApply(input: OrchestrationV2ApplyInput) {
  try { return compile(input); }
  catch (error) {
    if (error instanceof WorkspaceApplyCompileError) throw error;
    throw new WorkspaceApplyCompileError('WORKSPACE_APPLY_INPUT_INVALID');
  }
}

function compile(input: OrchestrationV2ApplyInput) {
  if (![input.workspace_id, input.course_node_id, input.run_id].every(value => UUID.test(value))
    || !['vi', 'en'].includes(input.content_locale) || !Number.isSafeInteger(input.event_head) || input.event_head < 0
    || ![input.source_snapshot_hash, input.runtime_config_hash, input.architecture_hash, input.inventory_hash]
      .every(value => HASH.test(value)) || input.request.expected_workspace_revision !== input.event_head) {
    fail('WORKSPACE_APPLY_INPUT_INVALID');
  }
  const assembly = readOrchestrationV2ArchitectureAssembly(input.architecture);
  if (assembly.assembly_hash !== input.architecture_hash || assembly.source_snapshot_hash !== input.source_snapshot_hash) {
    fail('WORKSPACE_APPLY_HASH_INVALID');
  }
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: input.run_id, assembly });
  if (identity.inventory_hash !== input.inventory_hash) fail('WORKSPACE_APPLY_BINDING_INVALID');
  if (input.nodes.length > MAX_NODES || input.request.expected_revision_manifest.length > MAX_NODES
    || Buffer.byteLength(JSON.stringify({ nodes: input.nodes, unit_artifacts: input.unit_artifacts,
      chapter_receipts: input.chapter_receipts, targets: input.targets })) > MAX_BYTES) fail('WORKSPACE_APPLY_LIMIT');

  const scope = input.nodes.find(node => node.node_id === input.request.scope_node_id);
  if (!scope) fail('WORKSPACE_APPLY_SCOPE_INVALID');
  const selectedScope = scope!;
  const chapterCount = workspaceApplyScopeChapter(selectedScope.kind, selectedScope.canonical_path)
    ?? fail('WORKSPACE_APPLY_SCOPE_INVALID');
  const expectedNodes = identity.nodes.filter(node => node.kind !== 'course'
    && Number(/^chapter_([1-9][0-9]*)/.exec(node.canonical_path)?.[1] ?? 0) <= chapterCount);
  if (expectedNodes.length !== input.nodes.length) fail('WORKSPACE_APPLY_CONTEXT_INCOMPLETE');
  const byPath = new Map(input.nodes.map(node => [node.canonical_path, node]));
  const byId = new Map(input.nodes.map(node => [node.node_id, node]));
  if (byPath.size !== input.nodes.length || byId.size !== input.nodes.length) fail('WORKSPACE_APPLY_BINDING_INVALID');

  const baseline = new Map<string, WorkspaceContent>();
  const current = new Map<string, WorkspaceContent>();
  for (const expected of expectedNodes) {
    const node = byPath.get(expected.canonical_path);
    if (!node) fail('WORKSPACE_APPLY_BINDING_INVALID', expected.canonical_path);
    const stored = node!;
    if (stored.node_id !== expected.id || stored.parent_id !== expected.parent_id || stored.kind !== expected.kind
      || stored.sort_order !== expected.sort_order || stored.contract_hash !== expected.contract_hash
      || orchestrationV2Hash(stored.protected_contract) !== stored.contract_hash
      || !same(stored.protected_contract, expected.protected_contract)) {
      fail('WORKSPACE_APPLY_BINDING_INVALID', expected.canonical_path);
    }
    const base = checkedContent(stored, true), live = checkedContent(stored, false);
    baseline.set(stored.node_id, base); current.set(stored.node_id, live);
    if (stored.current_revision === 0 && stored.current!.content_hash !== stored.baseline!.content_hash) {
      fail('WORKSPACE_APPLY_BINDING_INVALID', stored.canonical_path);
    }
    if (expected.baseline && !same(base, expected.baseline)) fail('WORKSPACE_APPLY_BINDING_INVALID', stored.canonical_path);
    if (stored.kind !== 'component' && !same(live, base)) {
      try {
        const seed = workspaceStoryboardBoundSeed({ kind: stored.kind,
          canonical_path: stored.canonical_path, parent_path: expected.parent_path,
          sort_order: stored.sort_order, binding: stored.protected_contract, baseline: base });
        // Save and Apply must validate the same author-editable contract. The
        // immutable inventory binding above remains the architecture authority;
        // a valid current revision is materialized instead of being forced back
        // to revision zero merely because an author changed its display fields.
        current.set(stored.node_id, editWorkspaceStoryboard(seed, live));
      } catch {
        fail('WORKSPACE_APPLY_VALIDATION_FAILED', stored.canonical_path);
      }
    }
  }

  const artifacts = new Map<string, OrchestrationV2ApplyArtifact>();
  const components = new Map<string, LessonAuthorComponentProposal>();
  const artifactsByChapter = new Map<string, string[]>();
  const unitOrdinalByChapter = new Map<string, number>();
  for (const binding of identity.unit_bindings.filter(item => byPath.has(item.unit_path))) {
    const artifact = input.unit_artifacts.find(item => item.node_id === binding.unit_node_id);
    const unitOrdinal = (unitOrdinalByChapter.get(binding.chapter_key) ?? 0) + 1;
    unitOrdinalByChapter.set(binding.chapter_key, unitOrdinal);
    if (!artifact) fail('WORKSPACE_APPLY_VALIDATION_FAILED', binding.unit_path);
    const acceptedArtifact = artifact!;
    if (artifacts.has(acceptedArtifact.node_id) || !UUID.test(acceptedArtifact.task_id) || !HASH.test(acceptedArtifact.artifact_hash)
      || acceptedArtifact.chapter_key !== binding.chapter_key
      || acceptedArtifact.task_key !== `content:${binding.chapter_key}:unit:${unitOrdinal}`) {
      fail('WORKSPACE_APPLY_VALIDATION_FAILED', binding.unit_path);
    }
    const payload = record(acceptedArtifact.payload), generated = record(payload?.generated_unit);
    const artifactNodes = Array.isArray(payload?.nodes) ? payload!.nodes as unknown[] : [];
    const quality = orchestrationV2QualityPolicy(payload ?? {});
    // A raw-source fallback remains reviewable in the workspace but is not a
    // validated course payload. Applying it would silently convert diagnostic
    // source text into learner content.
    if (!quality.course_applicable) {
      fail('WORKSPACE_APPLY_VALIDATION_FAILED', binding.unit_path);
    }
    const generatedComponents = Array.isArray(generated?.components) ? generated!.components : [];
    const architectureUnit = binding.unit as OrchestrationV2ArchitectureAssembly['architecture']['chapters'][number]['lessons'][number]['units'][number];
    if (!payload || payload.contract_version !== 2 || payload.unit_path !== binding.unit_path
      || payload.source_snapshot_hash !== input.source_snapshot_hash
      || orchestrationV2UnitArtifactHash(payload) !== acceptedArtifact.artifact_hash
      || artifactNodes.length !== architectureUnit.component_plan.length + 1
      || generatedComponents.length !== architectureUnit.component_plan.length) {
      fail('WORKSPACE_APPLY_VALIDATION_FAILED', binding.unit_path);
    }
    const paths = [binding.unit_path, ...architectureUnit.component_plan.map((_plan, index) => `${binding.unit_path}.component_${index + 1}`)];
    for (const [index, path] of paths.entries()) {
      const artifactNode = record(artifactNodes[index]), node = byPath.get(path);
      if (!node) fail('WORKSPACE_APPLY_BINDING_INVALID', path);
      const stored = node!;
      if (!artifactNode || artifactNode.path !== path || !HASH.test(String(artifactNode.content_hash))
        || orchestrationV2Hash(artifactNode.content) !== artifactNode.content_hash
        || stored.baseline?.content_hash !== artifactNode.content_hash || stored.baseline === null) {
        fail('WORKSPACE_APPLY_BINDING_INVALID', path);
      }
      if (index === 0) continue;
      const original = generatedComponents[index - 1] as LessonAuthorComponentProposal;
      const metadata = record(original?.metadata), expectedPlan = architectureUnit.component_plan[index - 1]!;
      const protectedMetadata = record(stored.protected_contract.metadata);
      const sourceFactIds = stringArray(metadata?.source_fact_ids), coveredFactIds = stringArray(metadata?.covered_source_fact_ids);
      // The immutable unit artifact already binds both generated_unit and the
      // exact revision-0 node content through one accepted artifact hash. Do
      // not re-project a historical baseline through today's sanitizer here:
      // canonical Course Outline rules can evolve while an accepted workspace
      // must remain applicable. Re-validating with the current authoring
      // adapter happens below when the current revision is materialized.
      if (!original || original.type !== expectedPlan.type || metadata?.component_plan_id !== protectedMetadata?.component_plan_id
        || !sourceFactIds || !coveredFactIds || !same(sourceFactIds, coveredFactIds)) {
        fail('WORKSPACE_APPLY_BINDING_INVALID', path);
      }
      components.set(stored.node_id, editWorkspaceComponent(original, current.get(stored.node_id), input.allowed));
    }
    artifacts.set(acceptedArtifact.node_id, acceptedArtifact);
    artifactsByChapter.set(binding.chapter_key, [...(artifactsByChapter.get(binding.chapter_key) ?? []), acceptedArtifact.artifact_hash]);
  }
  if (artifacts.size !== identity.unit_bindings.filter(item => byPath.has(item.unit_path)).length
    || input.unit_artifacts.length !== artifacts.size) fail('WORKSPACE_APPLY_VALIDATION_FAILED');

  const selectedChapterKeys = assembly.architecture.chapters.slice(0, chapterCount).map(chapter => chapter.chapter_key);
  if (input.chapter_receipts.length !== selectedChapterKeys.length) fail('WORKSPACE_APPLY_VALIDATION_FAILED');
  for (const chapterKey of selectedChapterKeys) {
    const receipt = input.chapter_receipts.find(item => item.chapter_key === chapterKey);
    if (!receipt) fail('WORKSPACE_APPLY_VALIDATION_FAILED', chapterKey);
    readChapterReceipt(receipt!, assembly, input.inventory_hash, artifactsByChapter.get(chapterKey) ?? []);
  }

  const revisionManifest = sortedRevisions(input.nodes.map(node => ({ node_id: node.node_id,
    revision: node.current_revision!, content_hash: node.current!.content_hash })));
  const expectedManifest = sortedRevisions(input.request.expected_revision_manifest);
  if (new Set(expectedManifest.map(item => item.node_id)).size !== expectedManifest.length
    || !same(expectedManifest, revisionManifest)) fail('WORKSPACE_APPLY_REVISION_CONFLICT');

  const mappings = new Map(input.targets.mappings.map(mapping => [mapping.node_id, mapping]));
  if (!UUID.test(input.targets.course_root_id) || !HASH.test(input.targets.course_root_hash)
    || mappings.size !== input.targets.mappings.length
    || new Set(input.targets.mappings.map(mapping => mapping.target_block_id)).size !== mappings.size) {
    fail('WORKSPACE_APPLY_TARGET_CHANGED');
  }
  const offsets = new Map<string, number>();
  for (const mapping of input.targets.mappings) {
    const node = byId.get(mapping.node_id);
    if (!node) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    const mappedNode = node!;
    if (mappedNode.kind === 'media_brief' || mapping.target_hash !== mapping.actual_target_hash
      || mapping.target_block_type !== blockType(mappedNode) || mapping.target_block_id === input.targets.course_root_id
      || mapping.applied_revision > mappedNode.current_revision!
      || mapping.applied_revision === mappedNode.current_revision && mapping.applied_content_hash !== mappedNode.current!.content_hash
      || mapping.target_parent_id !== (mappedNode.kind === 'chapter' ? input.targets.course_root_id
        : mappings.get(mappedNode.parent_id)?.target_block_id)) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    const offset = mapping.target_sort_order - mappedNode.sort_order;
    if (offset < 0 || offsets.has(mappedNode.parent_id) && offsets.get(mappedNode.parent_id) !== offset) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    offsets.set(mappedNode.parent_id, offset);
    if (!mapping.receipt_revision_manifest.some(entry => entry.node_id === mapping.node_id
      && entry.revision === mapping.applied_revision && entry.content_hash === mapping.applied_content_hash)) {
      fail('WORKSPACE_APPLY_TARGET_CHANGED');
    }
  }
  const targetSnapshotHash = workspaceApplyTargetHash(input.targets);
  if (input.request.expected_target_snapshot_hash !== targetSnapshotHash) fail('WORKSPACE_APPLY_TARGET_CHANGED');

  const writeNodes = input.nodes.filter(node => node.kind !== 'media_brief'
    && (within(node.canonical_path, selectedScope.canonical_path) || within(selectedScope.canonical_path, node.canonical_path)));
  // V2 architecture currently has no explicit prerequisite-edge contract.
  // Canonical presentation order is not Apply authority, so a later independent
  // Independent chapter/section/lesson/component scopes must never require
  // earlier presentation siblings to have been applied.
  const required: WorkspaceApplyNode[] = [];

  const writes: WorkspaceApplyWrite[] = writeNodes.map(node => {
    const content = current.get(node.node_id)!, mapping = mappings.get(node.node_id);
    return { node_id: node.node_id, parent_node_id: node.parent_id, canonical_path: node.canonical_path,
      kind: node.kind as WorkspaceApplyWrite['kind'], block_type: blockType(node), sort_order: node.sort_order,
      revision: node.current_revision!, content_hash: node.current!.content_hash, title: content.title,
      component: components.get(node.node_id) ?? null,
      author_metadata: { purpose: content.purpose, implementation_notes: content.implementation_notes,
        storyboard: node.kind === 'component' ? null : content.data,
        media_briefs: input.nodes.filter(brief => brief.kind === 'media_brief' && brief.parent_id === node.node_id)
          .sort((a, b) => a.sort_order - b.sort_order).map(brief => ({ node_id: brief.node_id,
            revision: brief.current_revision!, content_hash: brief.current!.content_hash,
            media_type: typeof brief.protected_contract.media_type === 'string' ? brief.protected_contract.media_type : null,
            content: current.get(brief.node_id)! })) },
      mapped_target: mapping ? { block_id: mapping.target_block_id, parent_id: mapping.target_parent_id,
        sort_order: mapping.target_sort_order, before_hash: mapping.target_hash } : null };
  });
  const revisionSetHash = orchestrationV2Hash(revisionManifest);
  const capabilityHash = orchestrationV2Hash([...input.allowed].sort());
  const subjectContentHash = orchestrationV2Hash({
    canonicalization_version: ORCHESTRATION_V2_QUALITY_CANONICALIZATION,
    scope_node_id: selectedScope.node_id,
    scope_path: selectedScope.canonical_path,
    nodes: writeNodes.map(node => ({ node_id: node.node_id, parent_id: node.parent_id, kind: node.kind,
      canonical_path: node.canonical_path, sort_order: node.sort_order, revision: node.current_revision,
      content_hash: node.current!.content_hash, block_type: blockType(node) })),
  });
  const evidenceDependencyHash = orchestrationV2Hash({ source_snapshot_hash: input.source_snapshot_hash,
    architecture_hash: input.architecture_hash, inventory_hash: input.inventory_hash,
    capability_hash: capabilityHash });
  const checks = workspaceDraftQualityChecks();
  const acceptance = { scope_id: selectedScope.node_id, revision_set_hash: revisionSetHash,
    source_snapshot_hash: input.source_snapshot_hash, target_snapshot_hash: targetSnapshotHash, checks };
  assertWorkspaceDraftApplyReady({ ...acceptance, kind: selectedScope.kind, complete: true, validation: acceptance });
  const quality_receipt = {
    canonicalization_version: ORCHESTRATION_V2_QUALITY_CANONICALIZATION,
    evaluator_kind: 'deterministic' as const,
    evaluator_version: ORCHESTRATION_V2_QUALITY_EVALUATOR,
    subject_content_hash: subjectContentHash,
    evidence_dependency_hash: evidenceDependencyHash,
    origin_summary: orchestrationV2OriginSummary(input.unit_artifacts.map(artifact => record(artifact.payload)?.content_origin),
      input.nodes.filter(node => (node.current_revision ?? 0) > 0).length),
    checks,
    findings: [
      { check: 'pedagogy', status: 'NOT_RUN', reason_code: 'SEMANTIC_EVALUATOR_NOT_RUN' },
      { check: 'dependencies', status: 'NOT_APPLICABLE', reason_code: 'NO_EXPLICIT_V2_DEPENDENCY_CONTRACT' },
    ] as const,
  };
  const result = { validation_contract: ORCHESTRATION_V2_APPLY_CONTRACT, workspace_id: input.workspace_id,
    content_locale: input.content_locale, scope_node_id: selectedScope.node_id, scope_path: selectedScope.canonical_path,
    expected_workspace_revision: input.event_head, runtime_config_hash: input.runtime_config_hash,
    architecture_hash: input.architecture_hash, inventory_hash: input.inventory_hash,
    capability_hash: capabilityHash, revision_manifest: revisionManifest,
    revision_set_hash: revisionSetHash, required_applied_dependencies: required.map(node => node.node_id).sort(),
    acceptance, quality_receipt, writes };
  return structuredClone({ ...result, compilation_hash: orchestrationV2Hash(result) });
}
