import nodemailer from 'nodemailer';
import logger from '../logger.js';
import db from '../db.js';
import { decrypt } from '../utils/crypto.js';

let transporter;

async function getSmtpSettings() {
  try {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'");
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    return settings;
  } catch {
    return {};
  }
}

async function getTransporter() {
  if (transporter) return transporter;

  // Try DB settings first, fall back to env vars
  const dbSettings = await getSmtpSettings();
  const host = dbSettings.smtp_host || process.env.SMTP_HOST;
  const port = parseInt(dbSettings.smtp_port || process.env.SMTP_PORT || '587');
  const secure = (dbSettings.smtp_secure || process.env.SMTP_SECURE) === 'true';
  const user = dbSettings.smtp_user || process.env.SMTP_USER;
  let pass = process.env.SMTP_PASS;
  if (dbSettings.smtp_pass) {
    try { pass = decrypt(dbSettings.smtp_pass); } catch { pass = dbSettings.smtp_pass; }
  }

  if (host) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });
  } else {
    // Development: log emails to console instead of sending
    transporter = {
      sendMail: async (opts) => {
        logger.info({ to: opts.to, subject: opts.subject }, 'DEV EMAIL (not sent)');
        console.log('\n📧 ── DEV EMAIL ──────────────────────────');
        console.log(`  To:      ${opts.to}`);
        console.log(`  Subject: ${opts.subject}`);
        console.log(`  Body:\n${opts.text || opts.html}`);
        console.log('──────────────────────────────────────────\n');
        return { messageId: 'dev-' + Date.now() };
      },
    };
  }

  return transporter;
}

export function resetTransporter() {
  transporter = null;
}

async function getFromAddress() {
  const dbSettings = await getSmtpSettings();
  return dbSettings.smtp_from || process.env.SMTP_FROM || 'FlowTex <noreply@flowtex.local>';
}

export async function sendEmail({ to, subject, text, html }) {
  const transport = await getTransporter();
  const from = await getFromAddress();
  return transport.sendMail({ from, to, subject, text, html });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendProjectInvitationEmail(email, { inviterName, projectName, baseUrl }) {
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeUrl = escapeHtml(baseUrl);
  return sendEmail({
    to: email,
    subject: `${inviterName} invited you to "${projectName}" on FlowTex`,
    text: `${inviterName} has invited you to collaborate on "${projectName}".\n\nLog in to FlowTex to accept the invitation:\n${baseUrl}\n\nIf you were not expecting this invitation, you can safely ignore this email.\n`,
    html: `
      <p><strong>${safeInviter}</strong> has invited you to collaborate on <strong>${safeProject}</strong>.</p>
      <p><a href="${safeUrl}">Log in to FlowTex</a> to accept the invitation.</p>
      <p>If you were not expecting this invitation, you can safely ignore this email.</p>
    `,
  });
}

export async function sendEmailVerificationEmail(email, verifyUrl) {
  const safeUrl = escapeHtml(verifyUrl);
  return sendEmail({
    to: email,
    subject: 'Verify your FlowTex email address',
    text: `Welcome to FlowTex!\n\nPlease verify your email address by clicking the link below (valid for 24 hours):\n\n${verifyUrl}\n\nIf you did not create a FlowTex account, you can safely ignore this email.\n`,
    html: `
      <p>Welcome to FlowTex!</p>
      <p>Please verify your email address by clicking the link below:</p>
      <p><a href="${safeUrl}">Verify my email</a></p>
      <p>This link is valid for 24 hours.</p>
      <p>If you did not create a FlowTex account, you can safely ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(email, resetUrl) {
  const safeUrl = escapeHtml(resetUrl);
  return sendEmail({
    to: email,
    subject: 'Reset your FlowTex password',
    text: `You requested a password reset for your FlowTex account.\n\nClick the link below to set a new password (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.\n`,
    html: `
      <p>You requested a password reset for your FlowTex account.</p>
      <p><a href="${safeUrl}">Click here to set a new password</a></p>
      <p>This link is valid for 1 hour.</p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `,
  });
}
