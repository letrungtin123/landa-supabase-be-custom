# Hướng dẫn tích hợp chatbot-input-filter vào dự án khác

## 1. Mục tiêu và phạm vi

Folder sau sẽ được sao chép **nguyên vẹn** sang dự án đích:

```text
midesk-chatbot-backend/chatbot-input-filter/
```

Agent **không cần viết lại, tách lại hoặc sửa thuật toán** bên trong folder này. Package đã export sẵn:

```ts
import {
  runFilterPipeline,
  FilterRejectCode,
  type FilterResult,
  type FilterPipelineConfig,
  type FilterPipelineOptions,
  type FilterSteps,
} from '@timo/input-filter';
```

Agent ở dự án đích chỉ cần:

1. Gắn folder vào workspace/dependency graph.
2. Tạo cột DB lưu JSON cấu hình bộ lọc.
3. Tạo API đọc và cập nhật cấu hình.
4. Query JSON cấu hình khi nhận tin nhắn chat.
5. Chuyển JSON DB thành options của `runFilterPipeline`.
6. Truyền Redis client cho repeat filter.
7. Xử lý kết quả reject và dừng flow trước khi gọi AI.

## 2. Hiện trạng trong source gốc

### 2.1 Nơi gọi `runFilterPipeline`

Trong `ui-actions-backend/chatbot-workflow-engine` hiện **không có** import hoặc call `runFilterPipeline`.

Call site đang hoạt động nằm tại:

```text
midesk-chatbot-backend/chatbot-workflow-engine/src/services/messages-consume.service.ts
```

Import:

```ts
import { runFilterPipeline } from '@timo/input-filter';
```

Pipeline được gọi sau khi đã có `tenantId`, `botId` và `conversationId`, nhưng trước:

- intent classification;
- session reply lock;
- RAG/Gemini/LLM;
- các tác vụ AI tốn chi phí.

Khi port phải giữ đúng thứ tự này.

### 2.2 Nơi lưu cấu hình

```text
table:  widget_configurations
column: filter_config
scope:  tenant_id + chatbot_id
```

Consumer gốc đang query:

```ts
const { data: widgetConfig } = await supabase
  .from('widget_configurations')
  .select('filter_config, human_handoff_message, is_check_intent')
  .eq('chatbot_id', botId)
  .maybeSingle();
```

Khi port nên thêm điều kiện tenant và kiểm tra lỗi:

```ts
const { data: widgetConfig, error } = await supabase
  .from('widget_configurations')
  .select('filter_config')
  .eq('tenant_id', tenantId)
  .eq('chatbot_id', botId)
  .maybeSingle();

if (error) throw error;
```

## 3. Gắn package vào dự án đích

### 3.1 Dự án dùng npm workspaces

Package được copy đã có tên `@timo/input-filter`, entry runtime `dist/index.js` và types tại `dist/index.d.ts`.

Thêm workspace và build package trước consumer:

```json
{
  "private": true,
  "workspaces": [
    "chatbot-workflow-engine",
    "chatbot-input-filter"
  ],
  "scripts": {
    "build": "npm run build --workspace=chatbot-input-filter && npm run build --workspace=chatbot-workflow-engine"
  }
}
```

### 3.2 Dự án không dùng workspaces

Thêm local dependency vào package consumer:

```json
{
  "dependencies": {
    "@timo/input-filter": "file:../chatbot-input-filter"
  }
}
```

Sau khi cài dependency, phải build `chatbot-input-filter` trước khi build/start consumer. Không import trực tiếp từ `chatbot-input-filter/src`.

## 4. JSON cấu hình lưu trong DB

Đây là shape phù hợp với consumer hiện tại. Các toggle phải có prefix `enable_`:

```json
{
  "enable_length": true,
  "enable_normalize": true,
  "enable_language": true,
  "enable_gibberish": true,
  "enable_repeat": true,
  "enable_profanity": true,
  "filter_params": {
    "length": {
      "min": 2,
      "max": 2000
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
    "repeat": {
      "maxRepeatCount": 3,
      "ttlSeconds": 300
    },
    "profanity": {
      "blockSeverity": "HIGH",
      "blacklistVi": [],
      "blacklistEn": []
    }
  },
  "message_config": [
    { "code": "EMPTY", "message": "Vui lòng nhập nội dung." },
    { "code": "TOO_SHORT", "message": "Tin nhắn quá ngắn." },
    { "code": "TOO_LONG", "message": "Tin nhắn quá dài." },
    { "code": "GIBBERISH", "message": "Nội dung chưa rõ ràng." },
    { "code": "BINARY_GARBAGE", "message": "Nội dung có ký tự không hợp lệ." },
    { "code": "PROFANITY", "message": "Vui lòng sử dụng ngôn từ phù hợp." },
    { "code": "UNSUPPORTED_LANG", "message": "Chỉ hỗ trợ tiếng Việt và tiếng Anh." },
    { "code": "REPEATED_SENTENCE", "message": "Tin nhắn này đã được gửi nhiều lần." }
  ]
}
```

