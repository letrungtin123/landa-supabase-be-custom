import type { PoolClient } from 'pg';
import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

export const EMAIL_TEMPLATE_KEYS = [
  'course_notification',
  'assignment_created',
  'assignment_feedback',
  'team_member_added',
] as const;

export type EmailTemplateKey = typeof EMAIL_TEMPLATE_KEYS[number];

export interface EmailTemplateVariable {
  key: string;
  label: string;
  description: string;
  system?: boolean;
}

export interface EmailTemplateDefinition {
  key: EmailTemplateKey;
  name: string;
  description: string;
  subjectTemplate: string;
  preheaderTemplate: string;
  bodyTemplate: string;
  variables: EmailTemplateVariable[];
}

export interface EmailTemplateRecord {
  template_key: EmailTemplateKey;
  name: string;
  description: string;
  subject_template: string;
  preheader_template: string;
  body_template: string;
  variables: EmailTemplateVariable[];
  is_customized: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface EmailTemplateSmtpStatus {
  configured: boolean;
  is_enabled: boolean;
  has_password: boolean;
  can_send_email: boolean;
  host: string | null;
  from_email: string | null;
  reason: string | null;
}

export interface TemplateTokenValue {
  text: string;
  html?: string;
}

export type TemplateTokenMap = Record<string, TemplateTokenValue>;

interface TenantTemplateRow {
  tenant_id: string;
  template_key: EmailTemplateKey;
  subject_template: string;
  preheader_template: string;
  body_template: string;
  is_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

interface EmailTemplateInput {
  subject_template?: unknown;
  preheader_template?: unknown;
  body_template?: unknown;
}

const TEMPLATE_CACHE_TTL_MS = 60_000;
const templateCache = new Map<string, { expires: number; value: TenantTemplateRow | null }>();

const COMMON_VARIABLES: EmailTemplateVariable[] = [
  { key: 'tenant_name', label: 'Tên tenant', description: 'Tên tenant đang gửi email.', system: true },
  { key: 'brand_name', label: 'Tên thương hiệu email', description: 'Tên tenant + E-Learning.', system: true },
  { key: 'learner_domain', label: 'Domain học viên', description: 'Domain cổng học viên của tenant.', system: true },
  { key: 'learner_portal_url', label: 'Link cổng học viên', description: 'Link cổng học viên do hệ thống sinh.', system: true },
];

const DEFAULT_TEMPLATES: Record<EmailTemplateKey, EmailTemplateDefinition> = {
  course_notification: {
    key: 'course_notification',
    name: 'Thông báo khóa học',
    description: 'Email gửi cho học viên khi admin gửi thông báo trong bảng khóa học.',
    subjectTemplate: '{{notification_title}} - {{course_name}}',
    preheaderTemplate: 'Khóa học {{course_name}} vừa có thông báo mới dành cho bạn.',
    bodyTemplate: [
      'Xin chào,',
      '',
      'Khóa học {{course_name}} vừa có thông báo mới.',
      '',
      'Tiêu đề: {{notification_title}}',
      '',
      'Nội dung thông báo:',
      '{{notification_message}}',
      '',
      'Vui lòng đăng nhập cổng học viên để xem chi tiết.',
    ].join('\n'),
    variables: [
      ...COMMON_VARIABLES,
      { key: 'course_name', label: 'Tên khóa học', description: 'Tên khóa học phát sinh thông báo.', system: true },
      { key: 'notification_title', label: 'Tiêu đề thông báo', description: 'Tiêu đề admin nhập khi gửi thông báo.', system: true },
      { key: 'notification_message', label: 'Nội dung thông báo', description: 'Nội dung admin nhập khi gửi thông báo.', system: true },
    ],
  },
  assignment_created: {
    key: 'assignment_created',
    name: 'Bài tập mới',
    description: 'Email gửi cho học viên khi admin tạo bài tập cho khóa học.',
    subjectTemplate: 'Bài tập mới: {{assignment_title}} - {{course_name}}',
    preheaderTemplate: 'Khóa học {{course_name}} vừa có bài tập mới. Hạn nộp: {{deadline_text}}',
    bodyTemplate: [
      'Xin chào,',
      '',
      'Khóa học {{course_name}} vừa có bài tập mới: {{assignment_title}}.',
      '',
      '{{deadline_text}}',
      '{{submission_unlock_text}}',
      '',
      'Yêu cầu bài tập:',
      '{{assignment_question}}',
      '',
      'Vui lòng đăng nhập cổng học viên để xem chi tiết và nộp bài.',
    ].join('\n'),
    variables: [
      ...COMMON_VARIABLES,
      { key: 'course_name', label: 'Tên khóa học', description: 'Tên khóa học có bài tập mới.', system: true },
      { key: 'assignment_title', label: 'Tiêu đề bài tập', description: 'Tiêu đề bài tập do admin tạo.', system: true },
      { key: 'assignment_question', label: 'Câu hỏi bài tập', description: 'Nội dung/câu hỏi bài tập.', system: true },
      { key: 'deadline_text', label: 'Thời hạn nộp', description: 'Thời hạn nộp đã được hệ thống tính đúng theo learner.', system: true },
      { key: 'submission_unlock_text', label: 'Điều kiện nộp', description: 'Điều kiện cho phép học viên nộp bài.', system: true },
    ],
  },
  assignment_feedback: {
    key: 'assignment_feedback',
    name: 'Feedback bài tập',
    description: 'Email gửi cho học viên khi admin feedback bài nộp.',
    subjectTemplate: 'Feedback bài tập: {{assignment_title}} - {{course_name}}',
    preheaderTemplate: '{{feedback_by_name}} đã feedback bài tập {{assignment_title}} của bạn.',
    bodyTemplate: [
      'Xin chào {{learner_name}},',
      '',
      'Bài tập {{assignment_title}} trong khóa học {{course_name}} đã có feedback mới.',
      '',
      'Người feedback: {{feedback_by_name}}',
      '{{score_text}}',
      '',
      'Nhận xét:',
      '{{feedback_text}}',
      '',
      'Vui lòng đăng nhập cổng học viên để xem chi tiết và tệp đính kèm nếu có.',
    ].join('\n'),
    variables: [
      ...COMMON_VARIABLES,
      { key: 'learner_name', label: 'Tên học viên', description: 'Tên học viên nhận feedback.', system: true },
      { key: 'learner_email', label: 'Email học viên', description: 'Email học viên nhận feedback.', system: true },
      { key: 'course_name', label: 'Tên khóa học', description: 'Tên khóa học chứa bài tập.', system: true },
      { key: 'assignment_title', label: 'Tiêu đề bài tập', description: 'Tiêu đề bài tập đã được feedback.', system: true },
      { key: 'feedback_text', label: 'Nội dung feedback', description: 'Nội dung feedback admin nhập.', system: true },
      { key: 'feedback_by_name', label: 'Người feedback', description: 'Tên hiển thị của admin đã feedback.', system: true },
      { key: 'feedback_by_email', label: 'Email người feedback', description: 'Email admin feedback nếu có.', system: true },
      { key: 'score_text', label: 'Điểm/Trạng thái', description: 'Điểm hoặc trạng thái feedback.', system: true },
    ],
  },
  team_member_added: {
    key: 'team_member_added',
    name: 'Thêm học viên vào nhóm',
    description: 'Email gửi khi học viên được thêm vào group/sub-group/team.',
    subjectTemplate: 'Bạn đã được thêm vào {{team_label_lower}} {{team_name}}',
    preheaderTemplate: 'Các khóa học sẽ hiển thị theo danh mục được phân cho {{team_label_lower}} của bạn.',
    bodyTemplate: [
      'Xin chào,',
      '',
      'Bạn vừa được thêm vào {{team_label_lower}} {{team_name}} thuộc {{subgroup_label_lower}} {{subgroup_name}} - {{group_label_lower}} {{group_name}}.',
      '',
      'Danh mục khóa học được phân sẽ được hệ thống hiển thị trong bảng bên dưới.',
      '',
      'Vui lòng đăng nhập cổng học viên để xem các khóa học được phân cho bạn.',
    ].join('\n'),
    variables: [
      ...COMMON_VARIABLES,
      { key: 'group_label', label: 'Label group', description: 'Tên label group theo tenant.', system: true },
      { key: 'subgroup_label', label: 'Label sub-group', description: 'Tên label sub-group theo tenant.', system: true },
      { key: 'team_label', label: 'Label team', description: 'Tên label team theo tenant.', system: true },
      { key: 'group_label_lower', label: 'Label group viết thường', description: 'Label group viết thường.', system: true },
      { key: 'subgroup_label_lower', label: 'Label sub-group viết thường', description: 'Label sub-group viết thường.', system: true },
      { key: 'team_label_lower', label: 'Label team viết thường', description: 'Label team viết thường.', system: true },
      { key: 'group_name', label: 'Tên group', description: 'Tên group chứa learner.', system: true },
      { key: 'subgroup_name', label: 'Tên sub-group', description: 'Tên sub-group chứa learner.', system: true },
      { key: 'team_name', label: 'Tên team', description: 'Tên team learner vừa được thêm vào.', system: true },
      { key: 'course_categories_text', label: 'Danh mục khóa học dạng text', description: 'Danh sách danh mục khóa học dạng text.', system: true },
      { key: 'course_categories_table', label: 'Bảng danh mục khóa học', description: 'Bảng danh mục khóa học do hệ thống render an toàn.', system: true },
    ],
  },
};

const SAMPLE_TOKENS: TemplateTokenMap = {
  tenant_name: { text: 'VUG' },
  brand_name: { text: 'VUG E-Learning' },
  learner_domain: { text: 'elearning.example.vn' },
  learner_portal_url: { text: 'https://elearning.example.vn/explore' },
  course_name: { text: 'Hành trình hòa nhập - Đồng lòng nâng tầm Tôm Việt' },
  notification_title: { text: 'Lịch học tuần này' },
  notification_message: { text: 'Bạn vui lòng hoàn thành nội dung tuần này trước thứ Sáu để theo kịp tiến độ đào tạo.' },
  assignment_title: { text: 'Bài tập cuối khóa' },
  assignment_question: { text: 'Hãy trình bày kế hoạch áp dụng kiến thức đã học vào công việc thực tế của bạn.' },
  deadline_text: { text: 'Hạn nộp: 23:59 16 tháng 7, 2026.' },
  submission_unlock_text: { text: 'Học viên cần học xong toàn bộ nội dung khóa học trước khi nộp bài.' },
  learner_name: { text: 'Nguyễn Văn A' },
  learner_email: { text: 'learner@example.vn' },
  feedback_text: { text: 'Bài làm có cấu trúc tốt. Bạn cần bổ sung thêm ví dụ thực tế ở phần kế hoạch triển khai.' },
  feedback_by_name: { text: 'Trần Quản Trị' },
  feedback_by_email: { text: 'admin@example.vn' },
  score_text: { text: 'Điểm: 85/100' },
  group_label: { text: 'Khối' },
  subgroup_label: { text: 'Phòng ban' },
  team_label: { text: 'Nhóm' },
  group_label_lower: { text: 'khối' },
  subgroup_label_lower: { text: 'phòng ban' },
  team_label_lower: { text: 'nhóm' },
  group_name: { text: 'Vận hành' },
  subgroup_name: { text: 'Sản xuất' },
  team_name: { text: 'Ca sáng' },
  course_categories_text: { text: '- Onboarding: 12 khóa học\n- An toàn lao động: 6 khóa học' },
  course_categories_table: {
    text: '- Onboarding: 12 khóa học\n- An toàn lao động: 6 khóa học',
    html: '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;border:1px solid #dbe3ef;border-radius:14px;border-collapse:separate;border-spacing:0;background:#ffffff"><tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;font-weight:800;color:#0f172a">Onboarding</td><td align="right" style="padding:12px 14px;border-bottom:1px solid #e5e7eb;font-weight:800;color:#047857">12 khóa học</td></tr><tr><td style="padding:12px 14px;font-weight:800;color:#0f172a">An toàn lao động</td><td align="right" style="padding:12px 14px;font-weight:800;color:#047857">6 khóa học</td></tr></table>',
  },
};

function isUndefinedTableError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01');
}

function cacheKey(tenantId: string, key: EmailTemplateKey): string {
  return `${tenantId}:${key}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function htmlText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function normalizeTemplateText(value: unknown, maxLength: number, fieldName: string): string {
  if (typeof value !== 'string') throw new AppError(`${fieldName} không hợp lệ`, 400);
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) throw new AppError(`${fieldName} không được để trống`, 400);
  if (normalized.length > maxLength) throw new AppError(`${fieldName} vượt quá ${maxLength} ký tự`, 400);
  return normalized;
}

function normalizeSubject(value: unknown): string {
  const normalized = normalizeTemplateText(value, 180, 'Tiêu đề email').replace(/\s+/g, ' ');
  if (/<[^>]+>/.test(normalized)) throw new AppError('Tiêu đề email không được chứa HTML', 400);
  return normalized;
}

function normalizePreheader(value: unknown): string {
  return normalizeTemplateText(value, 260, 'Mô tả ngắn').replace(/\s+/g, ' ');
}

function extractPlaceholders(value: string): string[] {
  const found = new Set<string>();
  const pattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) found.add(match[1]);
  return Array.from(found);
}

function validatePlaceholders(key: EmailTemplateKey, values: string[]) {
  const allowed = new Set(DEFAULT_TEMPLATES[key].variables.map(variable => variable.key));
  const unknown = values.filter(value => !allowed.has(value));
  if (unknown.length > 0) {
    throw new AppError(`Biến hệ thống không hợp lệ: ${unknown.join(', ')}`, 400);
  }
}

function normalizeInput(key: EmailTemplateKey, input: EmailTemplateInput) {
  const subject = normalizeSubject(input.subject_template);
  const preheader = normalizePreheader(input.preheader_template);
  const body = normalizeTemplateText(input.body_template, 12_000, 'Nội dung email');
  validatePlaceholders(key, [
    ...extractPlaceholders(subject),
    ...extractPlaceholders(preheader),
    ...extractPlaceholders(body),
  ]);
  return {
    subject_template: subject,
    preheader_template: preheader,
    body_template: body,
  };
}

function ensureTemplateKey(value: string): EmailTemplateKey {
  if (EMAIL_TEMPLATE_KEYS.includes(value as EmailTemplateKey)) return value as EmailTemplateKey;
  throw new AppError('Mẫu email không hợp lệ', 404);
}

function toRecord(definition: EmailTemplateDefinition, row?: TenantTemplateRow | null): EmailTemplateRecord {
  return {
    template_key: definition.key,
    name: definition.name,
    description: definition.description,
    subject_template: row?.subject_template || definition.subjectTemplate,
    preheader_template: row?.preheader_template || definition.preheaderTemplate,
    body_template: row?.body_template || definition.bodyTemplate,
    variables: definition.variables,
    is_customized: Boolean(row),
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  };
}

async function selectTemplate(
  tenantId: string,
  key: EmailTemplateKey,
  client?: PoolClient,
): Promise<TenantTemplateRow | null> {
  const sql = `SELECT tenant_id, template_key, subject_template, preheader_template, body_template,
                     is_enabled, updated_at, updated_by
              FROM tenant_email_templates
              WHERE tenant_id = $1::uuid
                AND template_key = $2
                AND is_enabled = true
              LIMIT 1`;
  const params = [tenantId, key];
  const result = client
    ? await client.query<TenantTemplateRow>(sql, params)
    : await query<TenantTemplateRow>(sql, params);
  return result.rows[0] || null;
}

export function invalidateEmailTemplateCache(tenantId?: string, key?: EmailTemplateKey) {
  if (!tenantId) {
    templateCache.clear();
    return;
  }
  if (key) {
    templateCache.delete(cacheKey(tenantId, key));
    return;
  }
  for (const existingKey of templateCache.keys()) {
    if (existingKey.startsWith(`${tenantId}:`)) templateCache.delete(existingKey);
  }
}

export function getTemplateDefinition(key: EmailTemplateKey): EmailTemplateDefinition {
  return DEFAULT_TEMPLATES[key];
}

export function getTemplateDefinitions(): EmailTemplateDefinition[] {
  return EMAIL_TEMPLATE_KEYS.map(key => DEFAULT_TEMPLATES[key]);
}

export async function getEmailTemplateForRender(
  tenantId: string,
  key: EmailTemplateKey,
  client?: PoolClient,
): Promise<TenantTemplateRow | null> {
  const keyName = cacheKey(tenantId, key);
  const cached = templateCache.get(keyName);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const value = await selectTemplate(tenantId, key, client);
    templateCache.set(keyName, { value, expires: Date.now() + TEMPLATE_CACHE_TTL_MS });
    return value;
  } catch (err) {
    if (isUndefinedTableError(err)) {
      templateCache.set(keyName, { value: null, expires: Date.now() + 10_000 });
      return null;
    }
    throw err;
  }
}

export async function getEmailTemplateSmtpStatus(tenantId: string): Promise<EmailTemplateSmtpStatus> {
  const result = await query<{
    is_enabled: boolean;
    host: string | null;
    username: string | null;
    from_email: string | null;
    password_ciphertext: string | null;
    password_iv: string | null;
    password_auth_tag: string | null;
  }>(
    `SELECT is_enabled, host, username, from_email,
            password_ciphertext, password_iv, password_auth_tag
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  );

