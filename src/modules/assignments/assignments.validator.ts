import { z } from 'zod';

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255),
  question: z.string().trim().min(1).max(20_000),
  is_published: z.boolean().optional().default(true),
  allow_resubmission: z.boolean().optional().default(false),
});

export const updateAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  question: z.string().trim().min(1).max(20_000).optional(),
  is_published: z.boolean().optional(),
  allow_resubmission: z.boolean().optional(),
});

export const reorderAssignmentsSchema = z.object({
  assignment_ids: z.array(z.string().uuid()).min(1),
});

export const submitAssignmentSchema = z.object({
  answer_text: z.string().trim().max(100_000).default(''),
});

export const feedbackAssignmentSchema = z.object({
  feedback_text: z.string().trim().min(1).max(100_000),
});

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;
export type SubmitAssignmentInput = z.infer<typeof submitAssignmentSchema>;
export type FeedbackAssignmentInput = z.infer<typeof feedbackAssignmentSchema>;

