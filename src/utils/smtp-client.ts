import net from 'net';
import tls from 'tls';
import { env } from '../config/env.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string | null;
  replyToEmail?: string | null;
}

export interface SmtpMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type SmtpSocket = net.Socket | tls.TLSSocket;

export interface SmtpBatchMail extends SmtpMail {
  id: string;
}

export interface SmtpBatchResult {
  id: string;
  ok: boolean;
  error?: string;
}

export type SmtpBatchResultHandler = (result: SmtpBatchResult) => void | Promise<void>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAIL_TIMEOUT_MS = 30_000;
let smtpTlsWarningLogged = false;

function smtpRejectUnauthorized(): boolean {
  if (!env.SMTP_TLS_REJECT_UNAUTHORIZED && !smtpTlsWarningLogged) {
    smtpTlsWarningLogged = true;
    console.warn('[SMTP] TLS certificate verification is disabled by SMTP_TLS_REJECT_UNAUTHORIZED=false');
  }
  return env.SMTP_TLS_REJECT_UNAUTHORIZED;
}

function timeoutMessage(scope: string, timeoutMs: number): string {
  return `${scope} timeout after ${timeoutMs}ms`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scope: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(timeoutMessage(scope, timeoutMs)));
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function foldAsciiHeader(value: string, maxLength = 64): string {
  if (value.length <= maxLength) return value;

  const lines: string[] = [];
  let current = '';
  for (const word of value.split(/\s+/)) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxLength) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  return lines.length > 0 ? lines.join('\r\n ') : value;
}

function encodeMimeWords(value: string): string {
  const words: string[] = [];
  let chunk = '';

  for (const char of Array.from(value)) {
    const next = chunk + char;
    if (chunk && Buffer.byteLength(next, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = char;
      continue;
    }
    chunk = next;
  }

  if (chunk) {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }

  return words.join('\r\n ');
}

function encodeHeader(value: string): string {
  const sanitized = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(sanitized)) return foldAsciiHeader(sanitized);
  return encodeMimeWords(sanitized);
}

function formatAddress(email: string, name?: string | null): string {
  const trimmedEmail = email.trim();
  const trimmedName = name?.trim();
  if (!trimmedName) return `<${trimmedEmail}>`;
  if (/^[\x00-\x7F]*$/.test(trimmedName)) {
    return `"${trimmedName.replace(/["\\]/g, '\\$&')}" <${trimmedEmail}>`;
  }
  return `${encodeHeader(trimmedName)} <${trimmedEmail}>`;
}

function dotStuff(value: string): string {
  return value.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function encodeBody(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trimEnd();
}

function buildMimeMessage(config: SmtpConfig, mail: SmtpMail): string {
  const boundary = `landa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${formatAddress(config.fromEmail, config.fromName)}`,
    `To: <${mail.to}>`,
    `Subject: ${encodeHeader(mail.subject)}`,
    config.replyToEmail ? `Reply-To: <${config.replyToEmail}>` : '',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(mail.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(mail.html),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

class SmtpSession {
  private socket: SmtpSocket;
  private buffer = '';

  private constructor(socket: SmtpSocket) {
    this.socket = socket;
    this.socket.setTimeout(DEFAULT_TIMEOUT_MS);
  }

  static connect(config: SmtpConfig): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: SmtpSocket | null = null;
      const timer = setTimeout(() => {
        fail(new Error(timeoutMessage('SMTP connection', DEFAULT_TIMEOUT_MS)));
      }, DEFAULT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket?.off('error', fail);
        socket?.off('timeout', onTimeout);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket?.destroy(err);
        reject(err);
      };
      const onTimeout = () => fail(new Error(timeoutMessage('SMTP connection', DEFAULT_TIMEOUT_MS)));
      const onConnect = () => {
        if (settled || !socket) return;
        settled = true;
        cleanup();
        resolve(new SmtpSession(socket));
      };

      socket = config.secure
        ? tls.connect({
            host: config.host,
            port: config.port,
            servername: config.host,
            rejectUnauthorized: smtpRejectUnauthorized(),
          }, onConnect)
        : net.connect({ host: config.host, port: config.port }, onConnect);

      socket.once('error', fail);
      socket.once('timeout', onTimeout);
      socket.setTimeout(DEFAULT_TIMEOUT_MS);
    });
  }

  private readResponse(): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      let settled = false;
      const timer = setTimeout(() => {
        onTimeout();
      }, DEFAULT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy(err);
        reject(err);
      };

      const parse = () => {
        const lines = this.buffer.split(/\r?\n/);
        const completeIndex = lines.findIndex(line => /^\d{3} /.test(line));
        if (completeIndex === -1) return;

        const responseLines = lines.slice(0, completeIndex + 1).filter(Boolean);
        this.buffer = lines.slice(completeIndex + 1).join('\r\n');
        if (settled) return;
        settled = true;
        cleanup();
        const code = parseInt(responseLines[responseLines.length - 1].slice(0, 3), 10);
        resolve({ code, lines: responseLines });
      };

      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        parse();
      };
      const onError = (err: Error) => {
        fail(err);
      };
      const onTimeout = () => {
        fail(new Error(timeoutMessage('SMTP response', DEFAULT_TIMEOUT_MS)));
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      parse();
    });
  }

  async expect(expected: number | number[]): Promise<string[]> {
    const response = await this.readResponse();
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(response.code)) {
      throw new Error(`SMTP expected ${allowed.join('/')} got ${response.code}: ${response.lines.join(' | ')}`);
    }
    return response.lines;
  }

  async command(command: string, expected: number | number[]): Promise<string[]> {
    if (this.socket.destroyed) throw new Error('SMTP socket is closed');
    this.socket.write(`${command}\r\n`);
    return this.expect(expected);
  }

  async data(payload: string): Promise<void> {
    if (this.socket.destroyed) throw new Error('SMTP socket is closed');
    this.socket.write(`${payload}\r\n.\r\n`);
    await this.expect(250);
  }

  async upgradeToTls(host: string): Promise<void> {
    await this.command('STARTTLS', 220);
    const current = this.socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const upgraded = tls.connect({
        socket: current,
        servername: host,
        rejectUnauthorized: smtpRejectUnauthorized(),
      });
      this.socket = upgraded;
      const timer = setTimeout(() => {
        fail(new Error(timeoutMessage('SMTP STARTTLS', DEFAULT_TIMEOUT_MS)));
      }, DEFAULT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        upgraded.off('secureConnect', done);
        upgraded.off('error', fail);
        upgraded.off('timeout', onTimeout);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        upgraded.destroy(err);
        reject(err);
      };
      const onTimeout = () => fail(new Error(timeoutMessage('SMTP STARTTLS', DEFAULT_TIMEOUT_MS)));

      upgraded.setTimeout(DEFAULT_TIMEOUT_MS);
      upgraded.once('secureConnect', done);
      upgraded.once('error', fail);
      upgraded.once('timeout', onTimeout);
    });
  }

  destroy(err?: Error): void {
    this.socket.destroy(err);
  }

  isClosed(): boolean {
    return this.socket.destroyed;
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    try {
      await this.command('QUIT', 221);
    } catch {
      // Socket may already be closed by the server.
    } finally {
      this.socket.end();
    }
  }
}

