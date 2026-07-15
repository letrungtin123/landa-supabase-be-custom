// ============================================================
// GIBBERISH FILTER - Chặn nội dung vô nghĩa
// ============================================================

import { FilterRejectCode } from '../types/filter.types.js';
import type { FilterResult, GibberishConfig } from '../types/filter.types.js';
import { calculateShannonEntropy } from '../utils/entropy.js';

const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const VALID_CHAR_REGEX = /[\p{L}\p{N}\p{Z}\p{M}]/gu;
const CONSONANT_CLUSTER_REGEX = /[bcdfghjklmnpqrstvwxyz]{2,}/gi;
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

const VOWELS = 'aeiouyàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ';

function isEmojiOnly(text: string): boolean {
    return text.replace(EMOJI_REGEX, '').replace(/\s/g, '').length === 0;
}

function hasVowel(word: string): boolean {
    const lowerWord = word.toLowerCase();
    for (const char of lowerWord) {
        if (VOWELS.includes(char)) return true;
    }
    return false;
}

export function checkGibberish(normalizedText: string, config: GibberishConfig, debug: boolean = false): FilterResult {
    if (debug) console.log(`[gibberish-filter] Checking: "${normalizedText.substring(0, 50)}..."`);

    // Emoji only → cho qua
    if (isEmojiOnly(normalizedText)) {
        if (debug) console.log('[gibberish-filter] ✅ PASS (emoji only)');
        return { passed: true, code: 'PASS' };
    }

    // CHECK 1: Binary/control chars
    const controlChars = normalizedText.match(CONTROL_CHAR_REGEX);
    if (controlChars && controlChars.length > 0) {
        if (debug) console.log(`[gibberish-filter] ❌ BINARY_GARBAGE`);
        return { passed: false, code: FilterRejectCode.BINARY_GARBAGE, detail: `${controlChars.length} control chars` };
    }

    // CHECK 2: Valid char ratio
    const validChars = normalizedText.match(VALID_CHAR_REGEX);
    const validCharRatio = (validChars ? validChars.length : 0) / normalizedText.length;
    if (debug) console.log(`[gibberish-filter] Valid ratio: ${(validCharRatio * 100).toFixed(1)}%`);
    if (validCharRatio < config.minValidCharRatio) {
        return { passed: false, code: FilterRejectCode.GIBBERISH, detail: `Valid char ratio: ${(validCharRatio * 100).toFixed(1)}%` };
    }

    // CHECK 3: Shannon entropy (>= 4 chars)
    if (normalizedText.length >= 4) {
        const entropy = calculateShannonEntropy(normalizedText, debug);
        if (debug) console.log(`[gibberish-filter] Entropy: ${entropy.toFixed(4)}`);
        if (entropy < config.minEntropyThreshold) {
            return { passed: false, code: FilterRejectCode.GIBBERISH, detail: `Entropy: ${entropy.toFixed(4)}` };
        }
    }

    // CHECK 4: Repeat ratio
    const charFreq: Map<string, number> = new Map();
    for (const char of normalizedText) {
        charFreq.set(char, (charFreq.get(char) || 0) + 1);
    }
    let maxCharCount = 0;
    for (const count of charFreq.values()) {
        if (count > maxCharCount) maxCharCount = count;
    }
    const repeatRatio = maxCharCount / normalizedText.length;
    if (debug) console.log(`[gibberish-filter] Repeat ratio: ${(repeatRatio * 100).toFixed(1)}%`);
    if (repeatRatio > config.maxRepeatRatio) {
        return { passed: false, code: FilterRejectCode.GIBBERISH, detail: `Repeat ratio: ${(repeatRatio * 100).toFixed(1)}%` };
    }

    // CHECK 5: Vowelless words (>= 2 words)
    const words = normalizedText.split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 2) {
        let noVowelCount = 0;
        for (const word of words) {
            if (/\p{L}/u.test(word) && !hasVowel(word)) noVowelCount++;
        }
        const noVowelRatio = noVowelCount / words.length;
        if (noVowelRatio > 0.7 && words.length >= 3) {
            return { passed: false, code: FilterRejectCode.GIBBERISH, detail: `${noVowelCount}/${words.length} vowelless words` };
        }
    }

    // CHECK 6: Consonant clusters
    const clusters = normalizedText.match(CONSONANT_CLUSTER_REGEX);
    if (clusters) {
        for (const cluster of clusters) {
            if (cluster.length > config.maxConsonantCluster) {
                return { passed: false, code: FilterRejectCode.GIBBERISH, detail: `Consonant cluster: "${cluster}"` };
            }
        }
    }

    if (debug) console.log('[gibberish-filter] ✅ PASS');
    return { passed: true, code: 'PASS' };
}
