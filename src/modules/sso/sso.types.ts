export const SSO_PROVIDERS = ['google', 'keycloak', 'microsoft365'] as const;

export type SsoProvider = typeof SSO_PROVIDERS[number];

export interface SsoConfigRow {
  id: string;
  tenant_id: string;
  provider: SsoProvider;
  is_enabled: boolean;
  client_id: string | null;
  client_secret_enc: string | null;
  issuer_url: string | null;
  authorization_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  scopes: string[] | null;
  extra_config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PublicSsoProvider {
  provider: SsoProvider;
  label: string;
  client_id: string;
  authorization_url: string;
  scopes: string[];
  callback_path: string;
}
