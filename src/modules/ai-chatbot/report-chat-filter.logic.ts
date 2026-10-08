// Validation of `report_filters` sent by the dashboard filter editor and the
// clarification chips. Pure, so the controller only maps the result to a
// localized `[status, vi, en]` response.

import { z } from 'zod';
import type { ReportChatFilterInput } from './report-chat.service.js';
import { MAX_REPORT_RANGE_DAYS, dayCountBetween, parseYmd } from './report-date.logic.js';
import {
  REPORT_FILTERS_INVALID_CODE,
  REPORT_FILTER_DATE_INVALID_CODE,
  REPORT_FILTER_RANGE_INCOMPLETE_CODE,
  REPORT_FILTER_RANGE_REVERSED_CODE,
  REPORT_FILTER_RANGE_TOO_LONG_CODE,
  REPORT_FILTER_UNIT_INVALID_CODE,
  type ReportChatErrorCode,
} from './report-chat-error.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FilterShape = z.object({
  date_from: z.unknown().optional(),
  date_to: z.unknown().optional(),
  group_id: z.unknown().optional(),
  subgroup_id: z.unknown().optional(),
  team_id: z.unknown().optional(),
});

export type ReportFilterParseResult =
  | { ok: true; value: ReportChatFilterInput | undefined }
  | { ok: false; code: ReportChatErrorCode };

export function parseReportFilters(value: unknown): ReportFilterParseResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: REPORT_FILTERS_INVALID_CODE };
  const shape = FilterShape.safeParse(value);
  if (!shape.success) return { ok: false, code: REPORT_FILTERS_INVALID_CODE };
  const input = shape.data;

  const dates: Partial<Record<'date_from' | 'date_to', string>> = {};
  for (const key of ['date_from', 'date_to'] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || !parseYmd(raw)) return { ok: false, code: REPORT_FILTER_DATE_INVALID_CODE };
    dates[key] = raw;
  }
  if (Boolean(dates.date_from) !== Boolean(dates.date_to)) return { ok: false, code: REPORT_FILTER_RANGE_INCOMPLETE_CODE };
  if (dates.date_from && dates.date_to) {
    if (dates.date_from > dates.date_to) return { ok: false, code: REPORT_FILTER_RANGE_REVERSED_CODE };
    if (dayCountBetween(dates.date_from, dates.date_to) > MAX_REPORT_RANGE_DAYS) return { ok: false, code: REPORT_FILTER_RANGE_TOO_LONG_CODE };
  }

  const ids: Partial<Record<'group_id' | 'subgroup_id' | 'team_id', string>> = {};
  for (const key of ['group_id', 'subgroup_id', 'team_id'] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '' || raw === 'all') continue;
    if (typeof raw !== 'string' || !UUID.test(raw)) return { ok: false, code: REPORT_FILTER_UNIT_INVALID_CODE };
    ids[key] = raw;
  }
  return { ok: true, value: { ...dates, ...ids } };
}