### 4.1 Toggle

| JSON field | Pipeline step | Tác dụng |
|---|---|---|
| `enable_length` | `length` | Rỗng, chỉ emoji/link, quá ngắn hoặc quá dài |
| `enable_normalize` | `normalize` | Chuẩn hóa text cho các check phía sau |
| `enable_language` | `language` | Chỉ cho phép Việt/Anh theo threshold |
| `enable_gibberish` | `gibberish` | Nội dung vô nghĩa, ký tự lỗi, lặp ký tự |
| `enable_repeat` | `repeat` | Lặp cùng nội dung trong session; cần Redis |
| `enable_profanity` | `profanity` | Blacklist Việt và tùy chọn tiếng Anh |

`enable_normalize` không tự reject input; nó chỉ biến đổi text trước các bước sau.

### 4.2 Các tham số

| Path | Ý nghĩa |
|---|---|
| `length.min` | Độ dài tối thiểu sau trim |
| `length.max` | Độ dài tối đa sau trim |
| `language.foreignCharThreshold` | Chặn khi tỷ lệ ngôn ngữ ngoài lớn hơn giá trị này |
| `gibberish.minEntropyThreshold` | Entropy tối thiểu |
| `gibberish.maxRepeatRatio` | Tỷ lệ tối đa của ký tự xuất hiện nhiều nhất |
| `gibberish.minValidCharRatio` | Tỷ lệ tối thiểu của chữ, số và khoảng trắng hợp lệ |
| `gibberish.maxConsonantCluster` | Số phụ âm liên tiếp tối đa |
| `repeat.maxRepeatCount` | Count đạt ngưỡng này thì chặn; `3` nghĩa là lần thứ 3 bị chặn |
| `repeat.ttlSeconds` | Cửa sổ Redis tính từ lần gửi đầu tiên |
| `profanity.blockSeverity` | `HIGH`: chỉ Việt; `MEDIUM`: Việt và Anh |
| `profanity.blacklistVi` | Từ tiếng Việt bổ sung ngoài danh sách có sẵn trong package |
| `profanity.blacklistEn` | Từ tiếng Anh bổ sung ngoài danh sách có sẵn trong package |

### 4.3 Message phản hồi

Package không trả câu trả lời cho user, chỉ trả reject code:

```text
EMPTY
TOO_SHORT
TOO_LONG
GIBBERISH
BINARY_GARBAGE
PROFANITY
UNSUPPORTED_LANG
REPEATED_SENTENCE
```

Consumer phải map code sang `message_config`. Mỗi code cần xuất hiện đúng một lần và consumer luôn phải có fallback message.

## 5. Migration DB

Source gốc không chứa migration tạo `filter_config`, nên không thể xác minh kiểu cột thực tế. Khi tạo mới ở dự án đích nên dùng `jsonb`:

```sql
alter table public.widget_configurations
  add column if not exists filter_config jsonb;

create unique index if not exists uq_widget_configurations_tenant_chatbot
  on public.widget_configurations (tenant_id, chatbot_id);
```

Có thể đặt full JSON làm default DB, hoặc để nullable và merge với default trong code. Tuyệt đối không gọi pipeline với `config: undefined`.

Không cần GIN index trên `filter_config` nếu ứng dụng chỉ đọc theo tenant + chatbot và không search nested JSON.

## 6. Schema validation ở consumer/API

Source gốc dùng `filter_config: z.any()`. Không nên copy điểm này. Thêm schema chặt ở API boundary:

