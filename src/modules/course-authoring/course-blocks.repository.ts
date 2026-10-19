// ═══════════════════════════════════════════════════════════════
// Course blocks repository: the outline tree, one block, block creation and
// edits, the draft flags of ancestors, publish and discard of a subtree,
// child order, the author-notes reads and the course rows course authoring
// creates or renames. SQL only; moved unchanged from
// course-authoring.service.ts (and the course INSERT from the controller),
// which keep the rules, caches and messages.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import { COURSE_AUTHOR_NOTES_KEY, preserveAuthorNotesSql, withoutServerOwnedAuthorNotes } from './course-author-notes.logic.js';
import type { BlockInfo, UnitChild } from './course-authoring.types.js';

/** The pool query() (joins the current transaction). */
export interface CourseAuthoringDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Upper bound of blocks returned by one author-notes read. */
export const COURSE_AUTHOR_NOTES_MAX_BLOCKS = 10_000;

export interface CourseNameRow {
  id: string;
  display_name: string;
}

export interface CourseTenantRow {
  id: string;
  tenant_id: string;
}

/** One active block of the outline tree (no course or parent name). */
export type OutlineBlockRow = Omit<BlockInfo, 'course_name' | 'parent_name'>;

export interface AuthorNotesCourseRow {
  id: string;
  display_name: string;
  description: string | null;
}

export interface AuthorNotesBlockRow {
  id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  notes: unknown;
}

export interface CourseAuditContextRow {
  course_id: string;
  course_name: string;
}

export interface BlockFieldUpdates {
  display_name?: string;
  data?: unknown;
  metadata?: unknown;
  is_published?: boolean;
}

export interface PendingQuizBlockRow {
  display_name: string;
  data: any;
}

export interface PendingImageChoiceQuizBlockRow extends PendingQuizBlockRow {
  course_id: string;
  tenant_id: string;
}

export interface NewCourseRow {
  courseId: string;
  tenantId: string;
  displayName: string;
  description: string;
  org: string;
  startDate: string;
  createdBy: string;
}

