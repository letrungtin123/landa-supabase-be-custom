// Section renderers of the report PDF. Input is the formatted view model; all
// text goes through html`` (escaped) or renderNarrativeText (escaped + tokens).
import type {
  ReportPdfKpiCard,
  ReportPdfSectionId,
  ReportPdfSectionSlice,
  ReportPdfTrendChart,
  ReportPdfViewModel,
} from '../report-pdf-view-model.js';
import { formatReportNumber } from '../report-pdf-i18n.js';
import { renderAreaTrendChart, renderBarTrendChart, renderCoverArt, renderDonut, renderSparkline } from './charts.js';
import { html, num, renderNarrativeText, trusted, type SafeHtml } from './html.js';

const ICON_LOCK = trusted('<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M4.5 7V5.2a3.5 3.5 0 1 1 7 0V7h.6c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H3.9c-.8 0-1.4-.6-1.4-1.4V8.4C2.5 7.6 3.1 7 3.9 7h.6Zm1.6 0h3.8V5.2a1.9 1.9 0 1 0-3.8 0V7Z"/></svg>');
const ICON_UP = trusted('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M5 1.2 9.2 7.6H.8z"/></svg>');
const ICON_DOWN = trusted('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M5 8.8.8 2.4h8.4z"/></svg>');
const ICON_FLAT = trusted('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect fill="currentColor" x="1" y="4" width="8" height="2" rx="1"/></svg>');
const ICON_CHECK = trusted('<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="currentColor" fill-opacity="0.15"/><path d="m4.8 8.2 2.2 2.2 4.4-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const SECTION_NUMBERS: Record<ReportPdfSectionId, string> = {
  summary: '01', kpis: '01', trends: '02', courses: '03', portfolio: '03', organization: '04',
  attention: '05', recommendations: '06', appendixDefinitions: 'A', appendixData: 'B',
};

function sectionHead(number: string, copy: { eyebrow: string; title: string }, lead?: string | null): SafeHtml {
  return html`<div class="section-head"><div class="eyebrow"><span class="num">${number}</span>${copy.eyebrow}</div><h2>${copy.title}</h2>${lead ? html`<p class="lead">${lead}</p>` : ''}</div>`;
}

function continuedHead(number: string, copy: { eyebrow: string; title: string }, continued: string): SafeHtml {
  return html`<div class="section-head continued"><div class="eyebrow"><span class="num">${number}</span>${copy.eyebrow}</div><h2>${copy.title} <span>(${continued})</span></h2></div>`;
}

function sliceRange(slice: ReportPdfSectionSlice, size: number): { from: number; to: number; first: boolean; last: boolean } {
  const from = Math.max(0, Math.min(slice.from ?? 0, size));
  const to = Math.max(from, Math.min(slice.to ?? size, size));
  return { from, to, first: from === 0, last: to >= size };
}

function deltaChip(card: ReportPdfKpiCard, model: ReportPdfViewModel): SafeHtml {
  if (!card.deltaLabel || !card.direction) return html`<span class="delta tone-neutral">${model.dict.kpi.notComparableShort}</span>`;
  const icon = card.direction === 'up' ? ICON_UP : card.direction === 'down' ? ICON_DOWN : ICON_FLAT;
  return html`<span class="delta tone-${card.tone}">${icon}${card.deltaLabel}</span>`;
}

export function renderCover(model: ReportPdfViewModel): SafeHtml {
  const { dict } = model;
  const chips = model.scopePath.length
    ? model.scopePath.map((item) => html`<span class="chip"><span>${item.level}</span><b>${item.name}</b></span>`)
    : [html`<span class="chip"><span>${dict.cover.scope}</span><b>${dict.scope.all}</b></span>`];
  const tenantMark = model.tenant.logoDataUri
    ? html`<img src="${model.tenant.logoDataUri}" alt=""><span class="tenant-name">${model.tenant.name}</span>`
    : html`<span class="tenant-name">${model.tenant.name}</span>`;
  return html`<section class="page cover">
  <div class="hero">${renderCoverArt()}
    <div class="hero-top"><div class="tenant-mark">${tenantMark}</div><div class="badge-confidential">${ICON_LOCK}${dict.meta.confidential}</div></div>
    <div class="hero-text">
      <div class="eyebrow">${dict.meta.eyebrow}</div>
      <h1>${model.title}</h1>
      <div class="hero-period">${model.periodLabel}</div>
      <div class="chips">${chips}</div>
    </div>
  </div>
  <div class="body" data-fit>
    <div>
      <div class="glance-title">${dict.cover.atAGlance}</div>
      <div class="glance" style="margin-top:3mm">${model.coverKpis.map((card) => html`<div class="item"><div class="label">${card.label}</div><div class="value">${card.value}</div>${deltaChip(card, model)}</div>`)}</div>
    </div>
    <dl class="meta">
      <div><dt>${dict.cover.period}</dt><dd>${model.periodLabel}</dd></div>
      <div><dt>${dict.cover.comparison}</dt><dd>${model.comparisonLabel ?? dict.cover.noComparison}</dd></div>
      <div><dt>${dict.cover.scope}</dt><dd>${model.scopeLabel}</dd></div>
      <div><dt>${dict.cover.generatedAt}</dt><dd>${model.generatedAtLabel}</dd></div>
      <div><dt>${dict.cover.language}</dt><dd>${dict.meta.languageName}</dd></div>
      <div><dt>${dict.cover.reference}</dt><dd class="mono">${model.reference}</dd></div>
    </dl>
    <p class="prepared">${dict.cover.preparedBy}</p>
  </div>
  <div class="cover-footer"><span class="brand">${model.brandLine}</span><span class="confidential">${dict.meta.confidentialFooter}</span></div>
</section>`;
}

