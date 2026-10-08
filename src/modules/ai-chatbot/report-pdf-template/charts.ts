// Server-side vector charts (inline SVG). Pure functions of numbers + already
// formatted labels; labels are escaped. No scripts, no external references.
import { escapeHtml, num, trusted, type SafeHtml } from './html.js';

type Formatter = (value: number) => string;

export interface ReportChartScale { max: number; ticks: number[] }

/** "Nice" zero-based axis with integer steps for count data. */
export function niceReportChartScale(maxValue: number, integerData = true, targetTicks = 4): ReportChartScale {
  const safeMax = Number.isFinite(maxValue) && maxValue > 0 ? maxValue * 1.08 : 0;
  if (safeMax === 0) return { max: targetTicks, ticks: Array.from({ length: targetTicks + 1 }, (_, index) => index) };
  const rough = safeMax / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  if (integerData) step = Math.max(1, Math.ceil(step));
  const max = Math.ceil(safeMax / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return { max, ticks };
}

export function pickReportChartTickIndexes(size: number, maxTicks = 7): number[] {
  if (size <= 0) return [];
  if (size <= maxTicks) return Array.from({ length: size }, (_, index) => index);
  const indexes = Array.from({ length: maxTicks }, (_, index) => Math.round((index * (size - 1)) / (maxTicks - 1)));
  return [...new Set(indexes)];
}

interface TrendChartInput {
  values: number[];
  labels: string[];
  previousValues: number[] | null;
  previousAverage: number | null;
  average: number;
  peakIndex: number | null;
  peakLabel: string | null;
  format: Formatter;
  width?: number;
  height?: number;
}

const PAD = { left: 40, right: 16, top: 22, bottom: 26 } as const;

function axes(input: { width: number; height: number; scale: ReportChartScale; labels: string[]; xFor: (index: number) => number; format: Formatter }): string {
  const plotHeight = input.height - PAD.top - PAD.bottom;
  const yFor = (value: number) => PAD.top + plotHeight - (value / input.scale.max) * plotHeight;
  const grid = input.scale.ticks.map((tick) => {
    const y = yFor(tick);
    return `<line class="grid${tick === 0 ? ' baseline' : ''}" x1="${PAD.left}" x2="${num(input.width - PAD.right)}" y1="${num(y)}" y2="${num(y)}"/>`
      + `<text class="axis-y" x="${PAD.left - 8}" y="${num(y + 3.6)}" text-anchor="end">${escapeHtml(input.format(tick))}</text>`;
  }).join('');
  const ticks = pickReportChartTickIndexes(input.labels.length).map((index) => {
    const anchor = input.labels.length > 1 && index === 0 ? 'start' : input.labels.length > 1 && index === input.labels.length - 1 ? 'end' : 'middle';
    return `<text class="axis-x" x="${num(input.xFor(index))}" y="${num(input.height - 8)}" text-anchor="${anchor}">${escapeHtml(input.labels[index])}</text>`;
  }).join('');
  return grid + ticks;
}

function referenceLine(input: { value: number; width: number; yFor: (value: number) => number; className: string }): string {
  const y = input.yFor(input.value);
  return `<line class="${input.className}" x1="${PAD.left}" x2="${num(input.width - PAD.right)}" y1="${num(y)}" y2="${num(y)}"/>`;
}

function peakMarker(input: { x: number; y: number; label: string; width: number }): string {
  const boxWidth = Math.max(26, input.label.length * 6.6 + 14);
  const boxX = Math.min(Math.max(input.x - boxWidth / 2, PAD.left), input.width - PAD.right - boxWidth);
  const boxY = Math.max(2, input.y - 26);
  return `<circle class="peak-dot" cx="${num(input.x)}" cy="${num(input.y)}" r="4.2"/>`
    + `<rect class="peak-box" x="${num(boxX)}" y="${num(boxY)}" width="${num(boxWidth)}" height="17" rx="8.5"/>`
    + `<text class="peak-text" x="${num(boxX + boxWidth / 2)}" y="${num(boxY + 12)}" text-anchor="middle">${escapeHtml(input.label)}</text>`;
}

/**
 * Comparison series aligned with the current one by bucket index (day 1 with
 * day 1...): points past the current series' length are not drawn.
 */
function alignedPreviousValues(input: Pick<TrendChartInput, 'values' | 'previousValues'>): number[] {
  return (input.previousValues ?? []).slice(0, input.values.length).map((value) => (Number.isFinite(value) ? value : 0));
}

/** Dashed comparison line: one point per bucket, or a level line for a single bucket. */
function previousSeries(values: number[], xFor: (index: number) => number, yFor: (value: number) => number, width: number): string {
  if (values.length === 1) return referenceLine({ value: values[0], width, yFor, className: 'line-previous' });
  return values.length > 1
    ? `<path class="line-previous" d="${values.map((value, index) => `${index ? 'L' : 'M'}${num(xFor(index))} ${num(yFor(value))}`).join(' ')}"/>` : '';
}

/** Area/line chart of the current period with the comparison series or average. */
export function renderAreaTrendChart(input: TrendChartInput): SafeHtml {
  const width = input.width ?? 672;
  const height = input.height ?? 230;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const previousValues = alignedPreviousValues(input);
  const all = [...input.values, ...previousValues, input.previousAverage ?? 0, input.average];
  const scale = niceReportChartScale(Math.max(...all));
  const xFor = (index: number) => PAD.left + (input.values.length <= 1 ? plotWidth / 2 : (index * plotWidth) / (input.values.length - 1));
  const yFor = (value: number) => PAD.top + plotHeight - (value / scale.max) * plotHeight;
  const points = input.values.map((value, index) => [xFor(index), yFor(value)] as const);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${num(x)} ${num(y)}`).join(' ');
  const area = points.length > 1
    ? `<path class="area" d="${line} L${num(points.at(-1)![0])} ${num(yFor(0))} L${num(points[0][0])} ${num(yFor(0))} Z"/>` : '';
  const previous = previousSeries(previousValues, xFor, yFor, width);
  const previousAverage = input.previousAverage !== null ? referenceLine({ value: input.previousAverage, width, yFor, className: 'line-previous-average' }) : '';
  const average = referenceLine({ value: input.average, width, yFor, className: 'line-average' });
  const single = points.length === 1 ? `<circle class="point" cx="${num(points[0][0])}" cy="${num(points[0][1])}" r="3.6"/>` : '';
  const peak = input.peakIndex !== null && input.peakLabel && points[input.peakIndex]
    ? peakMarker({ x: points[input.peakIndex][0], y: points[input.peakIndex][1], label: input.peakLabel, width }) : '';
  return trusted(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" xmlns="http://www.w3.org/2000/svg">`
    + '<defs><linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2F5BEA" stop-opacity="0.26"/><stop offset="100%" stop-color="#2F5BEA" stop-opacity="0.02"/></linearGradient></defs>'
    + axes({ width, height, scale, labels: input.labels, xFor: (index) => xFor(index), format: input.format })
    + area + previousAverage + average + previous
    + (points.length > 1 ? `<path class="line-current" d="${line}"/>` : '') + single + peak
    + '</svg>');
}

