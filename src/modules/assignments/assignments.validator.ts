import { z } from 'zod';

const nullableDatetimeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) return null;
  return value;
}, z.string().datetime({ offset: true }).nullable());

const optionalNullableDatetimeSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) return undefined;
  return value;
}, z.string().datetime({ offset: true }).nullable().optional());

const optionalScoreSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  return Number(value);
}, z.number().int().min(0).max(100).optional());

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255),
  question: z.string().trim().min(1).max(20_000),
  is_published: z.boolean().optional().default(true),
  allow_resubmission: z.boolean().optional().default(false),
  deadline_enabled: z.boolean().optional().default(false),
  deadline_at: nullableDatetimeSchema.optional().default(null),
  grading_enabled: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.deadline_enabled && !value.deadline_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'Vui long chon thoi han nop bai',
    });
  }
});

export const updateAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  question: z.string().trim().min(1).max(20_000).optional(),
  is_published: z.boolean().optional(),
  allow_resubmission: z.boolean().optional(),
  deadline_enabled: z.boolean().optional(),
  deadline_at: optionalNullableDatetimeSchema,
}).superRefine((value, ctx) => {
  if (value.deadline_enabled === true && !value.deadline_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'Vui long chon thoi han nop bai',
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