  const row = result.rows[0];
  const configured = Boolean(row);
  const hasPassword = Boolean(row?.password_ciphertext && row?.password_iv && row?.password_auth_tag);
  const hasSender = Boolean(row?.username?.trim() && row?.from_email?.trim());
  const canSend = Boolean(row?.is_enabled && hasPassword && hasSender);
  let reason: string | null = null;

  if (!configured) reason = 'Tenant chưa cấu hình SMTP Google.';
  else if (!row?.is_enabled) reason = 'SMTP Google của tenant chưa được bật.';
  else if (!hasPassword) reason = 'SMTP Google chưa có app password hợp lệ.';
  else if (!hasSender) reason = 'SMTP Google chưa có email gửi hợp lệ.';

  return {
    configured,
    is_enabled: Boolean(row?.is_enabled),
    has_password: hasPassword,
    can_send_email: canSend,
    host: row?.host || null,
    from_email: row?.from_email || null,
    reason,
  };
}

async function assertSmtpReady(tenantId: string) {
  const status = await getEmailTemplateSmtpStatus(tenantId);
  if (!status.can_send_email) {
    throw new AppError(status.reason || 'Tenant chưa cấu hình SMTP Google hợp lệ.', 400);
  }
}

export async function listTenantEmailTemplates(tenantId: string) {
  let rows: TenantTemplateRow[] = [];
  try {
    const result = await query<TenantTemplateRow>(
      `SELECT tenant_id, template_key, subject_template, preheader_template, body_template,
              is_enabled, updated_at, updated_by
       FROM tenant_email_templates
       WHERE tenant_id = $1::uuid
         AND is_enabled = true`,
      [tenantId],
    );
    rows = result.rows;
  } catch (err) {
    if (!isUndefinedTableError(err)) throw err;
  }

  const rowMap = new Map(rows.map(row => [row.template_key, row]));
  const smtpStatus = await getEmailTemplateSmtpStatus(tenantId);
  return {
    smtp_status: smtpStatus,
    templates: EMAIL_TEMPLATE_KEYS.map(key => toRecord(DEFAULT_TEMPLATES[key], rowMap.get(key))),
  };
}

