# Bộ lọc tin nhắn rác – Giải thích dễ hiểu

## Nó là gì?

Khi khách nhắn tin vào chatbot, tin nhắn đi qua "cổng kiểm tra" trước khi gửi cho AI. Cổng này chỉ trả về **mã lỗi** (code), bên BE `messages-consume` tự quyết định câu trả lời gửi về cho khách.

**Toàn bộ config (ngưỡng, bật/tắt) do consumer truyền vào — filter package không có hardcoded default.**

---

## Luồng dữ liệu

```
Khách nhắn tin
      ↓
BE nhận tin (messages-consume)
      ↓
  ┌──────────────────────────────────────────┐
  │       chatbot-input-filter               │
  │                                          │
  │  BE truyền vào:                          │
  │   - message gốc                          │
  │   - sessionId                            │
  │   - config: ngưỡng đầy đủ (bắt buộc)   │
  │   - redisClient (cho repeat check)       │
  │   - redisKeyPrefix (tuỳ chọn)           │
  │   - steps: bước nào bật/tắt              │
  │                                          │
  │  Filter trả về:                          │
  │   - passed: true/false                   │
  │   - code: 'PASS' | 'EMPTY' | ...        │
  │   - detail: 'giải thích lỗi'            │
  │   - processingTimeMs: 0.3               │
  │                                          │
  │  ❌ KHÔNG trả message                    │
  │  → BE tự map code → câu trả lời         │
  └────────────────┬─────────────────────────┘
                   │
            ┌──────┴──────┐
            │             │
       passed=false   passed=true
            │             │
            ↓             ↓
       BE tự lấy      Gọi AI
       message từ      (Gemini/RAG)
       code để trả
       về FE
```

---

## 6 bước kiểm tra (mỗi bước có thể bật/tắt)

### Bước 1: Có nội dung không? (`steps.length`)

- Tin trống → `EMPTY`
- Chỉ emoji → `EMPTY`
- Chỉ link → `EMPTY`
- Quá ngắn (dưới `config.length.min` ký tự) → `TOO_SHORT`
- Quá dài (hơn `config.length.max` ký tự) → `TOO_LONG`

### Bước 2: Làm sạch chữ (`steps.normalize`)

Dọn dẹp tin nhắn cho các bước sau: gộp dấu, xoá ký tự vô hình, co chữ lặp.
Nếu tắt → dùng text gốc (chỉ trim) cho các bước sau.

### Bước 3: Đúng ngôn ngữ không? (`steps.language`)

Chặn tiếng Trung/Nhật/Hàn/Ả Rập... → `UNSUPPORTED_LANG`
Ngưỡng: `config.language.foreignCharThreshold`

### Bước 4: Có nghĩa không? (`steps.gibberish`)

Chặn keyboard smash, toàn ký tự đặc biệt, lặp vô nghĩa → `GIBBERISH`
Ngưỡng: `config.gibberish.*`

### Bước 5: Lặp lại hoài? (`steps.repeat`, cần Redis)

Dùng hash counter (Redis INCR): mỗi tin nhắn unique = 1 key nhỏ (~80 bytes), tự expire.
Text được chuẩn hoá trước khi hash (bỏ dấu câu, lowercase) → "xin chào!" và "xin chào--" = cùng 1 hash.
Cùng câu gửi `config.repeat.maxRepeatCount`+ lần trong `config.repeat.ttlSeconds` giây → `REPEATED_SENTENCE`

### Bước 6: Có chửi bậy? (`steps.profanity`)

Từ thô tục tiếng Việt/Anh → `PROFANITY`
`config.profanity.blockSeverity`: `'HIGH'` = chỉ VN, `'MEDIUM'` = cả EN

---

## Cách dùng trong messages-consume.service.ts

### 1. Import

```typescript
import { runFilterPipeline, FilterRejectCode } from '@timo/input-filter';
import { getRedis, genRedisKey } from '../services/redis/client';
```

### 2. Response messages (lấy từ widget_configurations)

```typescript
// Lấy từ filter_config.message_config
const filterResponses: Record<string, string> = {}
for (const item of filterConfig.message_config) {
    filterResponses[item.code] = item.message
}
```

### 3. Gọi filter trước khi gọi AI

```typescript
const fp = filterConfig.filter_params

const filterResult = await runFilterPipeline(message, {
    sessionId: conversationId,
    redisClient: getRedis(),
    redisKeyPrefix: genRedisKey(tenantId, 'input-filter', 'repeat'),
    steps: {
        length: filterConfig.length,
        normalize: filterConfig.normalize,
        language: filterConfig.language,
        gibberish: filterConfig.gibberish,
        repeat: filterConfig.repeat,
        profanity: filterConfig.profanity,
    },
    config: {
        length: fp.length,
        gibberish: fp.gibberish,
        language: fp.language,
        repeat: fp.repeat,
        profanity: fp.profanity,
    },
    debug: false,
});

// Bị chặn → lấy message từ filterResponses
if (!filterResult.passed && filterResult.code) {
    const replyMessage = filterResponses[filterResult.code] || 'Tin nhắn không hợp lệ.'
    // ... gửi về FE qua supabase channel (giả lập LLM streaming)
    return;
}

// PASS → gọi Gemini/RAG bình thường
```

