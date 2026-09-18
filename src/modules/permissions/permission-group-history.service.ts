// ═══════════════════════════════════════════════════════════════
// Permission Group History — tenant-scoped operational history.
// This is intentionally independent from the global Audit Log module.
// ═══════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { normalizeVietnameseSearchText } from './permission-group-history.search.js';

export const PERMISSION_GROUP_HISTORY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'matrix_updated',
  'members_assigned',
  'member_removed',
  'configuration_updated',
] as const;

export type PermissionGroupHistoryAction = (typeof PERMISSION_GROUP_HISTORY_ACTIONS)[number];

export interface PermissionMatrixSnapshot {
  module_code: string;
  module_name: string | null;
  module_icon: string | null;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface PermissionGroupStateSnapshot {
  group: {
    id: string;
    name: string;
    description: string;
  };
  matrix: PermissionMatrixSnapshot[];
}

export interface PermissionGroupHistoryParticipant {
  user_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  change: 'added' | 'removed' | 'reassigned';
  previous_group_id?: string | null;
  previous_group_name?: string | null;
}

export interface PermissionGroupHistoryActor {
  id: string;
  username: string;
  role: string;
}

interface HistoryEntry {
  tenantId: string;
  groupId: string;
  groupName: string;
  action: PermissionGroupHistoryAction;
  actor: PermissionGroupHistoryActor;
  beforeState?: PermissionGroupStateSnapshot | null;
  afterState?: PermissionGroupStateSnapshot | null;
  participants?: PermissionGroupHistoryParticipant[];
}

interface CursorPayload {
  version: 1;
  tenantId: string;
  createdAt: string;
  id: string;
}

const MAX_SEARCH_LENGTH = 160;
const CURSOR_VERSION = 1 as const;
// The count is display-only. A short cache keeps exact COUNT queries from
// becoming a hot path at scale while bounding cross-instance staleness.
const HISTORY_TOTAL_CACHE_TTL_MS = 10_000;
const HISTORY_TOTAL_CACHE_MAX_ENTRIES = 300;

const historyTotalCache = new Map<string, { total: number; expiresAt: number }>();
const historyTotalInFlight = new Map<string, Promise<number>>();

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function buildSearchText(groupName: string, actor: { username: string; displayName: string | null }, participants: PermissionGroupHistoryParticipant[]): string {
  return normalizeVietnameseSearchText([
    groupName,
    actor.username,
    actor.displayName,
    ...participants.flatMap((participant) => [participant.username, participant.display_name]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')).slice(0, 6000);
}

/**
 * Optional state is represented by SQL NULL, not the JSON literal `null`.
 * The history table deliberately accepts only an object when a snapshot exists.
 */
export function serializeOptionalHistoryState(
  state: PermissionGroupStateSnapshot | null | undefined,
): string | null {
  return state == null ? null : JSON.stringify(state);
}

function historyTotalCacheKey(tenantId: string, search: string, from: Date | null, to: Date | null): string {
  return [tenantId, search, from?.toISOString() || '', to?.toISOString() || ''].join('\u0001');
}

function invalidateHistoryTotalCache(tenantId: string): void {
  const prefix = `${tenantId}\u0001`;
  for (const key of historyTotalCache.keys()) {
    if (key.startsWith(prefix)) historyTotalCache.delete(key);
  }
}

async function getHistoryTotal(cacheKey: string, whereClause: string, params: unknown[]): Promise<number> {
  const now = Date.now();
  const cached = historyTotalCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.total;

  const active = historyTotalInFlight.get(cacheKey);
  if (active) return active;

  const pending = query<{ total: string }>(
    `SELECT count(*)::text AS total
     FROM permission_group_history h
     WHERE ${whereClause}`,
    params,
  ).then((result) => {
    const total = Number.parseInt(result.rows[0]?.total || '0', 10);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new AppError('Không thể đếm lịch sử nhóm quyền', 500);
    }

    if (historyTotalCache.size >= HISTORY_TOTAL_CACHE_MAX_ENTRIES) {
      const oldestKey = historyTotalCache.keys().next().value;
      if (oldestKey) historyTotalCache.delete(oldestKey);
    }
    historyTotalCache.set(cacheKey, { total, expiresAt: Date.now() + HISTORY_TOTAL_CACHE_TTL_MS });
    return total;
  }).finally(() => {
    historyTotalInFlight.delete(cacheKey);
  });

  historyTotalInFlight.set(cacheKey, pending);
  return pending;
}

async function resolveActorSnapshot(client: PoolClient, actor: PermissionGroupHistoryActor) {
  const result = await client.query<{ full_name: string | null; email: string | null; username: string | null; role: string | null }>(
    `SELECT NULLIF(btrim(full_name), '') AS full_name,
            NULLIF(lower(btrim(email)), '') AS email,
            username,
            role
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
    [actor.id],
  );
  const row = result.rows[0];
  return {
    username: cleanText(row?.username || actor.username, 150) || actor.username.slice(0, 150),
    displayName: cleanText(row?.full_name, 160),
    email: cleanText(row?.email, 254),
    role: cleanText(row?.role || actor.role, 50),
  };
}

/** Must run on the same transaction as the permission-group mutation. */
export async function appendPermissionGroupHistory(client: PoolClient, entry: HistoryEntry): Promise<void> {
  const actor = await resolveActorSnapshot(client, entry.actor);
  const participants = entry.participants || [];
  const searchText = buildSearchText(entry.groupName, actor, participants);

  await client.query(
    `INSERT INTO permission_group_history (
       tenant_id, permission_group_id, permission_group_name, action,
       actor_id, actor_username, actor_display_name, actor_email, actor_role,
       before_state, after_state, participants, search_text
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
    [
      entry.tenantId,
      entry.groupId,
      entry.groupName.slice(0, 100),
      entry.action,
      entry.actor.id,
      actor.username,
      actor.displayName,
      actor.email,
      actor.role,
      serializeOptionalHistoryState(entry.beforeState),
      serializeOptionalHistoryState(entry.afterState),
      JSON.stringify(participants),
      searchText,
    ],
  );
  invalidateHistoryTotalCache(entry.tenantId);
}

function signCursor(payload: CursorPayload): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ ...payload, signature: signCursor(payload) })).toString('base64url');
}

