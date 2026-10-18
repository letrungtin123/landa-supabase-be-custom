// ═══════════════════════════════════════════════════════════════
// AI ID access rule — who may use AI course design
// ═══════════════════════════════════════════════════════════════
//
// Owner decisions (2026-10-09, confirmed 2026-10-18): AI ID is not gated by the
// tenant's AI module switch (ai_chatbot); that module guards the chatbot
// configuration pages only. Using AI ID needs:
//   1. an author role (staff, superuser, superadmin; never learner_plus, even
//      with a courses.can_edit grant) in a normal session (not a demo iframe),
//      with a UUID user id and tenant (isAiIdActor below);
//   2. the course data permission courses.can_edit, decided by the shared
//      permission matrix (hasAiIdCoursePermission in
//      lesson-author-ai-id-access.service.ts -> decidePermission).
// Whether AI ID is deployed for the tenant (bot and knowledge base assigned to
// lesson_author, engine and key in tenant_ai_settings) is set by the superadmin
// and checked where those settings are read, not here.
//
// The workspace write fence (createWorkspaceAuthority.canEdit) re-reads the
// role, the active flags and the courses.can_edit grants with row locks and no
// cache inside the write transaction; it uses isAiIdActor for the caller shape.

import type { AuthUser } from '../../types/express.js';
import { UUID_PATTERN, isUuid } from '../../utils/uuid.js';

/** The data permission AI ID needs. */
export const AI_ID_COURSE_PERMISSION = { moduleCode: 'courses', action: 'can_edit' } as const;

/** Roles that may use AI ID. */
export const AI_ID_AUTHOR_ROLES: ReadonlySet<string> = new Set(['staff', 'superuser', 'superadmin']);

export function isAiIdAuthorRole(role: unknown): boolean {
  return typeof role === 'string' && AI_ID_AUTHOR_ROLES.has(role);
}

/**
 * The caller every AI ID handler requires before any permission lookup: an
 * author role in a normal session, with a UUID tenant and user id.
 */
export function isAiIdActor(user: AuthUser | null | undefined): user is AuthUser & { tenantId: string } {
  return !!user && user.sessionMode === 'normal' && isAiIdAuthorRole(user.role)
    && isUuid(user.tenantId) && UUID_PATTERN.test(user.id);
}
