// @ts-check
// @ts-ignore
import nodemailer from 'nodemailer';
import logger from '../logger.js';
import db from '../db.js';
import { decrypt } from '../utils/crypto.js';

/**
 * @typedef {{
 *   smtp_host?: string,
 *   smtp_port?: string,
 *   smtp_secure?: string,
 *   smtp_user?: string,
 *   smtp_pass?: string,
 *   smtp_from?: string,
 * }} SmtpSettings
 *
 * @typedef {{ sendMail: (opts: { from: string, to: string, subject: string, text?: string, html?: string }) => Promise<unknown> }} Transporter
 */

/** @type {Transporter | null} */
let transporter = null;

/** Load SMTP settings from the database settings table.
 *  @returns {Promise<SmtpSettings>}
 */
async function getSmtpSettings() {
  try {
    const rows = await db.all("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'");
    /** @type {Record<string, string>} */
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
      sendMail: async (/** @type {{ to: string, subject: string, text?: string, html?: string }} */ opts) => {
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

/** Send an email using the configured SMTP transport.
 *  @param {{ to: string, subject: string, text?: string, html?: string }} args
 */
export async function sendEmail({ to, subject, text, html }) {
  const transport = await getTransporter();
  const from = await getFromAddress();
  // Strip CR/LF from subject to prevent header injection
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  if (!transport) throw new Error('Email transporter not configured');
  return transport.sendMail({ from, to, subject: safeSubject, text, html });
}

/** Escape a string for safe inclusion in HTML email bodies.
 *  @param {string} str
 */
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
/**
 * @typedef {{
 *   preheader: string,
 *   greeting?: string,
 *   heading?: string,
 *   bodyHtml: string,
 *   ctaLabel?: string,
 *   ctaUrl?: string,
 *   footnoteHtml?: string,
 * }} EmailLayoutArgs
 *
 * @param {EmailLayoutArgs} args
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
// L2 (audit): trim attacker-controllable display strings before they
// hit email subjects / banners. nodemailer normalises CRLF in headers
// so injection isn't the worry — the worry is phishing leverage. An
// attacker who controls inviterName (their own profile name) and
// projectName (their own project) could stuff "URGENT — DocuSign
// invoice — click here" into either field and bury "on FlowTex"
// off the visible line. 80 chars for the project name + 60 for the
// inviter is generous for real users but caps that lever. CRLF strip
// is belt-and-suspenders against any underlying lib that doesn't.
/**
 * @param {string | null | undefined} s
 * @param {number} n
 */
function trimDisplayName(s, n) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').slice(0, n).trim();
}
const MAX_INVITER_NAME = 60;
const MAX_PROJECT_NAME = 80;

/**
 * @param {string} email
 * @param {{ inviterName: string, projectName: string, baseUrl?: string, inviteUrl?: string }} args
 */
export async function sendProjectInvitationEmail(email, { inviterName, projectName, baseUrl, inviteUrl }) {
  inviterName = trimDisplayName(inviterName, MAX_INVITER_NAME);
  projectName = trimDisplayName(projectName, MAX_PROJECT_NAME);
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  // Prefer the deep link if provided; the recipient still has to log in
  // with the invited email — the link only works for them. Fall back to
  // the bare baseUrl for backwards-compatible callers.
  const url = inviteUrl || baseUrl || '';
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

/** Send an invitation email to someone who does NOT yet have a
 *  FlowTex account. Differs from sendProjectInvitationEmail by:
 *  - Explaining the recipient needs to create an account first.
 *  - The "Accept" link is actually a "Create account & accept" link
 *    that pre-fills the register form with the invitation context.
 *  - Includes a "Decline" link backed by a one-shot token so the
 *    recipient can decline without ever creating an account; the
 *    inviter sees the invitation move to status=declined. */
/** Notify the inviter that an unregistered invitee declined via the
 *  email link. The inviter only gets a live WS event if they happen
 *  to be online when the decline lands — this email closes the gap
 *  for the (common) offline case. Best-effort: a send failure does
 *  NOT roll back the decline.
 *
 *  No CTA — the inviter has nothing to do but acknowledge. The
 *  project URL is included as a body link in case they want to
 *  invite a different address. */
/**
 * @param {string} inviterEmail
 * @param {{ inviterName: string, declinedEmail: string, projectName: string, projectUrl?: string }} args
 */
export async function sendInvitationDeclinedEmail(inviterEmail, { inviterName, declinedEmail, projectName, projectUrl }) {
  inviterName = trimDisplayName(inviterName, MAX_INVITER_NAME);
  projectName = trimDisplayName(projectName, MAX_PROJECT_NAME);
  const safeProject = escapeHtml(projectName);
  const safeDeclined = escapeHtml(declinedEmail);
  const safeProjectUrl = escapeHtml(projectUrl || '');
  return sendEmail({
    to: inviterEmail,
    subject: `Invitation declined: ${declinedEmail} declined to join "${projectName}"`,
    text:
      `Hi ${inviterName || 'there'},\n\n` +
      `${declinedEmail} declined your invitation to collaborate on "${projectName}".\n\n` +
      `They were not a FlowTex user and chose to decline via the email link rather\n` +
      `than create an account. No further action is needed — if you'd like to\n` +
      `invite them again or invite a different address, open the project in FlowTex.\n\n` +
      (projectUrl ? `Project: ${projectUrl}\n` : ''),
    html: renderEmailLayout({
      preheader: `${declinedEmail} declined your invitation to ${projectName}.`,
      heading: `Invitation declined`,
      bodyHtml:
        `<p style="margin:0 0 12px 0;"><strong>${safeDeclined}</strong> declined your invitation to collaborate on &ldquo;${safeProject}&rdquo;.</p>` +
        `<p style="margin:0;">They were not a FlowTex user and chose to decline via the email link rather than create an account. No further action is needed.</p>`,
      ctaLabel: projectUrl ? 'Open project' : undefined,
      ctaUrl: projectUrl ? safeProjectUrl : undefined,
      footnoteHtml: `You&rsquo;re receiving this because you sent the invitation.`,
    }),
  });
}

/**
 * @param {string} email
 * @param {{ inviterName: string, projectName: string, registerUrl: string, declineUrl: string }} args
 */
export async function sendUnregisteredInvitationEmail(email, { inviterName, projectName, registerUrl, declineUrl }) {
  inviterName = trimDisplayName(inviterName, MAX_INVITER_NAME);
  projectName = trimDisplayName(projectName, MAX_PROJECT_NAME);
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeRegisterUrl = escapeHtml(registerUrl);
  const safeDeclineUrl = escapeHtml(declineUrl);
  return sendEmail({
    to: email,
    subject: `${inviterName} invited you to "${projectName}" on FlowTex — create an account to accept`,
    text:
      `${inviterName} has invited you to collaborate on "${projectName}" on FlowTex,\n` +
      `a self-hosted collaborative LaTeX editor. You don't have a FlowTex account\n` +
      `yet, so to accept you'll need to register first (with this email address).\n\n` +
      `Create account & accept:\n${registerUrl}\n\n` +
      `If you don't want this invitation, you can decline without registering:\n${declineUrl}\n\n` +
      `If you weren't expecting this invitation, you can safely ignore this email\n` +
      `— no account will be created.\n`,
    html: renderEmailLayout({
      preheader: `${inviterName} invited you to ${projectName}. Create an account to accept.`,
      heading: `${safeInviter} invited you to &ldquo;${safeProject}&rdquo;`,
      bodyHtml:
        `<p style="margin:0 0 12px 0;">You&rsquo;ve been invited to collaborate on a LaTeX project on FlowTex (a self-hosted collaborative LaTeX editor).</p>` +
        `<p style="margin:0 0 12px 0;">You don&rsquo;t have a FlowTex account yet, so to accept you&rsquo;ll need to <strong>create one with this email address</strong> first.</p>` +
        `<p style="margin:0;">Prefer not to? You can decline below without creating an account &mdash; ${safeInviter} will see the invitation as declined.</p>`,
      ctaLabel: 'Create account & accept',
      ctaUrl: safeRegisterUrl,
      footnoteHtml:
        `Not interested? <a href="${safeDeclineUrl}" style="color:#dc2626;">Decline this invitation</a> &mdash; no account will be created. ` +
        `If you weren&rsquo;t expecting this invitation, you can safely ignore this email.`,
    }),
  });
}

/** Send an email verification link to a new user. */
/**
 * @param {string} email
 * @param {string} verifyUrl
 */
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

/** Send confirmation that a user's account has been soft-deleted (bin).
 *
 *  `purgeAt` is the absolute UTC date on which the account will be
 *  permanently purged (today + SOFT_DELETE_WINDOW_DAYS, computed by the
 *  caller). The body tells the user how to recover the account during
 *  the window: reply to this email — the SMTP_FROM address is the
 *  operator contact for FlowTex. */
/**
 * @param {string} email
 * @param {string} name
 * @param {{ purgeAt?: Date }} [opts]
 */
export async function sendAccountDeletedEmail(email, name, { purgeAt } = {}) {
  const safeName = escapeHtml(name);
  const purgeDateText = purgeAt instanceof Date
    ? purgeAt.toISOString().slice(0, 10)
    : 'in 30 days';
  return sendEmail({
    to: email,
    subject: 'Your FlowTex account has been scheduled for deletion',
    text:
      `Hi ${name},\n\n` +
      `Your FlowTex account has been deactivated and is scheduled for ` +
      `permanent deletion on ${purgeDateText}. Until then, the account ` +
      `cannot be signed into and your email cannot be reused to register ` +
      `a new account.\n\n` +
      `If this was a mistake and you'd like to recover the account, ` +
      `reply to this email before ${purgeDateText} and the FlowTex ` +
      `operator can restore it.\n\n` +
      `After ${purgeDateText}, the account and its data will be ` +
      `permanently and irreversibly removed.\n`,
    html: renderEmailLayout({
      preheader: `Your FlowTex account will be permanently deleted on ${purgeDateText}.`,
      greeting: `Hi ${safeName},`,
      heading: 'Your account is scheduled for deletion',
      bodyHtml:
        `<p style="margin:0 0 10px 0;">Your FlowTex account has been deactivated and is scheduled for permanent deletion on <strong>${escapeHtml(purgeDateText)}</strong>.</p>` +
        `<p style="margin:0 0 10px 0;">Until then the account cannot be signed into and your email address cannot be reused to register a new account.</p>` +
        `<p style="margin:0;">If this was a mistake, <strong>reply to this email</strong> before ${escapeHtml(purgeDateText)} and the FlowTex operator can restore it.</p>`,
      footnoteHtml: `After ${escapeHtml(purgeDateText)} the account and its data will be permanently and irreversibly removed.`,
    }),
  });
}

/** Notify a user that their previously-deleted account has been restored
 *  by an admin. They can sign in again with the existing password. */
/**
 * @param {string} email
 * @param {string} name
 */
export async function sendAccountRestoredEmail(email, name) {
  const safeName = escapeHtml(name);
  return sendEmail({
    to: email,
    subject: 'Your FlowTex account has been restored',
    text:
      `Hi ${name},\n\n` +
      `Your FlowTex account has been restored and you can sign in again ` +
      `with your existing password. All of your projects, files, and ` +
      `memberships are intact.\n\n` +
      `If you didn't ask for this, please reply to this email.\n`,
    html: renderEmailLayout({
      preheader: 'Your FlowTex account is active again.',
      greeting: `Hi ${safeName},`,
      heading: 'Your account has been restored',
      bodyHtml: `<p style="margin:0 0 10px 0;">Your FlowTex account has been restored. You can sign in again with your existing password.</p><p style="margin:0;">All of your projects, files, and memberships are intact.</p>`,
      footnoteHtml: `If you didn&rsquo;t ask for this, please reply to this email.`,
    }),
  });
}

/** Notify the OLD address that the account email was changed to a new one.
 *
 *  This is the security half of the change-email flow: the new address
 *  receives a verification link (proves ownership), and the old address
 *  receives this notice so a stolen-credentials attacker swapping the
 *  email to one they control can't do it silently. The old-address
 *  email lists the new address so the user can call support and say
 *  "my account just got moved to X without my consent".
 */
/**
 * @param {string} oldEmail
 * @param {{ name: string, newEmail: string }} args
 */
export async function sendEmailChangedNotice(oldEmail, { name, newEmail }) {
  const safeName = escapeHtml(name);
  const safeNewEmail = escapeHtml(newEmail);
  return sendEmail({
    to: oldEmail,
    subject: 'Your FlowTex email address was changed',
    text: `Hi ${name},\n\nThe email address on your FlowTex account was just changed to ${newEmail}.\n\nIf this WAS you, no action is needed — the new address will receive a verification link.\n\nIf this was NOT you, your account may be compromised. Reply to this email immediately so we can lock the account and restore access.\n`,
    html: renderEmailLayout({
      preheader: `Your FlowTex account email was changed to ${newEmail}.`,
      greeting: `Hi ${safeName},`,
      heading: 'Your account email was changed',
      bodyHtml: `<p style="margin:0 0 10px 0;">The email address on your FlowTex account was just changed to <strong>${safeNewEmail}</strong>.</p><p style="margin:0;">If this <strong>was you</strong>, no action is needed — the new address will receive a verification link.</p>`,
      footnoteHtml: `If this was <strong>not you</strong>, your account may be compromised. Reply to this email immediately so we can lock the account and restore access.`,
    }),
  });
}

/** Notify the user that their password was changed. */
/**
 * @param {string} email
 * @param {string} name
 */
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
/**
 * @typedef {{ mentioner_name: string, project_name: string, snippet?: string }} MentionRow
 *
 * @param {string} email
 * @param {{ recipientName: string, mentions: MentionRow[], baseUrl: string }} args
 */
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
    .map((/** @type {MentionRow} */ m) => {
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
    (/** @type {MentionRow} */ m) => `- ${m.mentioner_name} mentioned you in "${m.project_name}": ${m.snippet || ''}`,
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
/**
 * @param {string} email
 * @param {string} resetUrl
 */
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
/**
 * @param {string[]} adminEmails
 * @param {{
 *   reporter: { id: string, name: string, email: string },
 *   description: string,
 *   features: string[],
 * }} args
 */
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
  const metaRow = (/** @type {string} */ label, /** @type {string} */ value) =>
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
