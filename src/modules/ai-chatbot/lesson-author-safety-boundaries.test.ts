import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const chatServiceSource = readFileSync(fileURLToPath(new URL('./chat.service.ts', import.meta.url)), 'utf8');
const routeSource = readFileSync(fileURLToPath(new URL('./ai-chatbot.routes.ts', import.meta.url)), 'utf8');
const chatControllerSource = readFileSync(fileURLToPath(new URL('./chat.controller.ts', import.meta.url)), 'utf8');
const aiRagClientSource = readFileSync(fileURLToPath(new URL('./ai-rag-client.service.ts', import.meta.url)), 'utf8');
const courseAuthoringServiceSource = readFileSync(
  fileURLToPath(new URL('../course-authoring/course-authoring.service.ts', import.meta.url)),
  'utf8',
);

test('keeps generation proposal-first and reserves course mutation for the explicit Apply service', () => {
  const streamStart = chatServiceSource.indexOf('export async function sendMessageStream(');
  const applyStart = chatServiceSource.indexOf('export async function applyLessonAuthorJob(');
  assert.ok(streamStart > 0);
  assert.ok(applyStart > 0 && applyStart < streamStart);

  const streamSource = chatServiceSource.slice(streamStart);
  const applySource = chatServiceSource.slice(applyStart, streamStart);
  assert.match(streamSource, /createLessonAuthorJob\(/);
  assert.doesNotMatch(streamSource, /applyLessonAuthorProposalToCourse\(/);
  assert.match(applySource, /applyLessonAuthorProposalToCourse\(/);
});

test('keeps explicit Apply RBAC, source validation, target snapshots, and both AI engines wired', () => {
  assert.match(routeSource, /lesson-author\/jobs\/:jobId\/apply', checkPermission\('courses', 'can_edit'\)/);
  assert.match(chatServiceSource, /validateLessonAuthorSourceDocuments\(/);
  assert.match(chatServiceSource, /canonicalTargetSnapshot\(/);
  assert.match(chatServiceSource, /WHERE cb\.id = \$1[\s\S]+?AND cb\.course_id = \$2[\s\S]+?AND c\.tenant_id = \$3/);
  assert.match(chatServiceSource, /generateRagLessonAuthorBlueprint\(/);
  assert.match(chatServiceSource, /generateRagLessonAuthorProposal\(/);
  assert.match(chatServiceSource, /sendRagChat\(/);
  assert.match(chatServiceSource, /aiSettings\.activeEngine === 'gemini_file_search'/);
});

test('validates the Component Registry before proposal persistence and again inside Apply', () => {
  const proposalValidation = chatServiceSource.indexOf('assertLessonAuthorProposalComponentsValid(');
  const proposalPersistence = chatServiceSource.indexOf('createLessonAuthorJob(', proposalValidation);
  assert.ok(proposalValidation > 0 && proposalPersistence > proposalValidation);

  const applyStart = courseAuthoringServiceSource.indexOf('export async function applyLessonAuthorProposalToCourse(');
  const registryValidation = courseAuthoringServiceSource.indexOf('assertLessonAuthorProposalComponentsValid(', applyStart);
  const firstGeneratedWrite = courseAuthoringServiceSource.indexOf('getOrCreateGeneratedBlock(', applyStart);
  assert.ok(registryValidation > applyStart && registryValidation < firstGeneratedWrite);
});

test('opens Lesson Author SSE before asynchronous workflow preparation', () => {
  const sseHeaders = chatControllerSource.indexOf("'Content-Type': 'text/event-stream'");
  const flushHeaders = chatControllerSource.indexOf('res.flushHeaders();');
  const acceptedEvent = chatControllerSource.indexOf("stage: 'REQUEST_ACCEPTED'");
  const workflowStart = chatControllerSource.indexOf('await chatService.sendMessageStream(');

  assert.ok(sseHeaders >= 0);
  assert.ok(flushHeaders > sseHeaders);
  assert.ok(acceptedEvent > flushHeaders);
  assert.ok(workflowStart > acceptedEvent);
  assert.match(chatControllerSource, /if \(target === 'lesson_author'\) \{[\s\S]*?type: 'progress'/);
});

test('passes one Node-owned correlation ID to self-built-RAG Blueprint diagnostics only', () => {
  const blueprintStart = chatServiceSource.indexOf("if (ctx.target === LESSON_AUTHOR_TARGET && lessonAuthorIntent === 'course_blueprint')");
  const blueprintSource = chatServiceSource.slice(blueprintStart);
  assert.ok(blueprintStart > 0);
  assert.match(chatServiceSource, /lessonAuthorCorrelationId = ctx\.target === LESSON_AUTHOR_TARGET \? randomUUID\(\) : null/);
  assert.match(blueprintSource, /generateRagLessonAuthorBlueprint\(\{[\s\S]*?correlation_id: lessonAuthorCorrelationId \?\? undefined/);
  assert.match(blueprintSource, /course_id: ctx\.courseId \?\? undefined/);
  assert.match(blueprintSource, /logLessonAuthorFlow\('blueprint_branch_failed', \{[\s\S]*?correlation_id: lessonAuthorCorrelationId/);
  assert.match(aiRagClientSource, /correlation_id\?: string/);
});
