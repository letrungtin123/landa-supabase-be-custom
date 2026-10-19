// ═══════════════════════════════════════════════════════════════
// Course authoring types: the outline, block, asset and AI ID proposal shapes
// the course-authoring services return or accept. Moved unchanged from
// course-authoring.service.ts, which still re-exports every one.
// ═══════════════════════════════════════════════════════════════

import type { LessonAuthorIntentPlan } from '../ai-chatbot/ai-id/lesson-author-intent.logic.js';

export interface BlockNode {
  id: string;
  display_name: string;
  block_type: string;
  published: boolean;
  has_changes: boolean;
  sort_order: number;
  data?: any;
  metadata?: any;
  children?: BlockNode[];
}

export interface CourseOutlineResponse {
  course_id: string;
  course_structure: BlockNode;
}

export interface BlockInfo {
  id: string;
  course_id: string;
  course_name: string;
  parent_id: string | null;
  parent_name: string | null;
  block_type: string;
  display_name: string;
  data: any;
  metadata: any;
  sort_order: number;
  is_published: boolean;
  has_draft_changes: boolean;
  created_at: string;
  updated_at: string;
}

export interface UnitChild {
  id: string;
  block_id: string;
  display_name: string;
  block_type: string;
  has_changes: boolean;
  published: boolean;
}

export interface AssetRecord {
  id: string;
  course_id: string;
  display_name: string;
  content_type: string;
  file_size: number;
  storage_path?: string;
  url: string;
  thumbnail_url: string | null;
  is_locked: boolean;
  is_reference?: boolean;
  is_outline_media?: boolean;
  outline_reference_count?: number;
  date_added: string;
}

export interface CourseAssetsResponse {
  start: number;
  end: number;
  page: number;
  pageSize: number;
  totalCount: number | null;
  assets: AssetRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}



export interface AssetDeleteResult {
  asset: any;
  deleted: boolean;
  pendingPublishedReferences: boolean;
  publishedReferenceCount: number;
  storagePathsToDelete: string[];
}

export interface DeleteAssetByStoragePathResult {
  deletedRows: { storage_path: string; display_name: string | null }[];
  pendingPublishedReferences: boolean;
  publishedReferenceCount: number;
  storagePathsToDelete: string[];
}

export type LessonAuthorComponentType = 'html' | 'problem' | 'la_faq' | 'la_sortable' | 'la_crossword' | 'la_diagram';

export interface LessonAuthorComponentPlan {
  supporting_evidence_fact_ids?: string[];
  component_plan_id?: string;
  learning_objective_refs?: string[];
  type: LessonAuthorComponentType;
  title?: string;
  rationale?: string;
  source_fact_ids?: string[];
  purpose?: 'explain' | 'assess' | 'clarify' | 'sequence' | 'relationship' | 'terminology';
  content_requirements?: string[];
  /** Phase 2 stable planner diagnostic; never model chain-of-thought. */
  reason_code?: string;
  /** Semantic learning-block IDs that the deterministic planner mapped here. */
  learning_block_ids?: string[];
  required_artifacts?: Array<{
    type: 'ordered_list' | 'checklist' | 'table' | 'warning' | 'requirement' | 'exception' | 'comparison';
    minimum_items?: number;
  }>;
}

export interface LessonAuthorComponentProposal {
  type: LessonAuthorComponentType;
  title: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface LessonAuthorUnitProposal {
  title: string;
  html?: string;
  components?: LessonAuthorComponentProposal[];
  source_refs?: string[];
  source_fact_ids?: string[];
  component_plan?: LessonAuthorComponentPlan[];
}

export interface LessonAuthorLessonProposal {
  title: string;
  units: LessonAuthorUnitProposal[];
  source_refs?: string[];
}

export interface LessonAuthorChapterProposal {
  title: string;
  lessons: LessonAuthorLessonProposal[];
  source_refs?: string[];
}

export interface LessonAuthorProposal {
  summary: string;
  chapters: LessonAuthorChapterProposal[];
  operation_plan?: LessonAuthorOperationPlan;
  source_evidence?: Record<string, unknown>;
}

export interface LessonAuthorOperationPlan extends LessonAuthorIntentPlan {
  target_block_id: string;
  target_path: string;
  target_display_name: string;
  target_updated_at: string;
  requested_title?: string | null;
  destination_block_id?: string | null;
  target_snapshot?: string | null;
}

export interface ApplyLessonAuthorProposalInput {
  courseId: string;
  tenantId: string;
  requestedBy: string;
  proposal: LessonAuthorProposal;
  jobId?: string;
  kbId?: string | null;
}

export interface ApplyLessonAuthorProposalResult {
  created_block_ids: string[];
  updated_block_ids: string[];
}
