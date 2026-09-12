import { jwtVerify, SignJWT } from 'jose';

const COOKIE_NAME = '__Host-sxgo-pilot';
const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_FORM_BODY_BYTES = 2 * 1024;
const MAX_COOKIE_BYTES = 16 * 1024;
const PILOT_PURPOSE = 'sxgo-pilot';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Configuration for the application-level closed pilot gate. */
export interface PilotGateConfig {
  origin: string;
  cookieSecret: string;
  inviteTokensSha256: readonly string[];
}

interface NormalizedPilotGateConfig {
  origin: string;
  cookieSecret: string;
  inviteTokensSha256: readonly string[];
  issuer: string;
}

interface BodyReadResult {
  bytes: Uint8Array | null;
  oversized: boolean;
  malformedLength: boolean;
}

const securityHeaders = (contentType?: string): Headers => {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'none'; object-src 'none'; script-src 'none'; style-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
};

const pilotPage = (): string =>
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>受邀测试</title></head><body><main><h1>受邀测试</h1><p>请输入邀请代码继续。</p><form method="post" action="/pilot" autocomplete="off"><label for="code">邀请代码</label><input id="code" name="code" type="password" minlength="32" maxlength="2048" required autocomplete="off"><button type="submit">继续</button></form></main></body></html>';

const htmlResponse = (status: number): Response =>
  new Response(pilotPage(), {
    status,
    headers: securityHeaders('text/html; charset=utf-8'),
  });

const jsonResponse = (status: number, code: string): Response =>
  new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: securityHeaders('application/json; charset=utf-8'),
  });

const serviceNotConfigured = (): Response => jsonResponse(503, 'SERVICE_NOT_CONFIGURED');

function normalizeConfig(
  config: PilotGateConfig | null | undefined,
): NormalizedPilotGateConfig | null {
  if (!config || typeof config !== 'object') return null;

  const candidate = config as Partial<PilotGateConfig>;
  if (typeof candidate.origin !== 'string' || typeof candidate.cookieSecret !== 'string')
    return null;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(candidate.origin);
  } catch {
    return null;
  }
  if (
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.search ||
    parsedOrigin.hash
  )
    return null;

  if (candidate.cookieSecret.length < 32) return null;
  if (!Array.isArray(candidate.inviteTokensSha256) || candidate.inviteTokensSha256.length === 0)
    return null;
  if (
    !candidate.inviteTokensSha256.every(
      (hash): hash is string => typeof hash === 'string' && SHA256_HEX.test(hash),
    )
  )
    return null;

  return {
    origin: parsedOrigin.origin,
    cookieSecret: candidate.cookieSecret,
    inviteTokensSha256: candidate.inviteTokensSha256,
    issuer: `${PILOT_PURPOSE}:${parsedOrigin.origin}`,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    difference |= leftCode ^ rightCode;
  }
  return difference === 0;
}

function matchesCurrentInviteHash(hash: string, configured: readonly string[]): boolean {
  let matched = false;
  for (const candidate of configured) {
    // Evaluate every configured hash so the matching position does not alter the loop length.
    const equal = constantTimeEqual(hash, candidate);
    matched = matched || equal;
  }
  return matched;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedBody(request: Request): Promise<BodyReadResult> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const normalizedLength = contentLength.trim();
    if (!/^\d+$/.test(normalizedLength))
      return { bytes: null, oversized: false, malformedLength: true };
    const declaredLength = Number(normalizedLength);
    if (!Number.isSafeInteger(declaredLength))
      return { bytes: null, oversized: true, malformedLength: false };
    if (declaredLength > MAX_FORM_BODY_BYTES)
      return { bytes: null, oversized: true, malformedLength: false };
  }

  if (!request.body) return { bytes: new Uint8Array(), oversized: false, malformedLength: false };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FORM_BODY_BYTES) {
        await reader.cancel();
        return { bytes: null, oversized: true, malformedLength: false };
      }
      chunks.push(value);
    }
  } catch {
    return { bytes: null, oversized: false, malformedLength: true };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, oversized: false, malformedLength: false };
}

function isFormUrlEncoded(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  if (!contentType) return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get('Origin') === origin;
}

function getCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    if (trimmed.slice(0, separator).trim() === COOKIE_NAME)
      return trimmed.slice(separator + 1).trim();
  }
  return null;
}

