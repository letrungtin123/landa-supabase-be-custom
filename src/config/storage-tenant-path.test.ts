import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// Tenant-scoped storage deletes (S1 C1). No storage, database or network:
// every refusal below must happen before any provider or pool call.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PUBLIC_PREFIX = 'https://storage.example.test/storage/v1/object/public/landa-storage/';

test('resolveTenantStoragePath accepts only keys inside the tenant prefix', async () => {
  const { resolveTenantStoragePath } = await import('./storage.js');

  assert.equal(resolveTenantStoragePath(`${TENANT_A}/avatars/u.png`, TENANT_A), `${TENANT_A}/avatars/u.png`);
  assert.equal(resolveTenantStoragePath(`${PUBLIC_PREFIX}${TENANT_A}/library/a%20b.pdf`, TENANT_A), `${TENANT_A}/library/a b.pdf`);
  assert.equal(resolveTenantStoragePath(`${TENANT_A}/library/x.pdf`, TENANT_A, 'library'), `${TENANT_A}/library/x.pdf`);

  const refused = [
    `${TENANT_B}/branding/logo.png`,
    `${PUBLIC_PREFIX}${TENANT_B}/branding/logo.png`,
    `${TENANT_A}/../${TENANT_B}/branding/logo.png`,
    `${PUBLIC_PREFIX}${TENANT_A}/%2e%2e/${TENANT_B}/logo.png`,
    `${TENANT_A}/%2e%2e/${TENANT_B}/logo.png`,
    `${TENANT_A}/./avatars/u.png`,
    `${TENANT_A}//avatars/u.png`,
    `/${TENANT_A}/avatars/u.png`,
    `${TENANT_A}\\..\\${TENANT_B}\\logo.png`,
    `${TENANT_A}/avatars/u.png\u0000`,
    `${TENANT_A}`,
    `${TENANT_A}/`,
    `${TENANT_A}x/avatars/u.png`,
    `${PUBLIC_PREFIX}${TENANT_A}/%E0%A4%A.png`,
    'https://elsewhere.example.test/some/file.png',
    '',
  ];
  for (const value of refused) assert.equal(resolveTenantStoragePath(value, TENANT_A), null, value);
  assert.equal(resolveTenantStoragePath(`${TENANT_A}/courses/x.pdf`, TENANT_A, 'library'), null);
  assert.equal(resolveTenantStoragePath(`${TENANT_A}/avatars/u.png`, null), null);
  assert.equal(resolveTenantStoragePath(`${TENANT_A}/avatars/u.png`, ''), null);
});

test('deleteTenantFileByUrl never deletes another tenant\'s object', async (t) => {
  const { deleteTenantFileByUrl } = await import('./storage.js');
  const warn = t.mock.method(console, 'warn', () => undefined);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });

  assert.equal(await deleteTenantFileByUrl(`${TENANT_B}/branding/logo.png`, TENANT_A), false);
  assert.equal(await deleteTenantFileByUrl(`${TENANT_A}/../${TENANT_B}/logo.png`, TENANT_A), false);
  assert.equal(await deleteTenantFileByUrl(null, TENANT_A), false);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 2);
});

test('avatar_url can no longer be chosen by a request (bot, admin user update, own profile)', async () => {
  const { updateBotSchema } = await import('../modules/ai-chatbot/bot.validator.js');
  const { updateUserSchema } = await import('../modules/users/users.validator.js');
  const foreign = `${TENANT_B}/branding/logo.png`;

  assert.equal(updateBotSchema.safeParse({ avatar_url: foreign }).success, false);
  assert.equal(updateBotSchema.safeParse({ avatar_url: null }).success, true);
  assert.equal(updateBotSchema.safeParse({ name: 'Bot' }).success, true);
  assert.equal(updateUserSchema.safeParse({ avatar_url: `${PUBLIC_PREFIX}${foreign}` }).success, false);
  assert.equal(updateUserSchema.safeParse({ avatar_url: null }).success, true);
  assert.equal(updateUserSchema.safeParse({ full_name: 'A' }).success, true);

  const { updateProfile } = await import('../modules/auth/auth.service.js');
  await assert.rejects(updateProfile('a0000000-0000-4000-8000-000000000001', { avatar_url: foreign }), { statusCode: 400 });
});

test('library JSON document registration refuses a file outside the tenant library', async () => {
  const { createDocumentController } = await import('../modules/library/library.controller.js');
  for (const fileUrl of [`${TENANT_B}/library/x.pdf`, `${TENANT_A}/branding/logo.png`, `${TENANT_A}/library/../../${TENANT_B}/x.pdf`, undefined]) {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: Record<string, unknown>) { out.body = body; return this; },
    } as unknown as Response;
    let forwarded: unknown;
    await createDocumentController(
      { user: { id: 'a0000000-0000-4000-8000-000000000001', tenantId: TENANT_A }, body: { title: 'x', file_url: fileUrl } } as unknown as Request,
      res,
      ((err: unknown) => { forwarded = err; }) as NextFunction,
    );
    assert.equal(forwarded, undefined);
    assert.equal(out.status, 400, String(fileUrl));
  }
});
