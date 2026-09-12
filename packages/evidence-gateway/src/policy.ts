import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { publicAddress } from '../../link-checker/src/index';
import type { SourcePolicy } from './types';

export type SourcePolicyState =
  | 'blocked'
  | 'needs_manual_triage'
  | 'fetchable_under_policy';

export type SourceURLAssessment = Readonly<{
  state: SourcePolicyState;
  code: string;
  url?: URL;
  domain?: string;
}>;

const sensitiveQueryKey = /^(?:token|receipt|password|secret|auth|access_token|code|key)$/i;

export function normalizeDomain(value: string) {
  return value.replace(/^\.+|\.+$/g, '').toLowerCase();
}

export function domainAllowed(hostname: string, allowedDomains: readonly string[]) {
  const host = normalizeDomain(hostname);
  return allowedDomains.some((candidate) => {
    const domain = normalizeDomain(candidate);
    return !!domain && (host === domain || host.endsWith('.' + domain));
  });
}

/**
 * URL policy is evaluated before any DNS lookup or network request.  An
 * unapproved domain is a manual-triage result rather than an invitation to
 * probe the domain.  This schema is intentionally separate from the
 * product-link schema: Evidence Gateway P0 permits HTTP/HTTPS on 80/443,
 * while outbound purchase links remain HTTPS-only elsewhere.
 */
export function assessSourceURL(raw: string, policy: SourcePolicy): SourceURLAssessment {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048)
    return { state: 'blocked', code: 'INVALID_URL' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { state: 'blocked', code: 'INVALID_URL' };
  }
  const protocol = url.protocol.slice(0, -1) as 'http' | 'https';
  if (!policy.allowed_protocols.includes(protocol))
    return { state: 'blocked', code: 'PROTOCOL_REJECTED' };
  if (url.username || url.password) return { state: 'needs_manual_triage', code: 'CREDENTIAL_IN_URL' };
  if (url.hash) return { state: 'needs_manual_triage', code: 'FRAGMENT_REJECTED' };
  const port = Number(url.port || (protocol === 'https' ? 443 : 80));
  if (!policy.allowed_ports.includes(port)) return { state: 'blocked', code: 'PORT_REJECTED' };
  const hostname = normalizeDomain(url.hostname.replace(/^\[|\]$/g, ''));
  if (!hostname) return { state: 'blocked', code: 'HOST_REJECTED' };
  if (ipaddr.isValid(hostname)) return { state: 'blocked', code: 'IP_LITERAL_REJECTED' };
  if ([...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key)))
    return { state: 'needs_manual_triage', code: 'CREDENTIAL_IN_URL' };
  if (!domainAllowed(hostname, policy.allowed_domains)) {
    return {
      state: policy.unknown_domain_auto_fetch_enabled
        ? 'fetchable_under_policy'
        : 'needs_manual_triage',
      code: 'DOMAIN_NOT_ALLOWED',
      url,
      domain: hostname,
    };
  }
  return { state: 'fetchable_under_policy', code: 'ALLOWED', url, domain: hostname };
}

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type AddressResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ResolvedAddress[]>;

export async function resolvePublicAddresses(
  hostname: string,
  resolver: AddressResolver = dnsLookup as AddressResolver,
) {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('DNS_RESOLUTION_FAILED');
  if (!addresses.every((entry) => publicAddress(entry.address))) throw new Error('SSRF_BLOCKED');
  return addresses;
}

