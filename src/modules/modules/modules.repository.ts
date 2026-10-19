// ═══════════════════════════════════════════════════════════════
// Modules repository: the platform's feature modules. SQL only, moved
// unchanged from modules.service.ts, which keeps the rules (unique code,
// messages, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { UpdateModuleInput } from './modules.validator.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface ModulesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface ModuleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

export type CreatedModuleRow = Pick<ModuleRow, 'id' | 'code' | 'name' | 'icon' | 'sort_order'>;

export type UpdatedModuleRow = CreatedModuleRow & Pick<ModuleRow, 'is_active'>;

export type ModuleSnapshotRow = Pick<ModuleRow, 'name' | 'sort_order' | 'is_active'>;

export function createModulesRepository(db: ModulesDb) {
  return {
    async selectAll(): Promise<ModuleRow[]> {
      const result = await db.query<ModuleRow>(
        'SELECT id, code, name, description, icon, sort_order, is_active, created_at FROM modules ORDER BY sort_order',
      );
      return result.rows;
    },

    async codeExists(code: string): Promise<boolean> {
      const result = await db.query<{ id: string }>('SELECT id FROM modules WHERE code = $1', [code]);
      return result.rowCount! > 0;
    },

    async insert(values: { code: string; name: string; description: string; icon: string; sortOrder: number }): Promise<CreatedModuleRow> {
      const result = await db.query<CreatedModuleRow>(
        `INSERT INTO modules (code, name, description, icon, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, icon, sort_order`,
        [values.code, values.name, values.description, values.icon, values.sortOrder],
      );
      return result.rows[0];
    },

    async lockSnapshot(moduleId: string): Promise<QueryResult<ModuleSnapshotRow>> {
      return db.query<ModuleSnapshotRow>('SELECT name, sort_order, is_active FROM modules WHERE id = $1 FOR UPDATE', [moduleId]);
    },

    /** Sets the fields present in `input`; null when none is. */
    async update(moduleId: string, input: UpdateModuleInput): Promise<QueryResult<UpdatedModuleRow> | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
      if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
      if (input.icon !== undefined) { sets.push(`icon = $${idx++}`); params.push(input.icon); }
      if (input.sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(input.sort_order); }
      if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }

      if (sets.length === 0) return null;

      params.push(moduleId);
      return db.query<UpdatedModuleRow>(
        `UPDATE modules SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, code, name, icon, sort_order, is_active`,
        params,
      );
    },
  };
}

export type ModulesRepository = ReturnType<typeof createModulesRepository>;
