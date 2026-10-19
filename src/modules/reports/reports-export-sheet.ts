// Workbook building blocks of the report exports: columns, colors and borders,
// period labels, number and status formatting, the worksheet chrome and the
// sheet writer that continues on a new sheet at Excel's row limit. Moved
// unchanged from reports-export.service.ts, which writes the workbook.

import ExcelJS from 'exceljs';
import type { HierarchyTrendRow } from './reports-export.repository.js';
import {
  type ReportExcelExportOptions,
  type ReportExcelLocale,
  getReportExcelCopy,
} from './reports-export-copy.logic.js';

export type ColumnDef = {
  header: string;
  key: string;
  width: number;
};

const EXCEL_MAX_ROWS = 1_048_576;

export const COLORS = {
  navy: 'FF0F172A',
  blue: 'FF2563EB',
  blueSoft: 'FFEFF6FF',
  indigo: 'FF4F46E5',
  emerald: 'FF059669',
  emeraldSoft: 'FFE8FFF6',
  amber: 'FFD97706',
  amberSoft: 'FFFFF7E6',
  slate: 'FF64748B',
  slateSoft: 'FFF8FAFC',
  red: 'FFDC2626',
  white: 'FFFFFFFF',
  border: 'FFD8E1EE',
  headerBg: 'FF1E293B',
};

export const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: COLORS.border } },
  left: { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'thin', color: { argb: COLORS.border } },
  right: { style: 'thin', color: { argb: COLORS.border } },
};

export function getMonthRange(year: number, month: number): { startDate: Date; endDate: Date } {
  return {
    startDate: new Date(year, month - 1, 1),
    endDate: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

function getPeriodRange(year: number, month?: number): { startDate: Date; endDate: Date } {
  if (month) return getMonthRange(year, month);
  return {
    startDate: new Date(year, 0, 1),
    endDate: new Date(year, 11, 31, 23, 59, 59, 999),
  };
}



export function getExportPeriodRange(options: ReportExcelExportOptions): { startDate: Date; endDate: Date } {
  if (options.dateRange) return options.dateRange;
  return getPeriodRange(options.year, options.month);
}



export function getExportPeriodLabel(options: ReportExcelExportOptions): string {
  const copy = getReportExcelCopy(options.locale);
  if (options.dateRange) {
    return `${formatExportDate(options.dateRange.dateFrom, options.locale)} ${copy.dateRangeSeparator} ${formatExportDate(options.dateRange.dateTo, options.locale)}`;
  }
  return options.month ? `${copy.months[options.month]}/${options.year}` : `${copy.year} ${options.year}`;
}

function formatExportDate(value: string, locale: ReportExcelLocale): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function dateTimeNumberFormat(locale: ReportExcelLocale): string {
  return locale === 'en' ? 'dd mmm yyyy hh:mm' : 'dd/mm/yyyy hh:mm';
}

export function formatHierarchyPeriodLabel(item: HierarchyTrendRow, locale: ReportExcelLocale): string {
  const copy = getReportExcelCopy(locale);
  const month = Number(item.period_month);
  const year = Number(item.period_year);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return '';
  return locale === 'en' ? `${copy.months[month]} ${year}` : `${copy.months[month]}/${year}`;
}

export function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function roundPercent(value: unknown): number {
  return Math.round(Math.min(Math.max(toNumber(value), 0), 100) * 100) / 100;
}

export function statusText(status: string, locale: ReportExcelLocale): string {
  const statuses = getReportExcelCopy(locale).statuses;
  if (status === 'completed') return statuses.completed;
  if (status === 'learning') return statuses.learning;
  return statuses.not_started;
}

export function statusColor(status: string): string {
  if (status === 'completed') return COLORS.emerald;
  if (status === 'learning') return COLORS.amber;
  return COLORS.slate;
}

function safeSheetName(baseName: string, index?: number): string {
  const suffix = index && index > 1 ? ` ${index}` : '';
  return `${baseName}${suffix}`.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31);
}

export function lowerLabel(label: string, locale: ReportExcelLocale): string {
  return label.trim().toLocaleLowerCase(locale === 'en' ? 'en-US' : 'vi-VN');
}

export function addStyledRow(
  worksheet: ExcelJS.Worksheet,
  values: unknown[],
  colCount: number,
  style: 'title' | 'subtitle' | 'header' | 'summary' | 'data' | 'spacer',
  dataIndex = 0,
): ExcelJS.Row {
  const padded = [...values, ...Array(Math.max(colCount - values.length, 0)).fill('')];
  const row = worksheet.addRow(padded);

  if (style === 'spacer') {
    row.height = 8;
    row.commit();
    return row;
  }

  row.height = style === 'title' ? 30 : style === 'header' ? 28 : 22;
  for (let i = 1; i <= colCount; i++) {
    const cell = row.getCell(i);
    cell.border = style === 'title' || style === 'subtitle' ? {} : thinBorder;
    cell.alignment = {
      vertical: 'middle',
      horizontal: style === 'header' ? 'center' : 'left',
      wrapText: style === 'header',
    };

    if (style === 'title') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
      cell.font = { name: 'Arial', size: i === 1 ? 15 : 11, bold: true, color: { argb: COLORS.white } };
    } else if (style === 'subtitle') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.blueSoft } };
      cell.font = { name: 'Arial', size: 10, italic: i === 1, color: { argb: COLORS.slate } };
    } else if (style === 'header') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.white } };
    } else if (style === 'summary') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.blueSoft } };
      cell.font = { name: 'Arial', size: 10, bold: i === 1, color: { argb: i === 1 ? COLORS.navy : COLORS.slate } };
    } else {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: dataIndex % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
  }

  row.commit();
  return row;
}