function decodeCursor(value: unknown, tenantId: string): CursorPayload | null {
  if (typeof value !== 'string' || !value || value.length > 800) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload & { signature?: string };
    const payload: CursorPayload = {
      version: decoded.version,
      tenantId: decoded.tenantId,
      createdAt: decoded.createdAt,
      id: decoded.id,
    };
    if (
      payload.version !== CURSOR_VERSION
      || payload.tenantId !== tenantId
      || typeof decoded.signature !== 'string'
      || !payload.id
      || Number.isNaN(Date.parse(payload.createdAt))
    ) return null;
    const actual = Buffer.from(decoded.signature);
    const expected = Buffer.from(signCursor(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(`${field} không hợp lệ`, 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(`${field} không hợp lệ`, 400);
  }
  return parsed;
}

function parsePageSize(value: unknown): number {
  const parsed = Number.parseInt(String(value || '20'), 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 10), 100);
}

/** Lightweight cursor list. Matrix and email remain detail-only. */
export async function listPermissionGroupHistory(tenantId: string, queryParams: Record<string, unknown>) {
  const pageSize = parsePageSize(queryParams.page_size);
  const search = typeof queryParams.search === 'string'
    ? normalizeVietnameseSearchText(queryParams.search.trim().slice(0, MAX_SEARCH_LENGTH))
    : '';
  const from = parseDate(queryParams.from, 'Ngày bắt đầu');
  const to = parseDate(queryParams.to, 'Ngày kết thúc');
  if (from && to && from > to) throw new AppError('Khoảng thời gian không hợp lệ', 400);

  const cursor = decodeCursor(queryParams.cursor, tenantId);
  if (queryParams.cursor && !cursor) throw new AppError('Trang lịch sử không hợp lệ', 400);

  const filterParams: unknown[] = [tenantId];
  const conditions = ['h.tenant_id = $1::uuid'];
  if (search) {
    filterParams.push(`%${search}%`);
    conditions.push(`h.search_text ILIKE $${filterParams.length}`);
  }
  if (from) {
    filterParams.push(from.toISOString());
    conditions.push(`h.created_at >= $${filterParams.length}::timestamptz`);
  }
  if (to) {
    const endExclusive = new Date(to);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    filterParams.push(endExclusive.toISOString());
    conditions.push(`h.created_at < $${filterParams.length}::timestamptz`);
  }
  const whereClause = conditions.join(' AND ');
  const params = [...filterParams];
  const pageConditions = [...conditions];
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    pageConditions.push(`(h.created_at, h.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(pageSize + 1);

  const [result, total] = await Promise.all([
    query(
    `SELECT h.id, h.permission_group_id, h.permission_group_name, h.action,
            h.actor_username, h.actor_display_name, h.actor_role,
            h.created_at
     FROM permission_group_history h
     WHERE ${pageConditions.join(' AND ')}
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT $${params.length}`,
    params,
    ),
    getHistoryTotal(historyTotalCacheKey(tenantId, search, from, to), whereClause, filterParams),
  ]);

  const hasMore = result.rows.length > pageSize;
  const data = result.rows.slice(0, pageSize);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return {
    data,
    total,
    has_more: hasMore,
    next_cursor: hasMore && last
      ? encodeCursor({ version: CURSOR_VERSION, tenantId, createdAt: new Date(last.created_at).toISOString(), id: last.id })
      : null,
  };
}

export async function getPermissionGroupHistoryDetail(historyId: string, tenantId: string) {
  const result = await query(
    `SELECT h.id, h.permission_group_id, h.permission_group_name, h.action,
            h.actor_id, h.actor_username, h.actor_display_name, h.actor_email, h.actor_role,
            h.before_state, h.after_state, h.participants, h.created_at
     FROM permission_group_history h
     WHERE h.id = $1::uuid AND h.tenant_id = $2::uuid`,
    [historyId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Lịch sử nhóm quyền không tồn tại', 404);
  return result.rows[0];
}