### 4. Redis Key

Repeat filter dùng hash counter — mỗi tin nhắn unique = 1 key riêng:

```
{prefix}:{sessionId}:{hash16(msg)}
```

| Cách | Key format |
|---|---|
| Không truyền `redisKeyPrefix` | `input-filter:repeat:{sessionId}:{hash}` |
| Truyền `genRedisKey(...)` | `midesk-chatbot-ai:development:tenant:{tenantId}:input-filter:repeat:{sessionId}:{hash}` |

Mỗi key chỉ lưu 1 integer (counter), tự expire theo `ttlSeconds`.

### 5. Bật/tắt từng bước

```typescript
// Chỉ check length + profanity
const result = await runFilterPipeline(message, {
    sessionId: conversationId,
    config: fullConfig,          // vẫn bắt buộc truyền config đầy đủ
    redisClient: getRedis(),
    steps: {
        length: true,
        normalize: false,
        language: false,
        gibberish: false,
        repeat: false,
        profanity: true,
    },
});
```

---

## Config đầy đủ (FilterPipelineConfig)

```typescript
// config là BẮT BUỘC — không có default nội bộ
{
    length: {
        min: 2,           // Tối thiểu 2 ký tự
        max: 2000,        // Tối đa 2000 ký tự
    },
    gibberish: {
        minEntropyThreshold: 1.5,   // Shannon entropy tối thiểu
        maxRepeatRatio: 0.6,        // Tỷ lệ lặp 1 ký tự tối đa (60%)
        minValidCharRatio: 0.5,     // Tỷ lệ ký tự hợp lệ tối thiểu (50%)
        maxConsonantCluster: 5,     // Cụm phụ âm tối đa 5 ký tự liên tiếp
    },
    language: {
        foreignCharThreshold: 0.3,  // Chặn nếu > 30% ký tự ngoại
    },
    repeat: {
        maxRepeatCount: 3,    // Chặn nếu lặp >= 3 lần trong TTL window
        ttlSeconds: 300,      // Key hết hạn sau 5 phút → reset bộ đếm
    },
    profanity: {
        blockSeverity: 'HIGH',  // HIGH = chỉ VN, MEDIUM = cả EN
    },
}
```

---

## filter_config trong widget_configurations (DB)

```json
{
  "length": true,
  "normalize": true,
  "language": true,
  "gibberish": true,
  "repeat": true,
  "profanity": true,
  "filter_params": {
    "length": { "min": 2, "max": 2000 },
    "gibberish": {
      "minEntropyThreshold": 1.5,
      "maxRepeatRatio": 0.6,
      "minValidCharRatio": 0.5,
      "maxConsonantCluster": 5
    },
    "language": { "foreignCharThreshold": 0.3 },
    "repeat": { "maxRepeatCount": 3, "ttlSeconds": 300 },
    "profanity": { "blockSeverity": "HIGH" }
  },
  "message_config": [
    { "code": "EMPTY", "message": "..." },
    { "code": "TOO_SHORT", "message": "..." },
    { "code": "TOO_LONG", "message": "..." },
    { "code": "GIBBERISH", "message": "..." },
    { "code": "BINARY_GARBAGE", "message": "..." },
    { "code": "PROFANITY", "message": "..." },
    { "code": "UNSUPPORTED_LANG", "message": "..." },
    { "code": "REPEATED_SENTENCE", "message": "..." }
  ]
}
```

- **Top-level booleans** (`length`, `normalize`...): bật/tắt từng bước → map vào `steps`
- **`filter_params`**: ngưỡng config cho từng bước → map vào `config`
- **`message_config`**: response messages → BE tự map `code` → `message`

---

## FilterResult trả về

```typescript
{
    passed: boolean,         // true = sạch, false = bị chặn
    code: string,            // 'PASS' | 'EMPTY' | 'TOO_SHORT' | ...
    detail?: string,         // Chi tiết lỗi (cho dev debug)
    processingTimeMs?: number,
}
```

> **Không có field `message`.** BE tự map `code` → câu trả lời từ `message_config`.

---

## Commands

```bash
# Test tự động (37 cases)
npm run test_input_filter

# Test thủ công
cd chatbot-input-filter && npx tsx tests/manual-test.ts
cd chatbot-input-filter && npx tsx tests/manual-test.ts --debug
```
