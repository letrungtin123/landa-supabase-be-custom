// ═══════════════════════════════════════════════════════════════
// SSO account policy — which LANDA account an external sign-in may reach
//
// A tenant's identity provider is trusted only for accounts of that tenant:
//   1. An identity already linked (tenant + provider + subject) signs in only
//      while the linked account still belongs to the config's tenant.
//   2. An existing account is linked by email only when it belongs to the
//      config's tenant (every role, superadmin included) and the provider
//      states the email is verified (`true` or the string 'true').
//   3. A brand-new learner keeps the historical rule: only an explicit
//      `email_verified: false` is refused.
//   4. When `extra_config.allowed_email_domains` lists domains, every other
//      email is refused. Without the key nothing changes.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../middleware/error-handler.js';

/** [HTTP status, Vietnamese, English] — the response picks by X-UI-Locale. */
export const SSO_LOGIN_ERRORS = {
  OTHER_ORGANIZATION: [
    403,
    'Không thể đăng nhập tài khoản này bằng cách này. Hãy đăng nhập bằng mật khẩu hoặc liên hệ quản trị viên.',
    'This account cannot sign in this way. Please sign in with your password or contact your administrator.',
  ],
  EMAIL_NOT_VERIFIED: [
    403,
    'Chưa thể nối lần đăng nhập này với tài khoản có sẵn vì email chưa được xác minh. Hãy đăng nhập bằng mật khẩu hoặc liên hệ quản trị viên.',
    'We could not connect this sign-in to your existing account because the email address is not verified. Please sign in with your password or contact your administrator.',
  ],
  EMAIL_DOMAIN_NOT_ALLOWED: [
    403,
    'Địa chỉ email này không được phép đăng nhập vào doanh nghiệp. Hãy liên hệ quản trị viên.',
    'This email address is not allowed to sign in to this organization. Please contact your administrator.',
  ],
  ALLOWED_DOMAINS_INVALID: [
    503,
    'Cách đăng nhập này đang được cài đặt chưa đúng. Hãy đăng nhập bằng mật khẩu hoặc liên hệ quản trị viên.',
    'This sign-in option is not set up correctly. Please sign in with your password or contact your administrator.',
  ],
  ACCOUNT_INACTIVE: [
    403,
    'Tài khoản đang chờ duyệt hoặc đã bị khóa. Hãy liên hệ quản trị viên.',
    'This account is waiting for approval or has been disabled. Please contact your administrator.',
  ],
  ALREADY_LINKED: [
    409,
    'Tài khoản đăng nhập này đã được nối với một người dùng khác. Hãy liên hệ quản trị viên.',
    'This sign-in account is already connected to another user. Please contact your administrator.',
  ],
  PROVIDER_TIMEOUT: [
    504,
    'Dịch vụ đăng nhập không phản hồi kịp. Vui lòng thử lại sau ít phút.',
    'The sign-in service did not respond in time. Please try again in a few minutes.',
  ],
} as const satisfies Record<string, readonly [number, string, string]>;

export type SsoLoginErrorCode = keyof typeof SSO_LOGIN_ERRORS;

/** Public API code: `SSO_LOGIN_<CODE>`. */
export const SSO_LOGIN_CODE_PREFIX = 'SSO_LOGIN_';

export class SsoLoginError extends AppError {
  public readonly ssoCode: SsoLoginErrorCode;
  public readonly messageEn: string;

  constructor(code: SsoLoginErrorCode) {
    const [status, vi, en] = SSO_LOGIN_ERRORS[code];
    super(vi, status, `${SSO_LOGIN_CODE_PREFIX}${code}`);
    this.name = 'SsoLoginError';
    this.ssoCode = code;
    this.messageEn = en;
  }

  localizedMessage(locale: 'vi' | 'en'): string {
    return locale === 'en' ? this.messageEn : this.message;
  }
}

/** Providers send the claim as a boolean; some serialise it as a string. */
export function isEmailVerifiedClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

export function isEmailExplicitlyUnverified(value: unknown): boolean {
  return value === false || value === 'false';
}

const MAX_ALLOWED_EMAIL_DOMAINS = 100;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export function normalizeEmailDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

export function isValidEmailDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(normalizeEmailDomain(value));
}

/**
 * Reads `extra_config.allowed_email_domains`. `null` means "no restriction"
 * (key absent, null or an empty list). A present but unreadable value fails
 * closed: a configured allowlist must never silently become "allow all".
 */
export function readAllowedEmailDomains(extraConfig: Record<string, unknown> | null | undefined): string[] | null {
  if (!extraConfig || typeof extraConfig !== 'object' || Array.isArray(extraConfig)) return null;
  if (!Object.prototype.hasOwnProperty.call(extraConfig, 'allowed_email_domains')) return null;
  const raw = extraConfig.allowed_email_domains;
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_EMAIL_DOMAINS) throw new SsoLoginError('ALLOWED_DOMAINS_INVALID');
  if (raw.length === 0) return null;
  const domains = raw.map((value) => {
    if (typeof value !== 'string' || !isValidEmailDomain(value)) throw new SsoLoginError('ALLOWED_DOMAINS_INVALID');
    return normalizeEmailDomain(value);
  });
  return [...new Set(domains)];
}

/** Exact domain match on the part after the last `@` (no implicit subdomains). */
export function assertEmailDomainAllowed(email: string, extraConfig: Record<string, unknown> | null | undefined): void {
  const domains = readAllowedEmailDomains(extraConfig);
  if (!domains) return;
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? normalizeEmailDomain(email.slice(at + 1)) : '';
  if (!domain || !domains.includes(domain)) throw new SsoLoginError('EMAIL_DOMAIN_NOT_ALLOWED');
}

export interface SsoAccountState {
  tenant_id: string | null;
  is_active: boolean;
}

/** Rule 1: an existing (tenant, provider, subject) link. */
export function assertLinkedIdentityUsable(account: SsoAccountState, configTenantId: string): void {
  if (!account.tenant_id || account.tenant_id !== configTenantId) throw new SsoLoginError('OTHER_ORGANIZATION');
  if (!account.is_active) throw new SsoLoginError('ACCOUNT_INACTIVE');
}

/** Rule 2: linking an existing account found by email. */
export function assertExistingAccountLinkable(
  account: SsoAccountState,
  configTenantId: string,
  emailVerifiedClaim: unknown,
): void {
  if (!account.tenant_id || account.tenant_id !== configTenantId) throw new SsoLoginError('OTHER_ORGANIZATION');
  if (!isEmailVerifiedClaim(emailVerifiedClaim)) throw new SsoLoginError('EMAIL_NOT_VERIFIED');
  if (!account.is_active) throw new SsoLoginError('ACCOUNT_INACTIVE');
}
