import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultProblemXml } from './course-authoring-problem-defaults.logic.js';

test('each Problem boilerplate creates its matching response type', () => {
  const expectedResponseByBoilerplate = {
    'multiplechoice.yaml': 'multiplechoiceresponse',
    'checkboxes_response.yaml': 'choiceresponse',
    'optionresponse.yaml': 'optionresponse',
    'numericalresponse.yaml': 'numericalresponse',
    'string_response.yaml': 'stringresponse',
  } as const;

  for (const [boilerplate, responseType] of Object.entries(expectedResponseByBoilerplate)) {
    const xml = getDefaultProblemXml(boilerplate);
    assert.match(xml, new RegExp(`<${responseType}(?:\\s|>)`));
    assert.match(xml, /<label>/);
  }
});

test('an absent or unknown Problem boilerplate remains single-choice', () => {
  assert.match(getDefaultProblemXml(), /<multiplechoiceresponse>/);
  assert.match(getDefaultProblemXml('unknown.yaml'), /<multiplechoiceresponse>/);
});
