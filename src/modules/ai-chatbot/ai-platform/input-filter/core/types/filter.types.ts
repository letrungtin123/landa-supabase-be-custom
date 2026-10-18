// ============================================================
// FILTER TYPES - Định nghĩa kiểu dữ liệu cho input filter
// ============================================================

/**
 * Mã lỗi khi input bị chặn
 */
export enum FilterRejectCode {
    EMPTY = 'EMPTY',
    TOO_SHORT = 'TOO_SHORT',
    TOO_LONG = 'TOO_LONG',
    GIBBERISH = 'GIBBERISH',
    BINARY_GARBAGE = 'BINARY_GARBAGE',
    PROFANITY = 'PROFANITY',
    UNSUPPORTED_LANG = 'UNSUPPORTED_LANG',
    REPEATED_SENTENCE = 'REPEATED_SENTENCE',
}

/**
 * Kết quả trả về sau khi chạy filter pipeline
 * Không chứa message — BE tự map code → message
 */
export interface FilterResult {
    passed: boolean;
    code: FilterRejectCode | 'PASS';
    detail?: string;
    processingTimeMs?: number;
}

/**
 * Mức độ chặn profanity
 */
export type ProfanitySeverity = 'HIGH' | 'MEDIUM';

// ============================================================
// TOGGLE CÁC BƯỚC — BE bật/tắt từng bước
// ============================================================

/**
 * Bật/tắt từng bước trong pipeline
 * Mặc định tất cả đều bật (true)
 */
export interface FilterSteps {
    length?: boolean;     // Bước 1: kiểm tra độ dài
    normalize?: boolean;  // Bước 2: làm sạch chữ
    language?: boolean;   // Bước 3: kiểm tra ngôn ngữ
    gibberish?: boolean;  // Bước 4: kiểm tra nội dung vô nghĩa
    repeat?: boolean;     // Bước 5: kiểm tra câu lặp (cần Redis)
    profanity?: boolean;  // Bước 6: kiểm tra chửi bậy
}

// ============================================================
// CẤU HÌNH CHO TỪNG FILTER
// ============================================================

export interface LengthConfig {
    min: number;
    max: number;
}

export interface GibberishConfig {
    minEntropyThreshold: number;
    maxRepeatRatio: number;
    minValidCharRatio: number;
    maxConsonantCluster: number;
}

export interface LanguageConfig {
    foreignCharThreshold: number;
}

export interface RepeatConfig {
    maxRepeatCount: number;
    ttlSeconds: number;
}

export type RepeatFallbackCounter = (args: {
    normalizedText: string;
    compareText: string;
    sessionId: string;
    config: RepeatConfig;
    keyPrefix: string;
    debug?: boolean;
}) => Promise<FilterResult>;

export interface ProfanityConfig {
    blockSeverity: ProfanitySeverity;
    blacklistVi: string[];   // danh sách từ cấm tiếng Việt (từ DB, FE có thể edit)
    blacklistEn: string[];   // danh sách từ cấm tiếng Anh (từ DB, FE có thể edit)
}

/**
 * Cấu hình tổng hợp cho toàn bộ filter pipeline
 * Consumer truyền đầy đủ — không có default nội bộ
 */
export interface FilterPipelineConfig {
    length: LengthConfig;
    gibberish: GibberishConfig;
    language: LanguageConfig;
    repeat: RepeatConfig;
    profanity: ProfanityConfig;
}

/**
 * Options truyền vào pipeline
 * config là BẮT BUỘC — consumer tự quản lý config
 */
export interface FilterPipelineOptions {
    sessionId: string;                          // ID session (bắt buộc)
    config: FilterPipelineConfig;               // Cấu hình đầy đủ (bắt buộc)
    redisClient?: any;                          // Redis client (cần cho repeat)
    redisKeyPrefix?: string;                    // Prefix cho Redis key, default 'input-filter:repeat'
    repeatFallbackCounter?: RepeatFallbackCounter | null; // DB fallback when Redis is unavailable
    steps?: FilterSteps;                        // Bật/tắt từng bước, default tất cả bật
    debug?: boolean;                            // Bật/tắt log
}