/** Column chart (used for active learners per bucket). */
export function renderBarTrendChart(input: TrendChartInput): SafeHtml {
  const width = input.width ?? 672;
  const height = input.height ?? 200;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const previousValues = alignedPreviousValues(input);
  const scale = niceReportChartScale(Math.max(...input.values, ...previousValues, input.average, input.previousAverage ?? 0));
  const slot = plotWidth / Math.max(1, input.values.length);
  const barWidth = Math.max(2, Math.min(28, slot * 0.64));
  const xFor = (index: number) => PAD.left + slot * index + slot / 2;
  const yFor = (value: number) => PAD.top + plotHeight - (value / scale.max) * plotHeight;
  const bars = input.values.map((value, index) => {
    const y = yFor(value);
    const barHeight = Math.max(value > 0 ? 1.2 : 0, yFor(0) - y);
    return `<rect class="bar${index === input.peakIndex ? ' bar-peak' : ''}" x="${num(xFor(index) - barWidth / 2)}" y="${num(yFor(0) - barHeight)}" width="${num(barWidth)}" height="${num(barHeight)}" rx="${num(Math.min(3, barWidth / 3))}"/>`;
  }).join('');
  const average = referenceLine({ value: input.average, width, yFor, className: 'line-average' });
  // Comparison period over the bars, one point per bucket, or its average.
  const previous = previousValues.length
    ? previousSeries(previousValues, xFor, yFor, width)
    : input.previousAverage !== null ? referenceLine({ value: input.previousAverage, width, yFor, className: 'line-previous-average' }) : '';
  const peak = input.peakIndex !== null && input.peakLabel
    ? peakMarker({ x: xFor(input.peakIndex), y: yFor(input.values[input.peakIndex]) - 2, label: input.peakLabel, width }).replace(/<circle[^>]*\/>/, '') : '';
  return trusted(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" xmlns="http://www.w3.org/2000/svg">`
    + axes({ width, height, scale, labels: input.labels, xFor, format: input.format })
    + bars + average + previous + peak + '</svg>');
}

