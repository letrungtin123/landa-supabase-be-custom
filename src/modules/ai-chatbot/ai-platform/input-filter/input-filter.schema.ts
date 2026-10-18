import { z } from 'zod';

export const INPUT_FILTER_CONFIG_KEY = 'input_filter';

export const INPUT_FILTER_MESSAGE_CODES = [
  'EMPTY',
  'TOO_SHORT',
  'TOO_LONG',
  'GIBBERISH',
  'BINARY_GARBAGE',
  'PROFANITY',
  'UNSUPPORTED_LANG',
  'REPEATED_SENTENCE',
] as const;

export type InputFilterMessageCode = typeof INPUT_FILTER_MESSAGE_CODES[number];

const inputFilterMessageCodeSchema = z.enum(INPUT_FILTER_MESSAGE_CODES);

const inputFilterMessageSchema = z.object({
  code: inputFilterMessageCodeSchema,
  message: z.string().trim().min(1, 'Câu trả lời không được để trống').max(500, 'Câu trả lời tối đa 500 ký tự'),
});

export const inputFilterConfigSchema = z.object({
  enabled: z.boolean(),
  enable_length: z.boolean(),
  enable_normalize: z.boolean(),
  enable_language: z.boolean(),
  enable_gibberish: z.boolean(),
  enable_repeat: z.boolean(),
  enable_profanity: z.boolean(),
  filter_params: z.object({
    length: z.object({
      min: z.number().int().min(1).max(100),
      max: z.number().int().min(100).max(10000),
    }).refine(value => value.min < value.max, 'Độ dài tối thiểu phải nhỏ hơn tối đa'),
    language: z.object({
      foreignCharThreshold: z.number().min(0.1).max(0.9),
    }),
    gibberish: z.object({
      minEntropyThreshold: z.number().min(0.5).max(4),
      maxRepeatRatio: z.number().min(0.3).max(0.9),
      minValidCharRatio: z.number().min(0.2).max(0.9),
      maxConsonantCluster: z.number().int().min(3).max(10),
    }),
    repeat: z.object({
      maxRepeatCount: z.number().int().min(2).max(10),
      ttlSeconds: z.number().int().min(60).max(3600),
    }),
    profanity: z.object({
      blockSeverity: z.enum(['HIGH', 'MEDIUM']),
      blacklistVi: z.array(z.string().trim().min(1).max(100)).max(500),
      blacklistEn: z.array(z.string().trim().min(1).max(100)).max(500),
    }),
  }),
  message_config: z.array(inputFilterMessageSchema).length(INPUT_FILTER_MESSAGE_CODES.length),
}).superRefine((value, ctx) => {
  const seen = new Set<InputFilterMessageCode>();
  for (const item of value.message_config) {
    if (seen.has(item.code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message_config'],
        message: `Mã phản hồi ${item.code} bị trùng`,
      });
    }
    seen.add(item.code);
  }

  for (const code of INPUT_FILTER_MESSAGE_CODES) {
    if (!seen.has(code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message_config'],
        message: `Thiếu câu trả lời cho mã ${code}`,
      });
    }
  }
});

export type InputFilterConfig = z.infer<typeof inputFilterConfigSchema>;

