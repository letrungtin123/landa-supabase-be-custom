// ═══════════════════════════════════════════════════════════════
// KB local source content — the text kept in kb_documents.content for
// plain-text sources (.txt, .md, .csv), at most 200,000 characters.
//
// The file version reads an uploaded temp file in chunks and stops once the
// kept text is decided, so a 50 MB text file is not read whole into the
// heap. It returns exactly what the buffer version returns for the same
// bytes (same UTF-8 decoding, NUL removal, trim and cut).
// ═══════════════════════════════════════════════════════════════

import { createReadStream } from 'node:fs';

export const LOCAL_SOURCE_CONTENT_EXTENSIONS = new Set(['.txt', '.md', '.csv']);
export const MAX_STORED_SOURCE_CONTENT_CHARS = 200_000;

const NUL = /\u0000/g;
const NON_WHITESPACE = /\S/;

export function extractLocalSourceContent(ext: string, buffer: Buffer): string | null {
  if (!LOCAL_SOURCE_CONTENT_EXTENSIONS.has(ext)) return null;
  const text = buffer.toString('utf8').replace(NUL, '').trim();
  return text ? text.slice(0, MAX_STORED_SOURCE_CONTENT_CHARS) : null;
}

/**
 * Same result as extractLocalSourceContent(ext, <file bytes>).
 *
 * `kept` is the decoded, NUL-free text with its leading whitespace removed
 * (removing it chunk by chunk equals one trimStart of the whole). Once a
 * non-whitespace character sits at index >= limit - 1, the final trimEnd
 * cannot reach into the first `limit` characters, so the rest of the file
 * cannot change the result and reading stops.
 */
export async function extractLocalSourceContentFromFile(
  ext: string,
  filePath: string,
  limit: number = MAX_STORED_SOURCE_CONTENT_CHARS,
  chunkBytes = 64 * 1024,
): Promise<string | null> {
  if (!LOCAL_SOURCE_CONTENT_EXTENSIONS.has(ext)) return null;
  // ignoreBOM keeps a leading U+FEFF like Buffer#toString does; streamed
  // decoding gives the same characters as decoding the whole buffer at once.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let kept = '';
  for await (const chunk of createReadStream(filePath, { highWaterMark: chunkBytes })) {
    kept = (kept + decoder.decode(chunk as Buffer, { stream: true }).replace(NUL, '')).trimStart();
    if (kept.length >= limit && NON_WHITESPACE.test(kept.slice(limit - 1))) {
      return kept.slice(0, limit);
    }
  }
  const text = (kept + decoder.decode().replace(NUL, '')).trim();
  return text ? text.slice(0, limit) : null;
}
