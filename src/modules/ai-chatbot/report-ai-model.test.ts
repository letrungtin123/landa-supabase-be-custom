import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinkingLevel } from '@google/genai';
import { REPORT_AI_THINKING_HEADROOM_TOKENS, reportAiGenerationConfig, resolveReportAiModel } from './report-ai-model.js';

test('report AI calls default to the platform report model, not the tenant chat model', () => {
  assert.equal(resolveReportAiModel('gemini-3.5-flash'), 'gemini-3.8-flash');
});

test('Gemini 3.8 gets a low thinking level, thinking headroom and no temperature', () => {
  for (const model of ['gemini-3.8-flash', 'models/gemini-3.8-flash', ' Gemini-3.8-Flash ']) {
    const config = reportAiGenerationConfig(model, 256, { temperature: 0.3 });
    assert.deepEqual(config, { maxOutputTokens: 256 + REPORT_AI_THINKING_HEADROOM_TOKENS, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
  }
});

test('other models keep their sampling settings and still get thinking headroom', () => {
  assert.deepEqual(reportAiGenerationConfig('gemini-3.5-flash', 800, { temperature: 0.3 }),
    { maxOutputTokens: 800 + REPORT_AI_THINKING_HEADROOM_TOKENS, temperature: 0.3 });
  assert.deepEqual(reportAiGenerationConfig('gemini-3.5-flash', 800), { maxOutputTokens: 800 + REPORT_AI_THINKING_HEADROOM_TOKENS });
});
