// ============================================================
// NORMALIZE UTILS - Làm sạch input trước khi filter xử lý
// ============================================================
// Chạy SAU length check (length check dùng raw text)
// Kết quả normalize dùng cho: flood, language, gibberish, repeat, profanity

/**
 * Regex bắt các ký tự invisible thường gặp:
 * - \u200B: zero-width space
 * - \u200C: zero-width non-joiner
 * - \u200D: zero-width joiner
 * - \uFEFF: BOM (byte order mark)
 * - \u00AD: soft hyphen
 * - \u2060: word joiner
 * - \u200E, \u200F: left-to-right / right-to-left mark
 */
const INVISIBLE_CHARS_REGEX = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g;

/**
 * Regex bắt khoảng trắng, tab, newline liên tiếp => gộp thành single space
 */
const MULTIPLE_WHITESPACE_REGEX = /\s+/g;

/**
 * Regex bắt ký tự bị lặp quá nhiều (>= 4 lần liên tiếp)
 * Ví dụ: "haaaaaaaa" => "haaa" (giữ lại 3 ký tự)
 * Giữ 3 vì tiếng Việt hợp lệ hiếm khi lặp >3 (vd: "ơơơ" trong chat)
 */
const REPEATED_CHAR_REGEX = /(.)\1{3,}/g;

/**
 * Normalize text: chuẩn hoá unicode, xoá invisible, gộp whitespace, co ký tự lặp
 *
 * @param input - Input đã qua length check
 * @param debug - Bật/tắt console.log
 * @returns Chuỗi đã normalize
 */
export function normalizeText(input: string, debug: boolean = false): string {
    // Bước 1: Unicode NFC normalize
    // Tiếng Việt có nhiều cách encode dấu, NFC gộp về dạng chuẩn
    let result = input.normalize('NFC');
    if (debug) console.log('[normalize] Sau NFC:', result);

    // Bước 2: Xoá ký tự invisible
    // User có thể chèn invisible chars để bypass profanity filter
    result = result.replace(INVISIBLE_CHARS_REGEX, '');
    if (debug) console.log('[normalize] Sau xoá invisible chars:', result);

    // Bước 3: Gộp khoảng trắng, tab, newline thành single space
    // Tin nhắn từ mobile thường có nhiều newline/spacing bẩn
    result = result.replace(MULTIPLE_WHITESPACE_REGEX, ' ');
    if (debug) console.log('[normalize] Sau gộp whitespace:', result);

    // Bước 4: Trim đầu cuối
    result = result.trim();

    // Bước 5: Co ký tự lặp quá nhiều (>= 4 lần => giữ 3)
    // "haaaaaaaa" => "haaa" để giảm noise trước khi check entropy
    result = result.replace(REPEATED_CHAR_REGEX, '$1$1$1');
    if (debug) console.log('[normalize] Sau co ký tự lặp:', result);

    return result;
}
