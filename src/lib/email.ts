import type { Env } from '../env';
import { escapeHtml } from './util';

const FROM = 'anymd <noreply@anymd.cc>';

export function emailEnabled(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY);
}

function layout(title: string, body: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f4ef;font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;color:#15140f">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:520px;background:#fff;border:1px solid #e7e2d6;border-radius:14px" cellpadding="0" cellspacing="0">
<tr><td style="padding:28px 28px 8px;font:700 18px/1 ui-monospace,Menlo,monospace"># anymd</td></tr>
<tr><td style="padding:8px 28px 0"><h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1>${body}</td></tr>
${cta ? `<tr><td style="padding:20px 28px 8px"><a href="${cta.url}" style="display:inline-block;background:#05c977;color:#10161a;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">${escapeHtml(cta.label)}</a></td></tr>` : ''}
<tr><td style="padding:20px 28px 28px;color:#6b675c;font-size:12px">anymd.cc · by <a href="https://digitop.ai" style="color:#6b675c">Digitop.ai</a> · <a href="https://anymd.cc/legal/privacy" style="color:#6b675c">Privacy</a></td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendEmail(env: Env, to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
  });
  return res.ok;
}

export function welcomeEmail(env: Env, name: string) {
  const url = `${env.PUBLIC_URL}/dashboard`;
  return {
    subject: 'Welcome to anymd — your first 500 credits are ready',
    html: layout(
      `Welcome, ${name}`,
      `<p style="line-height:1.6">Paste any URL and get clean Markdown back. Everything you convert while signed in lands in your searchable library — ready for your agents over MCP.</p>
       <p style="line-height:1.6">Quick start: prefix any link with <code>anymd.cc/</code>.</p>`,
      { label: 'Open your dashboard', url },
    ),
    text: `Welcome to anymd, ${name}!\n\nPrefix any link with anymd.cc/ to get Markdown. Your dashboard: ${url}`,
  };
}

export function resetEmail(env: Env, token: string) {
  const url = `${env.PUBLIC_URL}/reset?token=${encodeURIComponent(token)}`;
  return {
    subject: 'Reset your anymd password',
    html: layout(
      'Reset your password',
      '<p style="line-height:1.6">Someone (hopefully you) asked to reset the password for this account. The link works for one hour. If it was not you, ignore this email.</p>',
      { label: 'Choose a new password', url },
    ),
    text: `Reset your anymd password (valid for 1 hour): ${url}`,
  };
}
