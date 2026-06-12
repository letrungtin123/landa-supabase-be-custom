CREATE TABLE IF NOT EXISTS tenant_badge_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  badge_id VARCHAR NOT NULL REFERENCES badge_definitions(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (tenant_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_badge_settings_tenant_id ON tenant_badge_settings(tenant_id);
