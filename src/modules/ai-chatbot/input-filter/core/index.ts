// ============================================================
// INDEX - Entry point cho chatbot-input-filter
// ============================================================

// --- Pipeline ---
export { runFilterPipeline } from './pipeline/filter-pipeline.js';

// --- Types ---
export { FilterRejectCode } from './types/filter.types.js';
export type {
    FilterResult,
    FilterPipelineConfig,
    FilterPipelineOptions,
    FilterSteps,
    ProfanitySeverity,
    LengthConfig,
    GibberishConfig,
    LanguageConfig,
    RepeatConfig,
    ProfanityConfig,
} from './types/filter.types.js';

// --- Utils ---
export { normalizeText } from './utils/normalize.js';
export { calculateShannonEntropy } from './utils/entropy.js';

// --- Config ---
export { DEFAULT_BLACKLIST_VI, DEFAULT_BLACKLIST_EN } from './config/default-profanity.js';

// --- Filters (dùng độc lập nếu cần) ---
export { checkLength } from './filters/length.filter.js';
export { checkLanguage } from './filters/language.filter.js';
export { checkGibberish } from './filters/gibberish.filter.js';
export { checkRepeat } from './filters/repeat.filter.js';
export { checkProfanity } from './filters/profanity.filter.js';
