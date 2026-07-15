import {
  runFilterPipeline,
  type FilterResult,
} from './core/index.js';
import { query } from '../../../config/database.js';
import { normalizeRepeatCompareText } from './core/filters/repeat.filter.js';
import { FilterRejectCode, type RepeatConfig, type RepeatFallbackCounter } from './core/types/filter.types.js';
import {
  normalizeInputFilterConfig,
  type InputFilterConfig,
  type InputFilterMessageCode,
} from './input-filter.schema.js';

const FALLBACK_FILTER_MESSAGE = 'Tin nhắn không hợp lệ. Bạn vui lòng kiểm tra và gửi lại nhé.';

type RedisLikeClient = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export type InputFilterOutcome = {
  blocked: boolean;
  result: FilterResult;
  replyMessage: string | null;
  config: InputFilterConfig;
};

export type RunStoredInputFilterArgs = {
  message: string;
  sessionId: string;
  tenantId: string;
  botId: string;
  rawConfig: unknown;
  redisClient?: RedisLikeClient | null;
};

const DB_REPEAT_FALLBACK_LIMIT = 500;

function buildDbRepeatFallbackCounter(conversationId: string): RepeatFallbackCounter {
  return async function dbRepeatFallback(args: {
    normalizedText: string;
    compareText: string;
    sessionId: string;
    config: RepeatConfig;
    keyPrefix: string;
    debug?: boolean;
  }): Promise<FilterResult> {
    const ttlSeconds = Math.max(1, Math.min(args.config.ttlSeconds, 86_400));
    const limit = Math.min(
      DB_REPEAT_FALLBACK_LIMIT,
      Math.max(50, args.config.maxRepeatCount * 4),
    );
    const result = await query<{ content: string }>(
      `SELECT content
       FROM chat_messages
       WHERE conversation_id = $1
         AND role = 'user'
         AND created_at >= now() - ($2::int * INTERVAL '1 second')
       ORDER BY created_at DESC
       LIMIT $3`,
      [conversationId, ttlSeconds, limit],
    );

    let previousMatches = 0;
    for (const row of result.rows) {
      if (normalizeRepeatCompareText(row.content) === args.compareText) {
        previousMatches += 1;
      }
    }

    const count = previousMatches + 1;
    if (args.debug) {
      console.log(`[repeat-filter] DB fallback count: ${count}/${args.config.maxRepeatCount}`);
    }

    if (count >= args.config.maxRepeatCount) {
      return {
        passed: false,
        code: FilterRejectCode.REPEATED_SENTENCE,
        detail: `Lặp ${count} lần trong ${ttlSeconds}s`,
      };
    }

    return { passed: true, code: 'PASS' };
  };
}

export function buildInputFilterRedisKeyPrefix(tenantId: string, botId: string): string {
  const app = process.env.APP_NAME?.trim() || 'landa-backend';
  const env = process.env.NODE_ENV?.trim() || 'development';
  return `${app}:${env}:tenant:${tenantId}:bot:${botId}:input-filter:repeat`;
}

export function getInputFilterReplyMessage(config: InputFilterConfig, code: string): string {
  const item = config.message_config.find(message => message.code === code);
  return item?.message || FALLBACK_FILTER_MESSAGE;
}

export async function runStoredInputFilter(args: RunStoredInputFilterArgs): Promise<InputFilterOutcome> {
  const config = normalizeInputFilterConfig(args.rawConfig);

  if (!config.enabled) {
    return {
      blocked: false,
      result: { passed: true, code: 'PASS' },
      replyMessage: null,
      config,
    };
  }

  const hasRejectStepEnabled =
    config.enable_length ||
    config.enable_language ||
    config.enable_gibberish ||
    config.enable_repeat ||
    config.enable_profanity;

  if (!hasRejectStepEnabled) {
    return {
      blocked: false,
      result: { passed: true, code: 'PASS' },
      replyMessage: null,
      config,
    };
  }

  const fp = config.filter_params;
  const result = await runFilterPipeline(args.message, {
    sessionId: args.sessionId,
    redisClient: args.redisClient ?? null,
    redisKeyPrefix: buildInputFilterRedisKeyPrefix(args.tenantId, args.botId),
    repeatFallbackCounter: config.enable_repeat ? buildDbRepeatFallbackCounter(args.sessionId) : null,
    steps: {
      length: config.enable_length,
      normalize: config.enable_normalize,
      language: config.enable_language,
      gibberish: config.enable_gibberish,
      repeat: config.enable_repeat,
      profanity: config.enable_profanity,
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
    return {
      blocked: false,
      result,
      replyMessage: null,
      config,
    };
  }

  return {
    blocked: true,
    result,
    replyMessage: getInputFilterReplyMessage(config, result.code as InputFilterMessageCode),
    config,
  };
}
