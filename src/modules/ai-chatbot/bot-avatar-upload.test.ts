import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

// P3: the bot avatar is parsed with the real 5 MB limit (it used to be read
// into memory up to 50 MB before the handler refused it). Every answer stays
// the handler's: same status, same message, same check order. No database.

const {
  BOT_AVATAR_MAX_BYTES, BOT_AVATAR_SIZE_MESSAGE, BOT_AVATAR_TYPE_MESSAGE, BOT_NOT_FOUND_MESSAGE,
  botAvatarFileError, parseBotAvatarUpload,
} = await import('./bot-avatar-upload.js');

const BOT_ID = '0b9f6c7e-2f43-4d55-9a54-6f0c1d2e3a4b';

async function serve() {
  const seen: Array<{ size: number; mimetype: string; buffered: number }> = [];
  const app = express();
  app.post('/bots/:id/avatar', parseBotAvatarUpload, (req, res) => {
    const file = req.file!;
    seen.push({ size: file.size, mimetype: file.mimetype, buffered: file.buffer.length });
    // The handler's own checks (bot.controller.ts uploadAvatar).
    const refusal = botAvatarFileError(file);
    if (refusal) { res.status(400).json({ success: false, message: refusal }); return; }
    res.json({ success: true });
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ unexpected: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    post: async (id: string, bytes: number, type: string) => {
      const form = new FormData();
      form.append('avatar', new Blob([new Uint8Array(bytes)], { type }), 'avatar.bin');
      const response = await fetch(`${origin}/bots/${id}/avatar`, { method: 'POST', body: form });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('an avatar of exactly 5 MB still reaches the handler', async () => {
  const server = await serve();
  try {
    assert.deepEqual(await server.post(BOT_ID, BOT_AVATAR_MAX_BYTES, 'image/png'), { status: 200, body: { success: true } });
    assert.deepEqual(server.seen, [{ size: BOT_AVATAR_MAX_BYTES, mimetype: 'image/png', buffered: BOT_AVATAR_MAX_BYTES }]);
  } finally {
    await server.close();
  }
});

test('an avatar over 5 MB gets the handler message without being read further', async () => {
  const server = await serve();
  try {
    for (const bytes of [BOT_AVATAR_MAX_BYTES + 1, 6 * 1024 * 1024, 60 * 1024 * 1024]) {
      assert.deepEqual(await server.post(BOT_ID, bytes, 'image/jpeg'), {
        status: 400, body: { success: false, message: BOT_AVATAR_SIZE_MESSAGE },
      }, `${bytes} bytes`);
    }
    assert.deepEqual(server.seen, [], 'nothing over the limit is handed to the handler');
  } finally {
    await server.close();
  }
});

test('the handler order is kept for a large file: unknown bot id, then type, then size', async () => {
  const server = await serve();
  try {
    assert.deepEqual(await server.post('not-a-uuid', 6 * 1024 * 1024, 'image/png'), {
      status: 404, body: { success: false, message: BOT_NOT_FOUND_MESSAGE },
    });
    assert.deepEqual(await server.post(BOT_ID, 6 * 1024 * 1024, 'application/pdf'), {
      status: 400, body: { success: false, message: BOT_AVATAR_TYPE_MESSAGE },
    });
    // A small file of the wrong type is still refused by the handler itself.
    assert.deepEqual(await server.post(BOT_ID, 10, 'application/pdf'), {
      status: 400, body: { success: false, message: BOT_AVATAR_TYPE_MESSAGE },
    });
  } finally {
    await server.close();
  }
});

test('the avatar checks keep their messages', () => {
  assert.equal(BOT_AVATAR_SIZE_MESSAGE, 'File ảnh tối đa 5MB');
  assert.equal(BOT_AVATAR_TYPE_MESSAGE, 'Chỉ hỗ trợ JPEG, PNG, WebP, GIF');
  for (const mimetype of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    assert.equal(botAvatarFileError({ mimetype, size: BOT_AVATAR_MAX_BYTES }), null);
    assert.equal(botAvatarFileError({ mimetype, size: BOT_AVATAR_MAX_BYTES + 1 }), BOT_AVATAR_SIZE_MESSAGE);
  }
  assert.equal(botAvatarFileError({ mimetype: 'image/svg+xml', size: 1 }), BOT_AVATAR_TYPE_MESSAGE);
  assert.equal(botAvatarFileError({ mimetype: 'image/svg+xml', size: BOT_AVATAR_MAX_BYTES + 1 }), BOT_AVATAR_TYPE_MESSAGE);
});
