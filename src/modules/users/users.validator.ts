// ═══════════════════════════════════════════════════════════════
// Users Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { fitsChars } from '../../utils/text-length.js';

export const createUserSchema = z.object({
  username: z.string().min(3, 'Username tối thiểu 3 ký tự').max(150),
  email: z.string().email('Email không hợp lệ').max(255),
  password: z.string().min(6, 'Password tối thiểu 6 ký tự'),
  full_name: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  role: z.enum(['learner', 'learner_plus', 'staff', 'superuser', 'superadmin']).default('learner'),
  tenant_id: z.string().uuid('Tenant ID không hợp lệ').optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(3).max(150).optional(),
  email: z.string().email().max(255).optional(),
  password: z.string().min(6).optional(),
  full_name: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  // Avatars are set only by the avatar upload (server-generated path); null clears it.
  avatar_url: z.null({ invalid_type_error: 'Ảnh đại diện chỉ được thay bằng cách tải ảnh lên' }).optional(),
  role: z.enum(['learner', 'learner_plus', 'staff', 'superuser', 'superadmin']).optional(),
  is_active: z.boolean().optional(),
});

/** Schema gán user vào permission groups */
export const assignGroupsSchema = z.object({
  permission_group_ids: z.array(z.string().uuid()).max(1, 'Mỗi thành viên chỉ được thuộc tối đa một nhóm quyền'),
});

// ── Own profile (PATCH /api/users/profile and PATCH /api/auth/profile) ──
// No JSON body, a field of the wrong type or a text longer than its column
// used to fail with a 500. Each limit is the users column's VARCHAR(n), so a
// value the column stores (and so any value the dashboard or the learner app
// could save before) is still accepted. bio is TEXT and has no limit here.

/** Code of a refused profile body (docs/error-codes.md). */
export const PROFILE_INPUT_INVALID_CODE = 'PROFILE_INPUT_INVALID';
/** Same text as the services' answer to a body without any profile field. */
export const PROFILE_NOTHING_TO_UPDATE_MESSAGE = 'Không có dữ liệu cần cập nhật';
/** users.full_name VARCHAR(255), phone VARCHAR(20), country VARCHAR(10), language VARCHAR(10). */
export const PROFILE_TEXT_MAX_CHARS = Object.freeze({ fullName: 255, phone: 20, country: 10, language: 10 });
/** The user_gender and education_level enums; '' clears the field. */
export const PROFILE_GENDERS = ['male', 'female', 'other', ''] as const;
export const PROFILE_EDUCATION_LEVELS = [
  'primary',
  'junior_high',
  'high_school',
  'associate',
  'bachelor',
  'master',
  'doctorate',
  'other',
  'none',
  '',
] as const;

function profileText(label: string, max?: number) {
  const text = z.string({ invalid_type_error: `${label} không hợp lệ.` });
  return max === undefined ? text : text.refine(value => fitsChars(value, max), `${label} tối đa ${max} ký tự.`);
}

/** The profile fields both routes share, under their own names (required; each route makes them optional). */
export const profileFieldSchemas = {
  fullName: profileText('Họ và tên', PROFILE_TEXT_MAX_CHARS.fullName),
  phone: profileText('Số điện thoại', PROFILE_TEXT_MAX_CHARS.phone),
  bio: profileText('Giới thiệu'),
  country: profileText('Quốc gia', PROFILE_TEXT_MAX_CHARS.country),
  language: profileText('Ngôn ngữ', PROFILE_TEXT_MAX_CHARS.language),
  /** users.year_of_birth is INT. */
  yearOfBirth: z
    .number({ invalid_type_error: 'Năm sinh không hợp lệ.' })
    .int('Năm sinh không hợp lệ.')
    .min(-2147483648, 'Năm sinh không hợp lệ.')
    .max(2147483647, 'Năm sinh không hợp lệ.'),
};

/** A profile body: a JSON object (no body answers like a body without fields). */
export function profileBodySchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape, {
    required_error: PROFILE_NOTHING_TO_UPDATE_MESSAGE,
    invalid_type_error: PROFILE_NOTHING_TO_UPDATE_MESSAGE,
  });
}

/**
 * PATCH /api/users/profile (dashboard). null stays accepted where it was
 * stored before; gender and education stay text here because the service
 * checks their values and answers with its own messages.
 */
export const updateOwnProfileSchema = profileBodySchema({
  name: profileFieldSchemas.fullName.nullable().optional(),
  bio: profileFieldSchemas.bio.nullable().optional(),
  gender: profileText('Giới tính').optional(),
  country: profileFieldSchemas.country.nullable().optional(),
  level_of_education: profileText('Trình độ học vấn').optional(),
  language: profileFieldSchemas.language.nullable().optional(),
  year_of_birth: profileFieldSchemas.yearOfBirth.nullable().optional(),
  phone_number: profileFieldSchemas.phone.nullable().optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ── Query strings ──
// The query string of GET /api/users, read the way listUsers always read it.
// It never rejects and never coerces: every request accepted before is
// accepted with the same values (a repeated parameter stays a list). Only the
// keys the service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/users */
export const userListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  role: rawQueryValue,
  is_active: rawQueryValue,
  permission_group_id: rawQueryValue,
  include_team_assignments: rawQueryValue,
  current_team_id: rawQueryValue,
});
