# Hướng dẫn FE: CRUD Bộ lọc tin nhắn (filter_config)

## API Endpoint

```
PUT /api/v1/widget/:botId/configurations
```

- **Auth**: Supabase Auth (Bearer token)
- **Content-Type**: `application/json` hoặc `multipart/form-data` (nếu có upload avatar)
- **Body**: gửi field `filter_config` — chỉ gửi field cần update, các field khác không bị ảnh hưởng

---

## Cấu trúc `filter_config`

```json
{
  "filter_config": {
    "length": true,
    "normalize": true,
    "language": true,
    "gibberish": true,
    "repeat": true,
    "profanity": true,
    "filter_params": {
      "length": {
        "min": 2,
        "max": 2000
      },
      "repeat": {
        "maxRepeatCount": 3,
        "ttlSeconds": 300
      },
      "language": {
        "foreignCharThreshold": 0.3
      },
      "gibberish": {
        "minEntropyThreshold": 1.5,
        "maxRepeatRatio": 0.6,
        "minValidCharRatio": 0.5,
        "maxConsonantCluster": 5
      },
      "profanity": {
        "blockSeverity": "HIGH"
      }
    },
    "message_config": [
      { "code": "EMPTY", "message": "Bạn chưa nhập nội dung..." },
      { "code": "TOO_SHORT", "message": "Nội dung tin nhắn quá ngắn..." },
      { "code": "TOO_LONG", "message": "Tin nhắn quá dài..." },
      { "code": "GIBBERISH", "message": "Nội dung chưa rõ ràng..." },
      { "code": "BINARY_GARBAGE", "message": "Nội dung không hiển thị đúng..." },
      { "code": "PROFANITY", "message": "Tin nhắn chứa ngôn từ không phù hợp..." },
      { "code": "UNSUPPORTED_LANG", "message": "Hệ thống chỉ hỗ trợ tiếng Việt và tiếng Anh..." },
      { "code": "REPEATED_SENTENCE", "message": "Bạn đã gửi nội dung này nhiều lần..." }
    ]
  }
}
```

---

## Giải thích từng phần

### 1. Toggle bật/tắt (boolean)

| Field | Ý nghĩa | Mặc định |
|---|---|---|
| `length` | Kiểm tra tin nhắn có quá ngắn/dài không | `true` |
| `normalize` | Làm sạch text trước khi kiểm tra (xoá ký tự ẩn, gộp dấu cách) | `true` |
| `language` | Chặn ngôn ngữ ngoài (Trung, Nhật, Hàn, Ả Rập...) | `true` |
| `gibberish` | Chặn nội dung vô nghĩa (gõ bừa, lặp ký tự, ký tự đặc biệt) | `true` |
| `repeat` | Chặn gửi cùng 1 câu nhiều lần liên tiếp | `true` |
| `profanity` | Chặn chửi bậy | `true` |

> FE hiển thị dạng Switch/Toggle cho từng bước.

---

### 2. `filter_params` — Ngưỡng config chi tiết

#### `length` — Giới hạn độ dài

| Field | Kiểu | Ý nghĩa | Mặc định | Min | Max | Step | Validation |
|---|---|---|---|---|---|---|---|
| `min` | integer | Số ký tự tối thiểu | `2` | `1` | `100` | `1` | `min < max`, bắt buộc |
| `max` | integer | Số ký tự tối đa | `2000` | `100` | `10000` | `100` | `max > min`, bắt buộc |

> FE: 2 input number. Validate khi save: `1 ≤ min < max ≤ 10000`.

#### `language` — Chặn ngôn ngữ ngoài

| Field | Kiểu | Ý nghĩa | Mặc định | Min | Max | Step | Validation |
|---|---|---|---|---|---|---|---|
| `foreignCharThreshold` | float | Tỷ lệ ký tự ngoại (TQ/Nhật/Hàn/Ả Rập) tối đa cho phép. VD: 0.3 = chặn nếu > 30% | `0.3` | `0.1` | `0.9` | `0.1` | bắt buộc |

> FE: slider hoặc input number. Hiển thị dạng %: "30%". Không cho đặt 0 (chặn hết) hay 1 (không chặn gì).

#### `gibberish` — Chặn nội dung vô nghĩa

| Field | Kiểu | Ý nghĩa | Mặc định | Min | Max | Step | Validation |
|---|---|---|---|---|---|---|---|
| `minEntropyThreshold` | float | Entropy Shannon tối thiểu. Càng cao = càng dễ bị chặn. Text lặp "aaa" ≈ 0, text bình thường ≈ 3-5 | `1.5` | `0.5` | `4.0` | `0.1` | bắt buộc |
| `maxRepeatRatio` | float | Tỷ lệ lặp 1 ký tự tối đa. VD: 0.6 = chặn nếu 1 ký tự chiếm > 60% tin nhắn | `0.6` | `0.3` | `0.9` | `0.1` | bắt buộc |
| `minValidCharRatio` | float | Tỷ lệ ký tự hợp lệ (chữ, số, space) tối thiểu. VD: 0.5 = chặn nếu < 50% ký tự hợp lệ | `0.5` | `0.2` | `0.9` | `0.1` | bắt buộc |
| `maxConsonantCluster` | integer | Cụm phụ âm liên tiếp tối đa. Keyboard smash "bcdfg" = 5. Quá dài = vô nghĩa | `5` | `3` | `10` | `1` | bắt buộc |

