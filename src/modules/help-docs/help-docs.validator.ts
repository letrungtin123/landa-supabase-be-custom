// ═══════════════════════════════════════════════════════════════
// Help Docs Validator — Zod schemas of the folder and page bodies
//
// No JSON body, a create without a title, a field of the wrong type, a text
// longer than its column or a folder id that is not a UUID used to fail with
// a 500. Limits are the columns' VARCHAR(n): help_folders.title 200,
// help_folders.icon 100, help_pages.title 500. Updates still accept any text
// title (an empty one included), as before.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { fitsChars } from '../../utils/text-length.js';

/** Code of every refused help docs body (docs/error-codes.md). */
export const HELP_DOC_INPUT_INVALID_CODE = 'HELP_DOC_INPUT_INVALID';
export const HELP_DOC_NOTHING_TO_UPDATE_MESSAGE = 'Không có dữ liệu cần cập nhật';
export const HELP_FOLDER_TITLE_MAX_CHARS = 200;
export const HELP_FOLDER_ICON_MAX_CHARS = 100;
export const HELP_PAGE_TITLE_MAX_CHARS = 500;

const FOLDER_TITLE_REQUIRED = 'Vui lòng nhập tên thư mục.';
const FOLDER_TITLE_TOO_LONG = `Tên thư mục tối đa ${HELP_FOLDER_TITLE_MAX_CHARS} ký tự.`;
const FOLDER_ICON_INVALID = 'Biểu tượng thư mục không hợp lệ.';
const PAGE_TITLE_REQUIRED = 'Vui lòng nhập tiêu đề trang.';
const PAGE_TITLE_TOO_LONG = `Tiêu đề trang tối đa ${HELP_PAGE_TITLE_MAX_CHARS} ký tự.`;
const PAGE_FOLDER_INVALID = 'Vui lòng chọn thư mục cho trang.';
const PAGE_CONTENT_INVALID = 'Nội dung trang không hợp lệ.';
const PAGE_PUBLISHED_INVALID = 'Trạng thái xuất bản không hợp lệ.';

/** A JSON object body; `message` answers a request without one. */
function body<T extends z.ZodRawShape>(shape: T, message: string) {
  return z.object(shape, { required_error: message, invalid_type_error: message });
}

function requiredTitle(required: string, tooLong: string, max: number) {
  return z
    .string({ required_error: required, invalid_type_error: required })
    .refine(value => value.trim() !== '', required)
    .refine(value => fitsChars(value, max), tooLong);
}

function optionalTitle(invalid: string, tooLong: string, max: number) {
  return z
    .string({ invalid_type_error: invalid })
    .refine(value => fitsChars(value, max), tooLong)
    .optional();
}

const folderIcon = z
  .string({ invalid_type_error: FOLDER_ICON_INVALID })
  .refine(value => fitsChars(value, HELP_FOLDER_ICON_MAX_CHARS), FOLDER_ICON_INVALID);

/** POST /api/help-docs/folders */
export const createHelpFolderSchema = body(
  {
    title: requiredTitle(FOLDER_TITLE_REQUIRED, FOLDER_TITLE_TOO_LONG, HELP_FOLDER_TITLE_MAX_CHARS),
    // null or '' keeps the default icon, as before.
    icon: folderIcon.nullable().optional(),
  },
  FOLDER_TITLE_REQUIRED,
);

/** PATCH /api/help-docs/folders/:id */
export const updateHelpFolderSchema = body(
  {
    title: optionalTitle('Tên thư mục không hợp lệ.', FOLDER_TITLE_TOO_LONG, HELP_FOLDER_TITLE_MAX_CHARS),
    icon: folderIcon.optional(),
  },
  HELP_DOC_NOTHING_TO_UPDATE_MESSAGE,
);

/** POST /api/help-docs/pages */
export const createHelpPageSchema = body(
  {
    folder_id: z
      .string({ required_error: PAGE_FOLDER_INVALID, invalid_type_error: PAGE_FOLDER_INVALID })
      .uuid(PAGE_FOLDER_INVALID),
    title: requiredTitle(PAGE_TITLE_REQUIRED, PAGE_TITLE_TOO_LONG, HELP_PAGE_TITLE_MAX_CHARS),
    // null keeps the empty default content, as before.
    content: z.string({ invalid_type_error: PAGE_CONTENT_INVALID }).nullable().optional(),
  },
  PAGE_TITLE_REQUIRED,
);

/** PATCH /api/help-docs/pages/:id */
export const updateHelpPageSchema = body(
  {
    title: optionalTitle('Tiêu đề trang không hợp lệ.', PAGE_TITLE_TOO_LONG, HELP_PAGE_TITLE_MAX_CHARS),
    content: z.string({ invalid_type_error: PAGE_CONTENT_INVALID }).optional(),
    is_published: z.boolean({ invalid_type_error: PAGE_PUBLISHED_INVALID }).optional(),
  },
  HELP_DOC_NOTHING_TO_UPDATE_MESSAGE,
);
