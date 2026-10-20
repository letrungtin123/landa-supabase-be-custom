// Preloaded (`tsx --import`) by the AI ID test suites: scripts/test-lesson-author-orchestration-v2.mjs and the
// test:lesson-author* scripts of package.json. In those suites a value that is not plain JSON reaching
// orchestrationV2Hash or idmHash throws CANONICAL_JSON_INVALID with its JSON path, so a producer that builds
// one fails its tests. Production logs the violation and hashes the value as persisted instead
// (lesson-author-orchestration-v2-canonical-json.logic.ts).
import { setCanonicalJsonHashPolicy } from '../modules/ai-chatbot/ai-id/lesson-author-orchestration-v2-canonical-json.logic.js';

setCanonicalJsonHashPolicy({ mode: 'throw' });
