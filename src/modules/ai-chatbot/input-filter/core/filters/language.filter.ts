// ============================================================
// LANGUAGE FILTER - Kiểm tra ngôn ngữ hỗ trợ
// ============================================================
// Chỉ cho phép: Tiếng Việt + Tiếng Anh
// Chặn: mọi ngôn ngữ khác (cả non-Latin lẫn Latin ngoại như FR/IT/ES/DE...)
// Approach kết hợp 2 tầng:
//   Tầng 1 (Character-level): Đếm ký tự non-Latin + Latin có dấu ngoài VN
//   Tầng 2 (Word-level): Phát hiện stop words của FR/IT/ES/DE/PT
//   Kết quả cuối cùng = MAX(charRatio, wordRatio) → so với threshold

import { FilterRejectCode } from '../types/filter.types.js';
import type { FilterResult, LanguageConfig } from '../types/filter.types.js';

// --- Non-Latin script regexes ---
const CJK_REGEX = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF]/g;
const ARABIC_REGEX = /[\u0600-\u06FF]/g;
const CYRILLIC_REGEX = /[\u0400-\u04FF]/g;
const HEBREW_REGEX = /[\u0590-\u05FF]/g;
const DEVANAGARI_REGEX = /[\u0900-\u097F]/g;
const THAI_REGEX = /[\u0E00-\u0E7F]/g;
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const URL_REGEX = /https?:\/\/[^\s]+/gi;

// --- Whitelist ký tự tiếng Việt (Latin có dấu) ---
const VIETNAMESE_CHARS = new Set([
    'à','á','ả','ã','ạ','ă','ằ','ắ','ẳ','ẵ','ặ','â','ầ','ấ','ẩ','ẫ','ậ',
    'è','é','ẻ','ẽ','ẹ','ê','ề','ế','ể','ễ','ệ',
    'ì','í','ỉ','ĩ','ị',
    'ò','ó','ỏ','õ','ọ','ô','ồ','ố','ổ','ỗ','ộ','ơ','ờ','ớ','ở','ỡ','ợ',
    'ù','ú','ủ','ũ','ụ','ư','ừ','ứ','ử','ữ','ự',
    'ỳ','ý','ỷ','ỹ','ỵ','đ',
    'À','Á','Ả','Ã','Ạ','Ă','Ằ','Ắ','Ẳ','Ẵ','Ặ','Â','Ầ','Ấ','Ẩ','Ẫ','Ậ',
    'È','É','Ẻ','Ẽ','Ẹ','Ê','Ề','Ế','Ể','Ễ','Ệ',
    'Ì','Í','Ỉ','Ĩ','Ị',
    'Ò','Ó','Ỏ','Õ','Ọ','Ô','Ồ','Ố','Ổ','Ỗ','Ộ','Ơ','Ờ','Ớ','Ở','Ỡ','Ợ',
    'Ù','Ú','Ủ','Ũ','Ụ','Ư','Ừ','Ứ','Ử','Ữ','Ự',
    'Ỳ','Ý','Ỷ','Ỹ','Ỵ','Đ',
]);

// Regex khớp ký tự Latin có dấu (ngoài ASCII a-z A-Z)
const LATIN_ACCENTED_REGEX = /[À-ÖØ-öø-ɏḀ-ỿ]/g;

// ============================================================
// STOP WORDS - Từ đặc trưng của các ngôn ngữ Latin ngoại
// ============================================================
// Chỉ chọn từ ĐẶC TRƯNG, ít trùng với EN/VN để tránh false positive
// Mỗi ngôn ngữ ~20-30 từ phổ biến nhất

