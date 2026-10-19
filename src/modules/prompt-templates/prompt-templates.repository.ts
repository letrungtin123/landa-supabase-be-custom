// ═══════════════════════════════════════════════════════════════
// Prompt templates repository: the platform's mascot templates
// (system_prompt_templates). SQL only, moved unchanged from
// prompt-templates.service.ts, which keeps the rules (active limit, the
// single lesson author template and its advisory locks, Storage uploads and
// cleanup, messages, transactions).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface PromptTemplatesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface PromptTemplateRow {
  id: string;
  name: string;
  description: string;
  prompt: string;
  voice_prompt: string | null;
  avatar_url: string | null;
  fullbody_url: string | null;
  is_active: boolean;
  is_lesson_author: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type PromptTemplateCardRow = Pick<PromptTemplateRow, 'id' | 'name' | 'description' | 'avatar_url' | 'fullbody_url' | 'sort_order'>;

export type PromptTemplateImageColumn = 'avatar_url' | 'fullbody_url';

export function createPromptTemplatesRepository(db: PromptTemplatesDb) {
  return {
    async selectAll(): Promise<PromptTemplateRow[]> {
      const result = await db.query<PromptTemplateRow>(
        `SELECT * FROM system_prompt_templates ORDER BY sort_order ASC, created_at ASC`,
      );
      return result.rows;
    },

    async selectById(id: string): Promise<PromptTemplateRow | undefined> {
      const result = await db.query<PromptTemplateRow>(`SELECT * FROM system_prompt_templates WHERE id = $1`, [id]);
      return result.rows[0];
    },

    /** Active mascots that are not the lesson author template. */
    async countActive(): Promise<string | undefined> {
      const result = await db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM system_prompt_templates
         WHERE is_active = true AND is_lesson_author = false`,
      );
      return result.rows[0]?.cnt;
    },

    /** Display fields of the first `limit` active mascots (not the lesson author template). */
    async selectActiveCards(limit: number): Promise<PromptTemplateCardRow[]> {
      const result = await db.query<PromptTemplateCardRow>(
        `SELECT id, name, description, avatar_url, fullbody_url, sort_order
         FROM system_prompt_templates
         WHERE is_active = true AND is_lesson_author = false
         ORDER BY sort_order ASC, created_at ASC
         LIMIT ${limit}`,
      );
      return result.rows;
    },

    async selectLessonAuthor(): Promise<PromptTemplateRow | undefined> {
      const result = await db.query<PromptTemplateRow>(
        `SELECT *
         FROM system_prompt_templates
         WHERE is_lesson_author = true
         LIMIT 1`,
      );
      return result.rows[0];
    },

    /** Transaction advisory lock on a named key (hashtext). */
    async advisoryLock(key: string): Promise<void> {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
    },

    async lockById(id: string): Promise<PromptTemplateRow | undefined> {
      const result = await db.query<PromptTemplateRow>(`SELECT * FROM system_prompt_templates WHERE id = $1 FOR UPDATE`, [id]);
      return result.rows[0];
    },

    /** Clears the lesson author flag of every template but `keepId`. */
    async clearOtherLessonAuthors(keepId: string): Promise<void> {
      await db.query(
        `UPDATE system_prompt_templates
         SET is_lesson_author = false, updated_at = now()
         WHERE is_lesson_author = true AND id <> $1`,
        [keepId],
      );
    },

    /** Sets the lesson author flag; turning it on also turns the mascot off. */
    async setLessonAuthor(id: string, enabled: boolean): Promise<PromptTemplateRow | undefined> {
      const result = await db.query<PromptTemplateRow>(
        `UPDATE system_prompt_templates
         SET is_lesson_author = $2,
             is_active = CASE WHEN $2 = true THEN false ELSE is_active END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, enabled],
      );
      return result.rows[0];
    },

    async insert(values: {
      name: string;
      description: string;
      prompt: string;
      voicePrompt: string | null;
      isActive: boolean;
      sortOrder: number;
      createdBy: string;
    }): Promise<PromptTemplateRow> {
      const result = await db.query<PromptTemplateRow>(
        `INSERT INTO system_prompt_templates (name, description, prompt, voice_prompt, is_active, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [values.name, values.description, values.prompt, values.voicePrompt, values.isActive, values.sortOrder, values.createdBy],
      );
      return result.rows[0];
    },

    /** Sets the given columns, in order, and updated_at. */
    async update(id: string, columns: Array<[string, unknown]>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const [column, value] of columns) {
        sets.push(`${column} = $${idx++}`);
        params.push(value);
      }
      sets.push('updated_at = now()');
      params.push(id);
      await db.query<PromptTemplateRow>(
        `UPDATE system_prompt_templates SET ${sets.join(', ')} WHERE id = $${idx++} RETURNING *`,
        params,
      );
    },

    async lockImages(id: string): Promise<QueryResult<Pick<PromptTemplateRow, 'avatar_url' | 'fullbody_url'>>> {
      return db.query<Pick<PromptTemplateRow, 'avatar_url' | 'fullbody_url'>>(
        'SELECT avatar_url, fullbody_url FROM system_prompt_templates WHERE id = $1 FOR UPDATE',
        [id],
      );
    },

    async delete(id: string): Promise<void> {
      await db.query('DELETE FROM system_prompt_templates WHERE id = $1', [id]);
    },

    async lockImage(id: string, column: PromptTemplateImageColumn): Promise<QueryResult<Record<PromptTemplateImageColumn, string | null>>> {
      return db.query<Record<PromptTemplateImageColumn, string | null>>(
        `SELECT ${column} FROM system_prompt_templates WHERE id = $1 FOR UPDATE`,
        [id],
      );
    },

    async setImage(id: string, column: PromptTemplateImageColumn, storagePath: string): Promise<PromptTemplateRow | undefined> {
      const result = await db.query<PromptTemplateRow>(
        `UPDATE system_prompt_templates SET ${column} = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [storagePath, id],
      );
      return result.rows[0];
    },
  };
}

export type PromptTemplatesRepository = ReturnType<typeof createPromptTemplatesRepository>;
