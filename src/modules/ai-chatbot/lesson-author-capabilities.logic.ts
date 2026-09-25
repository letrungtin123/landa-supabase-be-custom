import { createHash } from 'node:crypto';

export interface LessonAuthorComponentCapabilities {
  version: 2;
  max_components_per_unit: 4;
  max_assessments_per_unit: 3;
  assessment_enabled: boolean;
}

export class ComponentCapabilityError extends Error {
  constructor(readonly code: string, readonly unit_path?: string) {
    super(code);
    this.name = 'ComponentCapabilityError';
  }
}

export function createComponentCapabilities(allowed: ReadonlySet<string>): LessonAuthorComponentCapabilities {
  return { version: 2, max_components_per_unit: 4, max_assessments_per_unit: 3, assessment_enabled: allowed.has('problem') };
}

export function readComponentCapabilities(value: unknown): LessonAuthorComponentCapabilities | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 2 || v.max_components_per_unit !== 4 || v.max_assessments_per_unit !== 3
      || typeof v.assessment_enabled !== 'boolean'
      || Object.keys(v).some(k => !['version', 'max_components_per_unit', 'max_assessments_per_unit', 'assessment_enabled'].includes(k))) {
    throw new Error('COMPONENT_CAPABILITY_PROFILE_INVALID');
  }
  return { version: 2, max_components_per_unit: 4, max_assessments_per_unit: 3, assessment_enabled: v.assessment_enabled };
}

export function componentPlanId(unitPath: string, type: string, blockIds: readonly string[]): string {
  return `cp2_${createHash('sha256').update(JSON.stringify([unitPath, type, [...blockIds].sort()])).digest('hex').slice(0, 32)}`;
}

export function assertComponentInstancePlan(plans: readonly { component_plan_id?: string }[]): void {
  const ids = plans.map(p => p.component_plan_id);
  if (plans.length < 1 || plans.length > 4 || ids.some(id => !id || !/^cp2_[a-f0-9]{32}$/.test(id))
      || new Set(ids).size !== ids.length) throw new Error('COMPONENT_PLAN_INSTANCE_INVALID');
}

/** Never forward provider bodies, prompts or arbitrary HTTP error metadata. */
export function readSafeBlueprintFailure(value: unknown): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ['failure_stage', 'internal_failure_code']) {
    if (typeof raw[key] === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(raw[key])) result[key] = raw[key];
  }
  if (typeof raw.correlation_id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.correlation_id)) result.correlation_id = raw.correlation_id;
  if (typeof raw.total_repair_provider_calls === 'number' && Number.isInteger(raw.total_repair_provider_calls)
      && raw.total_repair_provider_calls >= 0 && raw.total_repair_provider_calls <= 3) result.total_repair_provider_calls = raw.total_repair_provider_calls;
  return result;
}

export function assessmentGapMessage(code: string | undefined, locale: 'vi' | 'en'): string | undefined {
  if (code === 'ASSESSMENT_PLAN_DOWNSTREAM_CAPABILITY_GAP' || code === 'MANDATORY_COMPONENT_CAPACITY_EXCEEDED'
    || code === 'ASSESSMENT_TENANT_CAPABILITY_GAP' || code === 'COMPONENT_PLAN_COURSE_CAPACITY_EXCEEDED') {
    return locale === 'vi'
      ? 'Chưa thể tạo Bản thiết kế: yêu cầu đánh giá vượt khả năng component hiện được phép. Chưa áp dụng thay đổi nào.'
      : 'The required assessments exceed the currently permitted component capability. No changes have been applied.';
  }
  if (code === 'ASSESSMENT_PLAN_NO_SAFE_ANCHOR') {
    return locale === 'vi'
      ? 'Chưa thể tạo Bản thiết kế: chưa xác định được phần giảng dạy có căn cứ phù hợp trước bài kiểm tra. Chưa áp dụng thay đổi nào.'
      : 'A source-grounded teaching anchor could not be established before the assessment. No changes have been applied.';
  }
  return undefined;
}
