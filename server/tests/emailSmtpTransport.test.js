import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'net';

vi.mock('../db.js', () => ({ default: { all: vi.fn(async () => []) } }));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/crypto.js', () => ({ decrypt: vi.fn() }));

import { sendEmail, resetTransporter } from '../utils/email.js';

// Minimal in-process SMTP server: enough of RFC 5321 for nodemailer to hand
// over one message. Drives the real nodemailer transport (not a mock) so a
// breaking change in the library surfaces here.
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let current = { rcpt: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = { rcpt: [], data: '' };
            sock.write('250 OK queued\r\n');
          } else {
            current.data += line + '\n';
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 fake\r\n');
        else if (cmd === 'MAIL') { current.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { current.rcpt.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages }));
  });
}

describe('sendEmail over real nodemailer SMTP transport', () => {
  let smtp;
  const saved = { ...process.env };

  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });
  afterAll(() => smtp.server.close());
  afterEach(() => {
    process.env = { ...saved };
    resetTransporter();
  });

  it('delivers from/to/subject/body and strips CRLF from the subject', async () => {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_FROM = 'noreply@example.test';
    delete process.env.SMTP_USER;

    const info = await sendEmail({
      to: 'alice@example.test',
      subject: 'Hello\r\nBcc: evil@example.test',
      text: 'body text here',
    });

    expect(info.accepted).toEqual(['alice@example.test']);
    expect(smtp.messages).toHaveLength(1);
    const msg = smtp.messages[0];
    expect(msg.from).toContain('<noreply@example.test>');
    expect(msg.rcpt).toEqual(['RCPT TO:<alice@example.test>']);
    expect(msg.data).toMatch(/^From: FlowTex <noreply@example\.test>$/m);
    expect(msg.data).toMatch(/^Subject: Hello Bcc: evil@example\.test$/m);
    expect(msg.data).not.toMatch(/^Bcc:/m);
    expect(msg.data).toContain('body text here');
  });
});
