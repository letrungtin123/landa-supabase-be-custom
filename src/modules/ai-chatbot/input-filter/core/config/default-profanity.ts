// ============================================================
// DEFAULT PROFANITY BLACKLIST - Danh sách từ cấm mặc định (hardcoded)
// ============================================================
// Danh sách cơ bản luôn có sẵn, user có thể bổ sung thêm qua UI (DB)
// Khi check: gộp DEFAULT + DB words lại

export const DEFAULT_BLACKLIST_VI: string[] = [
    'đụ', 'đụ má',
    'địt', 'địt mẹ',
    'đéo', 'đéo mẹ',
    'cặc', 'buồi', 'lồn',
    'đĩ', 'đĩ chó',
    'chó đẻ',
    'mẹ mày', 'con mẹ mày',
    'đồ chó', 'thằng chó', 'con chó',
    'ngu', 'ngu lồn', 'ngu vãi', 'ngu vl',
    'óc chó', 'đồ ngu', 'thằng ngu', 'con ngu',
    'đồ khốn', 'khốn nạn',
    'mất dạy', 'vô học',
    'đồ điên', 'thằng điên', 'con điên',
    'đồ rác', 'đồ rác rưởi',
    'chết mẹ', 'chết cha',
    'chó rách',
    // Viết tắt
    'dm', 'đm', 'dcm', 'dkm', 'vcl', 'vkl', 'vl', 'cl',
    'cmm', 'clm', 'đkm', 'dcc', 'cc', 'cmnr',
    // Không dấu
    'dit', 'dit me', 'du ma', 'deo', 'cak', 'buoi', 'lon',
];

export const DEFAULT_BLACKLIST_EN: string[] = [
    'fuck', 'fucking', 'fucked', 'fucker',
    'shit', 'shitty', 'bullshit',
    'bitch', 'bitches',
    'asshole', 'ass',
    'damn', 'damned',
    'dick', 'dickhead',
    'bastard',
    'motherfucker', 'mf',
    'wtf', 'stfu',
];