function renderSummary(model: ReportPdfViewModel): SafeHtml {
  const { dict, narrative } = model;
  const findings = narrative.findings.length
    ? html`<ol class="findings">${narrative.findings.map((item, index) => html`<li class="finding tone-${item.tone}"><span class="marker">${index + 1}</span><p>${renderNarrativeText(item.text, model.entities)}</p></li>`)}</ol>`
    : html`<div class="empty">${dict.summary.emptyFindings}</div>`;
  const commentary = narrative.commentary.length
    ? html`<div class="commentary"><div class="label">${dict.summary.commentary}</div><ul>${narrative.commentary.map((text) => html`<li>${text}</li>`)}</ul></div>`
    : '';
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.summary, dict.sections.summary)}
  <div class="headline-card tone-${narrative.headline.tone}"><p>${renderNarrativeText(narrative.headline.text, model.entities)}</p></div>
  <h3>${dict.summary.keyFindings}</h3>${findings}${commentary}</section>`;
}

function renderKpis(model: ReportPdfViewModel): SafeHtml {
  const cards = model.kpis.map((card) => html`<div class="kpi" data-fit>
    <div class="kpi-label">${card.label}</div>
    <div class="kpi-value">${card.value}</div>
    <div class="kpi-row">${deltaChip(card, model)}</div>
    <div class="kpi-prev" style="margin-top:1.2mm">${card.previousLabel}</div>
    ${card.spark ? renderSparkline(card.spark, card.tone === 'negative' ? 'negative' : card.tone === 'positive' ? 'positive' : 'neutral') : ''}
  </div>`);
  return html`<section class="section"><div class="card-head" style="margin-bottom:0"><h3>${model.dict.summary.scorecard}</h3></div>
  <div class="kpi-grid">${cards}</div><p class="note">${model.scorecardNote}</p></section>`;
}

function trendCard(chart: ReportPdfTrendChart, model: ReportPdfViewModel): SafeHtml {
  const format = (value: number) => formatReportNumber(value, model.locale, Number.isInteger(value) ? 0 : 1);
  const legend = chart.legend.map((item) => html`<span class="key"><i class="swatch ${chart.kind === 'bars' && item.key === 'current' ? 'bars' : item.key}"></i>${item.label}</span>`);
  const svg = chart.kind === 'area'
    ? renderAreaTrendChart({ ...chart, format, height: 210 })
    : renderBarTrendChart({ ...chart, format, height: 180 });
  return html`<div class="card chart-card">
    <div class="card-head"><h3>${chart.title}</h3><div class="legend">${legend}</div></div>
    ${svg}
    <div class="stat-strip">${chart.stats.map((stat) => html`<div class="stat"><div class="label">${stat.label}</div><div class="value">${stat.value}</div>${stat.detail ? html`<div class="detail">${stat.detail}</div>` : ''}</div>`)}</div>
    ${chart.note ? html`<p class="note" style="margin-top:2mm">${chart.note}</p>` : ''}
  </div>`;
}

function renderTrends(model: ReportPdfViewModel): SafeHtml {
  const { dict, trends } = model;
  const observations = trends.observations.length
    ? html`<ul class="observations">${trends.observations.map((item) => html`<li class="tone-${item.tone}">${renderNarrativeText(item.text, model.entities)}</li>`)}</ul>`
    : html`<p class="note">${dict.trends.noObservations}</p>`;
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.trends, dict.sections.trends)}
  ${trends.enrollments ? trendCard(trends.enrollments, model) : html`<div class="empty">${dict.trends.noTrend}</div>`}
  ${trends.active ? trendCard(trends.active, model) : ''}
  <div><h3 style="margin-bottom:2mm">${dict.trends.observations}</h3>${observations}</div></section>`;
}

