// ============================================================
// RESPONSE TEMPLATES - Câu phản hồi thân thiện cho từng loại lỗi
// ============================================================

import { FilterRejectCode } from '../types/filter.types.js';

/**
 * Template phản hồi mặc định (thân thiện)
 */
export const RESPONSE_TEMPLATES: Record<FilterRejectCode, string> = {
    [FilterRejectCode.EMPTY]:
        'Bạn chưa nhập nội dung. Vui lòng nhập tin nhắn để mình hỗ trợ nhé! 😊',

    [FilterRejectCode.TOO_SHORT]:
        'Tin nhắn hơi ngắn quá, bạn có thể nói rõ hơn được không? 🤔',

    [FilterRejectCode.TOO_LONG]:
        'Tin nhắn quá dài rồi! Bạn có thể tóm tắt ý chính giúp mình không? 📝',

    [FilterRejectCode.GIBBERISH]:
        'Mình chưa hiểu nội dung này. Bạn có thể gửi lại bằng văn bản rõ ràng hơn không? 📖',

    [FilterRejectCode.BINARY_GARBAGE]:
        'Nội dung có vẻ bị lỗi hiển thị. Bạn có thể gửi lại dạng văn bản bình thường không? 🔧',

    [FilterRejectCode.PROFANITY]:
        'Vui lòng sử dụng ngôn từ phù hợp để mình có thể hỗ trợ bạn tốt hơn nhé! 🙏',

    [FilterRejectCode.UNSUPPORTED_LANG]:
        'Hiện tại mình chỉ hỗ trợ tiếng Việt và tiếng Anh. Bạn vui lòng gửi lại bằng 1 trong 2 ngôn ngữ này nhé! 🌐',

    [FilterRejectCode.REPEATED_SENTENCE]:
        'Bạn đã gửi tin nhắn này nhiều lần rồi. Nếu cần hỗ trợ thêm, mình có thể kết nối bạn với nhân viên hỗ trợ nhé! 👨‍💼',
};

/**
 * Template phản hồi phiên bản FORMAL (banking, enterprise)
 */
export const RESPONSE_TEMPLATES_FORMAL: Record<FilterRejectCode, string> = {
    [FilterRejectCode.EMPTY]:
        'Quý khách vui lòng nhập nội dung tin nhắn để chúng tôi có thể hỗ trợ.',

    [FilterRejectCode.TOO_SHORT]:
        'Nội dung tin nhắn quá ngắn. Quý khách vui lòng mô tả chi tiết hơn.',

    [FilterRejectCode.TOO_LONG]:
        'Nội dung tin nhắn vượt quá giới hạn cho phép. Quý khách vui lòng tóm tắt nội dung chính.',

    [FilterRejectCode.GIBBERISH]:
        'Hệ thống không thể xử lý nội dung này. Quý khách vui lòng gửi lại bằng văn bản rõ ràng.',

    [FilterRejectCode.BINARY_GARBAGE]:
        'Nội dung tin nhắn có định dạng không hợp lệ. Quý khách vui lòng gửi lại dạng văn bản.',

    [FilterRejectCode.PROFANITY]:
        'Quý khách vui lòng sử dụng ngôn từ phù hợp trong quá trình trao đổi.',

    [FilterRejectCode.UNSUPPORTED_LANG]:
        'Hệ thống hiện chỉ hỗ trợ tiếng Việt và tiếng Anh. Quý khách vui lòng sử dụng một trong hai ngôn ngữ này.',

    [FilterRejectCode.REPEATED_SENTENCE]:
        'Tin nhắn này đã được gửi nhiều lần. Quý khách có thể liên hệ tổng đài để được hỗ trợ trực tiếp.',
};

/**
 * Lấy câu phản hồi theo mã lỗi
 */
export function getResponseMessage(code: FilterRejectCode, useFormal: boolean = false): string {
    if (useFormal) {
        return RESPONSE_TEMPLATES_FORMAL[code];
    }
    return RESPONSE_TEMPLATES[code];
}
