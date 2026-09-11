import type { NextFunction, Request, Response } from 'express';
import { createPlatformTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import {
  createAiPricingRateCard,
  getTenantAiOverview,
  listAiPricingRateCards,
} from './ai-report.service.js';

export async function getAiOverviewController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      sendError(res, 'Không xác định được doanh nghiệp hiện tại.', 403);
      return;
    }
    sendSuccess(res, await getTenantAiOverview(tenantId));
  } catch (error) {
    next(error);
  }
}

export async function listAiPricingRateCardsController(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await listAiPricingRateCards());
  } catch (error) {
    next(error);
  }
}

export async function createAiPricingRateCardController(req: Request, res: Response, next: NextFunction): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const provider = body.provider;
  const model = body.model;
  const inputVndPer1M = body.input_vnd_per_1m;
  const outputVndPer1M = body.output_vnd_per_1m;
  const embeddingVndPer1M = body.embedding_vnd_per_1m;
  if (
    provider !== 'google_ai_studio'
    || typeof model !== 'string'
    || typeof inputVndPer1M !== 'string'
    || typeof outputVndPer1M !== 'string'
    || typeof embeddingVndPer1M !== 'string'
  ) {
    sendError(res, 'Dữ liệu bảng giá AI không hợp lệ.', 400);
    return;
  }

  try {
    const card = await runAuditedTransaction(
      () => createAiPricingRateCard({
        provider,
        model,
        inputVndPer1M,
        outputVndPer1M,
        embeddingVndPer1M,
        sourceUrl: typeof body.source_url === 'string' ? body.source_url : null,
        sourceNote: typeof body.source_note === 'string' ? body.source_note : null,
      }, req.user!.id),
      (created) => createPlatformTransactionalAuditEntry(
        req,
        'CREATE',
        'ai_pricing_rate_card',
        {
          code: 'ai.pricing_rate_card.created',
          context: {
            related_entity_name: created.model,
            related_entity_type: created.provider,
          },
        },
        created.id,
        created.model,
      ),
    );
    sendSuccess(res, card, 'Đã cập nhật bảng giá AI.', 201);
  } catch (error) {
    next(error);
  }
}