export async function updateTenantEmailTemplate(
  tenantId: string,
  keyValue: string,
  input: EmailTemplateInput,
  updatedBy: string,
) {
  const key = ensureTemplateKey(keyValue);
  await assertSmtpReady(tenantId);
  const normalized = normalizeInput(key, input);
  const result = await query<TenantTemplateRow>(
    `INSERT INTO tenant_email_templates (
       tenant_id, template_key, subject_template, preheader_template, body_template,
       is_enabled, updated_by, updated_at
     )
     VALUES ($1::uuid, $2, $3, $4, $5, true, $6::uuid, now())
     ON CONFLICT (tenant_id, template_key) DO UPDATE SET
       subject_template = EXCLUDED.subject_template,
       preheader_template = EXCLUDED.preheader_template,
       body_template = EXCLUDED.body_template,
       is_enabled = true,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING tenant_id, template_key, subject_template, preheader_template, body_template,
               is_enabled, updated_at, updated_by`,
    [tenantId, key, normalized.subject_template, normalized.preheader_template, normalized.body_template, updatedBy],
  );
  invalidateEmailTemplateCache(tenantId, key);
  return toRecord(DEFAULT_TEMPLATES[key], result.rows[0]);
}

export async function resetTenantEmailTemplate(tenantId: string, keyValue: string) {
  const key = ensureTemplateKey(keyValue);
  await assertSmtpReady(tenantId);
  await query(
    `DELETE FROM tenant_email_templates
     WHERE tenant_id = $1::uuid
       AND template_key = $2`,
    [tenantId, key],
  );
  invalidateEmailTemplateCache(tenantId, key);
  return toRecord(DEFAULT_TEMPLATES[key], null);
}

