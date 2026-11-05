import { INGEST_MAX_STRING_LENGTH, type RedactionSettings } from '@tracemind/shared';

/**
 * Masks secrets and personal data in telemetry before it leaves the request handler, so raw values
 * never reach Redis or PostgreSQL. Pure and synchronous; every pattern is linear-time (bounded
 * quantifiers, no nested repetition) and inputs are capped in length before matching.
 */

interface Detector {
  name: string;
  pattern: RegExp;
  /** Optional post-filter to cut false positives (e.g. Luhn for card numbers). */
  accept?: (match: string) => boolean;
  replacement?: (match: string) => string;
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const SECRET_DETECTORS: Detector[] = [
  {
    name: 'private_key',
    pattern:
      /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{1,10000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g,
  },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,200}/g },
  { name: 'openai_key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,200}/g },
  { name: 'tracemind_key', pattern: /\btm_(?:dev|stg|prod)_[A-Za-z0-9_-]{32}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,200}/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,4000}/g,
  },
  {
    name: 'bearer_token',
    pattern: /\bBearer\s{1,5}[A-Za-z0-9._~+/-]{16,4000}=*/gi,
    replacement: () => 'Bearer [REDACTED:bearer_token]',
  },
  { name: 'card_number', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, accept: luhnValid },
];

const EMAIL_DETECTOR: Detector = {
  name: 'email',
  pattern:
    /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
};

const PHONE_DETECTOR: Detector = {
  name: 'phone',
  // International or local numbers with at least 10 digits, allowing common separators.
  pattern: /(?<![\w+])\+?\d{1,3}?[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,5}[ .-]?\d{4}\b/g,
  accept: (match) => match.replace(/\D/g, '').length >= 10,
};

/** Object keys whose values are always masked, regardless of content. */
const SENSITIVE_KEY =
  /^(?:password|passwd|pwd|secret|client_secret|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|authorization|cookie|set-cookie|private[-_]?key|x-api-key|x-tracemind-key)$/i;

const MAX_DEPTH = 32;
const MAX_ARRAY_ITEMS = 2000;

export interface RedactionResult<T> {
  value: T;
  /** Number of masked occurrences, by detector name. */
  counts: Record<string, number>;
}

export class Redactor {
  private readonly detectors: Detector[];
  private readonly literals: string[];

  constructor(private readonly settings: RedactionSettings) {
    this.detectors = settings.enabled
      ? [
          ...SECRET_DETECTORS,
          ...(settings.maskEmails ? [EMAIL_DETECTOR] : []),
          ...(settings.maskPhoneNumbers ? [PHONE_DETECTOR] : []),
        ]
      : [];
    // Longest first so overlapping literals mask the larger match.
    this.literals = [...settings.literals].sort((a, b) => b.length - a.length);
  }

  redact<T>(value: T): RedactionResult<T> {
    const counts: Record<string, number> = {};
    const result = this.visit(value, 0, counts) as T;
    return { value: result, counts };
  }

  /** Redacts a single string (also applies the length cap). */
  redactString(input: string, counts: Record<string, number> = {}): string {
    let text = input;
    let truncatedBy = 0;
    if (text.length > INGEST_MAX_STRING_LENGTH) {
      truncatedBy = text.length - INGEST_MAX_STRING_LENGTH;
      text = text.slice(0, INGEST_MAX_STRING_LENGTH);
    }

    for (const literal of this.literals) {
      if (text.includes(literal)) {
        const parts = text.split(literal);
        counts.literal = (counts.literal ?? 0) + parts.length - 1;
        text = parts.join('[REDACTED:literal]');
      }
    }

    for (const detector of this.detectors) {
      detector.pattern.lastIndex = 0;
      text = text.replace(detector.pattern, (match) => {
        if (detector.accept && !detector.accept(match)) return match;
        counts[detector.name] = (counts[detector.name] ?? 0) + 1;
        return detector.replacement ? detector.replacement(match) : `[REDACTED:${detector.name}]`;
      });
    }

    return truncatedBy > 0 ? `${text}…[truncated ${truncatedBy} chars]` : text;
  }

  private visit(value: unknown, depth: number, counts: Record<string, number>): unknown {
    if (typeof value === 'string') return this.redactString(value, counts);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[truncated: max depth]';

    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => this.visit(item, depth + 1, counts));
      if (value.length > MAX_ARRAY_ITEMS)
        items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
      return items;
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        this.settings.enabled &&
        SENSITIVE_KEY.test(key) &&
        child !== null &&
        child !== undefined &&
        child !== ''
      ) {
        counts.sensitive_key = (counts.sensitive_key ?? 0) + 1;
        output[key] = '[REDACTED:sensitive_key]';
      } else {
        output[key] = this.visit(child, depth + 1, counts);
      }
    }
    return output;
  }
}
