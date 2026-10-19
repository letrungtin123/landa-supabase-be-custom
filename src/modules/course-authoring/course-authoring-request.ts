// ═══════════════════════════════════════════════════════════════
// Course authoring request helpers shared by its controllers: the audit
// context of a component and the UI locale of a request. Moved unchanged from
// course-authoring.controller.ts.
// ═══════════════════════════════════════════════════════════════

import type { Request } from 'express';

export function componentAuditContext(block: {
  course_id: string;
  course_name: string;
  block_type: string;
  parent_name?: string | null;
}) {
  return {
    course_id: block.course_id,
    course_name: block.course_name,
    component_type: block.block_type,
    ...(block.parent_name ? { parent_name: block.parent_name } : {}),
  };
}

export function requestComponentLocale(req: Request): 'vi' | 'en' {
  return req.get('X-UI-Locale')?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}