const FOREIGN_STOP_WORDS = new Set([
    // French (Pháp)
    'je','tu','il','elle','nous','vous','ils','elles','le','la','les','un','une','des',
    'du','de','et','est','en','que','qui','dans','pour','sur','avec','au','aux',
    'ce','cette','ses','son','sa','ne','pas','ont','sont','par','mais','ou',
    'très','plus','aussi','peut','où','votre','notre','leur','être','avoir','fait',
    'faire','comme','tout','bien','quand','ici','été','mes','tes','nos','vos',
    'je voudrais','bonjour','merci','oui','non','Comment','pourquoi',

    // Italian (Ý)
    'il','lo','la','le','gli','un','uno','una','di','del','della','dei','delle',
    'da','in','con','su','per','tra','fra','che','non','si','mi','ti','ci','vi',
    'ma','se','ed','anche','come','più','molto','questo','questa','questi','queste',
    'quello','quella','io','tu','lui','lei','noi','voi','loro','sono','sei','è',
    'siamo','siete','ho','hai','ha','abbiamo','avete','hanno','fare','devo','deve',
    'essere','stato','stata','grazie','buongiorno','prego',
    'effettuare','pagamento','vorrei','posso','bisogno',

    // Spanish (Tây Ban Nha)
    'el','la','los','las','un','una','unos','unas','de','del','en','por','para',
    'con','sin','que','no','es','ser','estar','hay','yo','tú','él','ella',
    'usted','ustedes','ellos','ellas','su','sus','mi','mis','al','lo','le','les',
    'se','me','te','nos','como','más','muy','pero','también','otro','otra',
    'otros','otras','todo','todos','bien','ahora','después','antes','aquí',
    'allí','donde','cuando','hola','necesito','hacer','pago','quiero',

    // German (Đức)
    'der','die','das','ein','eine','eines','einem','einen','einer','und','ist',
    'von','zu','mit','auf','für','nicht','ich','du','er','sie','es','wir','ihr',
    'als','an','den','dem','des','aus','nach','bei','über','unter','durch',
    'oder','aber','wenn','wie','was','wer','wo','noch','schon','kann','muss',
    'hat','haben','sein','wird','werden','möchte','zahlung','leisten','bitte',

    // Portuguese (Bồ Đào Nha)
    'o','a','os','as','um','uma','uns','umas','de','do','da','dos','das',
    'em','no','na','nos','nas','por','para','com','que','não','se','é','são',
    'tem','há','eu','tu','ele','ela','nós','vós','eles','elas','seu','sua',
    'seus','suas','meu','minha','como','mais','muito','mas','também','este',
    'esta','esse','essa','obrigado','preciso','fazer','pagamento',
]);

// Từ quá ngắn hoặc trùng EN phổ biến → bỏ qua khi đếm foreign
// Bao gồm: 1-2 ký tự Latin + từ EN phổ biến trùng foreign stop words
const AMBIGUOUS_WORDS = new Set([
    // 1 ký tự
    'a','o','e','i','u','à','è','é','ù','ò','ó','ì','í','ê',
    // 2 ký tự EN phổ biến trùng stop word ngoại
    'no','do','in','on','an','me','or','is','it','so','to','be','we','he','my','us','up','if','at','by','go',
    'le','la','de','el','un','se','lo','al','da','di','du','en','es','eu','ha','ho','ma','mi','na','ne','os','ou','par','per','son','su','tu','um','vi','yo',
]);

// Minimum foreign stop words cần match để block (tránh false positive)
const MIN_FOREIGN_WORD_MATCHES = 2;

// Minimum tổng số từ để word-level check có ý nghĩa
const MIN_WORDS_FOR_WORD_CHECK = 3;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function isEmojiOnly(text: string): boolean {
    return text.replace(EMOJI_REGEX, '').replace(/\s/g, '').length === 0;
}

function isUrlOnly(text: string): boolean {
    return text.replace(URL_REGEX, '').replace(/\s/g, '').length === 0;
}

function countNonVietnameseLatinAccented(text: string): number {
    const matches = text.match(LATIN_ACCENTED_REGEX) || [];
    let count = 0;
    for (const char of matches) {
        if (!VIETNAMESE_CHARS.has(char)) {
            count++;
        }
    }
    return count;
}

/**
 * Tách text thành các từ (lowercase), loại bỏ dấu câu
 */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // Giữ letters + numbers + spaces
        .split(/\s+/)
        .filter(w => w.length > 0);
}

/**
 * Word-level check: Đếm số từ trong message khớp với foreign stop words
 * Trả về tỷ lệ foreign words / total words
 */