```ts
import { z } from 'zod';

const MessageCodeSchema = z.enum([
  'EMPTY',
  'TOO_SHORT',
  'TOO_LONG',
  'GIBBERISH',
  'BINARY_GARBAGE',
  'PROFANITY',
  'UNSUPPORTED_LANG',
  'REPEATED_SENTENCE',
]);

export const FilterConfigSchema = z.object({
  enable_length: z.boolean(),
  enable_normalize: z.boolean(),
  enable_language: z.boolean(),
  enable_gibberish: z.boolean(),
  enable_repeat: z.boolean(),
  enable_profanity: z.boolean(),
  filter_params: z.object({
    length: z.object({
      min: z.number().int().min(1),
      max: z.number().int().max(10000),
    }).refine(v => v.min < v.max, 'min phải nhỏ hơn max'),
    language: z.object({
      foreignCharThreshold: z.number().min(0).max(1),
    }),
    gibberish: z.object({
      minEntropyThreshold: z.number().min(0),
      maxRepeatRatio: z.number().min(0).max(1),
      minValidCharRatio: z.number().min(0).max(1),
      maxConsonantCluster: z.number().int().positive(),
    }),
    repeat: z.object({
      maxRepeatCount: z.number().int().min(2),
      ttlSeconds: z.number().int().positive(),
    }),
    profanity: z.object({
      blockSeverity: z.enum(['HIGH', 'MEDIUM']),
      blacklistVi: z.array(z.string().trim().min(1)).default([]),
      blacklistEn: z.array(z.string().trim().min(1)).default([]),
    }),
  }),
  message_config: z.array(z.object({
    code: MessageCodeSchema,
    message: z.string().trim().min(1).max(500),
  })).length(8),
});

export type StoredFilterConfig = z.infer<typeof FilterConfigSchema>;
```

Nên thêm refinement để đảm bảo tám code là unique và đủ toàn bộ danh sách.

## 7. API đọc và ghi cấu hình

Endpoint tham khảo:

```text
GET /api/v1/widget/:botId/configurations
PUT /api/v1/widget/:botId/configurations
```

### 7.1 Đọc row hiện tại

```ts
export async function getWidgetConfigRow(
  supabase: SupabaseClient,
  tenantId: string,
  botId: string,
) {
  const { data, error } = await supabase
    .from('widget_configurations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('chatbot_id', botId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}
```

### 7.2 Lưu full object

```ts
export async function saveFilterConfig(args: {
  supabase: SupabaseClient;
  tenantId: string;
  botId: string;
  actorUserId: string;
  input: unknown;
}) {
  const filterConfig = FilterConfigSchema.parse(args.input);

  const { data, error } = await args.supabase
    .from('widget_configurations')
    .upsert({
      tenant_id: args.tenantId,
      chatbot_id: args.botId,
      filter_config: filterConfig,
      updated_by: args.actorUserId,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'tenant_id,chatbot_id',
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}
```

`filter_config` là một cột JSON, nên update object này sẽ ghi đè nguyên cột. FE phải gửi full object, hoặc backend phải chủ động deep-merge rồi validate kết quả cuối.

Nếu table bắt buộc `created_by`, hãy tách insert/update như source gốc thay vì dùng upsert ngắn gọn.

## 8. Adapter gọi `runFilterPipeline`

Nên tạo adapter riêng để message consumer không chứa logic map DB dài:

```ts
import {
  runFilterPipeline,
  type FilterResult,
} from '@timo/input-filter';

const FALLBACK_FILTER_MESSAGE = 'Tin nhắn không hợp lệ.';

type RunStoredFilterArgs = {
  message: string;
  sessionId: string;
  rawConfig: unknown;
  redisClient: any | null;
  redisKeyPrefix: string;
};

type StoredFilterOutcome = {
  result: FilterResult;
  replyMessage: string | null;
};

export async function runStoredInputFilter(
  args: RunStoredFilterArgs,
): Promise<StoredFilterOutcome> {
  const cfg = FilterConfigSchema.parse(args.rawConfig);

  const hasRejectStepEnabled =
    cfg.enable_length ||
    cfg.enable_language ||
    cfg.enable_gibberish ||
    cfg.enable_repeat ||
    cfg.enable_profanity;

  if (!hasRejectStepEnabled) {
    return {
      result: { passed: true, code: 'PASS' },
      replyMessage: null,
    };
  }

  const fp = cfg.filter_params;
  const result = await runFilterPipeline(args.message, {
    sessionId: args.sessionId,
    redisClient: args.redisClient,
    redisKeyPrefix: args.redisKeyPrefix,
    steps: {
      length: cfg.enable_length,
      normalize: cfg.enable_normalize,
      language: cfg.enable_language,
      gibberish: cfg.enable_gibberish,
      repeat: cfg.enable_repeat,
      profanity: cfg.enable_profanity,
    },
    config: {
      length: fp.length,
      language: fp.language,
      gibberish: fp.gibberish,
      repeat: fp.repeat,
      profanity: fp.profanity,
    },
    debug: false,
  });

  if (result.passed) {
    return { result, replyMessage: null };
  }

  const responseMap = Object.fromEntries(
    cfg.message_config.map(item => [item.code, item.message]),
  );

  return {
    result,
    replyMessage: responseMap[result.code] ?? FALLBACK_FILTER_MESSAGE,
  };
}
```

