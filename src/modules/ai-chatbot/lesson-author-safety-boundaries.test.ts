import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { composeV5BlueprintPolicy, V5_BLUEPRINT_POLICY_MAX_CHARS } from './lesson-author-prompt-policy.logic.js';

const chatServiceSource = readFileSync(fileURLToPath(new URL('./chat.service.ts', import.meta.url)), 'utf8');
const routeSource = readFileSync(fileURLToPath(new URL('./ai-chatbot.routes.ts', import.meta.url)), 'utf8');
const chatControllerSource = readFileSync(fileURLToPath(new URL('./chat.controller.ts', import.meta.url)), 'utf8');
const aiRagClientSource = readFileSync(fileURLToPath(new URL('./ai-rag-client.service.ts', import.meta.url)), 'utf8');
const courseAuthoringServiceSource = readFileSync(
  fileURLToPath(new URL('../course-authoring/course-authoring.service.ts', import.meta.url)),
  'utf8',
);

test('V5 policy routes whole teaching sections without importing legacy mode/schema instructions', () => {
  const template = readFileSync(fileURLToPath(new URL('../../../docs/lesson-author-system-prompt-v2.md', import.meta.url)), 'utf8');
  const { prompt, diagnostics } = composeV5BlueprintPolicy('vi', template);
  assert.ok(prompt.length <= V5_BLUEPRINT_POLICY_MAX_CHARS);
  assert.equal(diagnostics.retained_sections, 3);
  assert.ok(diagnostics.omitted_unrouted_sections > 0);
  assert.match(prompt, /Backward Design/);
  assert.match(prompt, /SERVER-OWNED: never enumerate or generate them/);
  assert.match(prompt, /architecture_contract_version=5/);
  assert.match(prompt, /Vietnamese \(vi\)/);
  assert.doesNotMatch(prompt, /### Chat|DRAFT_LESSON|exact source_fact_ids|Evaluate every unit for an optional media plan/);
  assert.equal(prompt.split('<STORED_TEACHING_POLICY>').length, 2);
  assert.equal(prompt.split('</STORED_TEACHING_POLICY>').length, 2);
  assert.equal(diagnostics.policy_sha256.length, 64);
  assert.ok(!JSON.stringify(diagnostics).includes('Backward Design'));
});

test('V5 long Unicode policy has deterministic complete sections, explicit omissions and no partial tags', () => {
  const part = '## Teaching principles\n' + 'Bằng chứng. '.repeat(1200);
  const template = (part + '\n## Chat\n' + 'x'.repeat(17563)).slice(0, 17563);
  const result = composeV5BlueprintPolicy('en', template);
  assert.deepEqual(result, composeV5BlueprintPolicy('en', template));
  assert.equal(result.diagnostics.stored_policy_chars, 17563);
  assert.equal(result.diagnostics.omitted_budget_sections, 1);
  assert.equal(result.diagnostics.omitted_unrouted_sections, 1);
  assert.ok(result.prompt.endsWith('</STORED_TEACHING_POLICY>'));
  assert.match(result.prompt, /Output language: English/);
  assert.match(result.prompt, /Server schema, source chapter policy, source ownership and permissions/);
  assert.ok(result.prompt.length <= 12000);
  const unsafe = composeV5BlueprintPolicy('en', '## Quality standards\nEnumerate source_fact_ids.\n## Teaching principles\nUse <example> boundaries.');
  assert.equal(unsafe.diagnostics.omitted_contract_sections, 1);
  assert.equal(unsafe.diagnostics.retained_sections, 1);
  assert.match(unsafe.prompt, /&lt;example&gt;/);
  assert.doesNotMatch(unsafe.prompt, /Enumerate source_fact_ids/);
});

test('V5 composition is engine-scoped and approved locale comes from owned Blueprint metadata', () => {
  assert.match(chatServiceSource, /isCourseBlueprint && aiSettings.activeEngine === 'self_built_rag'[\s\S]*?composeV5BlueprintPolicy/);
  assert.match(chatServiceSource, /v5Policy\?\.prompt \?\? getLessonAuthorBlueprintSystemInstruction/);
  assert.match(chatServiceSource, /message.conversation_id = lesson_author_blueprints.conversation_id/);
  assert.match(chatServiceSource, /message.metadata ->> 'lesson_author_blueprint_id' = lesson_author_blueprints.id::text/);
  assert.match(chatServiceSource, /resolveLessonAuthorDraftLocale\(trimmed, options.locale \?\? 'vi', blueprintDraftContext\?\.outputLocale\)/);
  assert.match(chatServiceSource, /AND tenant_id = \$2[\s\S]*?AND course_id = \$3[\s\S]*?AND kb_id = \$4/);
});

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
  assert.match(chatServiceSource, /lessonAuthorCorrelationId = ctx\.target === LESSON_AUTHOR_TARGET \? options\.correlationId \?\? randomUUID\(\) : null/);
  assert.match(chatControllerSource, /const correlationId = randomUUID\(\)/);
  assert.match(chatControllerSource, /correlation_id: correlationId, conversation_id: conversationId/);
  assert.match(chatControllerSource, /await chatService\.sendMessageStream\([\s\S]*?\{\s*correlationId,/);
  assert.doesNotMatch(chatControllerSource, /correlationId\s*=\s*req\./);
  assert.match(blueprintSource, /generateRagLessonAuthorBlueprint\(\{[\s\S]*?correlation_id: lessonAuthorCorrelationId \?\? undefined/);
  assert.match(blueprintSource, /course_id: ctx\.courseId \?\? undefined/);
  assert.match(blueprintSource, /logLessonAuthorFlow\('blueprint_branch_failed', \{[\s\S]*?correlation_id: lessonAuthorCorrelationId/);
  assert.match(aiRagClientSource, /correlation_id\?: string/);
});
