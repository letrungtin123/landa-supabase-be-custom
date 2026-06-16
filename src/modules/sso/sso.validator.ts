import { z } from 'zod';
import { SSO_PROVIDERS } from './sso.types.js';

const httpsUrl = z.string().trim().url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://localhost') || value.startsWith('http://127.0.0.1'),
  'URL phải dùng HTTPS, trừ localhost khi development',
);

export const providerParamSchema = z.object({
  provider: z.enum(SSO_PROVIDERS),
});

export const updateSsoConfigSchema = z.object({
  is_enabled: z.boolean().optional(),
  client_id: z.string().trim().max(500).optional().nullable(),
  client_secret: z.string().trim().max(4000).optional().nullable(),
  clear_client_secret: z.boolean().optional(),
  issuer_url: httpsUrl.optional().nullable(),
  authorization_url: httpsUrl.optional().nullable(),
  token_url: httpsUrl.optional().nullable(),
  userinfo_url: httpsUrl.optional().nullable(),
  scopes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  extra_config: z.record(z.unknown()).optional(),
}).refine(
  (value) => value.client_secret === undefined || !value.clear_client_secret,
  'Không thể vừa nhập secret mới vừa xóa secret',
);

export const exchangeSsoCodeSchema = z.object({
  tenant_id: z.string().uuid(),
  code: z.string().min(8).max(8000),
  redirect_uri: z.string().url(),
  code_verifier: z.string().min(32).max(256).optional(),
  client_app: z.enum(['admin', 'learner']).optional(),
});

export type UpdateSsoConfigInput = z.infer<typeof updateSsoConfigSchema>;
export type ExchangeSsoCodeInput = z.infer<typeof exchangeSsoCodeSchema>;
