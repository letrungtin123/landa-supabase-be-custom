// Report PDF artifacts in Supabase Storage (tenant prefix, existing bucket and
// quota-tracked upload helper) and tenant branding for the document cover.
import { downloadFileBuffer, storageObjectExists, uploadFile } from '../../config/storage.js';
import { getBrandingByTenantId } from '../branding/branding.service.js';
import type { ReportPdfTenantBranding } from './report-pdf-view-model.js';

export interface ReportPdfArtifactStore {
  exists(storagePath: string): Promise<boolean>;
  put(storagePath: string, pdf: Buffer): Promise<void>;
  get(storagePath: string): Promise<Buffer>;
}

const MAX_LOGO_BYTES = 512 * 1024;

export const supabaseReportPdfArtifactStore: ReportPdfArtifactStore = {
  exists: (storagePath) => storageObjectExists(storagePath),
  // upsert: two instances may render the same deterministic key concurrently.
  put: async (storagePath, pdf) => { await uploadFile(storagePath, pdf, 'application/pdf', true); },
  get: async (storagePath) => (await downloadFileBuffer(storagePath)).buffer,
};

/** Only PNG/JPEG/WEBP by magic bytes; SVG and anything else are ignored. */
export function toReportPdfLogoDataUri(buffer: Buffer): string | null {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_LOGO_BYTES) return null;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  const type = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : null;
  return type ? `data:${type};base64,${buffer.toString('base64')}` : null;
}

/**
 * Tenant name and header logo for the PDF. The logo is optional: it must live
 * under the tenant prefix and be a small raster image, otherwise it is skipped.
 */
export async function loadReportPdfTenantBranding(tenantId: string, log: (event: Record<string, unknown>) => void): Promise<ReportPdfTenantBranding> {
  const branding = await getBrandingByTenantId(tenantId);
  const logoPath = branding.images.header_logo ?? null;
  let logoDataUri: string | null = null;
  if (logoPath && logoPath.startsWith(`${tenantId}/`) && !logoPath.includes('..')) {
    try {
      logoDataUri = toReportPdfLogoDataUri((await downloadFileBuffer(logoPath)).buffer);
    } catch {
      log({ event: 'report_pdf_logo_unavailable', tenant_id: tenantId });
    }
  }
  return { name: branding.tenant_name, logoDataUri };
}
