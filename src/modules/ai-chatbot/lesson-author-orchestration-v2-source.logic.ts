import { createHash } from 'node:crypto';

export const ORCHESTRATION_V2_SOURCE_PAGE_SIZE = 500;
export const ORCHESTRATION_V2_FACT_MAX_BYTES = 32_768;

export interface SourceFactCandidateV2 {
  document_id: string;
  fact_key: string;
  scope_key: string;
  fact_text: string;
  source_ref?: string | null;
  source_page?: number | null;
  source_chunk?: number | null;
  locator?: Record<string, unknown>;
}

export interface SourceFactRowV2 extends SourceFactCandidateV2 {
  ordinal: number;
  fact_hash: string;
  locator: Record<string, unknown>;
}

export class SourceFactV2Error extends Error {
  constructor(readonly code:
    | 'SOURCE_FACT_PAGE_INVALID'
    | 'SOURCE_FACT_PAGE_TOO_LARGE'
    | 'SOURCE_FACT_IDENTITY_DUPLICATE') {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function normalizeSourceFactPageV2(startOrdinal: number, facts: readonly SourceFactCandidateV2[]): SourceFactRowV2[] {
  if (!Number.isSafeInteger(startOrdinal) || startOrdinal < 0 || !Array.isArray(facts) || facts.length < 1) {
    throw new SourceFactV2Error('SOURCE_FACT_PAGE_INVALID');
  }
  if (facts.length > ORCHESTRATION_V2_SOURCE_PAGE_SIZE) throw new SourceFactV2Error('SOURCE_FACT_PAGE_TOO_LARGE');
  const factKeys = new Set<string>();
  return facts.map((fact, index) => {
    const locator = fact.locator ?? {};
    const locatorBytes = byteLength(JSON.stringify(locator));
    if (!fact || !UUID.test(fact.document_id) || typeof fact.fact_key !== 'string' || !fact.fact_key.trim()
      || typeof fact.scope_key !== 'string' || !fact.scope_key.trim() || typeof fact.fact_text !== 'string'
      || byteLength(fact.fact_text) < 1 || byteLength(fact.fact_text) > ORCHESTRATION_V2_FACT_MAX_BYTES
      || locator === null || Array.isArray(locator) || typeof locator !== 'object' || locatorBytes > 4_096
      || (fact.source_page != null && (!Number.isSafeInteger(fact.source_page) || fact.source_page < 1))
      || (fact.source_chunk != null && (!Number.isSafeInteger(fact.source_chunk) || fact.source_chunk < 0))) {
      throw new SourceFactV2Error('SOURCE_FACT_PAGE_INVALID');
    }
    const key = fact.fact_key.trim();
    if (factKeys.has(key)) throw new SourceFactV2Error('SOURCE_FACT_IDENTITY_DUPLICATE');
    factKeys.add(key);
    return Object.freeze({
      ...fact,
      fact_key: key,
      scope_key: fact.scope_key.trim(),
      source_ref: fact.source_ref?.trim() || null,
      source_page: fact.source_page ?? null,
      source_chunk: fact.source_chunk ?? null,
      ordinal: startOrdinal + index,
      fact_hash: sha256(fact.fact_text),
      locator: Object.freeze({ ...locator }),
    });
  });
}

export function sourceFactPageDigestV2(rows: readonly SourceFactRowV2[]): string {
  if (!rows.length) throw new SourceFactV2Error('SOURCE_FACT_PAGE_INVALID');
  return sha256(JSON.stringify(rows.map(row => [row.ordinal, row.fact_key, row.scope_key, row.fact_hash, row.document_id])));
}
