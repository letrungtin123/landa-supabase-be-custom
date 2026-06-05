// ═══════════════════════════════════════════════════════════════
// Branding Validator — Zod schemas + constants
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Danh sách image keys hợp lệ (single images) */
export const SINGLE_IMAGE_KEYS = [
  'left_panel_bg',
  'register_bg',
  'white_logo',
  'square_icon',
  'header_logo',
  'header_logo_dark',
  'person_1',
  'person_2',
  'person_3',
  'person_4',
] as const;

/** Max carousel logos */
export const MAX_CAROUSEL = 10;

/** All valid image keys (singles + carousels) */
export const ALL_IMAGE_KEYS = [
  ...SINGLE_IMAGE_KEYS,
  ...Array.from({ length: MAX_CAROUSEL }, (_, i) => `carousel_${i + 1}`),
] as const;

export type SingleImageKey = typeof SINGLE_IMAGE_KEYS[number];

/** Kích thước gợi ý cho từng image key */
export const IMAGE_SIZE_HINTS: Record<string, string> = {
  left_panel_bg: '1200×1600px (3:4 portrait)',
  register_bg: '1200×1600px (3:4 portrait)',
  white_logo: '~300×36px, PNG transparent',
  square_icon: '96×96px (2x retina)',
  header_logo: '~300×40px, PNG/WEBP (logo header - Light mode)',
  header_logo_dark: '~300×40px, PNG/WEBP (logo header - Dark mode)',
  person_1: '96×96px',
  person_2: '96×96px',
  person_3: '96×96px',
  person_4: '96×96px',
};
// carousel_N: ~200×28px, PNG transparent — xử lý dynamic

export const uploadBrandingSchema = z.object({
  image_key: z.string().refine(
    (key) => (ALL_IMAGE_KEYS as readonly string[]).includes(key),
    { message: 'image_key không hợp lệ' },
  ),
});

/** Max file size per image: 5MB */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Accepted MIME types */
export const ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
];