function renderCourses(model: ReportPdfViewModel): SafeHtml {
  const { dict, courses } = model;
  const status = courses.status
    ? html`<div class="donut-wrap">${renderDonut(courses.status.map((segment) => ({ ratio: segment.ratio, className: `seg-${segment.key}` })), { value: courses.statusTotal ?? '', label: dict.courses.statusCenter })}
      <div class="status-legend">${courses.status.map((segment) => html`<div class="row"><i class="dot dot-${segment.key}"></i><div><div class="name">${segment.label}</div><div class="figures">${segment.countLabel}<span>${segment.shareLabel}</span></div></div></div>`)}</div></div>`
    : html`<div class="empty">${courses.legacy ? dict.courses.legacyNote : dict.courses.noCourses}</div>`;
  const concentration = courses.concentration.length
    ? html`<div class="bars">${courses.concentration.map((bar) => html`<div class="bar-row"><div class="top"><span class="name">${bar.name}</span><span class="val">${bar.valueLabel}<span>${bar.shareLabel}</span></span></div><div class="track"><i style="width:${num(Math.max(bar.ratio * 100, 1.5), 1)}%"></i></div></div>`)}</div>
      ${courses.concentrationNote ? html`<p class="note" style="margin-top:2.6mm">${courses.concentrationNote}</p>` : ''}`
    : html`<div class="empty">${dict.courses.noCourses}</div>`;
  const ranked = (items: typeof courses.top, kind: 'top' | 'low') => (items.length
    ? html`<div class="ranked ${kind}">${items.map((item) => html`<div class="item"><div><div class="name">${item.name}</div><div class="detail">${item.detail}</div></div><div class="rate">${item.rateLabel}</div></div>`)}</div>`
    : html`<div class="empty">${dict.courses.noRankable}</div>`);
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.courses, dict.sections.courses)}
  <div class="grid-2">
    <div class="card status-card"><div class="card-head"><h3>${dict.courses.statusTitle}</h3></div>${status}</div>
    <div class="card"><div class="card-head"><h3>${dict.courses.concentrationTitle}</h3></div>${concentration}</div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-head"><h3>${dict.courses.topPerformers}</h3></div>${ranked(courses.top, 'top')}</div>
    <div class="card"><div class="card-head"><h3>${dict.courses.lowPerformers}</h3></div>${ranked(courses.low, 'low')}</div>
  </div>
  <p class="note">${courses.minSampleNote}</p>
  ${courses.backlog.length ? html`<div class="card"><div class="card-head"><h3>${dict.courses.backlogTitle}</h3>${courses.backlogNote ? html`<span class="note">${courses.backlogNote}</span>` : ''}</div>
    <div class="bars two-col">${courses.backlog.map((bar) => html`<div class="bar-row"><div class="top"><span class="name">${bar.name}</span><span class="val">${bar.valueLabel}<span>${bar.shareLabel}</span></span></div><div class="track warm"><i style="width:${num(Math.max(bar.ratio * 100, 1.5), 1)}%"></i></div></div>`)}</div></div>` : ''}</section>`;
}

function renderPortfolio(model: ReportPdfViewModel, slice: ReportPdfSectionSlice): SafeHtml {
  const { dict, courses } = model;
  const c = dict.courses.columns;
  const range = sliceRange(slice, courses.rows.length);
  const rows = courses.rows.slice(range.from, range.to).map((row, offset) => html`<tr data-measure="row:portfolio:${range.from + offset}">
    <td class="rank">${row.rank}</td>
    <td class="name"><div class="clamp">${row.name}</div>${row.watch ? html`<span class="watch">${dict.courses.watchBadge}</span>` : ''}</td>
    <td class="num">${row.enrollments}</td><td class="num">${row.completed}</td><td class="num">${row.inProgress}</td><td class="num">${row.notStarted}</td>
    <td class="rate"><div class="cell"><div class="track"><i style="width:${num(Math.max(row.rate, 1), 1)}%"></i></div><span class="label">${row.rateLabel}</span></div></td>
    <td class="num">${row.share}</td></tr>`);
  const head = range.first
    ? sectionHead(SECTION_NUMBERS.portfolio, dict.sections.portfolio, courses.portfolioLead)
    : continuedHead(SECTION_NUMBERS.portfolio, dict.sections.portfolio, dict.meta.continued);
  return html`<section class="section">${head}
  <table class="portfolio"><colgroup><col style="width:7mm"><col><col style="width:14mm"><col style="width:15mm"><col style="width:14mm"><col style="width:15mm"><col style="width:31mm"><col style="width:13mm"></colgroup>
  <thead><tr><th>${c.rank}</th><th>${c.course}</th><th class="num">${c.enrollments}</th><th class="num">${c.completed}</th><th class="num">${c.inProgress}</th><th class="num">${c.notStarted}</th><th>${c.completionRate}</th><th class="num">${c.share}</th></tr></thead>
  <tbody>${rows}</tbody></table>
  ${range.last && courses.coverageNote ? html`<p class="note">${courses.coverageNote}</p>` : ''}</section>`;
}

function renderOrganization(model: ReportPdfViewModel, slice: ReportPdfSectionSlice): SafeHtml {
  const { dict, organization } = model;
  const o = dict.organization;
  const range = sliceRange(slice, organization.rows.length);
  const path = model.scopePath.length
    ? html`<div class="scope-path">${model.scopePath.map((item, index) => html`<span class="scope-node depth-${index}"><span class="level">${item.level}</span><span class="name">${item.name}</span></span>`)}</div>`
    : html`<div class="scope-path"><span class="scope-node"><span class="level">${dict.cover.scope}</span><span class="name">${dict.scope.all}</span></span></div>`;
  const breakdown = organization.rows.length
    ? html`<div>${range.first ? html`<div class="card-head"><h3>${o.breakdownTitle}</h3><span class="note">${organization.level ? o.levelLabel({ level: organization.level }) : ''} · ${organization.unitCountLabel ?? ''}</span></div>` : ''}
      <table class="heat"><colgroup><col><col style="width:20mm"><col style="width:22mm"><col style="width:20mm"><col style="width:30mm"><col style="width:24mm"></colgroup>
      <thead><tr><th>${o.columns.unit}</th><th class="num">${o.columns.learners}</th><th class="num">${o.columns.active}</th><th class="num">${o.columns.enrollments}</th><th class="num">${o.columns.completionRate}</th><th class="num">${o.columns.delta}</th></tr></thead>
      <tbody>${organization.rows.slice(range.from, range.to).map((row, offset) => html`<tr data-measure="row:organization:${range.from + offset}"><td class="name"><div class="clamp">${row.name}</div></td><td class="num">${row.learners}</td><td class="num">${row.active}</td><td class="num">${row.enrollments}</td>
        <td class="rate-heat" style="background:rgba(47,91,234,${num(0.08 + row.heat * 0.42, 3)})">${row.rateLabel}</td><td class="num tone-text-${row.deltaTone}">${row.deltaLabel}</td></tr>`)}</tbody></table>
      ${range.last ? html`<p class="note" style="margin-top:2mm">${o.heatLegend}</p>` : ''}</div>`
    : '';
  if (!range.first) {
    return html`<section class="section">${continuedHead(SECTION_NUMBERS.organization, dict.sections.organization, dict.meta.continued)}${breakdown}</section>`;
  }
  const missing = organization.rows.length ? '' : html`<p class="note" style="margin-top:3mm">${o.breakdownMissing}</p>`;
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.organization, dict.sections.organization)}
  <div class="card soft"><div class="card-head"><h3>${o.scopeTitle}</h3></div>${path}${missing}</div>${breakdown}</section>`;
}

