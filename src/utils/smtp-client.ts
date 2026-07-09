import net from 'net';
import tls from 'tls';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string | null;
  replyToEmail?: string | null;
}

interface SmtpMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

type SmtpSocket = net.Socket | tls.TLSSocket;

const DEFAULT_TIMEOUT_MS = 15_000;

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
      const onError = (err: Error) => reject(err);
      const socket = config.secure
        ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () => {
            socket.off('error', onError);
            resolve(new SmtpSession(socket));
          })
        : net.connect({ host: config.host, port: config.port }, () => {
            socket.off('error', onError);
            resolve(new SmtpSession(socket));
          });

      socket.once('error', onError);
      socket.setTimeout(DEFAULT_TIMEOUT_MS, () => {
        socket.destroy(new Error('SMTP connection timeout'));
      });
    });
  }

  private readResponse(): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;

      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
      };

      const parse = () => {
        const lines = this.buffer.split(/\r?\n/);
        const completeIndex = lines.findIndex(line => /^\d{3} /.test(line));
        if (completeIndex === -1) return;

        const responseLines = lines.slice(0, completeIndex + 1).filter(Boolean);
        this.buffer = lines.slice(completeIndex + 1).join('\r\n');
        cleanup();
        const code = parseInt(responseLines[responseLines.length - 1].slice(0, 3), 10);
        resolve({ code, lines: responseLines });
      };

      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        parse();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('SMTP response timeout'));
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
    this.socket.write(`${command}\r\n`);
    return this.expect(expected);
  }

  async data(payload: string): Promise<void> {
    this.socket.write(`${payload}\r\n.\r\n`);
    await this.expect(250);
  }

  async upgradeToTls(host: string): Promise<void> {
    await this.command('STARTTLS', 220);
    const current = this.socket;
    this.socket = tls.connect({ socket: current, servername: host });
    this.socket.setTimeout(DEFAULT_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      this.socket.once('secureConnect', resolve);
      this.socket.once('error', reject);
    });
  }

  async close(): Promise<void> {
    try {
      await this.command('QUIT', 221);
    } catch {
      // Socket may already be closed by the server.
    } finally {
      this.socket.end();
    }
  }
}

export async function sendSmtpMail(config: SmtpConfig, mail: SmtpMail): Promise<void> {
  const session = await SmtpSession.connect(config);
  try {
    await session.expect(220);
    await session.command('EHLO landa.local', 250);

    if (!config.secure && config.port !== 25) {
      await session.upgradeToTls(config.host);
      await session.command('EHLO landa.local', 250);
    }

    const auth = Buffer.from(`\0${config.username}\0${config.password}`, 'utf8').toString('base64');
    await session.command(`AUTH PLAIN ${auth}`, 235);
    await session.command(`MAIL FROM:<${config.fromEmail}>`, 250);
    await session.command(`RCPT TO:<${mail.to}>`, [250, 251]);
    await session.command('DATA', 354);
    await session.data(dotStuff(buildMimeMessage(config, mail)));
  } finally {
    await session.close();
  }
}