/** Small trend line for KPI cards. */
export function renderSparkline(values: number[], tone: 'positive' | 'negative' | 'neutral' | 'attention'): SafeHtml {
  const width = 132;
  const height = 30;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => [index * step, height - 3 - (value / max) * (height - 6)] as const);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${num(x)} ${num(y)}`).join(' ');
  const last = points.at(-1)!;
  return trusted(`<svg class="spark spark-${tone}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`
    + `<path class="spark-area" d="${line} L${num(last[0])} ${height} L0 ${height} Z"/>`
    + `<path class="spark-line" d="${line}"/><circle class="spark-dot" cx="${num(last[0])}" cy="${num(last[1])}" r="2.4"/></svg>`);
}

/** Donut of mutually exclusive segments (ratios sum to 1). */
export function renderDonut(segments: Array<{ ratio: number; className: string }>, center: { value: string; label: string }): SafeHtml {
  const size = 150;
  const radius = 56;
  const stroke = 20;
  const circumference = 2 * Math.PI * radius;
  const visible = segments.filter((segment) => segment.ratio > 0);
  const gap = visible.length > 1 ? 1.6 : 0;
  let offset = 0;
  const arcs = visible.map((segment) => {
    const length = Math.max(0, segment.ratio * circumference - gap);
    const arc = `<circle class="donut-seg ${segment.className}" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}" stroke-dasharray="${num(length)} ${num(circumference - length)}" stroke-dashoffset="${num(-offset)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
    offset += segment.ratio * circumference;
    return arc;
  }).join('');
  return trusted(`<svg class="donut" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`
    + `<circle class="donut-track" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}"/>${arcs}`
    + `<text class="donut-value" x="${size / 2}" y="${size / 2 + 4}" text-anchor="middle">${escapeHtml(center.value)}</text>`
    + `<text class="donut-label" x="${size / 2}" y="${size / 2 + 21}" text-anchor="middle">${escapeHtml(center.label)}</text></svg>`);
}

/** Decorative, data-free cover artwork (constant markup). */
export function renderCoverArt(): SafeHtml {
  const rings = [140, 220, 300, 380, 460].map((r, index) => `<circle cx="720" cy="40" r="${r}" fill="none" stroke="#FFFFFF" stroke-opacity="${num(0.09 - index * 0.012, 3)}" stroke-width="1.2"/>`).join('');
  const dots: string[] = [];
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 10; col += 1) dots.push(`<circle cx="${560 + col * 18}" cy="${120 + row * 18}" r="1.6" fill="#FFFFFF" fill-opacity="0.12"/>`);
  }
  const bars = [0.38, 0.52, 0.47, 0.66, 0.6, 0.78, 0.9].map((ratio, index) => `<rect x="${560 + index * 26}" y="${num(470 - ratio * 150)}" width="14" height="${num(ratio * 150)}" rx="4" fill="#FFFFFF" fill-opacity="${num(0.07 + index * 0.018, 3)}"/>`).join('');
  return trusted(`<svg class="cover-art" viewBox="0 0 794 520" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${rings}${dots.join('')}${bars}`
    + '<path d="M548 430 C 600 400, 640 380, 690 330 S 760 260, 794 240" fill="none" stroke="#7DD3FC" stroke-opacity="0.45" stroke-width="2.4"/></svg>');
}