export function addWorksheetChrome(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  name: string,
  title: string,
  subtitle: string,
  columns: ColumnDef[],
): ExcelJS.Worksheet {
  const worksheet = workbook.addWorksheet(safeSheetName(name), {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { defaultRowHeight: 20 },
  });
  worksheet.columns = columns.map(col => ({ key: col.key, width: col.width }));

  addStyledRow(worksheet, [title], columns.length, 'title');
  addStyledRow(worksheet, [subtitle], columns.length, 'subtitle');
  addStyledRow(worksheet, [], columns.length, 'spacer');
  addStyledRow(worksheet, columns.map(col => col.header), columns.length, 'header');
  worksheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: columns.length },
  };

  return worksheet;
}

export class SplitWorksheetWriter {
  private worksheet: ExcelJS.Worksheet | null = null;
  private sheetIndex = 0;
  private currentRowCount = 0;
  private dataRowCount = 0;

  constructor(
    private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter,
    private readonly baseName: string,
    private readonly title: string,
    private readonly subtitle: string,
    private readonly columns: ColumnDef[],
  ) {
    this.openNextSheet();
  }

  addRow(values: unknown[], customize?: (row: ExcelJS.Row) => void): void {
    if (!this.worksheet) this.openNextSheet();
    if (this.currentRowCount >= EXCEL_MAX_ROWS - 1) this.openNextSheet();

    const row = this.worksheet!.addRow(values);
    row.height = 22;
    for (let i = 1; i <= this.columns.length; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: this.dataRowCount % 2 === 0 ? COLORS.white : COLORS.slateSoft },
      };
      cell.font = { name: 'Arial', size: 10, color: { argb: COLORS.navy } };
    }
    customize?.(row);
    row.commit();
    this.currentRowCount++;
    this.dataRowCount++;
  }

  finish(): void {
    this.worksheet?.commit();
    this.worksheet = null;
  }

  private openNextSheet(): void {
    this.worksheet?.commit();
    this.sheetIndex++;
    this.currentRowCount = 4;
    this.worksheet = addWorksheetChrome(
      this.workbook,
      safeSheetName(this.baseName, this.sheetIndex),
      this.title,
      this.subtitle,
      this.columns,
    );
  }
}
