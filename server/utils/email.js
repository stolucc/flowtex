import nodemailer from 'nodemailer';
import logger from '../logger.js';
import db from '../db.js';
import { decrypt } from '../utils/crypto.js';

let transporter;

/** Load SMTP settings from the database settings table. */
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

/** Get or create the nodemailer transporter (falls back to console logging in dev). */
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
    try {
      pass = decrypt(dbSettings.smtp_pass);
    } catch {
      pass = dbSettings.smtp_pass;
    }
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

/** Reset the cached transporter so the next send re-reads SMTP settings. */
export function resetTransporter() {
  transporter = null;
}

async function getFromAddress() {
  const dbSettings = await getSmtpSettings();
  const raw = (dbSettings.smtp_from || process.env.SMTP_FROM || 'noreply@flowtex.local').trim();
  // If the configured value is just a bare email address (no display
  // name, no `<...>` brackets), wrap it as "FlowTex <email>" so mail
  // clients show "FlowTex" as the sender instead of the raw address.
  // Values that already include a display name (e.g. "Support <x@y>" or
  // "FlowTex Mentions <x@y>") are passed through unchanged.
  if (/^[^\s<>"]+@[^\s<>"]+$/.test(raw)) {
    return `FlowTex <${raw}>`;
  }
  return raw;
}

/** Send an email using the configured SMTP transport. */
export async function sendEmail({ to, subject, text, html }) {
  const transport = await getTransporter();
  const from = await getFromAddress();
  // Strip CR/LF from subject to prevent header injection
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  return transport.sendMail({ from, to, subject: safeSubject, text, html });
}

/** Escape a string for safe inclusion in HTML email bodies. */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Send a project collaboration invitation email. */
export async function sendProjectInvitationEmail(email, { inviterName, projectName, baseUrl, inviteUrl }) {
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  // Prefer the deep link if provided; the recipient still has to log in
  // with the invited email — the link only works for them. Fall back to
  // the bare baseUrl for backwards-compatible callers.
  const url = inviteUrl || baseUrl;
  const safeUrl = escapeHtml(url);
  return sendEmail({
    to: email,
    subject: `${inviterName} invited you to "${projectName}" on FlowTex`,
    text: `${inviterName} has invited you to collaborate on "${projectName}".\n\nOpen this link to accept (you'll be asked to log in with the invited email):\n${url}\n\nThe link only works if you sign in as the invited recipient.\n\nIf you were not expecting this invitation, you can safely ignore this email.\n`,
    html: `
      <p><strong>${safeInviter}</strong> has invited you to collaborate on <strong>${safeProject}</strong>.</p>
      <p><a href="${safeUrl}">Accept invitation</a> — you'll be asked to log in with the invited email.</p>
      <p>The link only works if you sign in as the invited recipient.</p>
      <p>If you were not expecting this invitation, you can safely ignore this email.</p>
    `,
  });
}

/** Send an email verification link to a new user. */
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

/** Send confirmation that a user's account has been deleted. */
export async function sendAccountDeletedEmail(email, name) {
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Your FlowTex account has been deleted',
    text: `Hi ${name},\n\nYour FlowTex account has been successfully deleted. All your personal data has been removed.\n\nIf you did not request this, please contact us immediately.\n\nThank you for using FlowTex.\n`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Your FlowTex account has been successfully deleted. All your personal data has been removed.</p>
      <p>If you did not request this, please contact us immediately.</p>
      <p>Thank you for using FlowTex.</p>
    `,
  });
}

/** Notify the user that their password was changed. */
export async function sendPasswordChangedEmail(email, name) {
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Your FlowTex password was changed',
    text: `Hi ${name},\n\nYour FlowTex password was successfully changed. All other sessions have been signed out.\n\nIf you did not make this change, please reset your password immediately or contact support.\n`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Your FlowTex password was successfully changed. All other sessions have been signed out.</p>
      <p>If you did not make this change, please reset your password immediately or contact support.</p>
    `,
  });
}

/** Send a batched mention digest email with all recent @mentions for a user. */
export async function sendMentionDigestEmail(email, { recipientName, mentions, baseUrl }) {
  const safeName = escapeHtml(recipientName);
  const safeUrl = escapeHtml(baseUrl);
  const items = mentions.map((m) => {
    const from = escapeHtml(m.mentioner_name);
    const proj = escapeHtml(m.project_name);
    const snippet = escapeHtml(m.snippet || '');
    return `<li><strong>${from}</strong> mentioned you in <strong>${proj}</strong>: <em>${snippet}</em></li>`;
  });
  const textItems = mentions.map(
    (m) => `- ${m.mentioner_name} mentioned you in "${m.project_name}": ${m.snippet || ''}`,
  );
  return sendEmail({
    to: email,
    subject: `You were mentioned in ${mentions.length === 1 ? 'a comment' : mentions.length + ' comments'} on FlowTex`,
    text: `Hi ${recipientName},\n\n${textItems.join('\n')}\n\nView them on FlowTex:\n${baseUrl}\n`,
    html: `
      <p>Hi ${safeName},</p>
      <ul>${items.join('')}</ul>
      <p><a href="${safeUrl}">Open FlowTex</a></p>
    `,
  });
}

/** Send a password-reset link email. */
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

/** Send a bug report from `reporter` (a user object) to one or more admin
 *  inboxes. `features` is the user-checked feature-area list. */
export async function sendBugReportEmail(adminEmails, { reporter, description, features }) {
  if (!Array.isArray(adminEmails) || adminEmails.length === 0) {
    throw new Error('No admin recipient configured for bug reports');
  }
  const featureList = Array.isArray(features) && features.length > 0 ? features.join(', ') : '(none specified)';
  const reporterLine = `${reporter.name || 'Unknown'} <${reporter.email || 'unknown@unknown'}>`;
  const safeName = escapeHtml(reporter.name || 'Unknown');
  const safeEmail = escapeHtml(reporter.email || 'unknown@unknown');
  const safeFeatures = escapeHtml(featureList);
  // Bug-report descriptions can be multi-paragraph; preserve newlines in the
  // HTML version via white-space: pre-wrap. The text body retains them
  // verbatim. escapeHtml protects against any <script>… etc. the user types.
  const safeDescription = escapeHtml(description);
  return sendEmail({
    to: adminEmails.join(', '),
    subject: `[FlowTex bug report] ${featureList}`.slice(0, 200),
    text:
      `A FlowTex user submitted a bug report.\n\n` +
      `Reported by: ${reporterLine}\n` +
      `Features: ${featureList}\n` +
      `Submitted at: ${new Date().toISOString()}\n\n` +
      `--- Description ---\n${description}\n`,
    html: `
      <h2 style="margin:0 0 12px 0;font-size:16px">FlowTex bug report</h2>
      <p><strong>Reported by:</strong> ${safeName} &lt;${safeEmail}&gt;</p>
      <p><strong>Features:</strong> ${safeFeatures}</p>
      <p><strong>Submitted at:</strong> ${new Date().toISOString()}</p>
      <hr>
      <h3 style="margin:16px 0 8px 0;font-size:14px">Description</h3>
      <div style="white-space: pre-wrap; font-family: -apple-system, system-ui, sans-serif; line-height: 1.5;">${safeDescription}</div>
    `,
  });
}