function renderAttention(model: ReportPdfViewModel): SafeHtml {
  const { dict } = model;
  const body = model.attention.length
    ? html`<div class="attention-grid">${model.attention.map((item) => html`<div class="alert sev-${item.severity}"><span class="sev">${item.severityLabel}</span><h3>${item.title}</h3><p>${renderNarrativeText(item.text, model.entities)}</p></div>`)}</div>`
    : html`<div class="ok-state">${ICON_CHECK}<span>${dict.attention.none}</span></div>`;
  const c = dict.courses.columns;
  const watch = model.watchlist.rows.length
    ? html`<div><div class="card-head"><h3>${dict.attention.watchlistTitle}</h3><span class="note">${model.watchlist.lead}</span></div>
      <table class="watchlist"><colgroup><col><col style="width:18mm"><col style="width:22mm"><col style="width:40mm"></colgroup>
      <thead><tr><th>${c.course}</th><th class="num">${c.enrollments}</th><th class="num">${c.notStarted}</th><th>${c.completionRate}</th></tr></thead>
      <tbody>${model.watchlist.rows.map((row) => html`<tr><td class="name"><div class="clamp">${row.name}</div></td><td class="num">${row.enrollments}</td><td class="num">${row.notStarted}</td>
        <td class="rate"><div class="cell"><div class="track warm"><i style="width:${num(Math.max(row.rate, 1), 1)}%"></i></div><span class="label">${row.rateLabel}</span></div></td></tr>`)}</tbody></table></div>`
    : '';
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.attention, dict.sections.attention)}${body}${watch}</section>`;
}

function renderRecommendations(model: ReportPdfViewModel): SafeHtml {
  const { dict } = model;
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.recommendations, dict.sections.recommendations)}
  <ol class="recs">${model.recommendations.map((item, index) => html`<li class="rec"><span class="no">${index + 1}</span><div>
    <div class="meta"><span class="prio prio-${item.priority}">${item.priorityLabel}</span>${item.fromChat ? html`<span class="from-chat">${dict.recommendations.fromChat}</span>` : ''}</div>
    <p>${renderNarrativeText(item.text, model.entities)}</p></div></li>`)}</ol></section>`;
}

