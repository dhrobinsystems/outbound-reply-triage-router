'use strict';

/** Text helpers: HTML stripping, quoted-history removal, masking and redaction. Pure functions, no dependencies. */

function stripHtml(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Keep only what the person actually wrote: drop quoted history, forwarded headers, and mobile signatures. */
function cleanReply(text) {
  let t = '\n' + String(text || '').replace(/\r\n/g, '\n');
  const cutters = [
    /\n\s*On [^\n]{0,200}(?:\n[^\n]{0,120})?\bwrote:/i,
    /\n\s*-{2,}\s*(?:Original Message|Forwarded message)/i,
    /\n\s*_{5,}/,
    /\n\s*From:\s[^\n]+\n\s*(?:Sent|Date):/i,
    /\n\s*Sent from my /i,
    /\n\s*Get Outlook for /i,
  ];
  for (const re of cutters) {
    const m = re.exec(t);
    if (m) t = t.slice(0, m.index);
  }
  return t
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return `${s[0]}***${s.slice(at)}`;
}

/** Mask every email address inside free text (used for Slack excerpts). */
function maskEmailsInText(text) {
  return String(text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskEmail(m));
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Remove contact details before text is sent to any third-party service (LLM fallback). */
function redactForLlm(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[phone]');
}

/** Small, dependency-free string hash (djb2) used to build fallback reply IDs. */
function hashString(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// @build:strip-start
module.exports = { stripHtml, cleanReply, maskEmail, maskEmailsInText, truncate, redactForLlm, hashString };
// @build:strip-end
