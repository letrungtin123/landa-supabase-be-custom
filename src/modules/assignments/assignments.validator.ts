import { z } from 'zod';

const optionalNullableDatetimeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) return undefined;
  return value;
}, z.string().datetime({ offset: true }).nullable().optional());

const booleanSchema = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const optionalBooleanSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean().optional());

const optionalPositiveDaysSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().int().min(1).max(3650).optional());

const optionalScoreSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().int().min(0).max(100).optional());

const optionalDeadlineModeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return value;
}, z.enum(['none', 'absolute', 'relative_to_enrollment']).optional());
const submissionUnlockModeSchema = z.enum(['after_content_complete', 'anytime']);

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255),
  question: z.string().trim().min(1).max(20_000),
  is_published: booleanSchema.optional().default(true),
  allow_resubmission: booleanSchema.optional().default(false),
  deadline_enabled: booleanSchema.optional().default(true),
  deadline_mode: optionalDeadlineModeSchema.default('relative_to_enrollment'),
  deadline_at: optionalNullableDatetimeSchema,
  deadline_after_days: optionalPositiveDaysSchema,
  grading_enabled: booleanSchema.optional().default(false),
  submission_unlock_mode: submissionUnlockModeSchema.optional().default('after_content_complete'),
}).superRefine((value, ctx) => {
  if (value.deadline_mode === 'absolute') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_mode'],
      message: 'Không còn hỗ trợ hạn cụ thể cho bài tập',
    });
  }
  if (value.deadline_at !== undefined && value.deadline_at !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'Không còn hỗ trợ hạn cụ thể cho bài tập',
    });
  }
});

export const updateAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  question: z.string().trim().min(1).max(20_000).optional(),
  is_published: optionalBooleanSchema,
  allow_resubmission: optionalBooleanSchema,
  deadline_enabled: optionalBooleanSchema,
  deadline_mode: optionalDeadlineModeSchema,
  deadline_at: optionalNullableDatetimeSchema,
  deadline_after_days: optionalPositiveDaysSchema,
  submission_unlock_mode: submissionUnlockModeSchema.optional(),
  remove_attachment: optionalBooleanSchema,
}).superRefine((value, ctx) => {
  if (
    value.deadline_enabled !== undefined
    || value.deadline_mode !== undefined
    || value.deadline_at !== undefined
    || value.deadline_after_days !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_after_days'],
      message: 'Không thể chỉnh hạn bài tập sau khi đã tạo',
    });
  }
});

export const reorderAssignmentsSchema = z.object({
  assignment_ids: z.array(z.string().uuid()).min(1),
});

export const submitAssignmentSchema = z.object({
  answer_text: z.string().trim().max(100_000).default(''),
});

export const feedbackAssignmentSchema = z.object({
  feedback_text: z.string().trim().min(1).max(100_000),
  score: optionalScoreSchema,
});

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type SubmitAssignmentInput = z.infer<typeof submitAssignmentSchema>;
export type FeedbackAssignmentInput = z.infer<typeof feedbackAssignmentSchema>;
