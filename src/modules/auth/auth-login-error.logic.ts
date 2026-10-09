// ═══════════════════════════════════════════════════════════════
// Password sign-in refusals — one plain message per case, both languages.
//
// Account enumeration: an unknown name, a wrong password and a name that
// belongs to another organization all answer INVALID_CREDENTIALS. Account
// state (disabled, no organization, ...) is told only after the correct
// password was given.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../middleware/error-handler.js';

/** [HTTP status, Vietnamese, English] — the response picks by X-UI-Locale. */
export const AUTH_LOGIN_ERRORS = {
  INVALID_CREDENTIALS: [
    401,
    'Tên đăng nhập hoặc mật khẩu không đúng.',
    'The username or password is incorrect.',
  ],
  ACCOUNT_DISABLED: [
    403,
    'Tài khoản này đã bị khóa. Hãy liên hệ quản trị viên.',
    'This account has been disabled. Please contact your administrator.',
  ],
  LEARNER_ADMIN_FORBIDDEN: [
    403,
    'Tài khoản học viên chỉ đăng nhập được ở trang học viên.',
    'Learner accounts can only sign in on the learner site.',
  ],
  NO_ADMIN_ACCESS: [
    403,
    'Tài khoản chưa được cấp quyền vào trang quản trị. Hãy liên hệ quản trị viên.',
    'This account has not been given access to the admin site. Please contact your administrator.',
  ],
  NO_ORGANIZATION: [
    403,
    'Tài khoản chưa thuộc doanh nghiệp nào. Hãy liên hệ quản trị viên.',
    'This account does not belong to any organization yet. Please contact your administrator.',
  ],
  ORGANIZATION_DISABLED: [
    403,
    'Doanh nghiệp của bạn đang tạm ngừng hoạt động. Hãy liên hệ quản trị viên.',
    'Your organization is currently disabled. Please contact your administrator.',
  ],
  DEMO_ACCOUNT_LOCKED: [
    403,
    'Tài khoản này đang được dùng cho bản demo nên tạm thời không đăng nhập được.',
    'This account is in use for a demo and cannot sign in right now.',
  ],
} as const satisfies Record<string, readonly [number, string, string]>;

export type AuthLoginErrorCode = keyof typeof AUTH_LOGIN_ERRORS;

/** Public API code: `AUTH_<CODE>`. */
export const AUTH_LOGIN_CODE_PREFIX = 'AUTH_';

export class AuthLoginError extends AppError {
  readonly loginCode: AuthLoginErrorCode;

  constructor(code: AuthLoginErrorCode) {
    const [status, vi] = AUTH_LOGIN_ERRORS[code];
    super(vi, status, `${AUTH_LOGIN_CODE_PREFIX}${code}`);
    this.name = 'AuthLoginError';
    this.loginCode = code;
  }

  localizedMessage(locale: 'vi' | 'en'): string {
    const [, vi, en] = AUTH_LOGIN_ERRORS[this.loginCode];
    return locale === 'en' ? en : vi;
  }
}