function isApiRequest(request: Request, url: URL): boolean {
  const path = url.pathname;
  if (
    path === '/health' ||
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path.startsWith('/private/v1/') ||
    path.startsWith('/admin/v1/')
  )
    return true;
  return request.headers.get('Accept')?.toLowerCase().includes('application/json') ?? false;
}

function cookieHeader(value: string, maxAge: number): string {
  const expires = maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}${expires}; HttpOnly; Secure; SameSite=Strict`;
}

function issuerFor(config: NormalizedPilotGateConfig): string {
  return config.issuer;
}

async function validPilotCookie(
  value: string | null,
  config: NormalizedPilotGateConfig,
): Promise<boolean> {
  if (!value || value.length > MAX_COOKIE_BYTES) return false;
  try {
    const { payload } = await jwtVerify(value, new TextEncoder().encode(config.cookieSecret), {
      algorithms: ['HS256'],
      audience: config.origin,
      issuer: issuerFor(config),
      maxTokenAge: `${COOKIE_MAX_AGE_SECONDS}s`,
      requiredClaims: ['exp', 'iat', 'iss', 'aud', 'purpose', 'token_hash'],
      typ: 'JWT',
    });
    if (payload.purpose !== PILOT_PURPOSE || typeof payload.token_hash !== 'string') return false;
    if (!SHA256_HEX.test(payload.token_hash)) return false;
    return matchesCurrentInviteHash(payload.token_hash, config.inviteTokensSha256);
  } catch {
    return false;
  }
}

async function issuePilotCookie(config: NormalizedPilotGateConfig, hash: string): Promise<string> {
  return await new SignJWT({ purpose: PILOT_PURPOSE, token_hash: hash })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuerFor(config))
    .setAudience(config.origin)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_MAX_AGE_SECONDS}s`)
    .sign(new TextEncoder().encode(config.cookieSecret));
}

function redirectResponse(location: string, setCookie?: string): Response {
  const headers = securityHeaders();
  headers.set('Location', location);
  if (setCookie) headers.set('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Apply the closed pilot gate before the application router.
 *
 * A null result permits the request to continue to the downstream application.
 */
export async function pilotGate(
  request: Request,
  config: PilotGateConfig,
): Promise<Response | null> {
  const normalized = normalizeConfig(config);
  if (!normalized) return serviceNotConfigured();

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return serviceNotConfigured();
  }
  if (requestUrl.origin !== normalized.origin) return jsonResponse(403, 'PILOT_ORIGIN_REJECTED');

  if (requestUrl.pathname === '/pilot') {
    if (request.method === 'GET') return htmlResponse(200);
    if (request.method !== 'POST') return jsonResponse(405, 'METHOD_NOT_ALLOWED');
    if (!sameOrigin(request, normalized.origin)) return htmlResponse(403);
    if (!isFormUrlEncoded(request)) return jsonResponse(415, 'UNSUPPORTED_MEDIA_TYPE');

    const body = await readBoundedBody(request);
    if (body.oversized) return jsonResponse(413, 'REQUEST_BODY_TOO_LARGE');
    if (body.malformedLength || !body.bytes) return jsonResponse(400, 'INVALID_REQUEST');

    const form = new URLSearchParams(new TextDecoder().decode(body.bytes));
    const code = form.get('code');
    if (!code || code.length < 32) return htmlResponse(403);
    const hash = await sha256Hex(code);
    if (!matchesCurrentInviteHash(hash, normalized.inviteTokensSha256)) return htmlResponse(403);

    const token = await issuePilotCookie(normalized, hash);
    return redirectResponse(
      new URL('/companies', normalized.origin).href,
      cookieHeader(token, COOKIE_MAX_AGE_SECONDS),
    );
  }

  if (requestUrl.pathname === '/pilot/logout') {
    if (request.method !== 'POST') return jsonResponse(405, 'METHOD_NOT_ALLOWED');
    if (!sameOrigin(request, normalized.origin)) return htmlResponse(403);
    return redirectResponse(new URL('/pilot', normalized.origin).href, cookieHeader('', 0));
  }

  if (await validPilotCookie(getCookie(request), normalized)) return null;
  return isApiRequest(request, requestUrl)
    ? jsonResponse(403, 'PILOT_INVITE_REQUIRED')
    : htmlResponse(403);
}