## 9. Query config và gọi adapter trong message consumer

Trước khi gọi cần có:

- raw `message` của user;
- `tenantId` và `botId`;
- `conversationId`, dùng làm `sessionId` cho repeat filter;
- Supabase client;
- Redis client hoặc `null`;
- hàm lưu/gửi phản hồi về client.

```ts
const { data: widgetConfig, error: widgetConfigError } = await supabase
  .from('widget_configurations')
  .select('filter_config')
  .eq('tenant_id', tenantId)
  .eq('chatbot_id', botId)
  .maybeSingle();

if (widgetConfigError) {
  throw widgetConfigError;
}

if (widgetConfig?.filter_config) {
  const outcome = await runStoredInputFilter({
    message,
    sessionId: conversationId,
    rawConfig: widgetConfig.filter_config,
    redisClient: getRedis(),
    redisKeyPrefix: genRedisKey(tenantId, 'input-filter', 'repeat'),
  });

  if (!outcome.result.passed) {
    await handleRejectedInput({
      tenantId,
      botId,
      conversationId,
      originalMessage: message,
      replyMessage: outcome.replyMessage!,
      rejectCode: outcome.result.code,
    });

    return; // Bắt buộc: không được rơi xuống AI flow.
  }
}

// Intent/RAG/LLM flow bắt đầu sau đây.
```

`return` sau reject là bắt buộc. Nếu thiếu, user có thể nhận cả filter message và câu trả lời AI.

## 10. Redis cho repeat filter

Chỉ `enable_repeat` cần Redis. Package sử dụng `INCR` và `EXPIRE`, không cần RedisJSON.

Hàm tạo prefix tham khảo:

```ts
export const genRedisKey = (
  tenantId: string,
  module: string,
  entity: string,
) => {
  const app = process.env.APP_NAME ?? 'midesk-chatbot-ai';
  const env = process.env.NODE_ENV ?? 'development';
  return `${app}:${env}:tenant:${tenantId}:${module}:${entity}`;
};
```

Truyền vào pipeline:

```ts
redisKeyPrefix: genRedisKey(tenantId, 'input-filter', 'repeat')
```

Key cuối cùng do package tạo:

```text
{app}:{env}:tenant:{tenantId}:input-filter:repeat:{conversationId}:{messageHash}
```

- `messageHash` là 16 ký tự hex đầu của SHA-256.
- Nội dung được lowercase, bỏ punctuation và gộp whitespace trước khi hash.
- Value là integer count.
- TTL lấy từ `filter_params.repeat.ttlSeconds`.
- Khi `count >= maxRepeatCount`, input bị reject.
- Nếu không có Redis hoặc Redis command lỗi, repeat filter fail-open và trả `PASS`; các filter khác vẫn chạy.

Redis client phải được connect khi bootstrap, trước khi consumer nhận message.

## 11. Xử lý input bị reject

Source gốc thực hiện:

1. Lấy reply message từ `message_config` theo reject code.
2. Lưu raw user message vào lịch sử chat.
3. Lưu bot filter reply vào lịch sử chat.
4. Phát response theo cùng protocol streaming của AI.
5. `return` để không gọi AI.

Pseudo-code để map sang dự án đích:

```ts
async function handleRejectedInput(args: RejectedInputArgs) {
  await insertMessage({
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    role: 'customer',
    content: args.originalMessage,
  });

  const botMessage = await insertMessage({
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    role: 'bot_ai',
    content: args.replyMessage,
    metadata: { inputFilterCode: args.rejectCode },
  });

  await sendToClient({
    event: 'message_start',
    messageId: botMessage.id,
    conversationId: args.conversationId,
    answer: '',
    seq: 0,
  });

  await sendToClient({
    event: 'message',
    messageId: botMessage.id,
    conversationId: args.conversationId,
    answer: args.replyMessage,
    seq: 1,
  });

  await sendToClient({
    event: 'message_end',
    messageId: botMessage.id,
    conversationId: args.conversationId,
    answer: '',
    seq: 2,
  });
}
```

Nếu dự án không lưu rejected messages có thể bỏ hai insert, nhưng vẫn nên ghi metric theo `rejectCode`. Không log raw message nếu có thể chứa PII.

