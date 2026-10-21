// ═══════════════════════════════════════════════════════════════
// Exclusive knowledge bases (owner rule D1, QC feedback 2026-10-21)
//
// Within a tenant, the knowledge base of the bot assigned to the admin page,
// the knowledge base of the bot assigned to the learner page and the AI ID
// knowledge base (tenant_kb_assignments target 'lesson_author') are pairwise
// different. The hidden AI ID organization context knowledge base
// (target 'lesson_author_context') belongs to AI ID too: a chatbot never uses it.
//
// A bot assigned to target 'lesson_author' does not count: AI ID never reads
// that bot's kb_id (it always uses the tenant_kb_assignments row).
//
// Pure rules only; the repository reads the usages and the service takes the
// per-tenant lock inside the write transaction (kb-usage.service.ts).
// ═══════════════════════════════════════════════════════════════

/** Where a knowledge base is used, as the API names it. */
export type KbUsageSlot = 'admin' | 'learner' | 'ai_id';
/** The order `used_by` lists are given in. */
export const KB_USAGE_SLOTS: readonly KbUsageSlot[] = Object.freeze(['admin', 'learner', 'ai_id']);

/** A usage row as the repository reads it: one per assigned chat page and per AI ID knowledge base assignment. */
export interface KbUsageRow {
  /** 'ai_id_context' is the hidden organization context knowledge base; it reads as 'ai_id' everywhere else. */
  slot: KbUsageSlot | 'ai_id_context';
  /** The assigned bot (chat pages only). */
  bot_id: string | null;
  /** null: the page's bot has no knowledge base, which never clashes. */
  kb_id: string | null;
  kb_name: string | null;
}

export const AI_CHATBOT_KB_ALREADY_USED_CODE = 'AI_CHATBOT_KB_ALREADY_USED';

/** The transaction advisory lock that serializes every knowledge base usage write of one tenant. */
export const KB_USAGE_LOCK_NAMESPACE = 'ai-chatbot:kb-usage:';

export function kbUsageLockKey(tenantId: string): string {
  return `${KB_USAGE_LOCK_NAMESPACE}${tenantId}`;
}

function usageSlot(row: KbUsageRow): KbUsageSlot {
  return row.slot === 'ai_id_context' ? 'ai_id' : row.slot;
}

function sortedSlots(slots: Iterable<KbUsageSlot>): KbUsageSlot[] {
  const set = new Set(slots);
  return KB_USAGE_SLOTS.filter(slot => set.has(slot));
}

export interface KbUsageClash {
  /** The other places that already use the knowledge base. Empty when only `same_bot_on_both_pages`. */
  used_by: KbUsageSlot[];
  /** The written bot serves the admin and the learner page, so both pages would share its knowledge base. */
  same_bot_on_both_pages: boolean;
}

/**
 * The clash a write would create: `slots` (the chat pages or AI ID being written) get `kbId`, every other
 * usage keeps its knowledge base. Clashes between usages the write does not touch are not this write's
 * (they are listed by kbUsageConflicts and fixed by the admin). null: no clash.
 */
export function findKbUsageClash(
  usages: readonly KbUsageRow[],
  write: { slots: readonly ('admin' | 'learner' | 'ai_id')[]; kbId: string | null },
): KbUsageClash | null {
  if (write.kbId === null) return null;
  const written = new Set(write.slots);
  const usedBy = sortedSlots(usages
    .filter(row => row.kb_id === write.kbId && (row.slot === 'ai_id_context' || !written.has(row.slot)))
    .map(usageSlot));
  const sameBotOnBothPages = written.has('admin') && written.has('learner');
  return usedBy.length || sameBotOnBothPages ? { used_by: usedBy, same_bot_on_both_pages: sameBotOnBothPages } : null;
}

export interface KbUsageConflict {
  kb_id: string;
  kb_name: string;
  used_by: KbUsageSlot[];
}

/** The clashes that already exist: every knowledge base used in two or more places, in a stable order. */
export function kbUsageConflicts(usages: readonly KbUsageRow[]): KbUsageConflict[] {
  const byKb = new Map<string, { name: string; slots: Set<KbUsageSlot> }>();
  for (const row of usages) {
    if (row.kb_id === null) continue;
    const entry = byKb.get(row.kb_id) ?? { name: row.kb_name ?? '', slots: new Set<KbUsageSlot>() };
    if (!entry.name && row.kb_name) entry.name = row.kb_name;
    entry.slots.add(usageSlot(row));
    byKb.set(row.kb_id, entry);
  }
  return [...byKb]
    .filter(([, entry]) => entry.slots.size > 1)
    .map(([kbId, entry]) => ({ kb_id: kbId, kb_name: entry.name, used_by: sortedSlots(entry.slots) }))
    .sort((a, b) => KB_USAGE_SLOTS.indexOf(a.used_by[0]) - KB_USAGE_SLOTS.indexOf(b.used_by[0])
      || (a.kb_id < b.kb_id ? -1 : a.kb_id > b.kb_id ? 1 : 0));
}

const SLOT_NAMES: Readonly<Record<KbUsageSlot, readonly [vi: string, en: string]>> = Object.freeze({
  admin: ['trợ lý trang quản trị', 'the admin page assistant'],
  learner: ['trợ lý trang học viên', 'the learner page assistant'],
  ai_id: ['AI ID', 'AI ID'],
});

function joinNames(names: string[], and: string): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`;
}

/** The plain refusal shown to the admin, naming where the knowledge base is already used. */
export function kbUsageClashMessage(clash: KbUsageClash, locale: 'vi' | 'en'): string {
  if (clash.used_by.length === 0) {
    return locale === 'en'
      ? 'This assistant is assigned to both the admin page and the learner page, so both pages would share one knowledge base. '
        + 'Please assign another assistant to one of the two pages first.'
      : 'Trợ lý này đang được gán cho cả trang quản trị và trang học viên, nên hai trang sẽ dùng chung một Kho tri thức. '
        + 'Vui lòng gán một trợ lý khác cho một trong hai trang trước.';
  }
  const names = clash.used_by.map(slot => SLOT_NAMES[slot][locale === 'en' ? 1 : 0]);
  return locale === 'en'
    ? `This knowledge base is already used by ${joinNames(names, 'and')}. `
      + 'The admin page assistant, the learner page assistant and AI ID each need their own knowledge base: please choose another one.'
    : `Kho tri thức này đang được dùng cho ${joinNames(names, 'và')}. `
      + 'Trợ lý trang quản trị, trợ lý trang học viên và AI ID mỗi nơi cần một Kho tri thức riêng, vui lòng chọn Kho tri thức khác.';
}
