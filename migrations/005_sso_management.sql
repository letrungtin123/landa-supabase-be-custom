-- Migration 005: Tenant SSO management
-- App-level SSO config for Google, Keycloak, and Microsoft 365.
-- Secrets are encrypted by the backend before being stored here.

CREATE TABLE IF NOT EXISTS tenant_sso_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'keycloak', 'microsoft365')),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  client_id TEXT,
  client_secret_enc TEXT,
  issuer_url TEXT,
  authorization_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'email', 'profile']::TEXT[],
  extra_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT tenant_sso_configs_tenant_provider_key UNIQUE (tenant_id, provider),
  CONSTRAINT tenant_sso_configs_client_id_nonempty CHECK (client_id IS NULL OR btrim(client_id) <> ''),
  CONSTRAINT tenant_sso_configs_secret_nonempty CHECK (client_secret_enc IS NULL OR btrim(client_secret_enc) <> '')
);

CREATE INDEX IF NOT EXISTS idx_tenant_sso_configs_enabled
  ON tenant_sso_configs (tenant_id, provider)
  WHERE is_enabled = true;

CREATE INDEX IF NOT EXISTS idx_tenant_sso_configs_extra_config
  ON tenant_sso_configs USING GIN (extra_config);

DROP TRIGGER IF EXISTS trigger_tenant_sso_configs_updated_at ON tenant_sso_configs;
CREATE TRIGGER trigger_tenant_sso_configs_updated_at
  BEFORE UPDATE ON tenant_sso_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS sso_user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'keycloak', 'microsoft365')),
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT sso_user_identities_provider_subject_nonempty CHECK (btrim(provider_subject) <> ''),
  CONSTRAINT sso_user_identities_email_nonempty CHECK (btrim(email) <> ''),
  CONSTRAINT sso_user_identities_tenant_provider_subject_key UNIQUE (tenant_id, provider, provider_subject),
  CONSTRAINT sso_user_identities_tenant_provider_user_key UNIQUE (tenant_id, provider, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sso_user_identities_user
  ON sso_user_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_sso_user_identities_email
  ON sso_user_identities (tenant_id, provider, lower(email));

DROP TRIGGER IF EXISTS trigger_sso_user_identities_updated_at ON sso_user_identities;
CREATE TRIGGER trigger_sso_user_identities_updated_at
  BEFORE UPDATE ON sso_user_identities
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Domain lookup indexes for /api/sso/public/by-domain/:domain.
-- These match the backend normalization expression and keep tenant lookup cheap.
CREATE INDEX IF NOT EXISTS idx_tenants_domain_learner_sso_lookup
  ON tenants (
    lower(regexp_replace(regexp_replace(regexp_replace(domain_learner, '^https?://', ''), '/.*$', ''), ':[0-9]+$', ''))
  )
  WHERE is_active = true AND domain_learner IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_domain_admin_sso_lookup
  ON tenants (
    lower(regexp_replace(regexp_replace(regexp_replace(domain_admin, '^https?://', ''), '/.*$', ''), ':[0-9]+$', ''))
  )
  WHERE is_active = true AND domain_admin IS NOT NULL;