## 12. Chính sách lỗi và config thiếu

### Không có config

Có thể bỏ qua pipeline để tương thích bot cũ, hoặc insert default config khi tạo bot. Không gọi pipeline với config thiếu.

### Config sai schema

- API phải từ chối config sai ngay khi lưu.
- Consumer nên ghi structured error/metric.
- Có thể fail-open để chat tiếp tục hoạt động, trừ khi nghiệp vụ yêu cầu fail-closed.

```ts
try {
  // Parse config và chạy pipeline.
} catch (error) {
  logger.error({ error, tenantId, botId }, 'Invalid input filter config');
  // Tiếp tục AI flow nếu chọn fail-open.
}
```

### Query DB lỗi

Source gốc không check `error` của query config. Khi port phải check và xác định rõ fail-open hay throw theo SLA.

### Redis lỗi

Package đã fail-open riêng repeat filter. Không cần catch quanh toàn bộ pipeline chỉ để xử lý Redis outage.

## 13. Những điểm không nên copy từ source gốc

1. Tài liệu cũ dùng toggle `length`, `normalize`, ... nhưng consumer thực tế đọc `enable_length`, `enable_normalize`, ... File này dùng đúng shape runtime `enable_*`.
2. Request schema gốc dùng `filter_config: z.any()`. Dự án đích phải validate.
3. Query consumer gốc chỉ lọc `chatbot_id`; dự án đích nên lọc thêm tenant.
4. `message_config` hoặc `filter_params` thiếu có thể làm runtime throw. Phải parse/default trước khi gọi.
5. Pipeline có internal step defaults, nhưng consumer truyền field `undefined` có thể ghi đè default. JSON persisted phải có boolean đầy đủ.
6. Không log toàn bộ raw message hoặc filter detail trong production.
7. `flood.filter.ts` hiện không được pipeline gọi; không tạo toggle flood ở DB/UI.

## 14. Thứ tự triển khai cho agent

1. Copy nguyên folder `chatbot-input-filter` vào dự án.
2. Gắn package vào workspace/local dependency với tên `@timo/input-filter`.
3. Build filter package trước consumer.
4. Tạo migration `filter_config jsonb` và unique tenant + bot.
5. Tạo `FilterConfigSchema` và default JSON.
6. Thêm `filter_config` vào GET/PUT bot/widget configuration.
7. Khi PUT, validate và lưu full JSON object.
8. Tạo adapter `runStoredInputFilter`.
9. Query config bằng tenant + bot trong message consumer.
10. Gọi adapter sau khi có conversation ID, trước intent/AI/lock.
11. Truyền Redis client và prefix có tenant/environment.
12. Implement reject response đúng protocol và `return` sớm.
13. Thêm integration test và metric.

## 15. Test checklist

### Package wiring

- Consumer import được `@timo/input-filter` khi dev và sau build.
- Deployment artifact có `chatbot-input-filter/dist`.

### DB/API

- GET trả đúng config theo tenant + bot.
- PUT từ chối JSON sai type/range/thiếu field.
- PUT không ghi nhầm bot của tenant khác.
- Lưu full object không làm mất nested params/messages.

### Toggle và runtime

- Tắt toàn bộ reject toggle: bỏ qua pipeline, AI flow vẫn chạy.
- Bật từng toggle riêng: chỉ filter tương ứng có thể reject.
- Giá trị `enable_normalize: false` được truyền đúng.
- Reject code map đúng message DB.
- Thiếu message dùng fallback.
- Reject chỉ gửi một bot response và không gọi AI.
- Pass tiếp tục flow AI cũ.
- Config null/sai và DB lỗi được xử lý đúng policy.

### Repeat/Redis

- Cùng message trong cùng conversation: lần `N` bị chặn.
- Khác conversation, tenant hoặc environment: counter độc lập.
- Hết TTL: counter reset.
- Redis down: repeat fail-open, filter khác vẫn hoạt động.

## 16. Tiêu chí hoàn thành

- Không viết lại logic bên trong folder `chatbot-input-filter`.
- Package build và import được bằng `@timo/input-filter`.
- JSON config có schema, default và persistence rõ ràng.
- Consumer query config theo tenant + bot.
- `runFilterPipeline` chạy trước AI.
- Repeat filter có Redis prefix cô lập tenant/environment/session.
- Reject response `return` sớm, không rơi xuống AI flow.
- Có integration test cho luồng DB -> adapter -> reject/pass.

