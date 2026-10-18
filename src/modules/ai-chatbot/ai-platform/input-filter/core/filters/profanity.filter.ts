// ============================================================
// PROFANITY FILTER - Phát hiện ngôn từ thô tục
// ============================================================
// Blacklist = DEFAULT (hardcoded) + DB (user thêm qua UI)
// Gộp 2 nguồn, loại trùng bằng Set, rồi check

import { FilterRejectCode } from '../types/filter.types.js';
import type { FilterResult, ProfanityConfig } from '../types/filter.types.js';
import { DEFAULT_BLACKLIST_VI, DEFAULT_BLACKLIST_EN } from '../config/default-profanity.js';

function createObfuscationPattern(word: string): RegExp {
    const chars = [...word];
    const pattern = chars.join('[.\\-_\\s*]{0,3}');
    return new RegExp(`(?:^|\\s|[.!?])${pattern}(?:\\s|$|[.!?])`, 'i');
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Gộp hardcoded + DB blacklist, loại trùng */
function mergeBlacklist(defaults: string[], dbList: string[]): string[] {
    return [...new Set([...defaults, ...dbList])].map(w => w.toLowerCase());
}

export function checkProfanity(normalizedText: string, config: ProfanityConfig, debug: boolean = false): FilterResult {
    const lowerText = normalizedText.toLowerCase();

    if (debug) console.log(`[profanity-filter] Checking (severity: ${config.blockSeverity})`);

    // Tiếng Việt (HIGH) — gộp DEFAULT + DB
    const viBlacklist = mergeBlacklist(DEFAULT_BLACKLIST_VI, config.blacklistVi || []);
    if (debug) console.log(`[profanity-filter] VI blacklist: ${viBlacklist.length} words (default: ${DEFAULT_BLACKLIST_VI.length}, db: ${(config.blacklistVi || []).length})`);

    for (const word of viBlacklist) {
        const wordPattern = new RegExp(`(?:^|\\s)${escapeRegex(word)}(?:\\s|$)`, 'i');
        if (wordPattern.test(lowerText) || lowerText === word) {
            if (debug) console.log(`[profanity-filter] ❌ VI exact: "${word}"`);
            return { passed: false, code: FilterRejectCode.PROFANITY, detail: `VI: "${word}"` };
        }

        if (word.length >= 2) {
            const obfPattern = createObfuscationPattern(word);
            if (obfPattern.test(lowerText)) {
                if (debug) console.log(`[profanity-filter] ❌ VI obfuscation: "${word}"`);
                return { passed: false, code: FilterRejectCode.PROFANITY, detail: `VI obfuscation: "${word}"` };
            }
        }
    }

    // Tiếng Anh (MEDIUM) — gộp DEFAULT + DB
    if (config.blockSeverity === 'MEDIUM') {
        const enBlacklist = mergeBlacklist(DEFAULT_BLACKLIST_EN, config.blacklistEn || []);
        if (debug) console.log(`[profanity-filter] EN blacklist: ${enBlacklist.length} words (default: ${DEFAULT_BLACKLIST_EN.length}, db: ${(config.blacklistEn || []).length})`);

        for (const word of enBlacklist) {
            const wordPattern = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
            if (wordPattern.test(lowerText)) {
                if (debug) console.log(`[profanity-filter] ❌ EN: "${word}"`);
                return { passed: false, code: FilterRejectCode.PROFANITY, detail: `EN: "${word}"` };
            }
        }
    }

    if (debug) console.log('[profanity-filter] ✅ PASS');
    return { passed: true, code: 'PASS' };
}
