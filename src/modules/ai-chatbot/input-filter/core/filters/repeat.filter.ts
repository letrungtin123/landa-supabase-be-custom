// ============================================================
// REPEAT SENTENCE FILTER - Hash Counter (Redis INCR)
// ============================================================
// Thay vì lưu list full message, dùng INCR counter per message hash
// Mỗi tin nhắn unique = 1 key Redis (~80 bytes), tự expire theo TTL
// O(1) thay vì O(n), tốn ít memory hơn 10x so với List

import { createHash } from 'crypto';
import { FilterRejectCode } from '../types/filter.types.js';
import type { FilterResult, RepeatConfig, RepeatFallbackCounter } from '../types/filter.types.js';

const DEFAULT_KEY_PREFIX = 'input-filter:repeat';

/**
 * Chuẩn hoá text trước khi so sánh:
 * - lowercase
 * - bỏ hết dấu câu, ký tự đặc biệt (chỉ giữ chữ + số + space)
 * - gộp whitespace
 * - trim
 *
 * Mục đích: "xin chào bạn", "xin chào bạn!!", "xin chào bạn--" → cùng 1 chuỗi
 */
export function normalizeRepeatCompareText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')  // chỉ giữ chữ (Unicode), số, space
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Hash text thành 16 ký tự hex (SHA-256 cắt 16 char đầu)
 * 16 hex = 64 bit = xác suất trùng hash ≈ 0 cho use case này
 */
function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Tạo Redis key: {prefix}:{sessionId}:{hash}
 */
function getRedisKey(sessionId: string, msgHash: string, keyPrefix: string): string {
    return `${keyPrefix}:${sessionId}:${msgHash}`;
}

/**
 * Check repeat bằng Redis INCR counter.
 *
 * Flow:
 *   1. Normalize text → bỏ dấu câu, lowercase, gộp space
 *   2. Hash → 16 char hex
 *   3. INCR key → count
 *   4. Set EXPIRE (chỉ lần đầu, khi count === 1)
 *   5. count >= maxRepeatCount → BLOCK
 *
 * @param normalizedText - Text đã qua normalize pipeline (bước 2)
 * @param sessionId - ID phiên chat
 * @param config - { maxRepeatCount, ttlSeconds }
 * @param redisClient - Redis client (nếu null → skip)
 * @param keyPrefix - Prefix cho Redis key
 * @param debug - Log chi tiết
 */
export async function checkRepeat(
    normalizedText: string,
    sessionId: string,
    config: RepeatConfig,
    redisClient: any,
    keyPrefix: string = DEFAULT_KEY_PREFIX,
    debug: boolean = false,
    fallbackCounter?: RepeatFallbackCounter | null
): Promise<FilterResult> {
    // Chuẩn hoá mạnh hơn cho so sánh: bỏ dấu câu, ký tự đặc biệt
    const compareText = normalizeRepeatCompareText(normalizedText);
    const msgHash = hashText(compareText);
    const redisKey = getRedisKey(sessionId, msgHash, keyPrefix);

    if (debug) {
        console.log(`[repeat-filter] Session: ${sessionId}`);
        console.log(`[repeat-filter] Compare text: "${compareText}"`);
        console.log(`[repeat-filter] Hash: ${msgHash}`);
        console.log(`[repeat-filter] Redis key: ${redisKey}`);
    }

    // Không có Redis → skip
    if (!redisClient) {
        if (debug) console.log('[repeat-filter] ⚠️ No Redis, skipping');
        if (fallbackCounter) {
            return fallbackCounter({ normalizedText, compareText, sessionId, config, keyPrefix, debug });
        }
        return { passed: true, code: 'PASS' };
    }

    try {
        // INCR atomic: tạo key nếu chưa có, tăng 1 nếu đã có → trả count
        const count: number = await redisClient.incr(redisKey);

        // Set TTL chỉ lần đầu tiên (count === 1 = key vừa được tạo)
        if (count === 1) {
            await redisClient.expire(redisKey, config.ttlSeconds);
        }

        if (debug) console.log(`[repeat-filter] Count: ${count}/${config.maxRepeatCount}`);

        if (count >= config.maxRepeatCount) {
            if (debug) console.log('[repeat-filter] ❌ REPEATED_SENTENCE');
            return {
                passed: false,
                code: FilterRejectCode.REPEATED_SENTENCE,
                detail: `Lặp ${count} lần trong ${config.ttlSeconds}s`,
            };
        }

        if (debug) console.log('[repeat-filter] ✅ PASS');
        return { passed: true, code: 'PASS' };

    } catch (error) {
        console.error('[repeat-filter] ⚠️ Redis error, using fallback when available:', error);
        if (fallbackCounter) {
            return fallbackCounter({ normalizedText, compareText, sessionId, config, keyPrefix, debug });
        }
        return { passed: true, code: 'PASS' };
    }
}
