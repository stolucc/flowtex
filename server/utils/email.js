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

/**
 * Render a Google-Docs-style HTML email: white card on a soft grey page,
 * small uppercase "FLOWTEX" wordmark, optional heading, body, blue CTA
 * button, footnote, and a tiny footer below the card.
 *
 * All styles are inline (most mail clients strip <style> blocks) and the
 * layout uses tables (flex / grid are not safe across Outlook / Apple
 * Mail). Width capped at 520px so it reads well on phones too.
 *
 * Inputs that come from a person (names, project names, free-text
 * descriptions) must be HTML-escaped by the caller — this helper
 * concatenates them as-is into the markup.
 */
function renderEmailLayout({ preheader, greeting, heading, bodyHtml, ctaLabel, ctaUrl, footnoteHtml }) {
  const ACCENT = '#1a73e8';
  const PAGE_BG = '#f5f5f7';
  const CARD_BG = '#ffffff';
  const TEXT = '#202124';
  const MUTED = '#5f6368';
  const BORDER = '#e8eaed';
  const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

  // Preheader is the snippet most inbox lists show next to the subject.
  // We hide it from the rendered body with the standard trick. ALWAYS
  // escape — preheader is semantically plain text and callers pass raw
  // user-controllable strings (inviter name, project name, reporter
  // name) into it; if a hostile project name like
  // `</div><img src=x onerror=...>` slipped through unescaped, the
  // hidden div would close and leak markup into the inbox-list preview
  // (and into the rendered body on clients that strip the display:none).
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>`
    : '';

  const greetingHtml = greeting
    ? `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:${TEXT};">${greeting}</p>`
    : '';

  const headingHtml = heading
    ? `<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;line-height:1.3;color:${TEXT};">${heading}</h1>`
    : '';

  const ctaHtml = ctaUrl && ctaLabel
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 4px 0;"><tr><td style="border-radius:6px;background:${ACCENT};"><a href="${ctaUrl}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:6px;font-family:${FONT};">${ctaLabel}</a></td></tr></table>`
    : '';

  const footnoteSection = footnoteHtml
    ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid ${BORDER};font-size:12px;line-height:1.5;color:${MUTED};">${footnoteHtml}</div>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlowTex</title></head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:${FONT};color:${TEXT};-webkit-font-smoothing:antialiased;">
${preheaderHtml}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE_BG};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:${CARD_BG};border:1px solid ${BORDER};border-radius:8px;">
    <tr><td style="padding:24px 28px 0 28px;">
      <div style="font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${ACCENT};font-family:${FONT};">FlowTex</div>
    </td></tr>
    <tr><td style="padding:20px 28px 24px 28px;font-family:${FONT};color:${TEXT};">
      ${greetingHtml}
      ${headingHtml}
      <div style="font-size:14px;line-height:1.55;color:${TEXT};">${bodyHtml}</div>
      ${ctaHtml}
      ${footnoteSection}
    </td></tr>
  </table>
  <div style="max-width:520px;font-size:11px;color:${MUTED};padding:14px 12px 0 12px;text-align:center;line-height:1.5;font-family:${FONT};">
    Sent by FlowTex — a collaborative LaTeX editor.
  </div>
