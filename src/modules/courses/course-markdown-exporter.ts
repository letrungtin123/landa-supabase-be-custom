type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export interface CourseMarkdownCourse {
  id: string;
  display_name: string;
  description: string | null;
  org: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CourseMarkdownBlock {
  id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string | null;
  data: JsonValue;
  metadata: JsonValue;
  sort_order: number | null;
  created_at: string | null;
}

interface BlockNode extends CourseMarkdownBlock {
  children: BlockNode[];
}

const STRUCTURAL_TYPES = new Set(['course', 'chapter', 'sequential', 'vertical']);
const INTERNAL_KEY_PATTERN = /(^id$|_id$|uuid|storage_path|path$|image|avatar|logo|thumbnail|file|asset)/i;
const URL_KEY_PATTERN = /(^url$|_url$|link$|href$)/i;

export function buildCourseMarkdown(course: CourseMarkdownCourse, blocks: CourseMarkdownBlock[]): string {
  const tree = buildBlockTree(blocks);
  const lines: string[] = [
    `# ${headingText(course.display_name || course.id)}`,
    '',
    `- Course ID: ${course.id}`,
  ];

  if (course.org) lines.push(`- Organization: ${course.org}`);
  if (course.description?.trim()) lines.push(`- Description: ${normalizeInlineText(course.description)}`);
  if (course.start_date) lines.push(`- Start date: ${course.start_date}`);
  if (course.end_date) lines.push(`- End date: ${course.end_date}`);
  if (course.updated_at) lines.push(`- Updated at: ${course.updated_at}`);
  lines.push(`- Exported at: ${new Date().toISOString()}`);
  lines.push('');

  if (tree.length === 0) {
    lines.push('_No published course content found._');
    return finalizeMarkdown(lines);
  }

  for (const node of tree) {
    renderNode(node, lines, node.block_type === 'course' ? 1 : 2);
  }

  return finalizeMarkdown(lines);
}

export function markdownFilename(courseId: string): string {
  const safeName = courseId
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'course-content';
  return `${safeName}.md`;
}

function buildBlockTree(blocks: CourseMarkdownBlock[]): BlockNode[] {
  const nodes = new Map<string, BlockNode>();
  const roots: BlockNode[] = [];

  for (const block of blocks) {
    nodes.set(block.id, { ...block, children: [] });
  }

  for (const block of blocks) {
    const node = nodes.get(block.id);
    if (!node) continue;
    if (block.parent_id && nodes.has(block.parent_id)) {
      nodes.get(block.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: BlockNode[]) => {
    items.sort(compareBlocks);
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

function compareBlocks(a: BlockNode, b: BlockNode): number {
  const orderA = a.sort_order ?? 0;
  const orderB = b.sort_order ?? 0;
  if (orderA !== orderB) return orderA - orderB;
  return String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id);
}

function renderNode(node: BlockNode, lines: string[], depth: number): void {
  const type = node.block_type;
  const title = node.display_name || type;

  if (STRUCTURAL_TYPES.has(type)) {
    if (type !== 'course') {
      lines.push(`${'#'.repeat(Math.min(depth, 6))} ${headingText(title)}`);
      lines.push('');
    }
    for (const child of node.children) renderNode(child, lines, depth + 1);
    return;
  }

  lines.push(`${'#'.repeat(Math.min(depth, 6))} ${headingText(title)} (${type})`);
  lines.push('');

  const content = renderLeafBlock(node);
  if (content) lines.push(content);
  else lines.push('_No text content._');
  lines.push('');

  for (const child of node.children) renderNode(child, lines, depth + 1);
}

function renderLeafBlock(node: CourseMarkdownBlock): string {
  switch (node.block_type) {
    case 'html':
      return renderHtmlBlock(node.data, node.metadata);
    case 'video':
      return renderVideoBlock(node.data, node.metadata);
    case 'problem':
      return renderProblemBlock(node.data, node.metadata);
    case 'la_crossword':
    case 'la_sortable':
    case 'la_diagram':
    case 'la_faq':
      return renderGenericBlock(node.data, node.metadata);
    default:
      return renderGenericBlock(node.data, node.metadata);
  }
}

function renderHtmlBlock(data: JsonValue, metadata: JsonValue): string {
  const raw = pickString(data, ['data', 'html', 'content', 'body', 'text']) || stringifyPrimitive(data);
  const lines = [htmlToMarkdown(raw)];
  const media = renderMedia(metadata, 'html_media');
  if (media) lines.push(media);
  return compactSections(lines);
}

function renderVideoBlock(data: JsonValue, metadata: JsonValue): string {
  const merged = mergeObjects(data, metadata);
  const title = pickString(merged, ['title', 'display_name', 'name']);
  const youtubeId = pickString(merged, ['youtube_id']);
  const rawUrl = pickString(merged, ['url', 'video_url', 'youtube_url', 'source', 'src'])
    || pickNestedString(merged, [['encoded_videos', 'fallback', 'url']]);
  const url = youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : rawUrl;
  const duration = pickString(merged, ['duration', 'duration_seconds']);

  const lines: string[] = [];
  if (title) lines.push(`- Title: ${normalizeInlineText(title)}`);
  if (url && isExternalUrl(url)) lines.push(`- Video URL: ${url}`);
  if (duration) lines.push(`- Duration: ${normalizeInlineText(duration)}`);
  if (lines.length === 0) lines.push(renderGenericBlock(data, metadata) || '_Video content._');
  return compactSections(lines);
}

function renderProblemBlock(data: JsonValue, metadata: JsonValue): string {
  const raw = pickString(data, ['data', 'html', 'content', 'body', 'text']) || stringifyPrimitive(data);
  const lines = [problemToMarkdown(raw)];
  const media = renderMedia(metadata, 'problem_media');
  if (media) lines.push(media);
  return compactSections(lines);
}

function renderGenericBlock(data: JsonValue, metadata: JsonValue): string {
  const content = jsonToMarkdown(data);
  const metaText = renderUsefulMetadata(metadata);
  return compactSections([content, metaText]);
}

function renderUsefulMetadata(metadata: JsonValue): string {
  if (!isPlainObject(metadata)) return '';
  const mediaSections = [
    renderMedia(metadata, 'problem_media'),
    renderMedia(metadata, 'html_media'),
  ].filter(Boolean);
  return mediaSections.join('\n\n');
}

function renderMedia(metadata: JsonValue, key: string): string {
  if (!isPlainObject(metadata) || !isPlainObject(metadata[key])) return '';
  const media = metadata[key] as Record<string, JsonValue>;
  const lines: string[] = [];

  const youtubeId = stringifyPrimitive(media.youtube_id);
  const youtubeUrl = stringifyPrimitive(media.youtube_url);
  if (youtubeId) lines.push(`- Media video: https://www.youtube.com/watch?v=${youtubeId}`);
  else if (youtubeUrl && isExternalUrl(youtubeUrl)) lines.push(`- Media video: ${youtubeUrl}`);

  if (Array.isArray(media.images)) {
    const imageLines = media.images
      .map((image, index) => {
        if (!isPlainObject(image)) return '';
        const alt = stringifyPrimitive(image.alt) || `Image ${index + 1}`;
        return `- Media image: ${normalizeInlineText(alt)}`;
      })
      .filter(Boolean);
    lines.push(...imageLines);
  }

  return lines.length > 0 ? ['Media:', ...lines].join('\n') : '';
}

function htmlToMarkdown(input: string): string {
  if (!input) return '';
  let md = input;
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<img\b[^>]*alt=["']?([^"'>]*)["']?[^>]*>/gi, (_m, alt) => alt ? `\n[Image: ${decodeHtml(String(alt))}]\n` : '\n');
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  md = md.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const cleanText = stripHtml(String(text));
    return isExternalUrl(String(href)) ? `[${cleanText}](${href})` : cleanText;
  });
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<p[^>]*>/gi, '');
  md = stripHtml(md);
  return normalizeMarkdown(md);
}

