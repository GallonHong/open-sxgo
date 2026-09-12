import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { RequestOptions } from 'node:http';
import { assessSourceURL, resolvePublicAddresses, type AddressResolver } from './policy';
import { sanitizeStaticBody } from './sanitize';
import type {
  ProcessorResult,
  ProcessorTask,
  SourcePolicy,
  SourceProcessor,
} from './types';
import { DomainError } from '../../domain/src/index';

type HeaderMap = Record<string, string | undefined>;
type RequestResponse = Readonly<{
  status: number;
  headers: HeaderMap;
  body: Uint8Array;
}>;

type Target = Readonly<{ url: string; policy: SourcePolicy }>;
export type TaskTargetResolver = (task: ProcessorTask) => Promise<Target>;
export type ProcessorRuntimeAttestation = Readonly<{
  isolation_attested: boolean;
  network_egress_policy_enforced: boolean;
}>;

type RequestDependencies = Readonly<{
  resolve: AddressResolver;
}>;

const asHeader = (headers: IncomingHttpHeaders, key: string) => {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
};

const mediaType = (value: string | undefined) =>
  (value ?? '').split(';', 1)[0].trim().toLowerCase();

const allowedStaticMedia = new Set(['text/html', 'text/plain', 'application/json']);

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return error instanceof Error && error.message ? error.message : 'NETWORK_ERROR';
}

function isRetryableNetworkError(code: string) {
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'NETWORK_ERROR'].includes(code);
}

function requestAtAddress(
  url: URL,
  address: { address: string; family: 4 | 6 },
  policy: SourcePolicy,
  deadline: number,
  network: { used: number; requests: number },
) {
  if (Date.now() >= deadline) return Promise.reject(new Error('FETCH_TIMEOUT'));
  network.requests += 1;
  if (network.requests > policy.max_network_requests)
    return Promise.reject(new Error('RESOURCE_LIMIT_EXCEEDED'));
  const remaining = Math.max(1, deadline - Date.now());
  const isHttps = url.protocol === 'https:';
  const request = isHttps ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    hostname: address.address,
    family: address.family,
    port: Number(url.port || (isHttps ? 443 : 80)),
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      Host: url.host,
      'User-Agent': 'WFD-Evidence-Gateway/1.0',
      Accept: 'text/html,text/plain,application/json;q=0.9',
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-store',
    },
    agent: false,
    ...(isHttps
      ? {
          servername: url.hostname.replace(/^\[|\]$/g, ''),
          rejectUnauthorized: true,
          checkServerIdentity: (_host: string, certificate: PeerCertificate) =>
            checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ''), certificate),
        }
      : {}),
  };
  return new Promise<RequestResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : Error('NETWORK_ERROR'));
    };
    const req = request(options, (res) => {
      const headers: HeaderMap = {
        'content-length': asHeader(res.headers, 'content-length'),
        'content-type': asHeader(res.headers, 'content-type'),
        'content-encoding': asHeader(res.headers, 'content-encoding'),
        location: asHeader(res.headers, 'location'),
      };
      const encoding = headers['content-encoding'];
      if (encoding && encoding !== 'identity') {
        res.destroy();
        fail(Error('COMPRESSED_RESPONSE_REJECTED'));
        return;
      }
      const contentLength = Number(headers['content-length'] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > policy.max_response_bytes) {
        res.destroy();
        fail(Error('RESPONSE_TOO_LARGE'));
        return;
      }
      const redirect = [301, 302, 303, 307, 308].includes(res.statusCode ?? 0);
      if (!redirect && res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        if (!allowedStaticMedia.has(mediaType(headers['content-type']))) {
          res.destroy();
          fail(Error('UNSUPPORTED_CONTENT_TYPE'));
          return;
        }
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const size = Buffer.byteLength(chunk);
        bytes += size;
        network.used += size;
        if (bytes > policy.max_response_bytes) {
          res.destroy();
          fail(Error('RESPONSE_TOO_LARGE'));
          return;
        }
        if (network.used > policy.max_task_network_bytes) {
          res.destroy();
          fail(Error('RESOURCE_LIMIT_EXCEEDED'));
          return;
        }
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks, bytes);
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      fail(Error('FETCH_TIMEOUT'));
    }, remaining);
    req.once('close', () => clearTimeout(timer));
    req.once('error', (error) => fail(error instanceof Error ? error : Error('NETWORK_ERROR')));
    req.end();
  });
}