export const DEFAULT_INPUT_FILTER_CONFIG: InputFilterConfig = {
  enabled: false,
  enable_length: true,
  enable_normalize: true,
  enable_language: true,
  enable_gibberish: true,
  enable_repeat: true,
  enable_profanity: true,
  filter_params: {
    length: {
      min: 2,
      max: 2000,
    },
    language: {
      foreignCharThreshold: 0.3,
    },
    gibberish: {
      minEntropyThreshold: 1.5,
      maxRepeatRatio: 0.6,
      minValidCharRatio: 0.5,
      maxConsonantCluster: 5,
    },
    repeat: {
      maxRepeatCount: 3,
      ttlSeconds: 300,
    },
    profanity: {
      blockSeverity: 'HIGH',
      blacklistVi: [],
      blacklistEn: [],
    },
  },
  message_config: [
    { code: 'EMPTY', message: 'Vui lòng nhập nội dung để mình hỗ trợ bạn nhé.' },
    { code: 'TOO_SHORT', message: 'Tin nhắn hơi ngắn, bạn vui lòng mô tả rõ hơn nhé.' },
    { code: 'TOO_LONG', message: 'Tin nhắn quá dài, bạn vui lòng tóm tắt ý chính giúp mình nhé.' },
    { code: 'GIBBERISH', message: 'Mình chưa hiểu nội dung này. Bạn vui lòng gửi lại bằng câu rõ ràng hơn nhé.' },
    { code: 'BINARY_GARBAGE', message: 'Nội dung có ký tự không hợp lệ. Bạn vui lòng gửi lại dạng văn bản bình thường nhé.' },
    { code: 'PROFANITY', message: 'Bạn vui lòng sử dụng ngôn từ phù hợp để mình có thể hỗ trợ tốt hơn nhé.' },
    { code: 'UNSUPPORTED_LANG', message: 'Hiện tại hệ thống hỗ trợ tiếng Việt và tiếng Anh. Bạn vui lòng gửi lại bằng một trong hai ngôn ngữ này nhé.' },
    { code: 'REPEATED_SENTENCE', message: 'Bạn đã gửi nội dung này nhiều lần. Mình đã ghi nhận và sẽ tiếp tục hỗ trợ khi bạn gửi thông tin mới nhé.' },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefaultConfig(): InputFilterConfig {
  return JSON.parse(JSON.stringify(DEFAULT_INPUT_FILTER_CONFIG)) as InputFilterConfig;
}

function normalizeLegacyToggleKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  const aliases: Array<[string, keyof InputFilterConfig]> = [
    ['length', 'enable_length'],
    ['normalize', 'enable_normalize'],
    ['language', 'enable_language'],
    ['gibberish', 'enable_gibberish'],
    ['repeat', 'enable_repeat'],
    ['profanity', 'enable_profanity'],
  ];

  for (const [legacyKey, canonicalKey] of aliases) {
    if (typeof next[canonicalKey] !== 'boolean' && typeof next[legacyKey] === 'boolean') {
      next[canonicalKey] = next[legacyKey];
    }
  }

  return next;
}

export function normalizeInputFilterConfig(rawConfig: unknown): InputFilterConfig {
  if (!isRecord(rawConfig)) return cloneDefaultConfig();

  const raw = normalizeLegacyToggleKeys(rawConfig);
  const defaults = cloneDefaultConfig();
  const rawParams = isRecord(raw.filter_params) ? raw.filter_params : {};
  const rawLength = isRecord(rawParams.length) ? rawParams.length : {};
  const rawLanguage = isRecord(rawParams.language) ? rawParams.language : {};
  const rawGibberish = isRecord(rawParams.gibberish) ? rawParams.gibberish : {};
  const rawRepeat = isRecord(rawParams.repeat) ? rawParams.repeat : {};
  const rawProfanity = isRecord(rawParams.profanity) ? rawParams.profanity : {};

  const merged = {
    ...defaults,
    ...raw,
    filter_params: {
      length: { ...defaults.filter_params.length, ...rawLength },
      language: { ...defaults.filter_params.language, ...rawLanguage },
      gibberish: { ...defaults.filter_params.gibberish, ...rawGibberish },
      repeat: { ...defaults.filter_params.repeat, ...rawRepeat },
      profanity: { ...defaults.filter_params.profanity, ...rawProfanity },
    },
    message_config: Array.isArray(raw.message_config) ? raw.message_config : defaults.message_config,
  };

  return inputFilterConfigSchema.parse(merged);
}

export function ensureInputFilterInBotConfig(rawConfig: unknown): Record<string, unknown> {
  const config = isRecord(rawConfig) ? { ...rawConfig } : {};
  config[INPUT_FILTER_CONFIG_KEY] = normalizeInputFilterConfig(config[INPUT_FILTER_CONFIG_KEY]);
  return config;
}
