// ═══════════════════════════════════════════════════════════════
// Auth Validator — Zod schemas cho login, refresh, etc.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import {
  PROFILE_EDUCATION_LEVELS,
  PROFILE_GENDERS,
  profileBodySchema,
  profileFieldSchemas,
} from '../users/users.validator.js';

/** Schema đăng nhập */
export const loginSchema = z.object({
  username: z.string().min(1, 'Username không được để trống'),
  password: z.string().min(1, 'Password không được để trống'),
  client_app: z.enum(['admin', 'learner']).optional(),
  origin: z.string().optional(),
});

/** Schema refresh token */
export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token không được để trống'),
  tenant_id: z.string().uuid().optional(),
});

/** Code of a refused password change body (docs/error-codes.md). */
export const PASSWORD_INPUT_INVALID_CODE = 'PASSWORD_INPUT_INVALID';
export const PASSWORD_INPUT_INVALID_MESSAGE = 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.';

/**
 * POST /api/auth/change-password and POST /api/users/profile/change-password:
 * a JSON object whose passwords are text. No body, or a password that is not
 * text (a number, a list), used to fail with a 500. A missing or empty
 * password keeps its own answer in the controller.
 */
export const changePasswordBodySchema = z.object(
  {
    current_password: z.string({ invalid_type_error: PASSWORD_INPUT_INVALID_MESSAGE }).nullable().optional(),
    new_password: z.string({ invalid_type_error: PASSWORD_INPUT_INVALID_MESSAGE }).nullable().optional(),
  },
  { required_error: PASSWORD_INPUT_INVALID_MESSAGE, invalid_type_error: PASSWORD_INPUT_INVALID_MESSAGE },
);

/**
 * PATCH /api/auth/profile (learner app): the users column limits of the
 * shared profile fields, and the gender and education values the database
 * enums accept ('' clears them). The avatar stays the service's check.
 */
export const updateProfileSchema = profileBodySchema({
  full_name: profileFieldSchemas.fullName.optional(),
  phone: profileFieldSchemas.phone.optional(),
  bio: profileFieldSchemas.bio.optional(),
  avatar_url: z.string({ invalid_type_error: 'Ảnh đại diện chỉ được thay bằng cách tải ảnh lên' }).nullable().optional(),
  gender: z.enum(PROFILE_GENDERS, { errorMap: () => ({ message: 'Giới tính không hợp lệ.' }) }).optional(),
  country: profileFieldSchemas.country.optional(),
  language: profileFieldSchemas.language.optional(),
  level_of_education: z
    .enum(PROFILE_EDUCATION_LEVELS, { errorMap: () => ({ message: 'Trình độ học vấn không hợp lệ.' }) })
    .optional(),
  year_of_birth: profileFieldSchemas.yearOfBirth.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
