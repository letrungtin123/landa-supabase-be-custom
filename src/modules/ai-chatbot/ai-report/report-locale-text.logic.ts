// Language checks for AI-written report text (chat narrative and PDF narrative).
// A model can answer Vietnamese requests in unaccented Vietnamese ("Thong tin han che"),
// which reads as broken text to customers; such answers fall back to the rule-based text.

const VIETNAMESE_DIACRITIC = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/iu;
// Machine codes (signal ids, limitation codes) are not prose.
const MACHINE_CODE = /^[a-z0-9_:.-]+$/i;
const MIN_LETTERS = 20;

export const VIETNAMESE_DIACRITICS_INSTRUCTION =
  'Viết tiếng Việt có dấu đầy đủ (Unicode chuẩn), tuyệt đối không viết tiếng Việt không dấu.';

/** True when Vietnamese prose was written without any diacritic (too short texts are not judged). */
export function isUnaccentedVietnamese(texts: readonly string[]): boolean {
  const prose = texts.map((text) => text.trim()).filter((text) => text && !MACHINE_CODE.test(text)).join(' ');
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  return letters >= MIN_LETTERS && !VIETNAMESE_DIACRITIC.test(prose);
}