async function fetchStatic(
  raw: string,
  policy: SourcePolicy,
  dependencies: RequestDependencies,
): Promise<ProcessorResult> {
  const first = assessSourceURL(raw, policy);
  if (first.state !== 'fetchable_under_policy')
    return { outcome: first.state, error_code: first.code };
  const deadline = Date.now() + policy.max_task_seconds * 1000;
  const network = { used: 0, requests: 0 };
  let retries = 0;
  let current = first.url!;
  let redirects = 0;
  while (true) {
    if (Date.now() >= deadline) return { outcome: 'failed', error_code: 'FETCH_TIMEOUT' };
    let addresses;
    try {
      addresses = await resolvePublicAddresses(current.hostname, dependencies.resolve);
    } catch (error) {
      const code = errorCode(error);
      return { outcome: code === 'SSRF_BLOCKED' ? 'blocked' : 'failed', error_code: code };
    }
    let response: RequestResponse;
    try {
      response = await requestAtAddress(current, addresses[0], policy, deadline, network);
    } catch (error) {
      const code = errorCode(error);
      if (retries < policy.max_retries && isRetryableNetworkError(code) && Date.now() < deadline) {
        retries += 1;
        continue;
      }
      const state =
        code === 'SSRF_BLOCKED' || code === 'COMPRESSED_RESPONSE_REJECTED'
          ? 'blocked'
          : code === 'UNSUPPORTED_CONTENT_TYPE' || code === 'RESPONSE_TOO_LARGE'
            ? 'needs_manual_triage'
            : 'failed';
      return { outcome: state, error_code: code, redirect_count: redirects };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location || redirects >= policy.max_redirects)
        return { outcome: 'needs_manual_triage', error_code: 'REDIRECT_LIMIT', redirect_count: redirects };
      let next: string;
      try {
        next = new URL(response.headers.location, current).href;
      } catch {
        return { outcome: 'needs_manual_triage', error_code: 'INVALID_REDIRECT', redirect_count: redirects };
      }
      const assessed = assessSourceURL(next, policy);
      if (assessed.state !== 'fetchable_under_policy')
        return {
          outcome: assessed.state,
          error_code: assessed.code,
          redirect_count: redirects + 1,
        };
      current = assessed.url!;
      redirects += 1;
      continue;
    }
    if (response.status === 401 || response.status === 403 || response.status === 407)
      return {
        outcome: 'needs_manual_triage',
        error_code: 'LOGIN_REQUIRED',
        redirect_count: redirects,
        final_url: current.href,
      };
    if (response.status === 429)
      return {
        outcome: 'needs_manual_triage',
        error_code: 'RATE_LIMITED',
        redirect_count: redirects,
        final_url: current.href,
      };
    if (response.status < 200 || response.status >= 300)
      return {
        outcome: 'failed',
        error_code: 'HTTP_STATUS_' + response.status,
        redirect_count: redirects,
        final_url: current.href,
      };
    try {
      const body = sanitizeStaticBody({
        content_type: response.headers['content-type'] ?? '',
        body: response.body,
        final_url: current.href,
        redirect_count: redirects,
        policy,
      });
      return {
        outcome: 'sanitized_preview_ready',
        final_url: body.final_url,
        redirect_count: body.redirect_count,
        text: body.text,
        checks: body.checks,
        threat_intelligence: 'not_checked',
        source_authenticity: 'unverified',
      };
    } catch (error) {
      const code = errorCode(error);
      return { outcome: 'needs_manual_triage', error_code: code, redirect_count: redirects };
    }
  }
}

/**
 * Node implementation for the separately deployed static processor.  The
 * attestation is deliberately explicit: direct in-process use without the
 * approved host/network boundary reports unavailable instead of pretending
 * to be isolated.  A deployment adapter resolves the URL from a one-time,
 * scoped task id; the processor never receives a Principal or session.
 */
export function createNodeStaticProcessor(
  resolveTask: TaskTargetResolver,
  runtime: ProcessorRuntimeAttestation,
  dependencies: Partial<RequestDependencies> = {},
): SourceProcessor {
  const requestDependencies: RequestDependencies = {
    resolve: dependencies.resolve ?? (dnsLookup as AddressResolver),
  };
  const activeDestinations = new Set<string>();
  return {
    async available() {
      return runtime.isolation_attested && runtime.network_egress_policy_enforced;
    },
    async process(task) {
      if (!(await this.available())) throw new DomainError('SAFE_PROCESSOR_UNAVAILABLE', 503);
      const target = await resolveTask(task);
      if (
        target.policy.version !== task.policy_version ||
        target.policy.dynamic_rendering_enabled ||
        target.policy.unknown_domain_auto_fetch_enabled ||
        target.policy.direct_reviewer_navigation ||
        target.policy.max_retries > 1
      )
        throw new DomainError('SOURCE_POLICY_MISMATCH', 503);
      const result = assessSourceURL(target.url, target.policy);
      if (result.state !== 'fetchable_under_policy')
        return { outcome: result.state, error_code: result.code };
      const destination = result.url!.hostname.toLowerCase();
      if (activeDestinations.has(destination))
        return { outcome: 'failed', error_code: 'RESOURCE_LIMIT_EXCEEDED' };
      activeDestinations.add(destination);
      try {
        return await fetchStatic(target.url, target.policy, requestDependencies);
      } finally {
        activeDestinations.delete(destination);
      }
    },
  };
}
