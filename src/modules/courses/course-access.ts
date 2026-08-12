export function assignedCourseToLearnerCondition(courseIdExpr: string, userIdExpr: string): string {
  return `EXISTS (
    SELECT 1
    FROM team_course_categories tcc
    JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
    JOIN team_members tm ON tm.team_id = tcc.team_id
    WHERE ccc.course_id = ${courseIdExpr}
      AND tm.user_id = ${userIdExpr}
    UNION ALL
    SELECT 1
    FROM team_courses tc
    JOIN team_members tm ON tm.team_id = tc.team_id
    WHERE tc.course_id = ${courseIdExpr}
      AND tm.user_id = ${userIdExpr}
  )`;
}

export function publicCourseCategoryCondition(courseIdExpr: string, tenantIdExpr?: string): string {
  return `EXISTS (
    SELECT 1
    FROM course_category_courses ccc_public
    JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
    WHERE ccc_public.course_id = ${courseIdExpr}
      ${tenantIdExpr ? `AND cc_public.tenant_id = ${tenantIdExpr}` : ''}
      AND COALESCE(cc_public.is_public, false) = true
  )`;
}

export function learnerCourseAccessCondition(courseAlias: string, userIdExpr: string): string {
  return `${courseAlias}.visible_to_staff_only = false
    AND (
      ${publicCourseCategoryCondition(`${courseAlias}.id`, `${courseAlias}.tenant_id`)}
      OR ${assignedCourseToLearnerCondition(`${courseAlias}.id`, userIdExpr)}
    )`;
}


