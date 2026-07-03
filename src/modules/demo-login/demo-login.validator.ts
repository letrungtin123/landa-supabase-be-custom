import { z } from 'zod';

export const tenantParamSchema = z.object({
  tenantId: z.string().uuid('Tenant không hợp lệ'),
});

export const publicDomainParamSchema = z.object({
  domain: z.string().trim().min(1, 'Domain không được để trống').max(255),
});

export const updateDemoLoginConfigSchema = z.object({
  is_enabled: z.boolean().optional(),
  max_demo_accounts: z.number().int().min(1).max(50).optional(),
  reservation_ttl_seconds: z.number().int().min(60).max(3600).optional(),
});

export const demoLoginAccountSchema = z.object({
  user_id: z.string().uuid('User không hợp lệ'),
  label: z.string().trim().max(120).optional().nullable(),
});

export const replaceDemoLoginAccountsSchema = z.object({
  accounts: z.array(demoLoginAccountSchema).max(50),
});

export const deleteDemoLoginAccountParamSchema = tenantParamSchema.extend({
  publicId: z.string().uuid('Demo account không hợp lệ'),
});

export const publicClaimSchema = z.object({
  account_id: z.string().uuid('Demo account không hợp lệ'),
});

export type UpdateDemoLoginConfigInput = z.infer<typeof updateDemoLoginConfigSchema>;
export type ReplaceDemoLoginAccountsInput = z.infer<typeof replaceDemoLoginAccountsSchema>;