function checkForeignStopWords(text: string, debug: boolean): { ratio: number; matchCount: number; totalWords: number; matchedWords: string[] } {
    const words = tokenize(text);
    const totalWords = words.length;

    if (totalWords < MIN_WORDS_FOR_WORD_CHECK) {
        return { ratio: 0, matchCount: 0, totalWords, matchedWords: [] };
    }

    let matchCount = 0;
    const matchedWords: string[] = [];

    for (const word of words) {
        if (FOREIGN_STOP_WORDS.has(word) && !AMBIGUOUS_WORDS.has(word)) {
            matchCount++;
            matchedWords.push(word);
        }
    }

    // Nếu chỉ match 1 từ → có thể trùng hợp (vd: "le" cũng là EN)
    // Cần >= MIN_FOREIGN_WORD_MATCHES mới tính
    if (matchCount < MIN_FOREIGN_WORD_MATCHES) {
        return { ratio: 0, matchCount, totalWords, matchedWords };
    }

    const ratio = matchCount / totalWords;
    return { ratio, matchCount, totalWords, matchedWords };
}

// ============================================================
// MAIN EXPORT
// ============================================================

export function checkLanguage(normalizedText: string, config: LanguageConfig, debug: boolean = false): FilterResult {
    if (debug) console.log('[language-filter] Checking...');

    if (isEmojiOnly(normalizedText)) {
        if (debug) console.log('[language-filter] ✅ PASS (emoji only)');
        return { passed: true, code: 'PASS' };
    }

    if (isUrlOnly(normalizedText)) {
        if (debug) console.log('[language-filter] ✅ PASS (URL only)');
        return { passed: true, code: 'PASS' };
    }

    // === TẦNG 1: Character-level check ===
    const cjkCount = (normalizedText.match(CJK_REGEX) || []).length;
    const arabicCount = (normalizedText.match(ARABIC_REGEX) || []).length;
    const cyrillicCount = (normalizedText.match(CYRILLIC_REGEX) || []).length;
    const hebrewCount = (normalizedText.match(HEBREW_REGEX) || []).length;
    const devanagariCount = (normalizedText.match(DEVANAGARI_REGEX) || []).length;
    const thaiCount = (normalizedText.match(THAI_REGEX) || []).length;

    const totalNonLatin = cjkCount + arabicCount + cyrillicCount + hebrewCount + devanagariCount + thaiCount;
    const nonVnLatinCount = countNonVietnameseLatinAccented(normalizedText);
    const charForeign = totalNonLatin + nonVnLatinCount;

    const letterChars = normalizedText.replace(/[\s\d\p{P}\p{S}]/gu, '');
    const totalLetters = letterChars.length;

    if (totalLetters === 0) {
        if (debug) console.log('[language-filter] ✅ PASS (no letters)');
        return { passed: true, code: 'PASS' };
    }

    const charRatio = charForeign / totalLetters;

    // === TẦNG 2: Word-level check (foreign stop words) ===
    const wordCheck = checkForeignStopWords(normalizedText, debug);

    // Lấy tỷ lệ cao nhất giữa 2 tầng
    const foreignRatio = Math.max(charRatio, wordCheck.ratio);

    if (debug) {
        console.log(`[language-filter] [Char] Non-Latin: ${totalNonLatin} | Non-VN Latin: ${nonVnLatinCount} | charRatio: ${(charRatio * 100).toFixed(1)}%`);
        console.log(`[language-filter] [Word] Matched: ${wordCheck.matchCount}/${wordCheck.totalWords} = ${(wordCheck.ratio * 100).toFixed(1)}% (words: ${wordCheck.matchedWords.join(', ')})`);
        console.log(`[language-filter] [Final] foreignRatio: ${(foreignRatio * 100).toFixed(1)}% (threshold: ${config.foreignCharThreshold * 100}%)`);
    }

    if (foreignRatio > config.foreignCharThreshold) {
        if (debug) console.log('[language-filter] ❌ UNSUPPORTED_LANG');

        const detailParts = [];
        if (totalNonLatin > 0) detailParts.push(`CJK:${cjkCount} AR:${arabicCount} CY:${cyrillicCount}`);
        if (nonVnLatinCount > 0) detailParts.push(`NonVnLatin:${nonVnLatinCount}`);
        if (wordCheck.matchCount > 0) detailParts.push(`ForeignWords:${wordCheck.matchCount}[${wordCheck.matchedWords.join(',')}]`);

        return {
            passed: false,
            code: FilterRejectCode.UNSUPPORTED_LANG,
            detail: `Foreign: ${(foreignRatio * 100).toFixed(1)}% (${detailParts.join(' | ')})`,
        };
    }

    if (debug) console.log('[language-filter] ✅ PASS');
    return { passed: true, code: 'PASS' };
}
