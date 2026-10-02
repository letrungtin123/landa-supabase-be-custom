import sanitizeHtml from 'sanitize-html';
import { AppError } from '../../middleware/error-handler.js';

const COURSE_HTML_MAX_LENGTH = 250_000;
const COURSE_HTML_MAX_ROWS = 100;
const COURSE_HTML_MAX_COLUMNS = 50;
const COURSE_HTML_MAX_CELLS = 10_000;

const COURSE_HTML_ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'col', 'colgroup', 'div', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre',
  's', 'section', 'span', 'strike', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
];

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PIXEL_WIDTH_PATTERN = /^(?:[1-9]\d{1,3}|[1-9]\d?)px$/;
const ROW_HEIGHT_PATTERN = /^(?:[3-9]\d|[1-3]\d{2}|4[0-8]\d)px$/;

/**
 * Canonical HTML boundary shared by Course Outline and the AI workspace.
 *
 * Author edits must be accepted and normalized exactly like edits made in the
 * Course Outline editor. Keeping this in a dependency-free logic module also
 * prevents workspace code from importing an Express controller.
 */
export function sanitizeCourseHtmlData(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('Nội dung văn bản phải là HTML hợp lệ.', 400);
  }
  if (Buffer.byteLength(raw, 'utf8') > COURSE_HTML_MAX_LENGTH) {
    throw new AppError('Nội dung văn bản vượt quá dung lượng cho phép.', 400);
  }

  const sanitized = sanitizeHtml(raw, {
    allowedTags: COURSE_HTML_ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'width', 'height', 'data-landa-image-mode'],
      table: ['class', 'style'],
      col: ['width', 'style'],
      tr: ['class', 'style', 'data-landa-row-height'],
      th: ['class', 'style', 'align', 'colspan', 'rowspan', 'colwidth', 'data-landa-cell-bg'],
      td: ['class', 'style', 'align', 'colspan', 'rowspan', 'colwidth', 'data-landa-cell-bg'],
      span: ['class', 'style'],
    },
    allowedClasses: {
      '*': [/^[A-Za-z0-9_-]{1,64}$/],
    },
    allowedStyles: {
      table: {
        width: [PIXEL_WIDTH_PATTERN],
        'min-width': [PIXEL_WIDTH_PATTERN],
      },
      col: { width: [PIXEL_WIDTH_PATTERN] },
      tr: { height: [ROW_HEIGHT_PATTERN] },
      th: { 'background-color': [HEX_COLOR_PATTERN] },
      td: { 'background-color': [HEX_COLOR_PATTERN] },
      span: { color: [HEX_COLOR_PATTERN] },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      img: ['http', 'https'],
    },
    allowProtocolRelative: false,
  });

  const tables = sanitized.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  let cellCount = 0;
  for (const table of tables) {
    const rows = table.match(/<tr\b[^>]*>/gi) || [];
    if (rows.length > COURSE_HTML_MAX_ROWS) {
      throw new AppError(`Một bảng chỉ được tối đa ${COURSE_HTML_MAX_ROWS} hàng.`, 400);
    }
    const rowFragments = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rowFragments) {
      const cells = row.match(/<(?:td|th)\b[^>]*>/gi) || [];
      if (cells.length > COURSE_HTML_MAX_COLUMNS) {
        throw new AppError(`Một bảng chỉ được tối đa ${COURSE_HTML_MAX_COLUMNS} cột.`, 400);
      }
      cellCount += cells.length;
    }
  }
  if (cellCount > COURSE_HTML_MAX_CELLS) {
    throw new AppError('Nội dung có quá nhiều ô bảng để lưu an toàn.', 400);
  }

  return sanitized;
}
