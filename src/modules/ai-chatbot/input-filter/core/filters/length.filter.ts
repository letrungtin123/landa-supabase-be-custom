// ============================================================
// LENGTH FILTER - Kiểm tra độ dài input
// ============================================================

import { FilterRejectCode } from '../types/filter.types.js';
import type { FilterResult, LengthConfig } from '../types/filter.types.js';

// Emoji regex
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

// URL regex
const URL_REGEX = /https?:\/\/[^\s]+/gi;

function isEmojiOnly(text: string): boolean {
    const withoutEmoji = text.replace(EMOJI_REGEX, '').replace(/\s/g, '');
    return withoutEmoji.length === 0;
}

function isUrlOnly(text: string): boolean {
    const withoutUrl = text.replace(URL_REGEX, '').replace(/\s/g, '');
    return withoutUrl.length === 0;
}

export function checkLength(rawInput: string, config: LengthConfig, debug: boolean = false): FilterResult {
    const trimmed = rawInput.trim();
    const length = trimmed.length;

    if (debug) console.log(`[length-filter] Input length: ${length}, min: ${config.min}, max: ${config.max}`);

    // Rỗng
    if (length === 0) {
        if (debug) console.log('[length-filter] ❌ EMPTY');
        return { passed: false, code: FilterRejectCode.EMPTY, detail: 'Input rỗng sau khi trim' };
    }

    // Chỉ emoji
    if (isEmojiOnly(trimmed)) {
        if (debug) console.log('[length-filter] ❌ EMPTY (emoji only)');
        return { passed: false, code: FilterRejectCode.EMPTY, detail: 'Tin nhắn chỉ chứa emoji' };
    }

    // Chỉ URL
    if (isUrlOnly(trimmed)) {
        if (debug) console.log('[length-filter] ❌ EMPTY (URL only)');
        return { passed: false, code: FilterRejectCode.EMPTY, detail: 'Tin nhắn chỉ chứa link' };
    }

    // Quá ngắn
    if (length < config.min) {
        if (debug) console.log(`[length-filter] ❌ TOO_SHORT (${length} < ${config.min})`);
        return { passed: false, code: FilterRejectCode.TOO_SHORT, detail: `Độ dài ${length} < min ${config.min}` };
    }

    // Quá dài
    if (length > config.max) {
        if (debug) console.log(`[length-filter] ❌ TOO_LONG (${length} > ${config.max})`);
        return { passed: false, code: FilterRejectCode.TOO_LONG, detail: `Độ dài ${length} > max ${config.max}` };
    }

    if (debug) console.log(`[length-filter] ✅ PASS (length=${length})`);
    return { passed: true, code: 'PASS' };
}