async function authenticateSmtpSession(session: SmtpSession, config: SmtpConfig): Promise<void> {
  await session.expect(220);
  await session.command('EHLO landa.local', 250);

  if (!config.secure && config.port !== 25) {
    await session.upgradeToTls(config.host);
    await session.command('EHLO landa.local', 250);
  }

  const auth = Buffer.from(`\0${config.username}\0${config.password}`, 'utf8').toString('base64');
  await session.command(`AUTH PLAIN ${auth}`, 235);
}

async function sendSmtpMailWithSession(session: SmtpSession, config: SmtpConfig, mail: SmtpMail): Promise<void> {
  await session.command(`MAIL FROM:<${config.fromEmail}>`, 250);
  await session.command(`RCPT TO:<${mail.to}>`, [250, 251]);
  await session.command('DATA', 354);
  await session.data(dotStuff(buildMimeMessage(config, mail)));
}

export async function sendSmtpMail(config: SmtpConfig, mail: SmtpMail): Promise<void> {
  const session = await SmtpSession.connect(config);
  try {
    await withTimeout(
      (async () => {
        await authenticateSmtpSession(session, config);
        await sendSmtpMailWithSession(session, config, mail);
      })(),
      DEFAULT_MAIL_TIMEOUT_MS,
      'SMTP send',
      () => session.destroy(new Error(timeoutMessage('SMTP send', DEFAULT_MAIL_TIMEOUT_MS))),
    );
  } finally {
    await session.close();
  }
}

export async function sendSmtpMailBatch(
  config: SmtpConfig,
  mails: SmtpBatchMail[],
  maxMessages = 20,
  onResult?: SmtpBatchResultHandler,
): Promise<SmtpBatchResult[]> {
  const batch = mails.slice(0, Math.max(1, maxMessages));
  if (batch.length === 0) return [];

  const results: SmtpBatchResult[] = [];
  const recordResult = async (result: SmtpBatchResult): Promise<void> => {
    results.push(result);
    await onResult?.(result);
  };
  const session = await SmtpSession.connect(config);
  try {
    await withTimeout(
      authenticateSmtpSession(session, config),
      DEFAULT_MAIL_TIMEOUT_MS,
      'SMTP auth',
      () => session.destroy(new Error(timeoutMessage('SMTP auth', DEFAULT_MAIL_TIMEOUT_MS))),
    );

    for (const mail of batch) {
      if (session.isClosed()) {
        await recordResult({ id: mail.id, ok: false, error: 'SMTP socket is closed' });
        continue;
      }

      try {
        await withTimeout(
          sendSmtpMailWithSession(session, config, mail),
          DEFAULT_MAIL_TIMEOUT_MS,
          'SMTP send',
          () => session.destroy(new Error(timeoutMessage('SMTP send', DEFAULT_MAIL_TIMEOUT_MS))),
        );
        await recordResult({ id: mail.id, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordResult({ id: mail.id, ok: false, error: message });
        if (session.isClosed()) continue;
        try {
          await session.command('RSET', 250);
        } catch {
          session.destroy();
        }
      }
    }
  } finally {
    await session.close();
  }

  return results;
}
