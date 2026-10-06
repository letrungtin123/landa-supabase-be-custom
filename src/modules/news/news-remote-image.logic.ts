import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList } from 'node:net';
import path from 'node:path';
import { AppError } from '../../middleware/error-handler.js';

const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS = 3;
const REMOTE_IMAGE_TIMEOUT_MS = 12_000;

const blockedNetworks = new BlockList();
const BLOCKED_IPV4_NETWORKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
];
BLOCKED_IPV4_NETWORKS.forEach(([network, prefix]) => blockedNetworks.addSubnet(network, prefix, 'ipv4'));
const BLOCKED_IPV6_NETWORKS: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
];
BLOCKED_IPV6_NETWORKS.forEach(([network, prefix]) => blockedNetworks.addSubnet(network, prefix, 'ipv6'));

export interface DetectedNewsImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: '.png' | '.jpg' | '.gif' | '.webp';
}

export interface DownloadedNewsImage extends DetectedNewsImage {
  buffer: Buffer;
  originalName: string;
}

export function detectNewsImage(buffer: Buffer): DetectedNewsImage | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { mime: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', extension: '.webp' };
  }
  return null;
}

export function parseRemoteNewsImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('Địa chỉ ảnh bên ngoài không hợp lệ', 400, 'INVALID_NEWS_IMAGE_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('Chỉ hỗ trợ ảnh HTTPS công khai', 400, 'INVALID_NEWS_IMAGE_URL');
  }
  return url;
}

export function isBlockedNewsImageAddress(address: string, family: number): boolean {
  const mappedIpv4 = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return blockedNetworks.check(mappedIpv4, 'ipv4');
  return blockedNetworks.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function resolvePublicTarget(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError('Không thể phân giải máy chủ ảnh', 422, 'NEWS_IMAGE_FETCH_FAILED');
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedNewsImageAddress(entry.address, entry.family))) {
    throw new AppError('Máy chủ ảnh không được phép truy cập', 400, 'INVALID_NEWS_IMAGE_URL');
  }
  const selected = addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function cleanRemoteFileName(url: URL, extension: DetectedNewsImage['extension']): string {
  let candidate = '';
  try {
    candidate = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    candidate = path.posix.basename(url.pathname);
  }
  const withoutControls = candidate.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (withoutControls || `imported-image${extension}`).slice(0, 255);
}

async function downloadRemoteNewsImageAt(url: URL, redirects: number): Promise<DownloadedNewsImage> {
  const target = await resolvePublicTarget(url);
  return new Promise<DownloadedNewsImage>((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/gif',
        'User-Agent': 'Landa-News-Image-Importer/1.0',
      },
      lookup: (_hostname, options, callback) => {
        // Node 20+ may request all addresses for connection auto-selection.
        // Return the already validated target in the callback shape it asks
        // for, so DNS cannot be resolved a second time after validation.
        if (typeof options === 'object' && options.all) {
          const allCallback = callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: Array<{ address: string; family: number }>,
          ) => void;
          allCallback(null, [target]);
          return;
        }
        const singleCallback = callback as unknown as (
          error: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void;
        singleCallback(null, target.address, target.family);
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects >= MAX_REMOTE_IMAGE_REDIRECTS) {
          reject(new AppError('Ảnh bên ngoài chuyển hướng quá nhiều lần', 422, 'NEWS_IMAGE_FETCH_FAILED'));
          return;
        }
        let nextUrl: URL;
        try {
          nextUrl = parseRemoteNewsImageUrl(new URL(location, url).toString());
        } catch (error) {
          reject(error);
          return;
        }
        void downloadRemoteNewsImageAt(nextUrl, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new AppError(`Không thể tải ảnh bên ngoài (HTTP ${status})`, 422, 'NEWS_IMAGE_FETCH_FAILED'));
        return;
      }

      const declaredLength = Number(response.headers['content-length'] || '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
        response.destroy();
        reject(new AppError('Ảnh bên ngoài vượt quá 10 MB', 413, 'NEWS_IMAGE_TOO_LARGE'));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | Uint8Array) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_REMOTE_IMAGE_BYTES) {
          response.destroy(new AppError('Ảnh bên ngoài vượt quá 10 MB', 413, 'NEWS_IMAGE_TOO_LARGE'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', reject);
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const detected = detectNewsImage(buffer);
        if (!detected) {
          reject(new AppError('Địa chỉ không trả về ảnh JPEG, PNG, WebP hoặc GIF hợp lệ', 422, 'INVALID_NEWS_IMAGE'));
          return;
        }
        resolve({
          ...detected,
          buffer,
          originalName: cleanRemoteFileName(url, detected.extension),
        });
      });
    });
    request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => {
      request.destroy(new AppError('Tải ảnh bên ngoài quá thời gian cho phép', 504, 'NEWS_IMAGE_FETCH_TIMEOUT'));
    });
    request.on('error', reject);
    request.end();
  });
}

export async function downloadRemoteNewsImage(rawUrl: string): Promise<DownloadedNewsImage> {
  return downloadRemoteNewsImageAt(parseRemoteNewsImageUrl(rawUrl), 0);
}
