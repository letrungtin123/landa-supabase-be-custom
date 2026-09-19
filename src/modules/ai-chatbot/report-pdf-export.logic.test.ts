import assert from 'node:assert/strict';
import test from 'node:test';
import { getReportPdfExportPhaseIndex, isReportPdfExportTerminal } from './report-pdf-export.logic.js';

test('orders report PDF export phases without treating in-flight phases as complete', () => {
  assert.ok(getReportPdfExportPhaseIndex('validating') < getReportPdfExportPhaseIndex('narrative'));
  assert.ok(getReportPdfExportPhaseIndex('narrative') < getReportPdfExportPhaseIndex('rendering'));
  assert.ok(getReportPdfExportPhaseIndex('rendering') < getReportPdfExportPhaseIndex('ready'));
  assert.equal(isReportPdfExportTerminal('rendering'), false);
  assert.equal(isReportPdfExportTerminal('ready'), true);
  assert.equal(isReportPdfExportTerminal('failed'), true);
});
