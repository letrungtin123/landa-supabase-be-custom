import type { LessonAuthorComponentProposal } from './course-authoring.service.js';

const PROTECTED_MEDIA_BLOCK_TYPES = new Set([
  'video',
  'audio',
  'image',
  'la_media_quiz',
  'la_image_choice_quiz',
  'la_pdf',
]);

const MEDIA_CONTAINER_KEYS = new Set([
  'html_media',
  'problem_media',
  'media',
  'image',
  'images',
  'video',
  'videos',
  'audio',
  'encoded_videos',
]);

const MEDIA_REFERENCE_KEYS = new Set([
  'storage_path',
  'video_storage_path',
  'image_storage_path',
  'audio_storage_path',
  'video_url',
  'image_url',
  'audio_url',
  'youtube_id',
  'youtube_url',
  'pdf_url',
  'asset_id',
]);

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasMeaningfulValue);
  return true;
}

function containsManagedMedia(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return /<(?:img|picture|video|audio|source)\b/i.test(value);
  }
  if (Array.isArray(value)) return value.some(item => containsManagedMedia(item, depth + 1));
  if (typeof value !== 'object') return false;

  return Object.entries(value as Record<string, unknown>).some(([rawKey, child]) => {
    const key = rawKey.trim().toLowerCase();
    if ((MEDIA_CONTAINER_KEYS.has(key) || MEDIA_REFERENCE_KEYS.has(key)) && hasMeaningfulValue(child)) {
      return true;
    }
    return containsManagedMedia(child, depth + 1);
  });
}

export function isLessonAuthorGeneratedContentOwned(metadata: unknown): boolean {
  return !!metadata
    && typeof metadata === 'object'
    && (metadata as Record<string, unknown>).generated_by === 'lesson_author_ai';
}

export function isLessonAuthorMediaProtectedBlock(
  blockType: string,
  data: unknown,
  metadata: unknown,
): boolean {
  return PROTECTED_MEDIA_BLOCK_TYPES.has(blockType) || containsManagedMedia(data) || containsManagedMedia(metadata);
}

/** Keep backend normalization aligned with the RAG sortable response contract. */
export function getLessonAuthorSortableItems(component: Record<string, unknown>): unknown[] {
  if (Array.isArray(component.items)) return component.items;
  if (Array.isArray(component.ordered_items)) return component.ordered_items;
  if (Array.isArray(component.steps)) return component.steps;
  return [];
}

/** Keep FAQ blocks at the end of a unit without changing stable order. */
export function orderLessonAuthorComponents(
  components: LessonAuthorComponentProposal[],
): LessonAuthorComponentProposal[] {
  return [
    ...components.filter(component => component.type !== 'la_faq'),
    ...components.filter(component => component.type === 'la_faq'),
  ];
}
