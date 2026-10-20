// AI ID course permission through the shared permission matrix (rule:
// lesson-author-ai-id-access.logic.ts). Kept apart from the pure rule so the
// guards and controllers that take it as a dependency do not import the
// permission middleware.

import { hasPermission, type PermissionSubject } from '../../../../middleware/authorize.js';
import { AI_ID_COURSE_PERMISSION } from './lesson-author-ai-id-access.logic.js';

/**
 * courses.can_edit as decidePermission answers it: superadmin always, then the
 * tenant's courses module switch, superuser, and the permission groups (cached
 * matrix). Never the ai_chatbot module.
 */
export function hasAiIdCoursePermission(subject: PermissionSubject): Promise<boolean> {
  return hasPermission(subject, AI_ID_COURSE_PERMISSION.moduleCode, AI_ID_COURSE_PERMISSION.action);
}
