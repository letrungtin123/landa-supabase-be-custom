/**
 * PostgreSQL ILIKE is accent-sensitive. Persisting and querying this compact
 * canonical form lets the existing trigram index serve Vietnamese searches
 * with or without diacritics.
 */
export function normalizeVietnameseSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLocaleLowerCase('vi-VN')
    .replace(/\s+/g, ' ')
    .trim();
}