function renderAppendixDefinitions(model: ReportPdfViewModel): SafeHtml {
  const { dict } = model;
  const a = dict.appendix;
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.appendixDefinitions, dict.sections.appendix)}
  <div><h3 style="margin-bottom:1.5mm">${a.definitionsTitle}</h3>
  <table class="defs"><tbody>${model.appendix.definitions.map((row) => html`<tr><td class="term">${row.label}</td><td>${row.text}</td></tr>`)}</tbody></table></div>
  <div class="formula"><h3>${a.formulaTitle}</h3>
    <ol>${a.formulaSteps.map((step) => html`<li>${step}</li>`)}</ol>
    <div class="expr">${a.formulaExpression}</div>
    <p class="legend-text">${a.formulaLegend}</p>
    <p class="callout">${a.formulaNote}</p></div></section>`;
}

function renderAppendixData(model: ReportPdfViewModel): SafeHtml {
  const { dict } = model;
  const a = dict.appendix;
  return html`<section class="section">${sectionHead(SECTION_NUMBERS.appendixData, dict.sections.appendixData)}
  <div><h3 style="margin-bottom:1.5mm">${a.scopeTitle}</h3><table class="kv"><tbody>${model.appendix.scopeRows.map((row) => html`<tr><td class="key">${row.label}</td><td>${row.value}</td></tr>`)}</tbody></table></div>
  <div><h3 style="margin-bottom:2mm">${a.methodologyTitle}</h3><ul class="bullets">${model.appendix.methodology.map((text) => html`<li>${text}</li>`)}</ul></div>
  ${model.appendix.limitations.length ? html`<div><h3 style="margin-bottom:2mm">${a.limitationsTitle}</h3><ul class="bullets">${model.appendix.limitations.map((text) => html`<li>${text}</li>`)}</ul></div>` : ''}</section>`;
}

const RENDERERS: Record<ReportPdfSectionId, (model: ReportPdfViewModel, slice: ReportPdfSectionSlice) => SafeHtml> = {
  summary: renderSummary,
  kpis: renderKpis,
  trends: renderTrends,
  courses: renderCourses,
  portfolio: renderPortfolio,
  organization: renderOrganization,
  attention: renderAttention,
  recommendations: renderRecommendations,
  appendixDefinitions: renderAppendixDefinitions,
  appendixData: renderAppendixData,
};

export function renderReportPdfSection(model: ReportPdfViewModel, slice: ReportPdfSectionSlice): SafeHtml {
  return RENDERERS[slice.id](model, slice);
}

export function renderContentPage(model: ReportPdfViewModel, sections: ReportPdfSectionSlice[], pageNumber: number, totalPages: number): SafeHtml {
  const { dict } = model;
  const brand = model.tenant.logoDataUri
    ? html`<img src="${model.tenant.logoDataUri}" alt="">`
    : html`<span class="tenant">${model.tenant.name}</span>`;
  const sectionList = sections.map((slice) => (slice.from === undefined ? slice.id : `${slice.id}[${slice.from}-${slice.to}]`)).join(' ');
  return html`<section class="page" data-sections="${sectionList}">
  <header class="page-header"><div class="brandline">${brand}<span class="sep"></span><span class="doc">${model.title}</span></div><span class="period">${model.periodLabel}</span></header>
  <div class="page-body">${sections.map((slice) => RENDERERS[slice.id](model, slice))}</div>
  <footer class="page-footer"><span class="confidential">${ICON_LOCK}${dict.meta.confidentialFooter}</span><span>${dict.meta.dataAsOf({ date: model.generatedAtLabel })}</span><span class="page-no">${dict.meta.page({ current: String(pageNumber), total: String(totalPages) })}</span></footer>
</section>`;
}
