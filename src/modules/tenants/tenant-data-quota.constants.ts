/** Stable transport contract. The UI maps this code to a non-technical notice. */
export const TENANT_DATA_LIMIT_REACHED_CODE = 'TENANT_DATA_LIMIT_REACHED';
export const TENANT_DATA_LIMIT_REACHED_MESSAGE = 'Không thể lưu thêm dữ liệu vì doanh nghiệp đã dùng hết dung lượng được cấp. Vui lòng xóa bớt dữ liệu hoặc liên hệ quản trị viên để tăng dung lượng.';

export const TENANT_DATA_QUOTA_RECONCILING_CODE = 'TENANT_DATA_QUOTA_RECONCILING';
export const TENANT_DATA_QUOTA_RECONCILING_MESSAGE = 'Hệ thống đang cập nhật dung lượng của doanh nghiệp. Vui lòng thử lại sau ít phút.';

/** Custom PostgreSQL SQLSTATE raised only by the quota trigger functions. */
export const TENANT_DATA_LIMIT_REACHED_SQLSTATE = 'LQ001';
export const TENANT_DATA_QUOTA_RECONCILING_SQLSTATE = 'LQ002';