export function createCourseBlocksRepository(db: CourseAuthoringDb) {
  return {
    /** The tenant's course (not deleted), with its name. */
    async selectTenantCourse(courseId: string, tenantId: string): Promise<CourseNameRow | undefined> {
      const result = await db.query<CourseNameRow>(
        `SELECT id, display_name FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** Every active block of the course in one query (a deleted ancestor hides its subtree). */
    async selectActiveOutlineBlocks(courseId: string): Promise<OutlineBlockRow[]> {
      const result = await db.query<OutlineBlockRow>(
        `WITH RECURSIVE active_tree AS (
       SELECT id, course_id, parent_id, block_type, display_name,
              data, metadata, sort_order, is_published, has_draft_changes,
              created_at, updated_at
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.course_id, child.parent_id, child.block_type, child.display_name,
              child.data, child.metadata, child.sort_order, child.is_published, child.has_draft_changes,
              child.created_at, child.updated_at
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL
     )
     SELECT id, course_id, parent_id, block_type, display_name,
            data, metadata, sort_order, is_published, has_draft_changes,
            created_at, updated_at
     FROM active_tree
     ORDER BY sort_order ASC, created_at ASC`,
        [courseId],
      );
      return result.rows;
    },

    /** The course (not deleted) with its tenant; any tenant when tenantId is null. */
    async selectCourseTenant(courseId: string, tenantId: string | null): Promise<CourseTenantRow | undefined> {
      const result = await db.query<CourseTenantRow>(
        `SELECT id, tenant_id
       FROM courses
      WHERE id = $1
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
        AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** The next sort order under the parent (or at the root of the course). */
    async selectNextSortOrder(courseId: string, parentId: string | null): Promise<number | undefined> {
      const result = await db.query<{ max_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_order
     FROM course_blocks WHERE course_id = $1 AND deleted_at IS NULL AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}`,
        parentId ? [courseId, parentId] : [courseId],
      );
      return result.rows[0]?.max_order;
    },

    async insertBlock(
      courseId: string,
      parentId: string | null,
      blockType: string,
      displayName: string,
      data: unknown,
      metadata: Record<string, unknown>,
      sortOrder: number,
    ): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO course_blocks (course_id, parent_id, block_type, display_name, data, metadata, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
        [courseId, parentId, blockType, displayName, JSON.stringify(data), metadata, sortOrder],
      );
      return result.rows[0].id;
    },

    /** One active block with its course and parent names; any tenant when tenantId is null. */
    async selectBlockInfo(blockId: string, tenantId: string | null): Promise<BlockInfo | undefined> {
      const result = await db.query<BlockInfo>(
        `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.course_id, c.display_name AS course_name,
            b.parent_id, parent.display_name AS parent_name,
            b.block_type, b.display_name,
            b.data, b.metadata, b.sort_order, b.is_published, b.has_draft_changes,
            b.created_at, b.updated_at
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     LEFT JOIN course_blocks parent ON parent.id = b.parent_id AND parent.deleted_at IS NULL
     WHERE b.id = $1
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND ($2::uuid IS NULL OR c.tenant_id = $2::uuid)
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
        [blockId, tenantId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    async selectAuthorNotesCourse(courseId: string, tenantId: string): Promise<AuthorNotesCourseRow | undefined> {
      const result = await db.query<AuthorNotesCourseRow>(
        `SELECT id, display_name, description FROM courses WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** The blocks of the active outline that carry author notes, in presentation order. */
    async selectAuthorNotesBlocks(courseId: string): Promise<AuthorNotesBlockRow[]> {
      const result = await db.query<AuthorNotesBlockRow>(
        `WITH RECURSIVE tree AS (
       SELECT b.id, b.parent_id, b.block_type::text AS block_type, b.display_name, b.metadata,
              ARRAY[b.sort_order, 0]::bigint[] AS path, b.id::text AS tie
       FROM course_blocks b
       WHERE b.course_id = $1 AND b.parent_id IS NULL AND b.block_type = 'course' AND b.deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type::text, child.display_name, child.metadata,
              tree.path || ARRAY[child.sort_order::bigint, 0], tree.tie || '/' || child.id::text
       FROM course_blocks child JOIN tree ON child.parent_id = tree.id
       WHERE child.course_id = $1 AND child.deleted_at IS NULL
     )
     SELECT id::text AS id, parent_id::text AS parent_id, block_type, display_name,
            metadata->'${COURSE_AUTHOR_NOTES_KEY}' AS notes
     FROM tree
     WHERE jsonb_typeof(metadata) = 'object' AND metadata ? '${COURSE_AUTHOR_NOTES_KEY}'
     ORDER BY path, tie
     LIMIT ${COURSE_AUTHOR_NOTES_MAX_BLOCKS}`,
        [courseId],
      );
      return result.rows;
    },

    /** The oldest active root block of the course. */
    async selectCourseRootId(courseId: string): Promise<string | undefined> {
      const result = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM course_blocks WHERE course_id = $1 AND parent_id IS NULL AND block_type = 'course' AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
        [courseId],
      );
      return result.rows[0]?.id;
    },

    async selectCourseAuditContext(courseId: string): Promise<CourseAuditContextRow | undefined> {
      const result = await db.query<CourseAuditContextRow>(
        `SELECT id AS course_id, display_name AS course_name
       FROM courses
      WHERE id = $1 AND deleted_at IS NULL`,
        [courseId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /**
     * Writes the given fields of an active block. Metadata replaces the editable
     * keys; AI ID author notes are server-owned and carried over. Publishing
     * clears the draft flag, any other edit sets it.
     */
    async updateBlockFields(blockId: string, updates: BlockFieldUpdates): Promise<BlockInfo | undefined> {
      const setClauses: string[] = ['updated_at = now()'];
      const params: any[] = [blockId];
      let paramIdx = 2;

      if (updates.display_name !== undefined) {
        setClauses.push(`display_name = $${paramIdx++}`);
        params.push(updates.display_name);
      }
      if (updates.data !== undefined) {
        setClauses.push(`data = $${paramIdx++}`);
        params.push(JSON.stringify(updates.data));
      }
      if (updates.metadata !== undefined) {
        // Metadata PATCH replaces the editable keys (an outline rename sends only
        // {display_name}), but AI ID author notes are server-owned: a browser can
        // neither forge nor delete them, and the stored value is carried over.
        setClauses.push(updates.metadata === null ? `metadata = $${paramIdx++}` : `metadata = ${preserveAuthorNotesSql(`$${paramIdx++}`)}`);
        params.push(updates.metadata === null ? null : JSON.stringify(withoutServerOwnedAuthorNotes(updates.metadata)));
      }
      if (updates.is_published !== undefined) {
        setClauses.push(`is_published = $${paramIdx++}`);
        params.push(updates.is_published);
        // Publish → clear draft flag; unpublish → mark as draft
        setClauses.push(`has_draft_changes = ${updates.is_published ? 'false' : 'true'}`);
      } else {
        // Editing content → mark as draft
        setClauses.push('has_draft_changes = true');
      }

      const result = await db.query<BlockInfo>(
        `UPDATE course_blocks SET ${setClauses.join(', ')} WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, course_id, parent_id, block_type, display_name,
               data, metadata, sort_order, is_published, has_draft_changes,
               created_at, updated_at`,
        params,
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** Renames the course (not deleted); its tenant, or undefined when no row changed. */
    async updateCourseDisplayName(displayName: string, courseId: string): Promise<string | undefined> {
      const result = await db.query<{ tenant_id: string }>(
        `UPDATE courses
       SET display_name = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING tenant_id`,
        [displayName, courseId],
      );
      return result.rows[0]?.tenant_id;
    },

    /** has_draft_changes = true on every active ancestor, in one recursive query. */
    async markAncestorsDirty(blockId: string): Promise<void> {
      await db.query(
        `WITH RECURSIVE ancestors AS (
       SELECT parent_id FROM course_blocks WHERE id = $1 AND parent_id IS NOT NULL AND deleted_at IS NULL
       UNION ALL
       SELECT cb.parent_id FROM course_blocks cb
       JOIN ancestors a ON cb.id = a.parent_id
       WHERE cb.parent_id IS NOT NULL AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks SET has_draft_changes = true, updated_at = now()
     WHERE id IN (SELECT parent_id FROM ancestors) AND deleted_at IS NULL`,
        [blockId],
      );
    },

    async selectParentId(blockId: string): Promise<string | null | undefined> {
      const result = await db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
        [blockId],
      );
      return result.rows[0]?.parent_id;
    },

    /** Whether any active child of the block still has draft changes. */
    async selectHasDirtyChildren(parentId: string): Promise<boolean | undefined> {
      const result = await db.query<{ has_dirty_children: boolean }>(
        `SELECT EXISTS(
         SELECT 1 FROM course_blocks
         WHERE parent_id = $1 AND has_draft_changes = true AND deleted_at IS NULL
       ) AS has_dirty_children`,
        [parentId],
      );
      return result.rows[0]?.has_dirty_children;
    },

    /** Whether the block's own draft differs from its published version. */
    async selectSelfIsDirty(blockId: string): Promise<boolean | undefined> {
      const result = await db.query<{ self_is_dirty: boolean }>(
        `SELECT (data IS DISTINCT FROM published_data OR metadata IS DISTINCT FROM published_metadata)
         AS self_is_dirty
       FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
        [blockId],
      );
      return result.rows[0]?.self_is_dirty;
    },

    async clearDraftFlag(blockId: string): Promise<void> {
      await db.query(
        `UPDATE course_blocks SET has_draft_changes = false, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
        [blockId],
      );
    },

    /** The block and every active descendant. */
    async selectDescendantIds(blockId: string): Promise<string[]> {
      const result = await db.query<{ id: string }>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id
       FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT id FROM descendants`,
        [blockId],
      );
      return result.rows.map((row) => row.id);
    },

    /** Media quizzes of the subtree that a publish would change. */
    async selectPendingMediaQuizBlocks(blockId: string): Promise<PendingQuizBlockRow[]> {
      const result = await db.query<PendingQuizBlockRow>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT display_name, data
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND block_type = 'la_media_quiz'
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
        [blockId],
      );
      return result.rows;
    },

    /** Image-choice questions of the subtree that a publish would change, with their course tenant. */
    async selectPendingImageChoiceQuizBlocks(blockId: string): Promise<PendingImageChoiceQuizBlockRow[]> {
      const result = await db.query<PendingImageChoiceQuizBlockRow>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT cb.display_name, cb.data, cb.course_id, c.tenant_id
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id IN (SELECT id FROM descendants)
       AND cb.block_type::text = 'la_image_choice_quiz'
       AND cb.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND (
         cb.has_draft_changes = true OR
         cb.data IS DISTINCT FROM cb.published_data OR
         cb.metadata IS DISTINCT FROM cb.published_metadata OR
         cb.is_published = false
       )`,
        [blockId],
      );
      return result.rows;
    },

    /** Scenario conversations of the subtree that a publish would change. */
    async selectPendingScenarioChatBlocks(blockId: string): Promise<PendingQuizBlockRow[]> {
      const result = await db.query<PendingQuizBlockRow>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT display_name, data
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND block_type::text = 'la_scenario_chat'
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
        [blockId],
      );
      return result.rows;
    },

    /** Publishes the block and every changed descendant: draft → published copy. */
    async publishSubtree(blockId: string): Promise<void> {
      await db.query(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET is_published = true,
         has_draft_changes = false,
         published_data = data,
         published_metadata = metadata,
         updated_at = now()
     WHERE id IN (SELECT id FROM descendants)
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
        [blockId],
      );
    },

    /** Whether the active block has a published version. */
    async selectHasPublishedVersion(blockId: string): Promise<boolean | undefined> {
      const result = await db.query<{ has_pub: boolean }>(
        `SELECT published_data IS NOT NULL AS has_pub
     FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
        [blockId],
      );
      return result.rows[0]?.has_pub;
    },

    /** Discard: every changed, once-published block of the subtree goes back to its published copy. */
    async restorePublishedSubtree(blockId: string): Promise<void> {
      await db.query(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET data = published_data,
         metadata = published_metadata,
         has_draft_changes = false,
         updated_at = now()
     WHERE id IN (SELECT id FROM descendants)
       AND deleted_at IS NULL
       AND published_data IS NOT NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata
       )`,
        [blockId],
      );
    },

    /** The ancestors of every block of the subtree still in draft get the draft flag again. */
    async markAncestorsOfDirtySubtreeBlocks(blockId: string): Promise<void> {
      await db.query(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     ),
     dirty_nodes AS (
       SELECT id, parent_id
       FROM course_blocks
       WHERE id IN (SELECT id FROM descendants)
         AND has_draft_changes = true
         AND deleted_at IS NULL
     ),
     dirty_ancestors AS (
       SELECT parent_id AS id
       FROM dirty_nodes
       WHERE parent_id IS NOT NULL
       UNION
       SELECT cb.parent_id AS id
       FROM course_blocks cb
       JOIN dirty_ancestors da ON cb.id = da.id
       WHERE cb.parent_id IS NOT NULL
         AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET has_draft_changes = true,
         updated_at = now()
     WHERE id IN (SELECT id FROM dirty_ancestors WHERE id IS NOT NULL)
       AND deleted_at IS NULL`,
        [blockId],
      );
    },

    /** New sort orders for children of the parent, in the given order (ids already validated as UUIDs). */
    async updateChildOrder(parentId: string, childIds: string[]): Promise<void> {
      // Parameterized VALUES — $1 = parentId, $2/$3 = id/order pairs
      const params: unknown[] = [parentId];
      const valuesList = childIds.map((id, i) => {
        params.push(id, i);
        return `($${params.length - 1}::uuid, $${params.length}::int)`;
      }).join(', ');

      await db.query(
        `UPDATE course_blocks AS cb SET
       sort_order = v.new_order,
       updated_at = now()
     FROM (VALUES ${valuesList}) AS v(block_id, new_order)
     WHERE cb.id = v.block_id AND cb.parent_id = $1 AND cb.deleted_at IS NULL`,
        params,
      );
    },

    async selectUnitChildren(unitId: string): Promise<UnitChild[]> {
      const result = await db.query<UnitChild>(
        `SELECT id, id AS block_id, display_name, block_type,
            has_draft_changes AS has_changes, is_published AS published
     FROM course_blocks
     WHERE parent_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
        [unitId],
      );
      return result.rows;
    },

    /** The root 'course' block of a new course (kept when it exists). */
    async insertCourseRootBlock(courseId: string, displayName: string): Promise<void> {
      await db.query(
        `INSERT INTO course_blocks (course_id, block_type, display_name, is_published, has_draft_changes)
     VALUES ($1, 'course', $2, true, false)
     ON CONFLICT DO NOTHING`,
        [courseId, displayName],
      );
    },

    /** A new course of the tenant; its creator is also its mentor. */
    async insertCourse(course: NewCourseRow): Promise<void> {
      await db.query(
        `INSERT INTO courses (id, tenant_id, display_name, description, org, start_date, created_by, mentor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [course.courseId, course.tenantId, course.displayName, course.description, course.org, course.startDate, course.createdBy],
      );
    },
  };
}

export type CourseBlocksRepository = ReturnType<typeof createCourseBlocksRepository>;
