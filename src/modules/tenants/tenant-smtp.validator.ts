import { z } from 'zod';

export const updateTenantSmtpSchema = z.object({
  is_enabled: z.boolean(),
  host: z.string().trim().min(1).max(255).default('smtp.gmail.com'),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().trim().email().max(255),
  password: z.string().min(1).max(1000).optional(),
  from_email: z.string().trim().email().max(255),
  from_name: z.string().trim().max(255).optional().default(''),
  reply_to_email: z.string().trim().email().max(255).nullable().optional(),
  copy_to_sender: z.boolean().default(true),
  copy_to_email: z.string().trim().email().max(255).nullable().optional(),
});

export type UpdateTenantSmtpInput = z.infer<typeof updateTenantSmtpSchema>;

