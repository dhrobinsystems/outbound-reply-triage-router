'use strict';

/**
 * Deterministic classification rules (no LLM). Each rule: { id, label, re, weight, on? }.
 * weight = how strongly a match indicates the label (0-1). Multiple matches combine with noisy-OR.
 * `on: 'positive'` runs against text with explicit negations ("not interested") removed.
 *
 * Tune here, then run `npm run eval` to see accuracy on the labeled sample corpus.
 */

const LABELS = ['UNSUBSCRIBE', 'INTERESTED', 'OUT_OF_OFFICE', 'WRONG_PERSON', 'NOT_NOW', 'NOT_INTERESTED'];

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

const RULES = [
  // ---- UNSUBSCRIBE (compliance-first; strong matches override everything else) ----
  { id: 'unsub-word', label: 'UNSUBSCRIBE', weight: 0.95, re: /\bunsubscribe\b/i },
  { id: 'unsub-remove-me', label: 'UNSUBSCRIBE', weight: 0.92, re: /\b(?:remove|take|delete|drop)\s+(?:me|my\s+(?:e-?mail|address|name|details|data|information|info|contact))\b/i },
  { id: 'unsub-stop-contacting', label: 'UNSUBSCRIBE', weight: 0.95, re: /\b(?:stop|cease|quit)\s+(?:e-?mailing|emailing|contacting|messaging|sending|writing|spamming|reaching out|calling)\b/i },
  { id: 'unsub-do-not-contact', label: 'UNSUBSCRIBE', weight: 0.95, re: /\bdo\s*not\s+(?:e-?mail|contact|message|call|solicit|write)\b|\bdon'?t\s+(?:e-?mail|contact|message|call|solicit|write)\s+(?:me|us)\b/i },
  { id: 'unsub-opt-me-out', label: 'UNSUBSCRIBE', weight: 0.92, re: /\bopt\s+(?:me|us)\s+out\b/i },
  { id: 'unsub-remove-address', label: 'UNSUBSCRIBE', weight: 0.92, re: /\b(?:remove|delete|take)\s+(?:this|that|the|my|our)\s+(?:e-?mail\s+)?(?:address|e-?mail)\b/i },
  { id: 'unsub-opt-out', label: 'UNSUBSCRIBE', weight: 0.92, re: /\bopt[\s-]?out\b/i },
  { id: 'unsub-no-more', label: 'UNSUBSCRIBE', weight: 0.92, re: /\b(?:no\s+more|stop\s+all)\s+(?:e-?mails?|messages?|outreach|communications?|solicitations?)\b/i },
  { id: 'unsub-bare-keyword', label: 'UNSUBSCRIBE', weight: 0.97, re: /^[ \t]*(?:please[ \t]+)?(?:stop|unsubscribe|remove|cancel)(?:[ \t]+(?:please|now|this))?[ \t]*[.!]*[ \t]*$/im },
  { id: 'unsub-privacy-law', label: 'UNSUBSCRIBE', weight: 0.92, re: /\b(?:right\s+to\s+be\s+forgotten|erase\s+my\s+(?:personal\s+)?data|delete\s+(?:all\s+)?(?:of\s+)?my\s+(?:personal\s+)?(?:data|information)|data\s+subject\s+request)\b/i },
  { id: 'unsub-law-mention', label: 'UNSUBSCRIBE', weight: 0.75, re: /\b(?:gdpr|ccpa|casl|can-?spam)\b/i },
  { id: 'unsub-spam', label: 'UNSUBSCRIBE', weight: 0.7, re: /\b(?:this\s+is\s+spam|reporting\s+(?:you|this)\s+(?:as\s+)?spam|marked\s+(?:you|this)\s+as\s+spam)\b/i },

  // ---- OUT_OF_OFFICE ----
  { id: 'ooo-phrase', label: 'OUT_OF_OFFICE', weight: 0.9, re: /\b(?:out\s+of\s+(?:the\s+)?office|away\s+from\s+(?:my|the)\s+(?:desk|office|e-?mail)|ooo)\b/i },
  { id: 'ooo-autoreply', label: 'OUT_OF_OFFICE', weight: 0.9, re: /\b(?:auto[-\s]?reply|automatic\s+reply|automated\s+(?:reply|response|message)|auto[-\s]?response)\b/i },
  { id: 'ooo-on-leave', label: 'OUT_OF_OFFICE', weight: 0.85, re: /\b(?:on|am\s+on|currently\s+on)\s+(?:vacation|holiday|leave|annual\s+leave|parental\s+leave|maternity\s+leave|paternity\s+leave|sabbatical|pto|a\s+business\s+trip)\b/i },
  { id: 'ooo-will-be-away', label: 'OUT_OF_OFFICE', weight: 0.75, re: /\b(?:will\s+be|i'?ll\s+be|i\s+am|i'?m)\s+(?:currently\s+)?(?:out|away|travell?ing|unavailable|off)\b/i },
  { id: 'ooo-return', label: 'OUT_OF_OFFICE', weight: 0.8, re: new RegExp(`\\b(?:(?:i'?ll|i\\s+will|will|i'?m|i\\s+am|am)\\s+(?:be\\s+)?back|(?:be\\s+)?returning|return(?:ing)?\\s+to\\s+(?:the\\s+)?office|will\\s+return|back\\s+in\\s+the\\s+office)\\b[^.\\n]{0,40}(?:\\d|${WEEKDAYS}|${MONTHS})`, 'i') },
  { id: 'ooo-limited-email', label: 'OUT_OF_OFFICE', weight: 0.65, re: /\b(?:limited|no|intermittent)\s+(?:access\s+to\s+)?(?:e-?mail|email)\b/i },
  { id: 'ooo-respond-upon-return', label: 'OUT_OF_OFFICE', weight: 0.7, re: /\b(?:will|i'?ll|i\s+will)\s+(?:respond|reply|get\s+back)\b[^.\n]{0,40}\b(?:return|back|when\s+i)\b/i },
  { id: 'ooo-attending', label: 'OUT_OF_OFFICE', weight: 0.6, re: /\b(?:attending|at)\s+(?:a\s+)?(?:conference|trade\s+show|summit|training|offsite|retreat)\b/i },

  // ---- WRONG_PERSON ----
  { id: 'wp-wrong-person', label: 'WRONG_PERSON', weight: 0.9, re: /\b(?:wrong|incorrect)\s+(?:person|contact|address|e-?mail|recipient|department)\b/i },
  { id: 'wp-not-right-person', label: 'WRONG_PERSON', weight: 0.88, re: /\bnot\s+(?:the\s+)?(?:right|correct|best|appropriate)\s+(?:person|contact|one|point\s+of\s+contact)\b/i },
  { id: 'wp-left-company', label: 'WRONG_PERSON', weight: 0.9, re: /\b(?:left|leaving)\s+(?:the\s+)?(?:company|organi[sz]ation|firm|business)\b|\bno\s+longer\s+(?:with|at|works?\s+(?:at|for|here)|working\s+(?:at|for|here)|employed)\b|\b(?:has|have)\s+left\b|\b(?:retired|resigned)\b/i },
  { id: 'wp-refer-to', label: 'WRONG_PERSON', weight: 0.7, re: /\b(?:you\s+should|please|best\s+to|suggest\s+you|recommend\s+you|i'?d\s+(?:suggest|recommend))\s+(?:contact|reach\s+out\s+to|speak\s+(?:with|to)|talk\s+to|e-?mail|try)\b/i },
  { id: 'wp-not-my-area', label: 'WRONG_PERSON', weight: 0.8, re: /\b(?:not|isn'?t|is\s+not)\s+(?:in\s+)?(?:my|our)\s+(?:area|department|role|responsibility|remit|scope)\b|\b(?:doesn'?t|does\s+not)\s+(?:fall\s+under|belong\s+to)\s+(?:me|my)\b|\b(?:i'?m|i\s+am)\s+not\s+(?:responsible|in\s+charge|the\s+decision[-\s]?maker)\b/i },
  { id: 'wp-no-longer-handle', label: 'WRONG_PERSON', weight: 0.8, re: /\bno\s+longer\s+(?:handle|manage|oversee|own|in\s+charge\s+of|responsible\s+for)\b|\bnow\s+(?:handled|managed|owned)\s+by\b/i },
  { id: 'wp-should-go-to', label: 'WRONG_PERSON', weight: 0.8, re: /\b(?:this|that|it)\s+(?:should|needs\s+to|would\s+need\s+to)\s+(?:go|be\s+(?:sent|directed|forwarded))\s+to\b|\b(?:send|direct|route)\s+(?:this|it)\s+to\s+(?:our|the)\b/i },
  { id: 'wp-forwarded', label: 'WRONG_PERSON', weight: 0.6, re: /\bforward(?:ed|ing)?\s+(?:this|your|it|the\s+e-?mail|that)\s+to\b|\bi'?ve\s+(?:cc'?d|looped\s+in|copied)\b|\blooping\s+in\b/i },

  // ---- NOT_NOW ----
  { id: 'nn-not-now', label: 'NOT_NOW', weight: 0.85, re: /\bnot\s+(?:right\s+now|at\s+the\s+moment|at\s+this\s+time|a\s+priority(?:\s+right\s+now)?|the\s+(?:right|best)\s+(?:time|moment)|a\s+good\s+(?:time|moment)|currently)\b|\bnot\s+yet\b|\bbad\s+timing\b|\btiming\s+(?:isn'?t|is\s+not)\b/i },
  { id: 'nn-circle-back', label: 'NOT_NOW', weight: 0.85, re: new RegExp(`\\b(?:circle\\s+back|check\\s+(?:back|in)|follow\\s+up|reach\\s+out(?:\\s+again)?|touch\\s+base|revisit|reconnect|ping\\s+me|contact\\s+me(?:\\s+again)?|e-?mail\\s+me(?:\\s+again)?|talk|get\\s+back\\s+to\\s+me|come\\s+back)\\b[^.!?\\n]{0,40}\\b(?:later|next\\s+(?:week|month|quarter|year)|in\\s+(?:\\d+|a|an|one|two|three|four|five|six|few|couple(?:\\s+of)?)\\s+(?:day|week|month|quarter)s?|after\\s+(?:the\\s+)?(?:new\\s+year|holidays?|summer|q[1-4])|q[1-4]|in\\s+${MONTHS}|(?:early|late|mid)[-\\s]${MONTHS})`, 'i') },
  { id: 'nn-try-again', label: 'NOT_NOW', weight: 0.8, re: /\b(?:try\s+(?:me\s+)?again|ask\s+me\s+again|check\s+in\s+again|(?:talk|speak)\s+again)\b[^.!?\n]{0,30}\b(?:in|after|next|later)\b/i },
  { id: 'nn-until', label: 'NOT_NOW', weight: 0.7, re: new RegExp(`\\b(?:until|till|through)\\s+(?:next\\s+(?:week|month|quarter|year|${MONTHS})|q[1-4]|${MONTHS}|the\\s+(?:new\\s+year|summer|fall|spring|winter))\\b`, 'i') },
  { id: 'nn-then', label: 'NOT_NOW', weight: 0.75, re: /\b(?:reach\s+out|follow\s+up|circle\s+back|check\s+in|contact\s+me|talk)\s+(?:then|later|again)\b/i },
  { id: 'nn-busy', label: 'NOT_NOW', weight: 0.6, re: /\b(?:busy|swamped|slammed|tied\s+up|underwater|heads[-\s]down)\b/i },
  { id: 'nn-budget', label: 'NOT_NOW', weight: 0.7, re: /\b(?:budget|hiring|spending)\s+(?:freeze|is\s+frozen|has\s+been\s+frozen|cycle|planning|is\s+(?:exhausted|spent|maxed)|has\s+been\s+(?:spent|used))|\bbudget\b[^.\n]{0,30}\b(?:exhausted|spent|maxed)\b|\bnext\s+(?:year'?s\s+)?budget\b|\b(?:maybe|perhaps|possibly)\s+(?:next|later|in)\b/i },
  { id: 'nn-future', label: 'NOT_NOW', weight: 0.6, re: /\b(?:down\s+the\s+road|in\s+the\s+future|at\s+a\s+later\s+(?:date|time)|some\s+other\s+time)\b/i },

  // ---- NOT_INTERESTED ----
  { id: 'ni-not-interested', label: 'NOT_INTERESTED', weight: 0.92, re: /\bnot\s+(?:\w+\s+){0,2}interested\b|\bno\s+longer\s+interested\b|\buninterested\b/i },
  { id: 'ni-no-thanks', label: 'NOT_INTERESTED', weight: 0.9, re: /\bno,?\s+thanks?\b|\bno\s+thank\s+you\b|\bnot\s+for\s+us\b|\b(?:we'?ll|i'?ll)\s+pass\b|\bhard\s+pass\b/i },
  { id: 'ni-no-interest', label: 'NOT_INTERESTED', weight: 0.85, re: /\bno\s+(?:interest|use\s+for)\b|\bnot\s+something\s+(?:we|i)\b|\b(?:isn'?t|is\s+not)\s+something\s+(?:we|i)\b/i },
  { id: 'ni-in-house', label: 'NOT_INTERESTED', weight: 0.8, re: /\b(?:got|have|has)\s+(?:this|that|it)\s+(?:covered|handled)\b|\bin[-\s]house\b/i },
  { id: 'ni-bare-no', label: 'NOT_INTERESTED', weight: 0.85, re: /^[ \t]*(?:no|nope|nah)[ \t]*[.!]*[ \t]*$/im },
  { id: 'ni-dont-follow-up', label: 'NOT_INTERESTED', weight: 0.7, re: /\bdon'?t\s+follow\s+up\b/i },
  { id: 'ni-all-set', label: 'NOT_INTERESTED', weight: 0.8, re: /\b(?:we'?re|we\s+are|i'?m|i\s+am)\s+(?:all\s+set|good|covered|happy\s+with)\b/i },
  { id: 'ni-no-need', label: 'NOT_INTERESTED', weight: 0.8, re: /\bnot\s+(?:a\s+)?(?:fit|need|looking)\b|\bno\s+need\b|\b(?:don'?t|do\s+not)\s+(?:need|have\s+a\s+need)\b|\bnot\s+in\s+the\s+market\b/i },
  { id: 'ni-not-relevant', label: 'NOT_INTERESTED', weight: 0.85, re: /\b(?:isn'?t|is\s+not|not)\s+(?:really\s+|very\s+)?(?:relevant|applicable)\b/i },
  { id: 'ni-happy-with', label: 'NOT_INTERESTED', weight: 0.7, re: /\b(?:happy|satisfied|content)\s+with\s+(?:our|the|them|what|it|my)\b/i },
  { id: 'ni-already-have', label: 'NOT_INTERESTED', weight: 0.7, re: /\balready\s+(?:have|use|using|work\s+with|working\s+with|partnered\s+with)\b/i },

  // ---- INTERESTED (positive text only: explicit negations removed first) ----
  { id: 'int-interested', label: 'INTERESTED', on: 'positive', weight: 0.8, re: /\binterested\b/i },
  { id: 'int-tell-me-more', label: 'INTERESTED', on: 'positive', weight: 0.82, re: /\b(?:tell|show|walk)\s+me\s+more\b|\bmore\s+(?:info|information|details)\b|\bsend\s+(?:me\s+|over\s+)?(?:some\s+|more\s+|the\s+|your\s+|a\s+|an\s+)?(?:info|information|details|pricing|a\s+deck|the\s+deck|a\s+proposal|case\s+stud(?:y|ies)|examples|materials|a\s+quote|an?\s+overview)\b/i },
  { id: 'int-lets-talk', label: 'INTERESTED', on: 'positive', weight: 0.8, re: /\b(?:let'?s|lets|we\s+can|happy\s+to|glad\s+to|would\s+love\s+to|love\s+to|open\s+to|down\s+to|free\s+to)\s+(?:\w+\s+){0,2}(?:talk|chat|connect|meet|hop\s+on|jump\s+on|set\s+up|schedule|catch\s+up|discuss|speak|have\s+a\s+(?:call|chat|conversation))\b/i },
  { id: 'int-book-call', label: 'INTERESTED', on: 'positive', weight: 0.85, re: /\b(?:book|schedule|set\s+up|grab|find)\s+(?:a\s+|some\s+)?(?:call|time|meeting|demo|chat|slot)\b|\bsend\s+(?:over\s+)?(?:a\s+)?(?:calendar|invite|link|times|availability)\b|\bcalendly\b|\bmy\s+calendar\b|\bwhat\s+(?:times|days)\s+work\b/i },
  { id: 'int-sounds-good', label: 'INTERESTED', on: 'positive', weight: 0.55, re: /\b(?:sounds?\s+(?:good|great|interesting|promising)|looks?\s+(?:good|great|interesting)|this\s+(?:is\s+)?(?:interesting|relevant)|intriguing)\b/i },
  { id: 'int-pricing-demo', label: 'INTERESTED', on: 'positive', weight: 0.5, re: /\b(?:pricing|costs?|how\s+much|demo|trial|proposal|rates?)\b/i },
  { id: 'int-yes-start', label: 'INTERESTED', on: 'positive', weight: 0.55, re: /^[ \t]*(?:yes|yep|yeah|sure|absolutely|definitely)\b/im },
  { id: 'int-good-timing', label: 'INTERESTED', on: 'positive', weight: 0.7, re: /\b(?:good|great|perfect)\s+timing\b/i },
  { id: 'int-evaluating', label: 'INTERESTED', on: 'positive', weight: 0.7, re: /\b(?:we'?re|i'?m|we\s+are|i\s+am)\s+(?:actually\s+)?(?:looking|searching|evaluating|exploring)\b/i },
  { id: 'int-learn-more', label: 'INTERESTED', on: 'positive', weight: 0.8, re: /\b(?:love|like|want)\s+to\s+(?:learn|hear|know|see)\b|\blearn\s+more\b/i },
  { id: 'int-time-for-call', label: 'INTERESTED', on: 'positive', weight: 0.8, re: /\b(?:do\s+you\s+have\s+(?:time|a\s+few\s+minutes)|are\s+you\s+(?:free|available)|(?:can|could)\s+we\s+(?:schedule|talk|chat|meet|connect|jump|hop))\b/i },
  { id: 'int-how-works', label: 'INTERESTED', on: 'positive', weight: 0.7, re: /\bhow\s+(?:it|this|that)\s+works\b|\bwhat\s+(?:it|this)\s+costs?\b|\bshare\s+(?:a\s+bit\s+|a\s+little\s+)?more\b|\bwhat\s+does\s+(?:onboarding|setup|implementation)\b/i },
  { id: 'int-want-call', label: 'INTERESTED', on: 'positive', weight: 0.8, re: /\bwant\s+to\s+(?:do|have|hop|jump|set\s+up)\s+(?:a\s+|an\s+)?(?:\w+\s+)?(?:call|chat|meeting|demo)\b|\bcan\s+you\s+do\s+(?:\w+day|tomorrow|today|next\s+week)\b/i },
  { id: 'int-please-do', label: 'INTERESTED', on: 'positive', weight: 0.7, re: /\bplease\s+do\s+(?:follow|send|call|reach|e-?mail|get)\b/i },
];

// Phrases that negate "interested" so INTERESTED rules do not fire on them.
const NEGATION_RE = /\binterested\s+in\s+principle\b|\bnot\s+(?:\w+\s+){0,2}interested\b|\bno\s+longer\s+interested\b|\buninterested\b/gi;

// @build:strip-start
module.exports = { LABELS, MONTHS, WEEKDAYS, RULES, NEGATION_RE };
// @build:strip-end