</td></tr>
</table>
</body></html>`;
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
    html: renderEmailLayout({
      preheader: `${inviterName} invited you to collaborate on ${projectName}.`,
      heading: `${safeInviter} invited you to &ldquo;${safeProject}&rdquo;`,
      bodyHtml: `<p style="margin:0;">You&rsquo;ve been invited to collaborate on a LaTeX project. Open the invitation to sign in with your invited email and start editing.</p>`,
      ctaLabel: 'Open invitation',
      ctaUrl: safeUrl,
      footnoteHtml: `The link only works if you sign in as the invited recipient. If you weren&rsquo;t expecting this invitation, you can safely ignore this email.`,
    }),
  });
}

/** Send an email verification link to a new user. */
export async function sendEmailVerificationEmail(email, verifyUrl) {
  const safeUrl = escapeHtml(verifyUrl);
  return sendEmail({
    to: email,
    subject: 'Verify your FlowTex email address',
    text: `Welcome to FlowTex!\n\nPlease verify your email address by clicking the link below (valid for 24 hours):\n\n${verifyUrl}\n\nIf you did not create a FlowTex account, you can safely ignore this email.\n`,
    html: renderEmailLayout({
      preheader: 'Confirm your email to finish setting up your FlowTex account.',
      heading: 'Verify your email address',
      bodyHtml: `<p style="margin:0;">Welcome to FlowTex! Please confirm your email address to finish setting up your account.</p>`,
      ctaLabel: 'Verify email',
      ctaUrl: safeUrl,
      footnoteHtml: `This link is valid for 24 hours. If you didn&rsquo;t create a FlowTex account, you can safely ignore this email.`,
    }),
  });
}

/** Send confirmation that a user's account has been deleted. */
export async function sendAccountDeletedEmail(email, name) {
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Your FlowTex account has been deleted',
    text: `Hi ${name},\n\nYour FlowTex account has been successfully deleted. All your personal data has been removed.\n\nIf you did not request this, please contact us immediately.\n\nThank you for using FlowTex.\n`,
    html: renderEmailLayout({
      preheader: 'Your FlowTex account and personal data have been removed.',
      greeting: `Hi ${safeName},`,
      heading: 'Your account has been deleted',
      bodyHtml: `<p style="margin:0 0 10px 0;">Your FlowTex account has been deleted and all your personal data has been removed.</p><p style="margin:0;">Thanks for using FlowTex.</p>`,
      footnoteHtml: `If you didn&rsquo;t request this deletion, please contact us immediately.`,
    }),
  });
}

/** Notify the user that their password was changed. */
export async function sendPasswordChangedEmail(email, name) {
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Your FlowTex password was changed',
    text: `Hi ${name},\n\nYour FlowTex password was successfully changed. All other sessions have been signed out.\n\nIf you did not make this change, please reset your password immediately or contact support.\n`,
    html: renderEmailLayout({
      preheader: 'Your FlowTex password was changed and all other sessions signed out.',
      greeting: `Hi ${safeName},`,
      heading: 'Your password was changed',
      bodyHtml: `<p style="margin:0;">Your FlowTex password was successfully changed. All other sessions have been signed out.</p>`,
      footnoteHtml: `If you didn&rsquo;t make this change, please reset your password immediately or contact support.`,
    }),
  });
}

/** Send a batched mention digest email with all recent @mentions for a user. */
export async function sendMentionDigestEmail(email, { recipientName, mentions, baseUrl }) {
  const safeName = escapeHtml(recipientName);
  const safeUrl = escapeHtml(baseUrl);
  const n = mentions.length;
  const subjectCount = n === 1 ? 'a comment' : `${n} comments`;
  const headingCount = n === 1 ? '1 comment' : `${n} comments`;

  // Each mention rendered as a stacked card-row: who + project on top,
  // snippet quoted below in a soft tint. Cleaner than a bullet list and
  // mirrors how Google Docs surfaces multiple "Alice commented on …" rows.
  const mentionRowsHtml = mentions
    .map((m) => {
      const from = escapeHtml(m.mentioner_name);
      const proj = escapeHtml(m.project_name);
      const snippet = escapeHtml(m.snippet || '').trim();
      const snippetHtml = snippet
        ? `<div style="margin-top:6px;padding:8px 12px;background:#f5f5f7;border-left:3px solid #d2d4d8;border-radius:4px;font-size:13px;line-height:1.5;color:#3c4043;font-style:italic;">${snippet}</div>`
        : '';
      return `<div style="padding:14px 0;border-bottom:1px solid #e8eaed;">
        <div style="font-size:14px;line-height:1.4;color:#202124;"><strong>${from}</strong> mentioned you in <strong>${proj}</strong></div>
        ${snippetHtml}
      </div>`;
    })
    .join('');

  // Strip the trailing border on the last row so it doesnt double up
  // against the CTA section underneath.
  const bodyHtml = `<p style="margin:0 0 8px 0;">You have ${headingCount} waiting for you in FlowTex.</p>
    <div style="margin-top:8px;">${mentionRowsHtml}</div>`;

  const textItems = mentions.map(
    (m) => `- ${m.mentioner_name} mentioned you in "${m.project_name}": ${m.snippet || ''}`,
  );
  return sendEmail({
    to: email,
    subject: `You were mentioned in ${subjectCount} on FlowTex`,
    text: `Hi ${recipientName},\n\n${textItems.join('\n')}\n\nView them on FlowTex:\n${baseUrl}\n`,
    html: renderEmailLayout({
      preheader: `You were mentioned in ${subjectCount} on FlowTex.`,
      greeting: `Hi ${safeName},`,
      heading: `You were mentioned in ${headingCount}`,
      bodyHtml,
      ctaLabel: 'Open FlowTex',
      ctaUrl: safeUrl,
    }),
  });
}

/** Send a password-reset link email. */
export async function sendPasswordResetEmail(email, resetUrl) {
  const safeUrl = escapeHtml(resetUrl);
  return sendEmail({
    to: email,
    subject: 'Reset your FlowTex password',
    text: `You requested a password reset for your FlowTex account.\n\nClick the link below to set a new password (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.\n`,
    html: renderEmailLayout({
      preheader: 'Set a new password for your FlowTex account.',
      heading: 'Reset your password',
      bodyHtml: `<p style="margin:0;">You requested a password reset for your FlowTex account. Use the button below to choose a new one.</p>`,
      ctaLabel: 'Set a new password',
      ctaUrl: safeUrl,
      footnoteHtml: `This link is valid for 1 hour. If you didn&rsquo;t request this, you can safely ignore this email.`,
    }),
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
  const submittedAt = new Date().toISOString();
  const metaRow = (label, value) =>
    `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#5f6368;vertical-align:top;width:110px;">${label}</td><td style="padding:4px 0;font-size:13px;color:#202124;vertical-align:top;">${value}</td></tr>`;
  const metaTable = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;">
    ${metaRow('Reported by', `${safeName} &lt;${safeEmail}&gt;`)}
    ${metaRow('Features', safeFeatures)}
    ${metaRow('Submitted', submittedAt)}
  </table>`;
  const descriptionBlock = `<div style="margin-top:8px;padding:14px 16px;background:#f5f5f7;border-radius:6px;font-size:14px;line-height:1.55;color:#202124;white-space:pre-wrap;">${safeDescription}</div>`;

  return sendEmail({
    to: adminEmails.join(', '),
    subject: `[FlowTex bug report] ${featureList}`.slice(0, 200),
    text:
      `A FlowTex user submitted a bug report.\n\n` +
      `Reported by: ${reporterLine}\n` +
      `Features: ${featureList}\n` +
      `Submitted at: ${submittedAt}\n\n` +
      `--- Description ---\n${description}\n`,
    html: renderEmailLayout({
      preheader: `Bug report from ${reporter.name || 'a user'}: ${featureList}.`,
      heading: 'New bug report',
      bodyHtml: `${metaTable}${descriptionBlock}`,
    }),
  });
}
