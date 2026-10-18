// Monthly chart of one year grouped by org unit (the legacy chart without a
// date range): one series per company, branch or department, keyed by name.

import type { ReportChartPoint } from './reports.service.js';

export type OrgChartDimension = 'group' | 'subgroup' | 'team';

export interface OrgChartEntity {
  id: string;
  name: string;
}

/** Value of one unit in one month (1-12), from the grouped query. */
export interface OrgChartMonthValue {
  entityId: string;
  month: number;
  value: number;
}

/**
 * Twelve points (T1..T12), one property per unit name, 0 after `maxMonth`.
 * Units are visited in the order of `entities` (the unit list query's order)
 * and a unit takes the values of the LAST unit with the same name, exactly as
 * the former one-query-per-unit loop did.
 */
export function buildOrgUnitChartPoints(
  entities: readonly OrgChartEntity[],
  values: readonly OrgChartMonthValue[],
  maxMonth: number,
  monthLabels: readonly string[],
): ReportChartPoint[] {
  const valuesByEntity = new Map<string, Map<number, number>>();
  for (const item of values) {
    const months = valuesByEntity.get(item.entityId) ?? new Map<number, number>();
    months.set(item.month, item.value);
    valuesByEntity.set(item.entityId, months);
  }
  const valuesByName = new Map<string, Map<number, number>>();
  for (const entity of entities) valuesByName.set(entity.name, valuesByEntity.get(entity.id) ?? new Map());

  const data: ReportChartPoint[] = [];
  for (let month = 1; month <= 12; month++) {
    const point: ReportChartPoint = { month: `T${month}`, month_label: monthLabels[month] };
    for (const entity of entities) {
      point[entity.name] = month > maxMonth ? 0 : (valuesByName.get(entity.name)?.get(month) ?? 0);
    }
    data.push(point);
  }
  return data;
}
