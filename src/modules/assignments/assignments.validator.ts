import { z } from 'zod';

const nullableDatetimeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) return null;
  return value;
}, z.string().datetime({ offset: true }).nullable());

const optionalNullableDatetimeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) return undefined;
  return value;
}, z.string().datetime({ offset: true }).nullable().optional());

const optionalPositiveDaysSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().int().min(1).max(3650).optional());

const optionalScoreSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().int().min(0).max(100).optional());

const deadlineModeSchema = z.enum(['none', 'absolute', 'relative_to_enrollment']);
const submissionUnlockModeSchema = z.enum(['after_content_complete', 'anytime']);

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255),
  question: z.string().trim().min(1).max(20_000),
  is_published: z.boolean().optional().default(true),
  allow_resubmission: z.boolean().optional().default(false),
  deadline_enabled: z.boolean().optional().default(false),
  deadline_mode: deadlineModeSchema.optional(),
  deadline_at: nullableDatetimeSchema.optional().default(null),
  deadline_after_days: optionalPositiveDaysSchema,
  grading_enabled: z.boolean().optional().default(false),
  submission_unlock_mode: submissionUnlockModeSchema.optional().default('after_content_complete'),
}).superRefine((value, ctx) => {
  const mode = value.deadline_mode ?? (value.deadline_enabled ? 'absolute' : 'none');
  if (mode === 'absolute' && !value.deadline_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'Vui lòng chọn thời hạn nộp bài',
    });
  }
  if (mode === 'relative_to_enrollment' && !value.deadline_after_days) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_after_days'],
      message: 'Vui lòng nhập số ngày tính từ lúc học viên ghi danh',
    });
  }
});

export const updateAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  question: z.string().trim().min(1).max(20_000).optional(),
  is_published: z.boolean().optional(),
  allow_resubmission: z.boolean().optional(),
  deadline_enabled: z.boolean().optional(),
  deadline_mode: deadlineModeSchema.optional(),
  deadline_at: optionalNullableDatetimeSchema,
  deadline_after_days: optionalPositiveDaysSchema,
  submission_unlock_mode: submissionUnlockModeSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.deadline_mode === 'absolute' && !value.deadline_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'Vui lòng chọn thời hạn nộp bài',
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