> FE nên để dạng Advanced/Nâng cao (collapse mặc định). Các giá trị này ít khi cần chỉnh.

#### `repeat` — Chặn câu lặp

| Field | Kiểu | Ý nghĩa | Mặc định | Min | Max | Step | Validation |
|---|---|---|---|---|---|---|---|
| `maxRepeatCount` | integer | Số lần lặp câu tối đa trước khi chặn | `3` | `2` | `10` | `1` | bắt buộc |
| `ttlSeconds` | integer | Thời gian (giây) tự reset bộ đếm. Hết hạn = cho lặp lại | `300` | `60` | `3600` | `60` | bắt buộc |

> FE: 2 input number. Hiển thị `ttlSeconds` dạng phút nếu muốn (300s = 5ph). Dùng hash counter Redis (INCR), không cần `windowMessages` nữa.

#### `profanity` — Chặn chửi bậy

| Field | Kiểu | Ý nghĩa | Mặc định | Giá trị cho phép |
|---|---|---|---|---|
| `blockSeverity` | string | Mức độ chặn: `"HIGH"` = chỉ tiếng Việt, `"MEDIUM"` = cả tiếng Anh | `"HIGH"` | `"HIGH"` hoặc `"MEDIUM"` |

> FE: Radio/Select 2 options: "Chỉ tiếng Việt" → `HIGH` / "Cả tiếng Việt và Anh" → `MEDIUM`.

---

### 3. `message_config` — Câu phản hồi khi bị chặn

Mảng **cố định 8 phần tử**, mỗi phần tử gồm:

| Field | Kiểu | Ý nghĩa | Validation |
|---|---|---|---|
| `code` | string | Mã lỗi cố định, **FE không cho sửa** | readonly, không đổi |
| `message` | string | Câu phản hồi gửi về cho khách | bắt buộc, `1 ≤ length ≤ 500`, không được rỗng |

**8 mã lỗi cố định:**

| Code | Khi nào xảy ra |
|---|---|
| `EMPTY` | Tin nhắn rỗng / chỉ emoji / chỉ link |
| `TOO_SHORT` | Tin nhắn quá ngắn (dưới `min`) |
| `TOO_LONG` | Tin nhắn quá dài (trên `max`) |
| `GIBBERISH` | Nội dung vô nghĩa |
| `BINARY_GARBAGE` | Chứa ký tự điều khiển lỗi |
| `PROFANITY` | Chửi bậy |
| `UNSUPPORTED_LANG` | Ngôn ngữ không hỗ trợ |
| `REPEATED_SENTENCE` | Gửi lặp câu nhiều lần |

> FE: 8 textarea/input, label = code (readonly), value = message (editable). Không cho xoá/thêm phần tử.

---

## Cách gọi API

### Đọc config hiện tại (GET)

```
GET /api/v1/widget/:botId/configurations
```

Response trả về full row `widget_configurations`, trong đó có field `filter_config`.

### Cập nhật (PUT)

```
PUT /api/v1/widget/:botId/configurations
Content-Type: application/json
Authorization: Bearer <token>

{
  "filter_config": { ...toàn bộ object filter_config... }
}
```

> **QUAN TRỌNG**: Luôn gửi **toàn bộ** object `filter_config` khi save (không gửi partial). Backend sẽ ghi đè toàn bộ cột `filter_config` trong DB.

### Response

```json
{
  "status": 200,
  "message": "Success",
  "metadata": {
    "bot": { "id": "...", "name": "...", ... },
    "widget": {
      "id": "...",
      "filter_config": { ...object đã lưu... },
      ...
    }
  }
}
```

---

## Gợi ý UI Layout

```
┌──────────────────────────────────────────────────┐
│  Bộ lọc tin nhắn                                  │
│                                                    │
│  ┌─ Bước kiểm tra ─────────────────────────────┐ │
│  │  ☑ Kiểm tra độ dài          [Toggle]         │ │
│  │  ☑ Chuẩn hoá text           [Toggle]         │ │
│  │  ☑ Chặn ngôn ngữ ngoài      [Toggle]         │ │
│  │  ☑ Chặn nội dung vô nghĩa   [Toggle]         │ │
│  │  ☑ Chặn câu lặp             [Toggle]         │ │
│  │  ☑ Chặn chửi bậy            [Toggle]         │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ▶ Cấu hình nâng cao (collapse)                   │
│  ┌──────────────────────────────────────────────┐ │
│  │  Độ dài: min [2] — max [2000]                │ │
│  │  Ngôn ngữ ngoài: tối đa [30] %              │ │
│  │  Câu lặp: chặn sau [3] lần / [10] tin / [5] ph│ │
│  │  Chửi bậy: ○ Chỉ VN  ● Cả VN+EN            │ │
│  │  Gibberish: (hiếm khi cần chỉnh)            │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ▶ Câu phản hồi khi bị chặn                      │
│  ┌──────────────────────────────────────────────┐ │
│  │  EMPTY:      [___textarea___]                │ │
│  │  TOO_SHORT:  [___textarea___]                │ │
│  │  TOO_LONG:   [___textarea___]                │ │
│  │  GIBBERISH:  [___textarea___]                │ │
│  │  ...                                          │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  [Lưu cấu hình]                                  │
└──────────────────────────────────────────────────┘
```
