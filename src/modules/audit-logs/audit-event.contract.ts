// Structured audit events are language-neutral. The dashboard owns VI/EN rendering.

export type AuditScalar = string | number | boolean | null;

export interface AuditChange {
  field: string;
  before: AuditScalar;
  after: AuditScalar;
}

export interface AuditEventContext {
  course_id?: string;
  course_name?: string;
  component_type?: string;
  parent_name?: string;
  related_entity_name?: string;
  related_entity_type?: string;
  affected_count?: number;
  file_name?: string;
  file_size_bytes?: number;
}

export interface StructuredAuditEvent {
  code: string;
  context?: AuditEventContext;
  changes?: AuditChange[];
}

/**
 * Visibility is assigned by this server-owned registry only. It is never
 * accepted from a request body, query string, header, or controller caller.
 */
export type AuditLogViewerScope = 'tenant' | 'superadmin_only';

interface AuditEventRule {
  context: readonly (keyof AuditEventContext)[];
  changes: readonly string[];
}

// Adding an event requires an explicit, reviewed allowlist. Never store raw request bodies.
const AUDIT_EVENT_RULES: Record<string, AuditEventRule> = {
  'course.created': { context: [], changes: [] },
  'course.updated': {
    context: [],
    changes: ['display_name', 'visible_to_staff_only', 'start_date', 'end_date', 'image_status'],
  },
  'course.deleted': { context: [], changes: [] },
  'course.deletion_job.retry_queued': { context: [], changes: [] },
  'course.component.created': { context: ['course_id', 'course_name', 'component_type', 'parent_name'], changes: [] },
  'course.component.updated': {
    context: ['course_id', 'course_name', 'component_type', 'parent_name'],
    changes: ['display_name', 'publication_status', 'sort_order', 'child_count', 'content_status'],
  },
  'course.component.deleted': { context: ['course_id', 'course_name', 'component_type'], changes: [] },
  'course.component.reordered': { context: ['course_id', 'course_name', 'component_type', 'affected_count'], changes: ['sort_order'] },
  'course.asset.uploaded': { context: ['course_id', 'course_name', 'file_name', 'file_size_bytes'], changes: [] },
  'course.asset.deleted': { context: ['course_id', 'course_name', 'file_name', 'file_size_bytes', 'affected_count'], changes: [] },
  'course.asset.references.updated': { context: ['course_id', 'course_name', 'affected_count'], changes: [] },
  'tenant.created': { context: [], changes: [] },
  'tenant.updated': {
    context: [],
    changes: ['name', 'slug', 'domain_admin', 'domain_learner', 'is_active', 'max_users', 'max_courses', 'data_limit_gb'],
  },
  'tenant.deleted': { context: [], changes: [] },
  'tenant.modules.updated': { context: ['affected_count'], changes: [] },
  'user.created': { context: [], changes: [] },
  'user.updated': { context: [], changes: ['username', 'role', 'is_active', 'permission_groups'] },
  'user.deleted': { context: [], changes: [] },
  'user.deletion_job.retry_queued': { context: [], changes: [] },
  'auth.login.succeeded': { context: [], changes: [] },
  'auth.logout.succeeded': { context: [], changes: [] },

  // Groups. Membership and assignments deliberately contain only the group
  // and related entity names/counts — never an arbitrary request payload.
  'group.org.created': { context: [], changes: [] },
  'group.org.updated': { context: [], changes: ['name'] },
  'group.org.deleted': { context: [], changes: [] },
  'group.sub.created': { context: ['parent_name'], changes: [] },
  'group.sub.updated': { context: ['parent_name'], changes: ['name'] },
  'group.sub.deleted': { context: ['parent_name'], changes: [] },
  'group.team.created': { context: ['parent_name'], changes: [] },
  'group.team.updated': { context: ['parent_name'], changes: ['name'] },
  'group.team.deleted': { context: ['parent_name'], changes: [] },
  'group.team_member.added': { context: ['parent_name', 'affected_count'], changes: [] },
  'group.team_member.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },
  'group.team_course.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },
  'group.team_document_category.assigned': { context: ['parent_name', 'affected_count'], changes: [] },
  'group.team_document_category.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },
  'group.team_course_category.assigned': { context: ['parent_name', 'affected_count'], changes: [] },
  'group.team_course_category.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },

  // Course category membership. Category public/private changes can also
  // revoke team assignments; the exact number is recorded as a safe count.
  'course_category.created': { context: [], changes: [] },
  'course_category.updated': { context: ['affected_count'], changes: ['name', 'sort_order', 'is_public'] },
  'course_category.deleted': { context: [], changes: [] },
  'course_category.course.assigned': { context: ['parent_name', 'affected_count'], changes: [] },
  'course_category.course.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },

  // Library. File paths, binary contents and user-entered document bodies are
  // intentionally excluded; only the display name, size and safe state are
  // retained for operator traceability.
  'document_category.created': { context: [], changes: [] },
  'document_category.updated': { context: ['affected_count'], changes: ['name', 'is_public'] },
  'document_category.deleted': { context: [], changes: [] },
  'document_category.bulk.deleted': { context: ['affected_count'], changes: [] },
  'document.created': { context: ['file_name', 'file_size_bytes'], changes: [] },
  'document.updated': { context: ['parent_name'], changes: ['title', 'is_visible'] },
  'document.deleted': { context: ['file_name', 'file_size_bytes'], changes: [] },
  'document.bulk.deleted': { context: ['affected_count'], changes: [] },
  'document.bulk.visibility.updated': { context: ['affected_count'], changes: ['is_visible'] },
  'document.bulk.category.updated': { context: ['affected_count', 'related_entity_name'], changes: [] },

  // Assignments. Questions, learner submissions and feedback bodies are
  // content and never belong in the audit payload. Names, course context and
  // a score change are sufficient for an accountable operator history.
  'assignment.created': { context: ['course_id', 'course_name'], changes: [] },
  'assignment.updated': {
    context: ['course_id', 'course_name'],
    changes: ['title', 'allow_resubmission', 'deadline_at', 'submission_unlock_mode', 'attachment_status'],
  },
  'assignment.deleted': { context: ['course_id', 'course_name'], changes: [] },
  'assignment.reordered': { context: ['course_id', 'course_name', 'affected_count'], changes: [] },
  'assignment.submission.feedback_given': {
    context: ['course_id', 'course_name', 'parent_name', 'related_entity_name', 'related_entity_type'],
    changes: ['score'],
  },

  // Access control. Permission definitions themselves can be extensive, so
  // the audit records only the group, the number of affected entries and the
  // safe group/member labels — never the raw permission payload.
  'permission_group.created': { context: [], changes: [] },
  'permission_group.updated': { context: [], changes: ['name'] },
  'permission_group.deleted': { context: [], changes: [] },
  'permission_group.matrix.updated': { context: ['affected_count'], changes: [] },
  'permission_group.members.assigned': { context: ['parent_name', 'affected_count'], changes: [] },
  'permission_group.members.removed': {
    context: ['parent_name', 'related_entity_name', 'related_entity_type'],
    changes: [],
  },
  'system_module.created': { context: [], changes: [] },
  'system_module.updated': { context: [], changes: ['name', 'sort_order', 'is_active'] },

  // Tenant configuration. Secrets, template bodies and image storage paths
  // are intentionally never recorded. The event identifies the safe config
  // key/provider and whether its effective state changed.
  'sso_config.updated': { context: ['related_entity_name', 'related_entity_type'], changes: ['is_enabled', 'secret_status'] },
  'sso_config.deleted': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'dashboard_content.updated': { context: ['affected_count'], changes: [] },
  'email_template.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'email_template.reset': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'notification.created': { context: ['course_id', 'course_name', 'affected_count'], changes: [] },
  'enrollment.created': { context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'], changes: [] },
  'enrollment.bulk.created': { context: ['course_id', 'course_name', 'affected_count'], changes: [] },
  'enrollment.removed': { context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'], changes: [] },
  'enrollment.progress.updated': {
    context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'],
    changes: ['progress'],
  },

  // Tenant-level settings. Values may contain operational configuration or
  // credentials, therefore records identify only the setting family and safe
  // item counts; they never retain submitted configuration payloads.
  'tenant.settings.updated': { context: ['related_entity_name', 'related_entity_type', 'affected_count'], changes: [] },
  'tenant.user_tenants.updated': { context: ['affected_count'], changes: [] },
  'demo_login.settings.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'demo_login.accounts.updated': { context: ['related_entity_name', 'related_entity_type', 'affected_count'], changes: [] },
  'demo_login.account.removed': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'demo_iframe.settings.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'demo_iframe.embed.regenerated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'course.bulk.updated': { context: ['affected_count'], changes: [] },
  'course.mentor.updated': { context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'], changes: [] },
  'course.mentor_section.updated': { context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'], changes: [] },
  'course.modal.updated': { context: ['course_id', 'course_name', 'related_entity_name', 'related_entity_type'], changes: [] },
  'help_folder.created': { context: [], changes: [] },
  'help_folder.updated': { context: [], changes: ['title'] },
  'help_folder.deleted': { context: ['affected_count'], changes: [] },
  'help_folder.reordered': { context: ['affected_count'], changes: [] },
  'help_page.created': { context: ['parent_name'], changes: [] },
  'help_page.updated': { context: ['parent_name'], changes: ['title', 'is_published'] },
  'help_page.deleted': { context: ['parent_name', 'affected_count'], changes: [] },
  'help_page.reordered': { context: ['parent_name', 'affected_count'], changes: [] },
  'help_doc.image.uploaded': { context: ['file_name', 'file_size_bytes'], changes: [] },
  'help_doc.image.deleted': { context: ['file_name', 'affected_count'], changes: [] },
  'prompt_template.created': { context: [], changes: [] },
  'prompt_template.updated': { context: ['related_entity_name', 'related_entity_type'], changes: ['name', 'is_active', 'sort_order'] },
  'prompt_template.deleted': { context: [], changes: [] },
  'chatbot.created': { context: [], changes: [] },
  'chatbot.updated': { context: ['related_entity_name', 'related_entity_type'], changes: ['name', 'is_active'] },
  'chatbot.deleted': { context: [], changes: [] },
  'chatbot.persona.created': { context: ['parent_name'], changes: [] },
  'chatbot.persona.updated': { context: ['parent_name'], changes: ['name'] },
  'chatbot.persona.deleted': { context: ['parent_name'], changes: [] },
  'chatbot.assignment.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'knowledgebase.assignment.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'lesson_author.job.applied': { context: ['course_id', 'course_name', 'affected_count'], changes: [] },
  'knowledgebase.created': { context: [], changes: [] },
  'knowledgebase.updated': { context: [], changes: ['name'] },
  'knowledgebase.deleted': { context: [], changes: [] },
  'knowledgebase.restore.queued': { context: [], changes: [] },
  'knowledgebase.document.created': { context: ['parent_name', 'file_name', 'file_size_bytes'], changes: [] },
  'knowledgebase.document.updated': { context: ['parent_name'], changes: ['name'] },
  'knowledgebase.document.deleted': { context: ['parent_name'], changes: [] },
  'knowledgebase.document.bulk_deleted': { context: ['parent_name', 'affected_count'], changes: [] },
  'knowledgebase.document.retry_queued': { context: ['parent_name', 'affected_count'], changes: [] },
  'badge.settings.updated': { context: ['affected_count'], changes: [] },
  'badge.image.updated': { context: ['related_entity_name', 'related_entity_type', 'file_size_bytes'], changes: [] },
  'branding.image.updated': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'branding.image.deleted': { context: ['related_entity_name', 'related_entity_type'], changes: [] },
  'report.summary.refreshed': { context: [], changes: [] },
  'badge.rule.updated': { context: ['affected_count'], changes: ['is_enabled'] },
};

/** Used by the cross-repository translation verification script. */
export function getRegisteredAuditEventCodes(): readonly string[] {
  return Object.keys(AUDIT_EVENT_RULES);
}

// This is deliberately an allowlist of events that may leave the superadmin
// boundary. A newly registered event is fail-closed (superadmin_only) until it
// is explicitly reviewed and added here.
const TENANT_VISIBLE_AUDIT_EVENT_CODES = new Set<string>([
  'course.created',
  'course.updated',
  'course.deleted',
  'course.deletion_job.retry_queued',
  'course.component.created',
  'course.component.updated',
  'course.component.deleted',
  'course.component.reordered',
  'course.asset.uploaded',
  'course.asset.deleted',
  'course.asset.references.updated',
  'user.created',
  'user.updated',
  'user.deleted',
  'user.deletion_job.retry_queued',
  'auth.login.succeeded',
  'auth.logout.succeeded',
  'group.org.created',
  'group.org.updated',
  'group.org.deleted',
  'group.sub.created',
  'group.sub.updated',
  'group.sub.deleted',
  'group.team.created',
  'group.team.updated',
  'group.team.deleted',
  'group.team_member.added',
  'group.team_member.removed',
  'group.team_course.removed',
  'group.team_document_category.assigned',
  'group.team_document_category.removed',
  'group.team_course_category.assigned',
  'group.team_course_category.removed',
  'course_category.created',
  'course_category.updated',
  'course_category.deleted',
  'course_category.course.assigned',
  'course_category.course.removed',
  'document_category.created',
  'document_category.updated',
  'document_category.deleted',
  'document_category.bulk.deleted',
  'document.created',
  'document.updated',
  'document.deleted',
  'document.bulk.deleted',
  'document.bulk.visibility.updated',
  'document.bulk.category.updated',
  'assignment.created',
  'assignment.updated',
  'assignment.deleted',
  'assignment.reordered',
  'assignment.submission.feedback_given',
  'permission_group.created',
  'permission_group.updated',
  'permission_group.deleted',
  'permission_group.matrix.updated',
  'permission_group.members.assigned',
  'permission_group.members.removed',
  'dashboard_content.updated',
  'email_template.updated',
  'email_template.reset',
  'notification.created',
  'enrollment.created',
  'enrollment.bulk.created',
  'enrollment.removed',
  'enrollment.progress.updated',
  'course.bulk.updated',
  'course.mentor.updated',
  'course.mentor_section.updated',
  'course.modal.updated',
  'chatbot.created',
  'chatbot.updated',
  'chatbot.deleted',
  'chatbot.persona.created',
  'chatbot.persona.updated',
  'chatbot.persona.deleted',
  'chatbot.assignment.updated',
  'knowledgebase.assignment.updated',
  'lesson_author.job.applied',
  'knowledgebase.created',
  'knowledgebase.updated',
  'knowledgebase.deleted',
  'knowledgebase.restore.queued',
  'knowledgebase.document.created',
  'knowledgebase.document.updated',
  'knowledgebase.document.deleted',
  'knowledgebase.document.bulk_deleted',
  'knowledgebase.document.retry_queued',
  'branding.image.updated',
  'branding.image.deleted',
  'report.summary.refreshed',
  'badge.rule.updated',
]);

const MAX_CONTEXT_STRING_LENGTH = 256;
const MAX_CHANGES = 12;

function sanitizeScalar(value: unknown): AuditScalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.slice(0, MAX_CONTEXT_STRING_LENGTH);
  return null;
}

/** Resolve an event's response audience. Unknown/unreviewed events are never tenant-visible. */
export function getAuditEventViewerScope(eventCode: string): AuditLogViewerScope {
  if (!AUDIT_EVENT_RULES[eventCode]) {
    throw new Error(`Unregistered audit event: ${eventCode}`);
  }
  return TENANT_VISIBLE_AUDIT_EVENT_CODES.has(eventCode) ? 'tenant' : 'superadmin_only';
}

/** Validate and cap structured audit payloads before they can reach PostgreSQL. */
export function normalizeStructuredAuditEvent(event: StructuredAuditEvent): {
  eventCode: string;
  viewerScope: AuditLogViewerScope;
  metadata: Record<string, AuditScalar>;
  changes: AuditChange[];
} {
  const rule = AUDIT_EVENT_RULES[event.code];
  if (!rule) throw new Error(`Unregistered audit event: ${event.code}`);

  const metadata: Record<string, AuditScalar> = {};
  for (const key of rule.context) {
    const value = event.context?.[key];
    if (value !== undefined) metadata[key] = sanitizeScalar(value);
  }

  const changes = (event.changes || [])
    .filter((change) => rule.changes.includes(change.field))
    .slice(0, MAX_CHANGES)
    .map((change) => ({
      field: change.field,
      before: sanitizeScalar(change.before),
      after: sanitizeScalar(change.after),
    }));

  return {
    eventCode: event.code,
    viewerScope: getAuditEventViewerScope(event.code),
    metadata,
    changes,
  };
}
