// ═══════════════════════════════════════════════════════════════
// Delete Worker — Consume delete jobs from RabbitMQ
// Delete docs from Gemini store (throttled)
// ═══════════════════════════════════════════════════════════════

import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import { getGeminiClient, deleteFromStore } from './gemini.service.js';

interface DeleteJob {
  tenantId: string;
  kbId: string;
  geminiPaths: string[];
  documentIds?: string[];
  deleteKb?: boolean;
}

async function processDeleteJob(data: Record<string, any>): Promise<void> {
  const job = data as unknown as DeleteJob;
  const { tenantId, geminiPaths } = job;

  if (!geminiPaths || geminiPaths.length === 0) {
    console.log('[DeleteWorker] No gemini paths to delete, skipping');
    return;
  }

  try {
    console.log(`[DeleteWorker] Deleting ${geminiPaths.length} docs from Gemini`);

    // Lazy client init — only create if we actually need to delete
    const aiClient = await getGeminiClient(tenantId);

    // Throttled batch delete
    await deleteFromStore(geminiPaths, aiClient);

    console.log(`[DeleteWorker] Successfully deleted ${geminiPaths.length} docs`);
  } catch (err: any) {
    console.error('[DeleteWorker] Error:', err.message);
    throw err; // Re-throw for consumer retry logic
  }
}

/**
 * Start the delete consumer.
 */
export async function startDeleteWorker(): Promise<void> {
  await consume(
    QUEUES.GEMINI_DELETE,
    processDeleteJob,
    async function onMaxRetry(_queue: string, rawMessage: string) {
      console.error('[DeleteWorker] Max retries reached, message discarded:', rawMessage.substring(0, 200));
    },
  );
}
