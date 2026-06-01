-- ═══════════════════════════════════════════════════
-- Report Performance Indexes (for millions of rows)
-- ═══════════════════════════════════════════════════

-- Users: tenant + role + active (hot path for all learner counts)
CREATE INDEX IF NOT EXISTS idx_users_tenant_role_active
ON users (tenant_id, role, is_active)
WHERE is_active = true;

-- Users: last_login for active_learners metric (partial index on learner)
CREATE INDEX IF NOT EXISTS idx_users_tenant_login
ON users (tenant_id, last_login_at)
WHERE is_active = true AND role = 'learner';

-- Users: created_at for cumulative total_learners (partial index on learner)
CREATE INDEX IF NOT EXISTS idx_users_tenant_created
ON users (tenant_id, created_at)
WHERE is_active = true AND role = 'learner';

-- Enrollments: tenant + enrolled_at + is_active (hot path for enrollment counts)
CREATE INDEX IF NOT EXISTS idx_enrollments_tenant_date_active
ON enrollments (tenant_id, enrolled_at)
WHERE is_active = true;

-- Enrollments: user_id + is_active (for JOIN with team_members)
CREATE INDEX IF NOT EXISTS idx_enrollments_user_active
ON enrollments (user_id, is_active)
WHERE is_active = true;

-- team_members: team_id (for group breakdown queries)
CREATE INDEX IF NOT EXISTS idx_tm_team
ON team_members (team_id);
