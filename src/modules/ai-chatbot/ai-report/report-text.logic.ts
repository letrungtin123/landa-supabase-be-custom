// Text folding shared by the report time parser, intent gate, org-unit and
// course matching. Vietnamese "đ" has no Unicode decomposition, so it is
// mapped explicitly; otherwise "đến" would fold to "đen" instead of "den".

export function foldReportText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi-VN')
    .replace(/[‐-―−~]/g, '-')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alphanumeric tokens only: "CSKH TP.HCM" -> "cskh tp hcm". */
export function normalizeReportEntityName(value: string): string {
  return foldReportText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function reportEntityTokens(value: string): string[] {
  const normalized = normalizeReportEntityName(value);
  return normalized ? normalized.split(' ') : [];
}

/** Bounded Levenshtein similarity in [0, 1]; 1 means identical strings. */
export function reportTextSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength > 160) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[right.length] / maxLength;
}
