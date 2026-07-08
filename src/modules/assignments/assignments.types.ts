export type AssignmentSubmissionStatus = 'not_submitted' | 'submitted' | 'feedback_given';
export type AssignmentDeadlineMode = 'none' | 'absolute' | 'relative_to_enrollment';
export type AssignmentSubmissionUnlockMode = 'after_content_complete' | 'anytime';

export interface AssignmentFileMeta {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  download_url: string;
  created_at?: string;
}

export interface CourseAssignment {
  id: string;
  tenant_id: string;
  course_id: string;
  title: string;
  question: string;
  sort_order: number;
  is_published: boolean;
  allow_resubmission: boolean;
  deadline_enabled: boolean;
  deadline_mode: AssignmentDeadlineMode;
  deadline_at: string | null;
  deadline_after_days: number | null;
  effective_deadline_at?: string | null;
  grading_enabled: boolean;
  is_deadline_expired?: boolean;
  submission_unlock_mode: AssignmentSubmissionUnlockMode;
  locked_reason?: 'content' | 'deadline' | null;
  submitted_count?: number;
  feedback_count?: number;
  status?: AssignmentSubmissionStatus;
  can_submit?: boolean;
  submission?: {
    id: string;
    answer_text: string;
    files: AssignmentFileMeta[];
    status: AssignmentSubmissionStatus;
    submitted_at: string;
    submission_version: number;
    score: number | null;
    feedback_text: string | null;
    feedback_files: AssignmentFileMeta[];
    feedback_by: string | null;
    feedback_by_username: string | null;
    feedback_by_name: string | null;
    feedback_by_email: string | null;
    feedback_at: string | null;
  } | null;
}
