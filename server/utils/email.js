import nodemailer from 'nodemailer';
import logger from '../logger.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    // Production / configured SMTP
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
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

const FROM = process.env.SMTP_FROM || 'FlowTex <noreply@flowtex.local>';

export async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter();
  return transport.sendMail({ from: FROM, to, subject, text, html });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
