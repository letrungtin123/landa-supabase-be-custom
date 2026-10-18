import { readdirSync, readFileSync } from 'node:fs';

// Source pins of the chat turn. chat.service.ts moved its AI ID V1 /
// lesson-author legacy code to the ai-id/legacy/ folder, and the helpers both share to
// ./chat.constants.ts, ./chat.types.ts, ./chat-turn-runtime.service.ts and
// ./chat-turn.logic.ts (move only, re-exported by chat.service.ts). Tests that
// pin its wording read them as one text: the legacy files sorted by name, the
// shared files, then chat.service.ts last, so sendMessageStream stays the last
// function of the text, as it was of the file.
const LEGACY_DIRECTORY = new URL('./ai-id/legacy/', import.meta.url);
const SHARED_FILES = [
  new URL('./chat.constants.ts', import.meta.url),
  new URL('./chat.types.ts', import.meta.url),
  new URL('./chat-turn-runtime.service.ts', import.meta.url),
  new URL('./chat-turn.logic.ts', import.meta.url),
];
const CHAT_SERVICE_FILE = new URL('./chat.service.ts', import.meta.url);

/** chat.service.ts and the code it moved out, as one text. */
export function readChatServiceSource(): string {
  const legacy = readdirSync(LEGACY_DIRECTORY)
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => new URL(name, LEGACY_DIRECTORY));
  return [...legacy, ...SHARED_FILES, CHAT_SERVICE_FILE].map(file => readFileSync(file, 'utf8')).join('\n');
}
