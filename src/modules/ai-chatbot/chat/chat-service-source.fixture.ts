import { readdirSync, readFileSync } from 'node:fs';

// Source pins of the chat turn. chat.service.ts moved its AI ID V1 /
// lesson-author legacy code to the ai-id/legacy/ folder, and the helpers both share to
// ./chat.constants.ts, ./chat.types.ts, ./chat-turn-runtime.service.ts and
// ./chat-turn.logic.ts (move only, re-exported by chat.service.ts). Its
// sendMessageStream was split into stage files (./chat-turn-*.ts and
// ai-id/legacy/chat-turn-*.ts, move only). Tests that pin its wording read
// them as one text: the legacy files sorted by name, the shared files,
// chat.service.ts, then the stage files in the order the turn runs them, so
// sendMessageStream and its stages stay the last code of the text, in the
// order they were in the file.
const LEGACY_DIRECTORY = new URL('../ai-id/legacy/', import.meta.url);
const SHARED_FILES = [
  new URL('./chat.constants.ts', import.meta.url),
  new URL('./chat.types.ts', import.meta.url),
  new URL('./chat-turn-runtime.service.ts', import.meta.url),
  new URL('./chat-turn.logic.ts', import.meta.url),
];
const CHAT_SERVICE_FILE = new URL('./chat.service.ts', import.meta.url);
/** The stages of sendMessageStream, in the order of the turn. */
const STAGE_FILES = [
  new URL('./chat-course-context.service.ts', import.meta.url),
  new URL('./chat-response-emitter.logic.ts', import.meta.url),
  new URL('./chat-turn.types.ts', import.meta.url),
  new URL('./chat-turn-admission.service.ts', import.meta.url),
  new URL('./chat-turn-context.service.ts', import.meta.url),
  new URL('../ai-id/legacy/chat-turn-context.service.ts', import.meta.url),
  new URL('./chat-turn-reserve.service.ts', import.meta.url),
  new URL('./chat-turn-persist.service.ts', import.meta.url),
  new URL('./chat-turn-report.service.ts', import.meta.url),
  new URL('../ai-id/legacy/chat-turn-intent.service.ts', import.meta.url),
  new URL('../ai-id/legacy/chat-turn-blueprint.service.ts', import.meta.url),
  new URL('../ai-id/legacy/chat-turn-draft.service.ts', import.meta.url),
  new URL('./chat-turn-prompt.service.ts', import.meta.url),
  new URL('./chat-turn-stream.service.ts', import.meta.url),
  new URL('./chat-turn-settle.service.ts', import.meta.url),
];

/** chat.service.ts and the code it moved out, as one text. */
export function readChatServiceSource(): string {
  const legacy = readdirSync(LEGACY_DIRECTORY)
    .filter(name => name.endsWith('.ts') && !name.startsWith('chat-turn-'))
    .sort()
    .map(name => new URL(name, LEGACY_DIRECTORY));
  return [...legacy, ...SHARED_FILES, CHAT_SERVICE_FILE, ...STAGE_FILES].map(file => readFileSync(file, 'utf8')).join('\n');
}
