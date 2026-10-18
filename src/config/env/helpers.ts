// ═══════════════════════════════════════════════════════════════
// Env helpers — read and validate one variable each
// ═══════════════════════════════════════════════════════════════
// Used by the env/*.ts domain files; each call reads process.env when the
// domain file is evaluated (after ./load.ts) and throws on an invalid value.

import { isUuid } from '../../utils/uuid.js';

/**
 * Đọc biến môi trường bắt buộc — throw nếu thiếu hoặc rỗng.
 */
export function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[ENV] Thiếu biến môi trường bắt buộc: ${key}`);
  }
  return value.trim();
}

/**
 * Đọc biến môi trường kiểu số — throw nếu không hợp lệ.
 */
export function requiredInt(key: string): number {
  const raw = required(key);
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`[ENV] ${key} phải là số nguyên, nhận: "${raw}"`);
  }
  return num;
}

export function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`[ENV] ${key} must be an integer, received: "${raw}"`);
  }
  return num;
}

export function optionalNonNegativeInt(key: string, fallback: number): number {
  const num = optionalInt(key, fallback);
  if (num < 0) {
    throw new Error(`[ENV] ${key} must be a non-negative integer, received: "${num}"`);
  }
  return num;
}

export function optionalPositiveInt(key: string, fallback: number): number {
  const num = optionalInt(key, fallback);
  if (num <= 0) {
    throw new Error(`[ENV] ${key} must be a positive integer, received: "${num}"`);
  }
  return num;
}

export function optionalBoundedInt(key: string, fallback: number, minimum: number, maximum: number): number {
  const num = optionalInt(key, fallback);
  if (num < minimum || num > maximum) {
    throw new Error(`[ENV] ${key} must be between ${minimum} and ${maximum}, received: "${num}"`);
  }
  return num;
}

/** A renamed variable: the new name wins; the old name is still honoured when only it is set. */
export function optionalBoundedIntWithLegacyName(
  key: string,
  legacyKey: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!process.env[key]?.trim() && process.env[legacyKey]?.trim()) {
    console.warn(`[Env] ${legacyKey} is deprecated; it is read as ${key}. Rename it.`);
    return optionalBoundedInt(legacyKey, fallback, minimum, maximum);
  }
  return optionalBoundedInt(key, fallback, minimum, maximum);
}

export function optionalBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`[ENV] ${key} must be a boolean, received: "${raw}"`);
}

export function optionalCsv(key: string): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function optionalUuidCsv(key: string): string[] {
  const values = optionalCsv(key).map(item => item.toLowerCase());
  const invalid = values.find(item => !isUuid(item));
  if (invalid !== undefined) {
    throw new Error(`[ENV] ${key} must be a comma-separated list of UUIDs, received: "${invalid}"`);
  }
  return [...new Set(values)];
}

export function optionalString(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

/** Optional `scheme://host[:port]` (http/https, no path, query, fragment or credentials). */
export function optionalOrigin(key: string): string {
  const raw = process.env[key]?.trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[ENV] ${key} must be an origin such as https://host:8443`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error(`[ENV] ${key} must be an origin such as https://host:8443 (no path, query or credentials)`);
  }
  return parsed.origin;
}

export function optionalOneOf<const T extends readonly string[]>(
  key: string,
  fallback: T[number],
  allowed: T,
): T[number] {
  const value = optionalString(key, fallback);
  if (!allowed.includes(value as T[number])) {
    throw new Error(`[ENV] ${key} must be one of ${allowed.join(', ')}, received: "${value}"`);
  }
  return value as T[number];
}
