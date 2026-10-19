// ═══════════════════════════════════════════════════════════════
// Report results: the shapes the report service answers with (summary,
// charts, courses, learners). Types only; moved unchanged from
// reports.service.ts, which re-exports them.
// ═══════════════════════════════════════════════════════════════

// ── Types ──

export interface ReportSummary {
  meta: {
    month: number;
    year: number;
    month_label: string;
    is_current_month: boolean;
    date_from?: string;
    date_to?: string;
    range_label?: string;

  };
  overview: {
    total_learners: number;
    active_learners: number;
    completion_rate: number;
    total_enrollments: number;
    completed_enrollments: number;
    incomplete_enrollments: number;
  };
}

export type ReportChartGranularity = 'auto' | 'day' | 'week' | 'month';
export type EffectiveChartGranularity = Exclude<ReportChartGranularity, 'auto'>;
export type ReportChartWindowDirection = 'initial' | 'before' | 'after';

export interface ReportChartWindowOptions {
  mode?: 'range' | 'window';
  direction?: ReportChartWindowDirection;
  anchorBucket?: string;
  limitBuckets?: number;
  seriesLimit?: number;
}

export interface ReportChartWindowMeta {
  mode: 'window';
  range_start: string;
  range_end: string;
  window_start: string;
  window_end: string;
  has_before: boolean;
  has_after: boolean;
  next_before: string | null;
  next_after: string | null;
  limit_buckets: number;
}
export interface ReportDateRange {
  startDate: Date;
  endDate: Date;
  dateFrom: string;
  dateTo: string;
}
export interface ReportChartPoint {
  month: string;
  month_label: string;
  bucket?: string;
  bucket_label?: string;
  value?: number;
  [key: string]: unknown;
}
export interface ReportTopCourse {
  course_id: string;
  name: string;
  enrollments: number;
}

export type ReportCourseCompletionStatus = 'all' | 'not_started' | 'learning' | 'completed';
export type LearnerDetailDataScope = 'report_filter' | 'learner_history';

export interface ReportCourseCompletionRanking {
  course_id: string;
  name: string;
  total_enrollments: number;
  completed_enrollments: number;
  incomplete_enrollments: number;
  completion_rate: number;
}

export interface ReportCoursePerformance extends ReportCourseCompletionRanking {
  not_started_enrollments: number;
  in_progress_enrollments: number;
}

export interface ReportCompletionStatusDistribution {
  not_started: number;
  in_progress: number;
  completed: number;
}

export interface ReportCourseCompletionLearner {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  avatar: string | null;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: number | null;
  status: Exclude<ReportCourseCompletionStatus, 'all'>;
}

export interface ReportLearner {
  username: string;
  email: string;
  avatar: string | null;
  last_completion_at: string | null;
  completion_rate: number;
  completed_courses: number;
  enrolled_courses: number;
  status: 'not_started' | 'learning' | 'completed';
}

export interface LearnerDetailResult {
  course_id: string;
  course_name: string;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: number;
  is_completed: boolean;
  status: Exclude<ReportCourseCompletionStatus, 'all'>;
}

export interface LearnerDetailResponse {
  username: string;
  groups: Array<{ group_name: string; subgroup_name: string }>;
  results: LearnerDetailResult[];
  total_count: number;
  total_pages: number;
  current_page: number;
}