function problemToMarkdown(input: string): string {
  if (!input) return '';
  let md = input;
  md = md.replace(/<choice\b([^>]*)>/gi, (_m, attrs) => {
    const correct = /correct=["']?true["']?/i.test(String(attrs)) ? ' (correct)' : '';
    return `\n- Choice${correct}: `;
  });
  md = md.replace(/<\/choice>/gi, '\n');
  md = md.replace(/<option\b([^>]*)>/gi, (_m, attrs) => {
    const correct = /correct=["']?true["']?/i.test(String(attrs)) ? ' (correct)' : '';
    return `\n- Option${correct}: `;
  });
  md = md.replace(/<\/option>/gi, '\n');
  md = md.replace(/<solution[^>]*>/gi, '\n\nSolution:\n');
  md = md.replace(/<\/solution>/gi, '\n');
  md = md.replace(/<demandhint[^>]*>/gi, '\n\nHints:\n');
  md = md.replace(/<hint[^>]*>/gi, '\n- Hint: ');
  md = md.replace(/<\/hint>/gi, '\n');
  md = htmlToMarkdown(md);
  return normalizeMarkdown(md);
}

function jsonToMarkdown(value: JsonValue, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.includes('<') ? htmlToMarkdown(value) : normalizeMarkdown(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = jsonToMarkdown(item, depth + 1);
        if (!rendered) return '';
        return rendered.includes('\n') ? rendered : `- ${rendered}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  if (!isPlainObject(value)) return '';
  const preferredKeys = ['title', 'name', 'question', 'prompt', 'description', 'content', 'body', 'text', 'answer', 'explanation', 'items', 'questions', 'answers', 'steps'];
  const lines: string[] = [];
  const used = new Set<string>();

  for (const key of preferredKeys) {
    if (!(key in value)) continue;
    used.add(key);
    const rendered = jsonToMarkdown(value[key], depth + 1);
    if (rendered) lines.push(formatObjectField(key, rendered));
  }

  for (const [key, child] of Object.entries(value)) {
    if (used.has(key) || INTERNAL_KEY_PATTERN.test(key) || URL_KEY_PATTERN.test(key)) continue;
    const rendered = jsonToMarkdown(child, depth + 1);
    if (rendered) lines.push(formatObjectField(key, rendered));
  }

  return compactSections(lines);
}

function formatObjectField(key: string, value: string): string {
  const label = key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  if (value.includes('\n')) return `${label}:\n${value}`;
  return `- ${label}: ${value}`;
}

function pickString(value: JsonValue, keys: string[]): string {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return '';
  for (const key of keys) {
    const raw = value[key];
    const text = stringifyPrimitive(raw);
    if (text) return text;
  }
  return '';
}

function pickNestedString(value: JsonValue, paths: string[][]): string {
  for (const path of paths) {
    let current: JsonValue | undefined = value;
    for (const part of path) {
      if (!isPlainObject(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    const text = stringifyPrimitive(current);
    if (text) return text;
  }
  return '';
}

function mergeObjects(a: JsonValue, b: JsonValue): JsonValue {
  return {
    ...(isPlainObject(a) ? a : {}),
    ...(isPlainObject(b) ? b : {}),
  };
}

function stringifyPrimitive(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripHtml(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/g, ' '));
}

function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function headingText(input: string): string {
  return normalizeInlineText(input).replace(/^#+\s*/, '');
}

function normalizeInlineText(input: string): string {
  return decodeHtml(String(input)).replace(/\s+/g, ' ').trim();
}

function normalizeMarkdown(input: string): string {
  return decodeHtml(input)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function compactSections(sections: string[]): string {
  return sections.map(normalizeMarkdown).filter(Boolean).join('\n\n');
}

function finalizeMarkdown(lines: string[]): string {
  return normalizeMarkdown(lines.join('\n')) + '\n';
}

function isExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
