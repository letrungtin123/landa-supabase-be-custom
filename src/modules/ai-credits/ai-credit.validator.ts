import { z, type ZodError } from 'zod';

/** Every refused input of the AI credit routes: the UI shows a plain message for the named field. */
export const AI_CREDIT_INVALID_INPUT_CODE = 'AI_CREDIT_INVALID_INPUT';

const planFields = {
  name: z.string().trim().min(1, 'Nhập tên gói').max(120, 'Tên gói tối đa 120 ký tự'),
  description: z.string().trim().max(1000, 'Mô tả tối đa 1.000 ký tự').nullable().optional(),
  monthly_price_vnd: z.number().int('Giá phải là số nguyên').min(0, 'Giá không được âm').max(1_000_000_000_000),
  monthly_points: z.number().int('Số điểm phải là số nguyên').min(1, 'Số điểm phải lớn hơn 0').max(1_000_000_000),
  provider_cost_ratio: z.number().gt(0, 'Tỷ lệ chi phí phải lớn hơn 0').max(1, 'Tỷ lệ chi phí tối đa 100%'),
  safety_buffer_ratio: z.number().min(0, 'Đệm không được âm').lt(1, 'Đệm phải nhỏ hơn 100%'),
  is_unlimited: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(10_000).default(0),
};

export const createPlanSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Mã gói chỉ gồm chữ thường, số, "-" hoặc "_" (2-40 ký tự)'),
  ...planFields,
});

export const updatePlanSchema = z.object(planFields);

export const setTenantPlanSchema = z.object({ plan_id: z.string().uuid('Gói không hợp lệ') });

export const topupSchema = z.object({
  points: z.number().int('Số điểm phải là số nguyên').min(1, 'Số điểm phải lớn hơn 0').max(100_000_000),
  price_vnd: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  reason: z.string().trim().max(500, 'Lý do tối đa 500 ký tự').nullable().optional(),
});

export const fxSchema = z.object({
  vnd_per_usd: z.number().gt(0, 'Tỷ giá phải lớn hơn 0').max(1_000_000),
  source_note: z.string().trim().max(500).nullable().optional(),
});

export const reconcileSchema = z.object({
  cost_vnd: z.number().int().min(0).max(1_000_000_000_000),
  note: z.string().trim().max(500).nullable().optional(),
});

export const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Tháng không hợp lệ (YYYY-MM)');

export const idParam = z.string().uuid('Mã không hợp lệ');

export interface AiCreditInvalidInput {
  success: false;
  message: string;
  code: typeof AI_CREDIT_INVALID_INPUT_CODE;
  /** First refused field (body key, or the route parameter name). */
  field?: string;
}

/** The 400 body of a refused input: the first issue's message, its field and a stable code. */
export function invalidInputBody(error: ZodError, field?: string): AiCreditInvalidInput {
  const issue = error.errors[0];
  const path = issue?.path[0];
  const name = field ?? (typeof path === 'string' ? path : undefined);
  return {
    success: false,
    message: issue?.message || 'Dữ liệu không hợp lệ',
    code: AI_CREDIT_INVALID_INPUT_CODE,
    ...(name ? { field: name } : {}),
  };
}
