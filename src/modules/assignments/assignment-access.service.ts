// Assignment repositories over the pool, and the course access checks that
// the admin, submission and download paths share. Moved unchanged from
// assignments.service.ts.

import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import type { AuthUser } from '../../types/express.js';
import { createAssignmentsRepository, type AssignmentCourseRow, type AssignmentsDb } from './assignments.repository.js';
import { createAssignmentLearnerRepository } from './assignment-learner.repository.js';
import { createAssignmentSubmissionsRepository } from './assignment-submissions.repository.js';

// query() joins the caller's current transaction when there is one; the
// transaction blocks below use the repositories over their own client.
const poolDb: AssignmentsDb = { query };
export const assignmentsRepository = createAssignmentsRepository(poolDb);
export const learnerRepository = createAssignmentLearnerRepository(poolDb);
export const submissionsRepository = createAssignmentSubmissionsRepository(poolDb);

export type CourseRow = AssignmentCourseRow;

export async function ensureCourseForAdmin(courseId: string, tenantId: string): Promise<CourseRow> {
  const course = await assignmentsRepository.selectCourse(courseId, tenantId);
  if (!course) throw new AppError('Course khong ton tai', 404);
  return course;
}

export async function hasCoursePermission(user: AuthUser): Promise<boolean> {
  if (user.role === 'superadmin' || user.role === 'superuser') return true;
  if (user.role !== 'staff' || !user.tenantId) return false;
  return assignmentsRepository.staffHasCoursePermission(user.id, user.tenantId);
}

export async function getAssignmentForAdmin(assignmentId: string, tenantId: string) {
  const assignment = await assignmentsRepository.selectAssignment(assignmentId, tenantId);
  if (!assignment) throw new AppError('Assignment khong ton tai', 404);
  return assignment;
}
