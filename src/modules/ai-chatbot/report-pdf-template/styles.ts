// Print stylesheet of the report PDF: A4 fixed pages, 4 pt spacing grid,
// type scale >= 9.5 pt for body copy, WCAG AA contrast for text on fills.
import { REPORT_PDF_FONT_FAMILY } from './fonts.js';

export const REPORT_PDF_CSS = `
@page { size: A4; margin: 0; }
:root {
  --ink: #0B1733; --text: #2B3850; --muted: #56657D; --faint: #8A97AB; --line: #E1E7F0; --line-strong: #CBD4E1;
  --surface: #F5F7FB; --surface-2: #EDF1F8; --white: #FFFFFF;
  --navy: #0A1C47; --navy-2: #12307A; --brand: #2F5BEA; --brand-strong: #1D47C9; --brand-soft: #E9EFFE; --sky: #7DD3FC;
  --pos: #0D7A50; --pos-soft: #E2F5EC; --neg: #B42329; --neg-soft: #FCE9EA; --warn: #A3530A; --warn-soft: #FDF1E1;
  --neu: #4C5B72; --neu-soft: #EEF1F6;
  --status-completed: #12A06A; --status-progress: #2F5BEA; --status-not-started: #C3CCDA;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #FFFFFF; color: var(--text); font-family: '${REPORT_PDF_FONT_FAMILY}', sans-serif;
  font-size: 9.5pt; line-height: 1.5; font-variant-numeric: tabular-nums lining-nums; -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, ol, ul, dl, dd, figure { margin: 0; padding: 0; }
ol, ul { list-style: none; }
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; page-break-after: always; background: #FFFFFF; }
.page:last-child { break-after: auto; page-break-after: auto; }
.page-header { position: absolute; top: 9mm; left: 16mm; right: 16mm; height: 8mm; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 0.6pt solid var(--line); font-size: 8pt; color: var(--muted); }
.page-header .brandline { display: flex; align-items: center; gap: 2.5mm; min-width: 0; }
.page-header .brandline img { height: 5mm; max-width: 34mm; object-fit: contain; }
.page-header .tenant { font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70mm; }
.page-header .sep { width: 1px; height: 3.2mm; background: var(--line-strong); }
.page-header .doc { white-space: nowrap; }
.page-header .period { font-weight: 600; color: var(--text); white-space: nowrap; }
.page-body { position: absolute; top: 23mm; left: 16mm; right: 16mm; bottom: 21mm; overflow: hidden; display: flex; flex-direction: column; gap: 8mm; }
.page-footer { position: absolute; bottom: 8mm; left: 16mm; right: 16mm; height: 7mm; display: flex; align-items: center;
  justify-content: space-between; border-top: 0.6pt solid var(--line); font-size: 8pt; color: var(--muted); }
.page-footer .confidential { display: inline-flex; align-items: center; gap: 1.6mm; font-weight: 700; color: var(--navy-2); letter-spacing: 0.02em; }
.page-footer .confidential svg { width: 3mm; height: 3mm; }
.page-footer .page-no { font-weight: 700; color: var(--ink); }

.section { display: flex; flex-direction: column; gap: 4.5mm; }
.section-head { display: flex; flex-direction: column; gap: 1mm; }
.eyebrow { font-size: 8pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brand); display: flex; align-items: center; gap: 2mm; }
.eyebrow .num { display: inline-flex; align-items: center; justify-content: center; min-width: 6.2mm; height: 4.6mm; padding: 0 1.4mm; border-radius: 2.3mm;
  background: var(--brand-soft); color: var(--brand-strong); letter-spacing: 0.02em; }
h2 { font-size: 17pt; line-height: 1.22; font-weight: 800; color: var(--ink); letter-spacing: -0.01em; }
h3 { font-size: 10.5pt; line-height: 1.3; font-weight: 700; color: var(--ink); }
.lead { font-size: 9.5pt; color: var(--muted); }
.note { font-size: 8.2pt; color: var(--muted); line-height: 1.45; }
.entity { font-weight: 700; color: var(--ink); }
.card { background: #FFFFFF; border: 0.7pt solid var(--line); border-radius: 3.2mm; padding: 4.5mm 5mm; }
.card.soft { background: var(--surface); border-color: transparent; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; margin-bottom: 2.5mm; }
.grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 5mm; }
.measure-root { width: 178mm; display: flex; flex-direction: column; gap: 8mm; }
.section-head.continued h2 { font-size: 13pt; }
.section-head.continued h2 span { font-weight: 600; color: var(--muted); font-size: 10.5pt; }

/* ── Cover ── */
.cover .hero { position: absolute; inset: 0 0 auto 0; height: 168mm; overflow: hidden;
  background: linear-gradient(145deg, #071433 0%, #0E2766 52%, #1B49C8 100%); color: #FFFFFF; }
.cover .cover-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.cover .hero-top { position: absolute; top: 15mm; left: 18mm; right: 18mm; display: flex; justify-content: space-between; align-items: center; }
.cover .tenant-mark { display: flex; align-items: center; gap: 3mm; font-size: 11pt; font-weight: 700; letter-spacing: 0.01em; max-width: 120mm; }
.cover .tenant-mark img { height: 9mm; max-width: 60mm; object-fit: contain; }
.cover .tenant-mark .tenant-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cover .badge-confidential { display: inline-flex; align-items: center; gap: 1.6mm; padding: 1.4mm 3.2mm; border-radius: 4mm;
  border: 0.8pt solid rgba(255,255,255,0.55); font-size: 8pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.cover .badge-confidential svg { width: 3mm; height: 3mm; }
.cover .hero-text { position: absolute; left: 18mm; right: 18mm; bottom: 20mm; display: flex; flex-direction: column; gap: 4mm; }
.cover .hero-text .eyebrow { color: var(--sky); }
.cover h1 { font-size: 34pt; line-height: 1.08; font-weight: 800; letter-spacing: -0.02em; max-width: 150mm; }
.cover .hero-period { font-size: 15pt; font-weight: 600; color: #DCE6FF; }
.cover .chips { display: flex; flex-wrap: wrap; gap: 2mm; margin-top: 1mm; }
.cover .chip { display: inline-flex; align-items: baseline; gap: 1.5mm; padding: 1.4mm 3.4mm; border-radius: 4mm; background: rgba(255,255,255,0.12);
  border: 0.6pt solid rgba(255,255,255,0.22); font-size: 9pt; max-width: 172mm; white-space: nowrap; overflow: hidden; }
.cover .chip b { font-weight: 700; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; }
.cover .chip span { color: #C9D6F5; font-size: 8pt; }
.cover .body { position: absolute; top: 178mm; left: 18mm; right: 18mm; bottom: 22mm; display: flex; flex-direction: column; gap: 7mm; overflow: hidden; }
.cover .glance-title { font-size: 8pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.cover .glance { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
.cover .glance .item { border-left: 1mm solid var(--brand); padding: 1mm 0 1mm 3.5mm; }
.cover .glance .label { font-size: 8.4pt; color: var(--muted); font-weight: 600; }
.cover .glance .value { font-size: 20pt; font-weight: 800; color: var(--ink); line-height: 1.2; }
.cover .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm 6mm; padding-top: 5mm; border-top: 0.6pt solid var(--line); }
.cover .meta dt { font-size: 8pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.cover .meta dd { font-size: 9.5pt; font-weight: 600; color: var(--ink); line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
.cover .prepared { font-size: 8.4pt; color: var(--muted); max-width: 150mm; }
.cover .cover-footer { position: absolute; left: 18mm; right: 18mm; bottom: 9mm; display: flex; justify-content: space-between; align-items: center;
  font-size: 8pt; color: var(--muted); border-top: 0.6pt solid var(--line); padding-top: 2.5mm; }
.cover .cover-footer .brand { font-weight: 800; color: var(--navy-2); letter-spacing: 0.04em; min-width: 0; flex: 1 1 auto; margin-right: 6mm;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cover .cover-footer .confidential { flex: 0 0 auto; white-space: nowrap; }

/* ── Delta chips ── */
.delta { display: inline-flex; align-items: center; gap: 1mm; padding: 0.5mm 2.2mm; border-radius: 3mm; font-size: 8.2pt; font-weight: 700; white-space: nowrap; }
.delta svg { width: 2.4mm; height: 2.4mm; }
.delta.tone-positive { background: var(--pos-soft); color: var(--pos); }
.delta.tone-negative { background: var(--neg-soft); color: var(--neg); }
.delta.tone-neutral, .delta.tone-attention { background: var(--neu-soft); color: var(--neu); }

/* ── Executive summary ── */
.headline-card { position: relative; border-radius: 3.6mm; padding: 5mm 6mm 5mm 8mm; background: linear-gradient(120deg, #F1F5FF 0%, #F8FAFF 100%); border: 0.7pt solid #DCE5FB; }
.headline-card::before { content: ''; position: absolute; left: 0; top: 4mm; bottom: 4mm; width: 1.3mm; border-radius: 0 1mm 1mm 0; background: var(--brand); }
.headline-card.tone-attention::before, .headline-card.tone-negative::before { background: var(--warn); }
.headline-card .label { font-size: 8pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--brand-strong); margin-bottom: 1.5mm; }
.headline-card p { font-size: 12.5pt; line-height: 1.45; font-weight: 600; color: var(--ink); }
.findings { display: flex; flex-direction: column; gap: 2.6mm; counter-reset: finding; }
.finding { display: grid; grid-template-columns: 7mm 1fr; gap: 3mm; align-items: start; }
.finding .marker { width: 6.4mm; height: 6.4mm; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 8.4pt; font-weight: 800; color: #FFFFFF; background: var(--neu); margin-top: 0.3mm; }
.finding.tone-positive .marker { background: var(--pos); }
.finding.tone-negative .marker { background: var(--neg); }
.finding.tone-attention .marker { background: var(--warn); }
.finding p { font-size: 10pt; line-height: 1.5; color: var(--text); padding-top: 0.6mm; }
.commentary { border-radius: 3mm; background: var(--surface); padding: 3.5mm 4.5mm; }
.commentary .label { font-size: 8pt; font-weight: 700; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 1.2mm; }
.commentary li { font-size: 9.5pt; color: var(--text); padding-left: 3.5mm; position: relative; }
.commentary li::before { content: ''; position: absolute; left: 0; top: 2.2mm; width: 1.4mm; height: 1.4mm; border-radius: 50%; background: var(--faint); }
.kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
.kpi { position: relative; height: 36mm; border: 0.7pt solid var(--line); border-radius: 3.2mm; padding: 3.6mm 4mm; display: flex; flex-direction: column; overflow: hidden; }
.kpi > * { flex-shrink: 0; }
.kpi .kpi-label { font-size: 7.8pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); line-height: 1.35; height: 2.75em; overflow: hidden; padding-right: 1mm; }
.kpi .kpi-value { font-size: 20pt; font-weight: 800; color: var(--ink); line-height: 1.15; letter-spacing: -0.01em; }
.kpi .kpi-row { display: flex; align-items: center; gap: 2mm; margin-top: 1mm; }
.kpi .kpi-prev { font-size: 8pt; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi .spark { position: absolute; right: 4mm; top: 12.5mm; width: 22mm; height: 8mm; }
.spark-line { fill: none; stroke: var(--brand); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.spark-area { fill: var(--brand); fill-opacity: 0.08; stroke: none; }
.spark-dot { fill: var(--brand); }
.spark-positive .spark-line { stroke: var(--pos); } .spark-positive .spark-area { fill: var(--pos); } .spark-positive .spark-dot { fill: var(--pos); }
.spark-negative .spark-line { stroke: var(--neg); } .spark-negative .spark-area { fill: var(--neg); } .spark-negative .spark-dot { fill: var(--neg); }

/* ── Charts ── */
.chart-card { padding: 4.5mm 5mm 4mm; }
.chart-card .card-head h3 { font-size: 10.5pt; }
.legend { display: flex; gap: 4mm; font-size: 8pt; color: var(--muted); white-space: nowrap; }
.legend .key { display: inline-flex; align-items: center; gap: 1.4mm; }
.legend .swatch { width: 5mm; height: 0; border-top: 2pt solid var(--brand); }
.legend .swatch.previous { border-top: 1.6pt dashed var(--faint); }
.legend .swatch.previousAverage { border-top: 1.6pt dashed #7B8AA3; }
.legend .swatch.average { border-top: 1.4pt dotted var(--brand-strong); }
.legend .swatch.bars { width: 3mm; height: 3mm; border: none; border-radius: 0.8mm; background: #8FA9F5; }
svg.chart { display: block; width: 100%; height: auto; overflow: visible; }
svg.chart text { font-family: '${REPORT_PDF_FONT_FAMILY}', sans-serif; }
.grid { stroke: var(--line); stroke-width: 0.8; }
.grid.baseline { stroke: var(--line-strong); stroke-width: 1; }
.axis-y, .axis-x { font-size: 11px; fill: var(--muted); }
.area { fill: url(#areaFill); stroke: none; }
.line-current { fill: none; stroke: var(--brand); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
.line-previous { fill: none; stroke: #9AA7BC; stroke-width: 1.7; stroke-dasharray: 5 4; stroke-linejoin: round; }
.line-previous-average { stroke: #7B8AA3; stroke-width: 1.5; stroke-dasharray: 6 4; }
.line-average { stroke: var(--brand-strong); stroke-width: 1.2; stroke-dasharray: 1.5 3.5; stroke-linecap: round; opacity: 0.85; }
.point { fill: var(--brand); }
.peak-dot { fill: #FFFFFF; stroke: var(--brand); stroke-width: 2.2; }
.peak-box { fill: var(--navy-2); }
.peak-text { font-size: 10.5px; font-weight: 700; fill: #FFFFFF; }
.bar { fill: #9DB4F6; }
.bar-peak { fill: var(--brand); }
.stat-strip { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 0; margin-top: 3mm; border-top: 0.6pt solid var(--line); padding-top: 3mm; }
.stat { padding: 0 3.5mm; border-left: 0.6pt solid var(--line); }
.stat:first-child { border-left: none; padding-left: 0; }
.stat .label { font-size: 8pt; color: var(--muted); font-weight: 600; }
.stat .value { font-size: 13pt; font-weight: 800; color: var(--ink); line-height: 1.25; }
.stat .detail { font-size: 8pt; color: var(--muted); }
.observations li { position: relative; padding-left: 5mm; font-size: 9.5pt; margin-bottom: 1.6mm; }
.observations li::before { content: ''; position: absolute; left: 0.4mm; top: 1.9mm; width: 2.2mm; height: 2.2mm; border-radius: 0.6mm; background: var(--brand); transform: rotate(45deg); }
.observations li.tone-attention::before, .observations li.tone-negative::before { background: var(--warn); }
.observations li.tone-positive::before { background: var(--pos); }

/* ── Courses ── */
.status-card { display: flex; flex-direction: column; }
.status-card .donut-wrap { flex: 1; }
.donut-wrap { display: grid; grid-template-columns: 36mm minmax(0, 1fr); gap: 5mm; align-items: center; }
svg.donut { width: 36mm; height: 36mm; display: block; }
.donut-track { fill: none; stroke: var(--surface-2); }
.donut-seg { fill: none; }
.seg-completed { stroke: var(--status-completed); } .seg-in_progress { stroke: var(--status-progress); } .seg-not_started { stroke: var(--status-not-started); }
.donut-value { font-size: 22px; font-weight: 800; fill: var(--ink); }
.donut-label { font-size: 10.5px; fill: var(--muted); }
.status-legend { display: flex; flex-direction: column; gap: 2.6mm; }
.status-legend .row { display: grid; grid-template-columns: 3mm minmax(0, 1fr); gap: 2.4mm; align-items: start; }
.status-legend .row .dot { margin-top: 1.2mm; }
.status-legend .dot { width: 3mm; height: 3mm; border-radius: 0.8mm; }
.dot-completed { background: var(--status-completed); } .dot-in_progress { background: var(--status-progress); } .dot-not_started { background: var(--status-not-started); }
.status-legend .name { font-size: 9pt; color: var(--muted); line-height: 1.3; }
.status-legend .figures { font-size: 11pt; font-weight: 800; color: var(--ink); white-space: nowrap; line-height: 1.3; }
.status-legend .figures span { color: var(--muted); font-weight: 500; margin-left: 1.5mm; }
.bars { display: flex; flex-direction: column; gap: 2.4mm; }
.bar-row .top { display: flex; justify-content: space-between; gap: 3mm; font-size: 9pt; }
.bar-row .name { color: var(--text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; line-height: 1.35; }
.bars.two-col { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 3mm 8mm; }
.track.warm i { background: linear-gradient(90deg, #E8A04A, var(--warn)); }
.bar-row .val { font-weight: 700; color: var(--ink); white-space: nowrap; }
.bar-row .val span { color: var(--muted); font-weight: 500; margin-left: 1.2mm; }
.track { height: 2.2mm; border-radius: 1.1mm; background: var(--surface-2); overflow: hidden; margin-top: 0.8mm; }
.track i { display: block; height: 100%; border-radius: 1.1mm; background: linear-gradient(90deg, #4F7BF0, var(--brand-strong)); }
.ranked { display: flex; flex-direction: column; gap: 2.6mm; }
.ranked .item { display: grid; grid-template-columns: 1fr 17mm; gap: 3mm; align-items: center; }
.ranked .name { font-size: 9.5pt; font-weight: 600; color: var(--ink); line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.ranked .detail { font-size: 8pt; color: var(--muted); }
.ranked .rate { text-align: right; font-size: 12pt; font-weight: 800; }
.ranked.top .rate { color: var(--pos); } .ranked.low .rate { color: var(--neg); }
.empty { font-size: 9.5pt; color: var(--muted); padding: 4mm; border: 0.7pt dashed var(--line-strong); border-radius: 3mm; text-align: center; }

/* ── Tables ── */
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { font-size: 7.8pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); text-align: left;
  padding: 2mm 1.6mm; border-bottom: 0.9pt solid var(--line-strong); vertical-align: bottom; line-height: 1.25; }
td { font-size: 9pt; padding: 1.5mm 1.6mm; border-bottom: 0.5pt solid var(--line); vertical-align: middle; color: var(--text); line-height: 1.35; }
tbody tr:nth-child(even) td { background: #FAFBFD; }
th.num, td.num { text-align: right; }
td.num { font-weight: 600; color: var(--ink); white-space: nowrap; }
td.rank { color: var(--faint); font-weight: 700; }
td.name .clamp { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; font-weight: 600; color: var(--ink); }
.watch { display: inline-block; margin-top: 0.6mm; padding: 0 1.8mm; border-radius: 2mm; background: var(--warn-soft); color: var(--warn); font-size: 7.6pt; font-weight: 700; }
td.rate .cell { display: grid; grid-template-columns: 1fr 12mm; gap: 2mm; align-items: center; }
td.rate .track { margin-top: 0; }
td.rate .label { text-align: right; font-weight: 700; color: var(--ink); white-space: nowrap; }
.heat td.rate-heat { font-weight: 800; text-align: right; color: var(--ink); }
.tone-text-positive { color: var(--pos); font-weight: 700; } .tone-text-negative { color: var(--neg); font-weight: 700; } .tone-text-neutral { color: var(--muted); font-weight: 600; }

/* ── Organization ── */
.scope-path { display: flex; flex-direction: column; gap: 2mm; }
.scope-node { position: relative; display: flex; flex-direction: column; padding: 2mm 3.5mm; border-radius: 2.6mm; background: #FFFFFF; border: 0.6pt solid var(--line); }
.scope-node.depth-1 { margin-left: 7mm; } .scope-node.depth-2 { margin-left: 14mm; }
.scope-node.depth-1::before, .scope-node.depth-2::before { content: ''; position: absolute; left: -4.5mm; top: -2mm; width: 3.5mm; height: 6mm; border-left: 0.8pt solid var(--line-strong); border-bottom: 0.8pt solid var(--line-strong); border-bottom-left-radius: 1.6mm; }
.scope-node .level { font-size: 7.8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.scope-node .name { font-size: 10pt; font-weight: 700; color: var(--ink); word-break: break-word; }


/* ── Attention ── */
.attention-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(80mm, 1fr)); gap: 4mm; }
.alert { border-radius: 3mm; padding: 3.8mm 4.2mm; border: 0.7pt solid var(--line); border-top: 1.4mm solid var(--warn); background: #FFFFFF; }
.alert.sev-warning { border-top-color: var(--neg); }
.alert .sev { display: inline-block; font-size: 7.6pt; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.3mm 2mm; border-radius: 2mm; background: var(--warn-soft); color: var(--warn); }
.alert.sev-warning .sev { background: var(--neg-soft); color: var(--neg); }
.alert h3 { margin: 1.6mm 0 1.2mm; font-size: 10pt; }
.alert p { font-size: 9.2pt; color: var(--text); }
.ok-state { display: flex; gap: 3mm; align-items: center; padding: 4mm 5mm; border-radius: 3mm; background: var(--pos-soft); color: var(--pos); font-weight: 600; }

/* ── Recommendations ── */
.recs { display: flex; flex-direction: column; gap: 3mm; }
.rec { display: grid; grid-template-columns: 9mm 1fr; gap: 3.5mm; padding: 3.4mm 4mm; border-radius: 3mm; background: var(--surface); }
.rec .no { width: 8mm; height: 8mm; border-radius: 2.4mm; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 10pt; color: #FFFFFF; background: var(--navy-2); }
.rec .meta { display: flex; gap: 2mm; align-items: center; margin-bottom: 0.8mm; }
.prio { font-size: 7.6pt; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.2mm 2mm; border-radius: 2mm; }
.prio-high { background: var(--neg-soft); color: var(--neg); } .prio-medium { background: var(--warn-soft); color: var(--warn); } .prio-low { background: var(--neu-soft); color: var(--neu); }
.from-chat { font-size: 7.8pt; color: var(--muted); }
.rec p { font-size: 9.8pt; color: var(--ink); }

/* ── Appendix ── */
.defs td { vertical-align: top; padding: 2mm 1.6mm; }
.defs td.term { width: 46mm; font-weight: 700; color: var(--ink); }
.formula { border-radius: 3.2mm; border: 0.8pt solid #D6E0FA; background: #F7F9FF; padding: 4.5mm 5mm; display: flex; flex-direction: column; gap: 2.6mm; }
.formula ol { counter-reset: step; display: flex; flex-direction: column; gap: 1.8mm; }
.formula li { position: relative; padding-left: 7mm; font-size: 9.2pt; }
.formula li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 0.3mm; width: 4.8mm; height: 4.8mm; border-radius: 50%; background: var(--brand); color: #FFFFFF; font-size: 7.8pt; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.formula .expr { font-size: 11pt; font-weight: 700; color: var(--navy-2); background: #FFFFFF; border: 0.6pt solid #D6E0FA; border-radius: 2.4mm; padding: 2.6mm 3.5mm; text-align: center; letter-spacing: 0.01em; }
.formula .legend-text { font-size: 8.6pt; color: var(--muted); }
.formula .callout { font-size: 8.8pt; color: var(--warn); background: var(--warn-soft); border-radius: 2mm; padding: 2mm 3mm; font-weight: 600; }
.kv td { vertical-align: top; padding: 1.7mm 1.6mm; }
.kv td.key { width: 52mm; font-weight: 700; color: var(--ink); }
.bullets li { position: relative; padding-left: 4.5mm; font-size: 9.2pt; margin-bottom: 1.6mm; }
.bullets li::before { content: ''; position: absolute; left: 0.4mm; top: 2mm; width: 1.6mm; height: 1.6mm; border-radius: 50%; background: var(--brand); }
.mono { font-family: '${REPORT_PDF_FONT_FAMILY}', sans-serif; letter-spacing: 0.06em; font-weight: 700; }
`;
