// ============================================================
// FILTER PIPELINE - Điều phối toàn bộ filter
// ============================================================
// Thứ tự cố định:
// RAW -> [Length] -> Normalize -> [Language] -> [Gibberish] -> [Repeat] -> [Profanity]
// Mỗi bước có thể bật/tắt qua options.steps
// Normalize luôn chạy (các bước sau phụ thuộc)
// Config do consumer truyền vào — không có default nội bộ

import type { FilterResult, FilterPipelineOptions, FilterSteps } from '../types/filter.types.js';
import { normalizeText } from '../utils/normalize.js';
import { checkLength } from '../filters/length.filter.js';
import { checkLanguage } from '../filters/language.filter.js';
import { checkGibberish } from '../filters/gibberish.filter.js';
import { checkRepeat } from '../filters/repeat.filter.js';
import { checkProfanity } from '../filters/profanity.filter.js';

// Mặc định: tất cả bước đều bật (nếu consumer không truyền steps)
const DEFAULT_STEPS: Required<FilterSteps> = {
    length: true,
    normalize: true,
    language: true,
    gibberish: true,
    repeat: true,
    profanity: true,
};

/**
 * Chạy filter pipeline
 *
 * @param rawInput - Input gốc từ user
 * @param options - sessionId, config (bắt buộc), redisClient, steps, debug
 * @returns FilterResult (chỉ có code + detail, không có message)
 *
 * @example
 * const result = await runFilterPipeline(message, {
 *   sessionId: conversationId,
 *   config: {
 *     length: { min: 2, max: 2000 },
 *     gibberish: { minEntropyThreshold: 1.5, maxRepeatRatio: 0.6, minValidCharRatio: 0.5, maxConsonantCluster: 5 },
 *     language: { foreignCharThreshold: 0.3 },
 *     repeat: { maxRepeatCount: 3, ttlSeconds: 300 },
 *     profanity: { blockSeverity: 'HIGH' },
 *   },
 *   redisClient: getRedis(),
 *   steps: { length: true, language: true, gibberish: true, repeat: true, profanity: false },
 *   debug: false,
 * });
 *
 * if (!result.passed) {
 *   const replyMessage = MY_TEMPLATES[result.code]; // BE tự map
 * }
 */
export async function runFilterPipeline(
    rawInput: string,
    options: FilterPipelineOptions
): Promise<FilterResult> {
    const startTime = performance.now();

    const sessionId = options.sessionId;
    const debug = options.debug || false;
    const redisClient = options.redisClient || null;
    const redisKeyPrefix = options.redisKeyPrefix || 'input-filter:repeat';
    const repeatFallbackCounter = options.repeatFallbackCounter ?? null;
    const config = options.config;

    // Merge steps: user override + default (tất cả bật)
    const steps: Required<FilterSteps> = { ...DEFAULT_STEPS, ...options.steps };

    if (debug) {
        console.log('');
        console.log('==========================================================');
        console.log('[pipeline] 🚀 BẮT ĐẦU FILTER PIPELINE');
        console.log(`[pipeline] Input: "${rawInput.substring(0, 100)}${rawInput.length > 100 ? '...' : ''}"`);
        console.log(`[pipeline] Session: ${sessionId}`);
        console.log(`[pipeline] Steps: ${JSON.stringify(steps)}`);
        console.log(`[pipeline] Config: ${JSON.stringify(config)}`);
        console.log(`[pipeline] Redis: ${redisClient ? 'connected' : 'NOT provided'}`);
        console.log('==========================================================');
    }

    // ===== STEP 1: LENGTH CHECK =====
    if (steps.length) {
        if (debug) console.log('\n[pipeline] --- STEP 1: LENGTH CHECK ---');
        const lengthResult = checkLength(rawInput, config.length, debug);
        if (!lengthResult.passed) {
            lengthResult.processingTimeMs = performance.now() - startTime;
            if (debug) console.log(`[pipeline] ⛔ BLOCKED: ${lengthResult.code} (${lengthResult.processingTimeMs.toFixed(2)}ms)`);
            return lengthResult;
        }
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 1: LENGTH CHECK [TẮT] ---');
    }

    // ===== STEP 2: NORMALIZE =====
    let normalizedText: string;
    if (steps.normalize) {
        if (debug) console.log('\n[pipeline] --- STEP 2: NORMALIZE ---');
        normalizedText = normalizeText(rawInput, debug);
        if (debug) console.log(`[pipeline] Normalized: "${normalizedText.substring(0, 100)}"`);
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 2: NORMALIZE [TẮT] ---');
        normalizedText = rawInput.trim();
    }

    // ===== STEP 3: LANGUAGE CHECK =====
    if (steps.language) {
        if (debug) console.log('\n[pipeline] --- STEP 3: LANGUAGE CHECK ---');
        const languageResult = checkLanguage(normalizedText, config.language, debug);
        if (!languageResult.passed) {
            languageResult.processingTimeMs = performance.now() - startTime;
            if (debug) console.log(`[pipeline] ⛔ BLOCKED: ${languageResult.code} (${languageResult.processingTimeMs.toFixed(2)}ms)`);
            return languageResult;
        }
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 3: LANGUAGE CHECK [TẮT] ---');
    }

    // ===== STEP 4: GIBBERISH CHECK =====
    if (steps.gibberish) {
        if (debug) console.log('\n[pipeline] --- STEP 4: GIBBERISH CHECK ---');
        const gibberishResult = checkGibberish(normalizedText, config.gibberish, debug);
        if (!gibberishResult.passed) {
            gibberishResult.processingTimeMs = performance.now() - startTime;
            if (debug) console.log(`[pipeline] ⛔ BLOCKED: ${gibberishResult.code} (${gibberishResult.processingTimeMs.toFixed(2)}ms)`);
            return gibberishResult;
        }
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 4: GIBBERISH CHECK [TẮT] ---');
    }

    // ===== STEP 5: REPEAT CHECK (Redis) =====
    if (steps.repeat) {
        if (debug) console.log('\n[pipeline] --- STEP 5: REPEAT CHECK (Redis) ---');
        const repeatResult = await checkRepeat(normalizedText, sessionId, config.repeat, redisClient, redisKeyPrefix, debug, repeatFallbackCounter);
        if (!repeatResult.passed) {
            repeatResult.processingTimeMs = performance.now() - startTime;
            if (debug) console.log(`[pipeline] ⛔ BLOCKED: ${repeatResult.code} (${repeatResult.processingTimeMs.toFixed(2)}ms)`);
            return repeatResult;
        }
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 5: REPEAT CHECK [TẮT] ---');
    }

    // ===== STEP 6: PROFANITY CHECK =====
    if (steps.profanity) {
        if (debug) console.log('\n[pipeline] --- STEP 6: PROFANITY CHECK ---');
        const profanityResult = checkProfanity(normalizedText, config.profanity, debug);
        if (!profanityResult.passed) {
            profanityResult.processingTimeMs = performance.now() - startTime;
            if (debug) console.log(`[pipeline] ⛔ BLOCKED: ${profanityResult.code} (${profanityResult.processingTimeMs.toFixed(2)}ms)`);
            return profanityResult;
        }
    } else {
        if (debug) console.log('\n[pipeline] --- STEP 6: PROFANITY CHECK [TẮT] ---');
    }

    // ===== PASS =====
    const processingTimeMs = performance.now() - startTime;
    if (debug) {
        console.log('');
        console.log(`[pipeline] ✅✅✅ PASS (${processingTimeMs.toFixed(2)}ms)`);
        console.log('==========================================================');
    }

    return {
        passed: true,
        code: 'PASS',
        processingTimeMs,
    };
}
