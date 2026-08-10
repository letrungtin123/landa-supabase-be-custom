export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function looksLikeEmailIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.includes('@');
}
