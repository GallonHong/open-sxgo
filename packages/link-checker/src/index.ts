import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { httpsURL } from '../../protocol/src/public';
import { assert } from '../../domain/src/index';
export function publicAddress(address: string) {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
      return (parsed as ipaddr.IPv6).toIPv4Address().range() === 'unicast';
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolveTarget(raw: string, resolver = lookup) {
  const url = new URL(httpsURL.parse(raw));
  assert(!url.port || url.port === '443', 'PORT_REJECTED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4 }]
    : await resolver(host, { all: true, verbatim: true });
  assert(addresses.length && addresses.every((a) => publicAddress(a.address)), 'SSRF_BLOCKED');
  return { url, address: addresses[0] };
}
export async function checkLink(raw: string) {
  const deadline = Date.now() + 10000;
  let current = raw;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const remaining = Math.max(1, deadline - Date.now());
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const { url, address } = await Promise.race([
      resolveTarget(current),
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(Error('LINK_TIMEOUT')), remaining);
      }),
    ]).finally(() => clearTimeout(deadlineTimer));
    assert(Date.now() < deadline, 'LINK_TIMEOUT');
    const result = await new Promise<{ status: number; location?: string; bytes: number }>(
      (resolve, reject) => {
        // Connect to the verified IP, preserving the original TLS identity. No second DNS lookup.
        const req = request(
          {
            hostname: address.address,
            family: address.family,
            servername: url.hostname.replace(/^\[|\]$/g, ''),
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
              Host: url.host,
              'User-Agent': 'WFD-Link-Check/1.0',
              'Accept-Encoding': 'identity',
            },
            checkServerIdentity: (_host, cert) =>
              checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ''), cert),
            agent: false,
          },
          (res) => {
            let bytes = 0;
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
              res.destroy();
              reject(Error('COMPRESSED_RESPONSE_REJECTED'));
              return;
            }
            if (Number(res.headers['content-length'] ?? 0) > 2 * 1024 * 1024) {
              res.destroy();
              reject(Error('RESPONSE_TOO_LARGE'));
              return;
            }
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 2 * 1024 * 1024) {
                res.destroy();
                reject(Error('RESPONSE_TOO_LARGE'));
              }
            });
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, location: res.headers.location, bytes }),
            );
            res.on('error', reject);
          },
        );
        const timer = setTimeout(
          () => req.destroy(Error('LINK_TIMEOUT')),
          Math.max(1, deadline - Date.now()),
        );
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
        req.end();
      },
    );
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      assert(result.location && redirect < 3, 'REDIRECT_LIMIT');
      current = new URL(result.location, current).href;
      continue;
    }
    return {
      url: current,
      status: result.status,
      state: [401, 403, 429].includes(result.status)
        ? 'manual_review'
        : result.status >= 200 && result.status < 300
          ? 'reachable'
          : 'broken',
      checked_at: new Date().toISOString(),
      bytes: result.bytes,
    };
  }
  throw Error('REDIRECT_LIMIT');
}
