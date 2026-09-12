import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pilotGate, type PilotGateConfig } from '../apps/cloudflare/src/pilot-gate';

const ORIGIN = 'https://pilot.example.test';
const SECRET = 'pilot-cookie-secret-used-only-by-this-test-123456';
const INVITE_CODE = 'pilot-invite-code-with-more-than-32-characters-123456';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const INVITE_HASH = sha256Hex(INVITE_CODE);

function config(overrides: Partial<PilotGateConfig> = {}): PilotGateConfig {
  return {
    origin: ORIGIN,
    cookieSecret: SECRET,
    inviteTokensSha256: [INVITE_HASH],
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function pilotPost(body: string, headers: Record<string, string> = {}): Request {
  return request('/pilot', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body,
  });
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';', 1)[0];
}

function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

async function issuedCookie(
  gateConfig = config(),
): Promise<{ response: Response; cookie: string }> {
  const response = await pilotGate(
    pilotPost(`code=${encodeURIComponent(INVITE_CODE)}`),
    gateConfig,
  );
  expect(response).not.toBeNull();
  return { response: response!, cookie: cookiePair(response!) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pilotGate', () => {
  it('renders a query-independent invitation form and issues a signed secure cookie', async () => {
    const page = await pilotGate(request('/pilot?code=secret-should-not-be-used'), config());
    expect(page?.status).toBe(200);
    const pageBody = await page!.text();
    expect(pageBody).toContain('请输入邀请代码继续');
    expect(pageBody).not.toContain('secret-should-not-be-used');
    expect(page!.headers.get('content-security-policy')).toContain("default-src 'none'");

    const { response, cookie } = await issuedCookie();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/companies`);
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('__Host-sxgo-pilot=');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=28800');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Domain=');

    const verified = await jwtVerify(cookieValue(cookie), new TextEncoder().encode(SECRET), {
      algorithms: ['HS256'],
      issuer: `sxgo-pilot:${ORIGIN}`,
      audience: ORIGIN,
    });
    expect(verified.payload.purpose).toBe('sxgo-pilot');
    expect(verified.payload.token_hash).toBe(INVITE_HASH);
  });

  it('allows a valid cookie and rejects a forged cookie', async () => {
    const { cookie } = await issuedCookie();
    const allowed = await pilotGate(
      request('/companies', { headers: { Cookie: cookie } }),
      config(),
    );
    expect(allowed).toBeNull();

    const token = cookieValue(cookie);
    const first = token[0] === 'a' ? 'b' : 'a';
    const forged = `${first}${token.slice(1)}`;
    const rejected = await pilotGate(
      request('/companies', { headers: { Cookie: `__Host-sxgo-pilot=${forged}` } }),
      config(),
    );
    expect(rejected?.status).toBe(403);
  });

  it('expires the pilot cookie after eight hours', async () => {
    const issuedAt = new Date('2026-09-12T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(issuedAt);
    const { cookie } = await issuedCookie();

    vi.setSystemTime(new Date(issuedAt.getTime() + 8 * 60 * 60 * 1000 + 1));
    const expired = await pilotGate(
      request('/companies', { headers: { Cookie: cookie } }),
      config(),
    );
    expect(expired?.status).toBe(403);
  });

  it('revokes a previously issued cookie when its invite hash leaves the current list', async () => {
    const { cookie } = await issuedCookie();
    const replacementHash = sha256Hex('replacement-invite-code-with-more-than-32-characters-123');
    const revoked = await pilotGate(
      request('/companies', { headers: { Cookie: cookie } }),
      config({ inviteTokensSha256: [replacementHash] }),
    );
    expect(revoked?.status).toBe(403);
  });

  it('checks the configured origin on enrollment and logout', async () => {
    const wrongOrigin = await pilotGate(
      pilotPost(`code=${encodeURIComponent(INVITE_CODE)}`, {
        Origin: 'https://attacker.example.test',
      }),
      config(),
    );
    expect(wrongOrigin?.status).toBe(403);

    const { cookie } = await issuedCookie();
    const wrongLogout = await pilotGate(
      request('/pilot/logout', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example.test', Cookie: cookie },
      }),
      config(),
    );
    expect(wrongLogout?.status).toBe(403);

    const logout = await pilotGate(
      request('/pilot/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie } }),
      config(),
    );
    expect(logout?.status).toBe(303);
    expect(logout!.headers.get('location')).toBe(`${ORIGIN}/pilot`);
    expect(logout!.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects non-form requests and bodies over 2 KiB without reading credentials into logs', async () => {
    const wrongContentType = await pilotGate(
      request('/pilot', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: INVITE_CODE }),
      }),
      config(),
    );
    expect(wrongContentType?.status).toBe(415);

    const oversized = await pilotGate(pilotPost(`code=${'x'.repeat(2048)}`), config());
    expect(oversized?.status).toBe(413);
    expect(oversized!.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed when required configuration is missing or invalid', async () => {
    const missing = await pilotGate(request('/pilot'), undefined as unknown as PilotGateConfig);
    expect(missing?.status).toBe(503);

    const shortSecret = await pilotGate(request('/pilot'), config({ cookieSecret: 'too-short' }));
    expect(shortSecret?.status).toBe(503);

    const invalidHash = await pilotGate(
      request('/pilot'),
      config({ inviteTokensSha256: ['not-a-sha256'] }),
    );
    expect(invalidHash?.status).toBe(503);
  });

  it('returns JSON for API denials and HTML for browser denials', async () => {
    const api = await pilotGate(
      request('/private/v1/companies', { headers: { Accept: 'application/json' } }),
      config(),
    );
    expect(api?.status).toBe(403);
    expect(api!.headers.get('content-type')).toContain('application/json');
    expect(await api!.json()).toEqual({ error: { code: 'PILOT_INVITE_REQUIRED' } });

    const browser = await pilotGate(request('/companies'), config());
    expect(browser?.status).toBe(403);
    expect(browser!.headers.get('content-type')).toContain('text/html');
    expect(await browser!.text()).toContain('<form');
  });
});