export function renderTemplateToText(template: string, tokens: TemplateTokenMap): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key: string) => tokens[key]?.text ?? '');
}

export function renderTemplateToHtml(template: string, tokens: TemplateTokenMap): string {
  const pattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let cursor = 0;
  let output = '';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    output += htmlText(template.slice(cursor, match.index));
    const token = tokens[match[1]];
    output += token?.html ?? htmlText(token?.text ?? '');
    cursor = match.index + match[0].length;
  }
  output += htmlText(template.slice(cursor));
  return output;
}

export async function previewTenantEmailTemplate(
  tenantId: string,
  keyValue: string,
  input?: EmailTemplateInput,
) {
  const key = ensureTemplateKey(keyValue);
  let template = toRecord(DEFAULT_TEMPLATES[key], null);

  if (input) {
    const normalized = normalizeInput(key, input);
    template = {
      ...template,
      subject_template: normalized.subject_template,
      preheader_template: normalized.preheader_template,
      body_template: normalized.body_template,
    };
  } else {
    const row = await getEmailTemplateForRender(tenantId, key);
    template = toRecord(DEFAULT_TEMPLATES[key], row);
  }

  return {
    template_key: key,
    rendered_subject: renderTemplateToText(template.subject_template, SAMPLE_TOKENS),
    rendered_preheader: renderTemplateToText(template.preheader_template, SAMPLE_TOKENS),
    rendered_body_html: renderTemplateToHtml(template.body_template, SAMPLE_TOKENS),
    rendered_text: renderTemplateToText(template.body_template, SAMPLE_TOKENS),
  };
}
