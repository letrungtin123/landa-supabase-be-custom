// Assistant text for report clarification turns, in the request locale. The
// dashboard renders the same reasons from its own i18n keys; this text is the
// persisted message content (history, accessibility, older clients).

import type { ReportClarification, ReportClarificationReason } from './report-chat-route.logic.js';

type Params = ReportClarification['params'];
type Copy = (params: Params) => string;

const quote = (value: string | undefined) => (value ? `“${value}”` : '');

const COPY: Record<ReportClarificationReason, Record<'vi' | 'en', Copy>> = {
  date_conflict: {
    vi: () => 'Khoảng thời gian trong câu hỏi có thể hiểu theo hai cách.',
    en: () => 'The period in your question can be read in two ways.',
  },
  date_invalid: {
    vi: () => 'Ngày trong câu hỏi không có trên lịch.',
    en: () => 'A date in your question does not exist in the calendar.',
  },
  date_reversed: {
    vi: () => 'Ngày bắt đầu đang sau ngày kết thúc.',
    en: () => 'The start date is after the end date.',
  },
  date_too_long: {
    vi: (params) => `Mỗi báo cáo xem tối đa ${params.max_days ?? 366} ngày.`,
    en: (params) => `A report covers at most ${params.max_days ?? 366} days.`,
  },
  date_multiple: {
    vi: () => 'Câu hỏi có nhiều khoảng thời gian khác nhau.',
    en: () => 'Your question mentions several periods.',
  },
  date_future: {
    vi: () => 'Khoảng thời gian này của năm nay chưa diễn ra.',
    en: () => 'That period has not happened yet this year.',
  },
  date_open: {
    vi: () => 'Báo cáo cần một mốc bắt đầu.',
    en: () => 'The report needs a start date.',
  },
  unit_ambiguous: {
    vi: (params) => `Có nhiều đơn vị khớp với ${quote(params.mention)}.`,
    en: (params) => `Several units match ${quote(params.mention)}.`,
  },
  unit_not_found: {
    vi: (params) => (params.mention ? `Không tìm thấy đơn vị ${quote(params.mention)} trong tổ chức.` : 'Không tìm thấy đơn vị đã chọn trong tổ chức.'),
    en: (params) => (params.mention ? `No unit named ${quote(params.mention)} was found in your organization.` : 'The selected unit was not found in your organization.'),
  },
  // Never names the unit: a learner_plus must not learn names outside their groups.
  unit_forbidden: {
    vi: () => 'Bạn không có quyền xem báo cáo của đơn vị này.',
    en: () => 'You do not have access to reports for this unit.',
  },
  unit_multiple: {
    vi: () => 'Mỗi báo cáo xem một đơn vị.',
    en: () => 'Each report covers one unit.',
  },
  scope_required: {
    vi: () => 'Bạn được xem báo cáo của nhiều đơn vị.',
    en: () => 'You can view reports for several units.',
  },
  // The names are catalog names the question itself contains. One name means
  // several courses share it, so asking for it in quotes would not help.
  course_ambiguous: {
    vi: (params) => {
      const names = params.courses ?? [];
      if (names.length === 1) return `Có nhiều khóa học cùng tên ${quote(names[0])}, nên chưa thể chọn đúng một khóa học.`;
      return names.length > 1
        ? `Câu hỏi nhắc đến nhiều khóa học: ${names.map(quote).join(', ')}. Hãy hỏi lại với tên một khóa học trong dấu ngoặc kép.`
        : 'Câu hỏi khớp với nhiều khóa học. Hãy hỏi lại với tên một khóa học trong dấu ngoặc kép.';
    },
    en: (params) => {
      const names = params.courses ?? [];
      if (names.length === 1) return `Several courses are named ${quote(names[0])}, so one course cannot be chosen.`;
      return names.length > 1
        ? `Your question names several courses: ${names.map(quote).join(', ')}. Ask again with one course name in quotes.`
        : 'Your question matches several courses. Ask again with one course name in quotes.';
    },
  },
};

export function formatReportClarificationMessage(clarification: ReportClarification, locale: 'vi' | 'en'): string {
  const sentences = clarification.reasons.map((reason) => COPY[reason][locale](clarification.params));
  const prompt = clarification.options.length > 0
    ? locale === 'en' ? 'Choose an option below or open the filters.' : 'Chọn một lựa chọn bên dưới hoặc mở bộ lọc.'
    : locale === 'en' ? 'Open the filters to choose the period and unit.' : 'Mở bộ lọc để chọn thời gian và đơn vị.';
  return [...sentences, prompt].join(' ');
}
