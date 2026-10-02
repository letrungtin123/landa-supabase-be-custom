import { isDeepStrictEqual } from 'node:util';
import { assertComponentInstancePlan } from '../ai-chatbot/lesson-author-capabilities.logic.js';
import { isLessonAuthorGeneratedContentOwned, isLessonAuthorMediaProtectedBlock } from './lesson-author-components.logic.js';

export interface GeneratedComponentWrite {
  blockType: string;
  displayName: string;
  data: unknown;
  metadata: Record<string, unknown>;
}

export interface StoredComponentRow {
  id: string;
  block_type: string;
  display_name: string;
  data: unknown;
  metadata: unknown;
}

/** Adapter is supplied by the existing locked Apply transaction, never a new connection. */
export interface UnitComponentStore {
  list(): Promise<StoredComponentRow[]>;
  insert(component: GeneratedComponentWrite): Promise<string>;
  update(id: string, component: GeneratedComponentWrite): Promise<void>;
}

export class ComponentApplyError extends Error {
  constructor(readonly code: string, readonly componentIndex?: number) {
    super(code); // Fixed operational code only, never payload/title/source content.
    this.name = 'ComponentApplyError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function titleKey(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function writable(row: StoredComponentRow): boolean {
  return isLessonAuthorGeneratedContentOwned(row.metadata)
    && !isLessonAuthorMediaProtectedBlock(row.block_type, row.data, row.metadata);
}

/** JSONB ignores object key order; preserve array order and every payload value. */
function jsonValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export async function applyGeneratedUnitComponents(
  components: readonly GeneratedComponentWrite[], store: UnitComponentStore,
): Promise<Array<{ id: string; created: boolean; updated: boolean; component_plan_id?: string }>> {
  const instanceMode = components.some(c => c.metadata.component_plan_id != null);
  if (instanceMode) {
    try {
      assertComponentInstancePlan(components.map(c => ({ component_plan_id: c.metadata.component_plan_id as string | undefined })));
    } catch {
      throw new ComponentApplyError('COMPONENT_APPLY_INSTANCE_INVALID');
    }
  }
  // Snapshot once: a newly inserted same-title sibling can never be an update target.
  const baseline = await store.list();
  const claimed = new Set<string>();
  const resolutions = components.map((component, index) => {
    const instanceId = component.metadata.component_plan_id;
    let candidates: StoredComponentRow[];
    if (instanceMode) {
      candidates = baseline.filter(row => record(row.metadata).component_plan_id === instanceId);
    } else {
      // Legacy proposals cannot take over a newer instance-owned component.
      const available = baseline.filter(row => !claimed.has(row.id)
        && record(row.metadata).component_plan_id == null && row.block_type === component.blockType && writable(row));
      // Same-job server index supports replay of legacy duplicate-title siblings.
      const exactLegacy = component.metadata.job_id == null ? [] : available.filter(row =>
        record(row.metadata).job_id === component.metadata.job_id
        && record(row.metadata).ai_component_index === index);
      const normalizedTitle = titleKey(component.displayName);
      candidates = exactLegacy.length ? exactLegacy : available.filter(row =>
        !!normalizedTitle && titleKey(row.display_name) === normalizedTitle);
    }
    if (candidates.length > 1) throw new ComponentApplyError('COMPONENT_APPLY_IDENTITY_AMBIGUOUS', index);
    const existing = candidates[0];
    if (existing) {
      if (claimed.has(existing.id) || existing.block_type !== component.blockType) {
        throw new ComponentApplyError('COMPONENT_APPLY_IDENTITY_CONFLICT', index);
      }
      if (!writable(existing)) throw new ComponentApplyError('COMPONENT_APPLY_PROTECTED_INSTANCE', index);
      claimed.add(existing.id);
    }
    return { component, existing };
  });
  const written: Array<{ id: string; created: boolean; updated: boolean; component_plan_id?: string }> = [];
  for (const { component, existing } of resolutions) {
    let id: string;
    if (existing) {
      id = existing.id;
      await store.update(id, component);
    } else {
      id = await store.insert(component);
    }
    written.push({ id, created: !existing, updated: !!existing,
      ...(instanceMode ? { component_plan_id: component.metadata.component_plan_id as string } : {}) });
  }
  if (new Set(written.map(row => row.id)).size !== components.length) {
    throw new ComponentApplyError('COMPONENT_APPLY_TARGET_REUSED');
  }
  const persisted = await store.list();
  for (const [index, expected] of components.entries()) {
    const matches = persisted.filter(row => row.id === written[index].id);
    const actual = matches[0];
    if (matches.length !== 1 || actual.block_type !== expected.blockType
      || !isDeepStrictEqual(jsonValue(actual.data), jsonValue(expected.data))
      || Object.entries(expected.metadata).some(([key, value]) => value !== undefined
        && !isDeepStrictEqual(jsonValue(record(actual.metadata)[key]), jsonValue(value)))) {
      throw new ComponentApplyError('COMPONENT_APPLY_PARITY_FAILED', index);
    }
    if (instanceMode && persisted.filter(row => record(row.metadata).component_plan_id === written[index].component_plan_id).length !== 1) {
      throw new ComponentApplyError('COMPONENT_APPLY_IDENTITY_AMBIGUOUS', index);
    }
  }
  return written;
}
