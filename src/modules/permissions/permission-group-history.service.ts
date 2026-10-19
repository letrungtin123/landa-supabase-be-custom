// ═══════════════════════════════════════════════════════════════
// Permission Group History — tenant-scoped operational history.
// This is intentionally independent from the global Audit Log module.
// ═══════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../../config/env.js';
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { normalizeVietnameseSearchText } from './permission-group-history.search.js';
import {
  createPermissionGroupHistoryRepository,
  historyFilterSql,
  type PermissionGroupHistoryDb,
} from './permission-group-history.repository.js';

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
const historyRepository = createPermissionGroupHistoryRepository({ query } satisfies PermissionGroupHistoryDb);
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

async function getHistoryTotal(cacheKey: string, conditions: string[], params: unknown[]): Promise<number> {
  const now = Date.now();
  const cached = historyTotalCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.total;

  const active = historyTotalInFlight.get(cacheKey);
  if (active) return active;

  const pending = historyRepository.countHistory(conditions, params).then((counted) => {
    const total = Number.parseInt(counted || '0', 10);
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
  const row = await createPermissionGroupHistoryRepository(client).selectActorSnapshot(actor.id);
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

  await createPermissionGroupHistoryRepository(client).insertHistory({
    tenantId: entry.tenantId,
    groupId: entry.groupId,
    groupName: entry.groupName.slice(0, 100),
    action: entry.action,
    actorId: entry.actor.id,
    actorUsername: actor.username,
    actorDisplayName: actor.displayName,
    actorEmail: actor.email,
    actorRole: actor.role,
    beforeState: serializeOptionalHistoryState(entry.beforeState),
    afterState: serializeOptionalHistoryState(entry.afterState),
    participants: JSON.stringify(participants),
    searchText,
  });
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

  const filter = historyFilterSql({ tenantId, search, from, to });

  const [rows, total] = await Promise.all([
    historyRepository.selectHistoryPage(filter, cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null, pageSize + 1),
    getHistoryTotal(historyTotalCacheKey(tenantId, search, from, to), filter.conditions, filter.params),
  ]);

  const hasMore = rows.length > pageSize;
  const data = rows.slice(0, pageSize);
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
  const result = await historyRepository.selectHistoryDetail(historyId, tenantId);
  if (result.rowCount === 0) throw new AppError('Lịch sử nhóm quyền không tồn tại', 404);
  return result.rows[0];
}
