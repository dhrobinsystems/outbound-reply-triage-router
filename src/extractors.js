'use strict';

/**
 * Best-effort extraction of structured details from reply text:
 *   - parseReturnDate: when an out-of-office sender will be back
 *   - parseSnoozeDays: how long a "not now" lead asked to wait
 *   - extractReferral: who a "wrong person" reply points us to
 * All functions are pure and return null when they are not confident.
 */

// @build:strip-start
const { MONTHS, WEEKDAYS } = require('./rules');
// @build:strip-end

const DAY_MS = 86400000;
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const monthNum = (s) => MONTH_INDEX[String(s).toLowerCase().slice(0, 3)];

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const isoToMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

function addDaysIso(iso, n) {
  return new Date(isoToMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** A date written without a year means "the next time that date comes around". */
function inferYear(m, d, refMs) {
  const y = new Date(refMs).getUTCFullYear();
  let iso = isoDate(y, m, d);
  if (iso && isoToMs(iso) < refMs - 2 * DAY_MS) iso = isoDate(y + 1, m, d);
  return iso;
}

function fullYear(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

function collectDates(text, refMs, dateFormat) {
  const found = [];
  const push = (iso, index) => iso && found.push({ iso, index });
  let m;

  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) push(isoDate(Number(m[1]), Number(m[2]), Number(m[3])), m.index);

  const monthDay = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'gi');
  while ((m = monthDay.exec(text))) {
    const day = Number(m[2]);
    push(m[3] ? isoDate(Number(m[3]), monthNum(m[1]), day) : inferYear(monthNum(m[1]), day, refMs), m.index);
  }

  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b\\.?(?:,?\\s+(20\\d{2}))?`, 'gi');
  while ((m = dayMonth.exec(text))) {
    const day = Number(m[1]);
    push(m[3] ? isoDate(Number(m[3]), monthNum(m[2]), day) : inferYear(monthNum(m[2]), day, refMs), m.index);
  }

  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2}|\d{2})\b/g;
  while ((m = numeric.exec(text))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]);
    let month = dateFormat === 'DMY' ? b : a;
    let day = dateFormat === 'DMY' ? a : b;
    if (month > 12 && day <= 12) [month, day] = [day, month]; // unambiguous: swap
    push(isoDate(y, month, day), m.index);
  }

  const weekday = new RegExp(`\\b(?:back|return(?:ing)?|in\\s+the\\s+office|available)\\s+(?:on\\s+)?(?:next\\s+)?(${WEEKDAYS})\\b`, 'gi');
  while ((m = weekday.exec(text))) {
    const target = WEEKDAY_INDEX[m[1].toLowerCase()];
    const refDow = new Date(refMs).getUTCDay();
    const delta = ((target - refDow + 7) % 7) || 7;
    push(new Date(Date.UTC(new Date(refMs).getUTCFullYear(), new Date(refMs).getUTCMonth(), new Date(refMs).getUTCDate() + delta)).toISOString().slice(0, 10), m.index);
  }
  return found.sort((x, y) => x.index - y.index);
}

/**
 * @returns {{ returnDate: string, basis: string } | null}  returnDate = first day the person is back (YYYY-MM-DD)
 */
function parseReturnDate(text, refMs, dateFormat) {
  const dates = collectDates(String(text || ''), refMs, dateFormat === 'DMY' ? 'DMY' : 'MDY');
  if (!dates.length) return null;

  const keywords = [];
  const kw = /\b(return(?:ing|s)?|back|until|till|through|thru|resum(?:e|ing)|available\s+again)\b/gi;
  let m;
  while ((m = kw.exec(text))) keywords.push({ index: m.index, kind: /^(until|till|through|thru)$/i.test(m[1]) ? 'until' : 'back' });

  let pick = null;
  for (const d of dates) {
    const k = keywords.filter((x) => x.index < d.index && d.index - x.index <= 60).pop();
    if (k) {
      pick = { iso: k.kind === 'until' ? addDaysIso(d.iso, 1) : d.iso, basis: k.kind === 'until' ? 'until-date-plus-1' : 'return-date' };
      break;
    }
  }
  if (!pick) {
    const latest = dates.reduce((a, b) => (isoToMs(b.iso) > isoToMs(a.iso) ? b : a));
    pick = { iso: latest.iso, basis: 'latest-date-mentioned' };
  }

  const delta = (isoToMs(pick.iso) - refMs) / DAY_MS;
  if (delta < -1 || delta > 180) return null; // implausible: ignore and fall back to the default pause
  return { returnDate: pick.iso, basis: pick.basis };
}

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, few: 3, 'a few': 3, couple: 2, 'a couple': 2, 'a couple of': 2, 'couple of': 2 };

/** @returns {number|null} days to wait before following up (1-365) */
function parseSnoozeDays(text, refMs) {
  const t = String(text || '');
  let m = /\bin\s+(\d+|a\s+few|a\s+couple(?:\s+of)?|couple(?:\s+of)?|few|a|an|one|two|three|four|five|six)\s+(day|week|month|quarter|year)s?\b/i.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase().replace(/\s+/g, ' ')];
    const unit = { day: 1, week: 7, month: 30, quarter: 90, year: 365 }[m[2].toLowerCase()];
    if (n && unit) return Math.min(365, n * unit);
  }
  m = /\bnext\s+(week|month|quarter|year)\b/i.exec(t);
  if (m) return { week: 7, month: 30, quarter: 90, year: 365 }[m[1].toLowerCase()];

  const ref = new Date(refMs);
  if (/\bafter\s+(?:the\s+)?(?:new\s+year|holidays?)\b/i.test(t)) {
    const year = ref.getUTCMonth() >= 6 ? ref.getUTCFullYear() + 1 : ref.getUTCFullYear();
    const days = Math.ceil((Date.UTC(year, 0, 6) - refMs) / DAY_MS);
    return days >= 1 ? Math.min(365, days) : null;
  }
  m = /\bq([1-4])\b/i.exec(t);
  if (m) {
    const startMonth = (Number(m[1]) - 1) * 3;
    let start = Date.UTC(ref.getUTCFullYear(), startMonth, 1);
    if (start < refMs) start = Date.UTC(ref.getUTCFullYear() + 1, startMonth, 1);
    return Math.min(365, Math.ceil((start - refMs) / DAY_MS) + 7);
  }
  return null;
}

const NAME_STOPWORDS = new Set(['me', 'us', 'our', 'the', 'my', 'i', 'please', 'thanks', 'thank', 'best', 'regards', 'hi', 'hello', 'sales', 'team', 'support', 'info', 'customer', 'them', 'him', 'her', 'you', 'this', 'that', 'a', 'an']);
const TITLE_RE = /\b(Chief [A-Z][a-z]+ Officer|CEO|CTO|CFO|COO|CMO|CRO|CIO|(?:Vice President|VP|SVP|EVP)(?: of| for)?(?: [A-Z][A-Za-z&]+){0,3}|(?:Head|Director|Manager|Lead|Owner|Founder|Co-?founder|President|Partner|Principal|Controller)(?: of| for)?(?: [A-Z][A-Za-z&]+){0,3})\b/;

function nameFromEmail(email) {
  const local = String(email).split('@')[0];
  if (!/^[a-z]+[._-][a-z]+$/i.test(local)) return '';
  return local.split(/[._-]/).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/**
 * @param {string} text           cleaned reply text (original casing)
 * @param {string} senderEmail    the person who replied (excluded from results)
 * @param {string[]} ownDomains   your own sending domains (excluded from results)
 * @returns {{ email, name, title, confidence, nameFromEmail } | null}
 */
function extractReferral(text, senderEmail, ownDomains) {
  const t = String(text || '');
  const sender = String(senderEmail || '').toLowerCase();
  const own = (ownDomains || []).map((d) => d.toLowerCase());

  const emails = (t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => e !== sender && !own.includes(e.split('@')[1]) && !/^(?:noreply|no-reply|donotreply)@/.test(e));
  const email = emails[0] || '';

  let name = '';
  const nameRe = /(?:[Cc]ontact|[Rr]each out to|[Ss]peak (?:with|to)|[Tt]alk to|[Ee]mail|[Tt]ry|forwarded (?:this |it |your \w+ )?to|[Cc]c'?d|[Ll]ooping in|[Ll]oop in|[Dd]irect (?:this )?to|[Ii]ntroduce you to|[Cc]onnect you (?:with|to))\s+((?:Dr\.? |Mr\.? |Ms\.? |Mrs\.? )?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,2})/;
  const nm = nameRe.exec(t);
  if (nm && !NAME_STOPWORDS.has(nm[1].split(/\s+/)[0].toLowerCase())) name = nm[1].trim();

  let derived = false;
  if (!name && email) {
    name = nameFromEmail(email);
    derived = Boolean(name);
  }

  const tm = TITLE_RE.exec(t);
  const title = tm ? tm[1].trim() : '';

  if (!email && !name) return null;
  return { email, name, title, nameFromEmail: derived, confidence: email ? (name && !derived ? 0.9 : 0.75) : 0.5 };
}

// @build:strip-start
module.exports = { parseReturnDate, parseSnoozeDays, extractReferral, isoDate, addDaysIso };
// @build:strip-end
