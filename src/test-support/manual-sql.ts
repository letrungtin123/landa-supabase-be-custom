import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// SQL contract tests read the reviewed SQL files of the supabase repo, which
// is checked out next to landa-backend (../supabase/manual_sql). A clone of
// this repository alone (CI) does not have that folder: the tests that need
// it are skipped with this reason instead of failing. With the folder
// present, a missing or changed SQL file still fails its test.
const directory = new URL('../../../supabase/manual_sql/', import.meta.url);

export const MANUAL_SQL_DIRECTORY = fileURLToPath(directory);

/** `{ skip: manualSqlSkip }` for a test that reads ../supabase/manual_sql. */
export const manualSqlSkip: string | false = existsSync(directory)
  ? false
  : `needs ${MANUAL_SQL_DIRECTORY} (the supabase repo next to landa-backend), which is not checked out here`;

/** A file of ../supabase/manual_sql; '' when the folder is absent, so a test file still loads and its SQL tests skip. */
export function readManualSql(fileName: string): string {
  return manualSqlSkip ? '' : readFileSync(new URL(fileName, directory), 'utf8');
}
