import { DomainError } from '../../domain/src/index';
import type { SourcePolicy } from './types';

const blockedElements =
  /<(?:script|style|iframe|object|embed|svg|canvas|noscript|template|form|video|audio)\b[^>]*>[\s\S]*?(?:<\/(?:script|style|iframe|object|embed|svg|canvas|noscript|template|form|video|audio)\s*>|$)/gi;
const lineBreakElements = /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/header|\/footer|\/tr)\s*\/?>/gi;
const tag = /<[^>]*>/g;

const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntity(value: string) {
  if (value in namedEntities) return namedEntities[value];
  if (value.startsWith('#x')) {
    const code = Number.parseInt(value.slice(2), 16);
    return Number.isSafeInteger(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : '';
  }
  if (value.startsWith('#')) {
    const code = Number.parseInt(value.slice(1), 10);
    return Number.isSafeInteger(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : '';
  }
  return '&' + value + ';';
}

function decodeEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (_, entity: string) =>
    decodeEntity(entity.toLowerCase()),
  );
}

function normalizeText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type StaticBody = Readonly<{
  content_type: string;
  body: Uint8Array;
  final_url: string;
  redirect_count: number;
  policy: SourcePolicy;
}>;

export type SanitizedBody = Readonly<{
  text: string;
  final_url: string;
  redirect_count: number;
  checks: {
    public_destination_enforced: true;
    network_egress_policy_enforced: true;
    login_required: false;
    download_attempted: false;
    output_sanitized: true;
  };
}>;

function mediaType(value: string) {
  return value.split(';', 1)[0].trim().toLowerCase();
}

/**
 * Convert static text/HTML into a text-only reviewer artifact.  No source
 * markup is retained and no source URL survives in the returned body.
 */
export function sanitizeStaticBody(input: StaticBody): SanitizedBody {
  const type = mediaType(input.content_type);
  if (!['text/html', 'text/plain', 'application/json'].includes(type))
    throw new DomainError('UNSUPPORTED_CONTENT_TYPE', 422);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(input.body);
  let text = decoded;
  if (type === 'text/html') {
    text = text
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(blockedElements, '\n')
      .replace(lineBreakElements, '\n')
      .replace(tag, ' ');
  }
  text = normalizeText(decodeEntities(text));
  if (!text) throw new DomainError('EMPTY_SANITIZED_PREVIEW', 422);
  if (text.length > input.policy.max_output_characters)
    throw new DomainError('OUTPUT_TOO_LARGE', 413);
  if (/<(?:script|iframe|svg|object|embed)\b/i.test(text))
    throw new DomainError('UNSAFE_OUTPUT', 422);
  return {
    text,
    final_url: input.final_url,
    redirect_count: input.redirect_count,
    checks: {
      public_destination_enforced: true,
      network_egress_policy_enforced: true,
      login_required: false,
      download_attempted: false,
      output_sanitized: true,
    },
  };
}

