import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../packages/db/src/node';
import {
  EvidenceGatewayService,
  resolvePublicAddresses,
  sanitizeStaticBody,
  staticSourcePolicy,
  type ProcessorTask,
  type ProcessorResult,
  type SourceAuthorization,
  type SourceProcessor,
} from '../packages/evidence-gateway/src/index';
import type { Database } from '../packages/db/src/adapter';

async function setup() {
  const n = openDatabase(':memory:');
  n.sqlite.exec(await readFile('migrations/0001_init.sql', 'utf8'));
  n.sqlite.exec(await readFile('migrations/0003_review.sql', 'utf8'));
  return n;
}

const future = '2026-12-31T00:00:00.000Z';
const fetchAuth: SourceAuthorization = {
  principal_id: 'principal_a',
  grant_id: 'grant_a',
  capability: 'source.fetch',
  case_id: 'case_a',
  case_revision: 1,
  assignment_id: 'assign_a',
  expires_at: future,
};

function readyProcessor(text = '公开制度文本'): SourceProcessor {
  return {
    async available() {
      return true;
    },
    async process(_task: ProcessorTask): Promise<ProcessorResult> {
      return {
        outcome: 'sanitized_preview_ready',
        final_url: 'https://example.org/policy',
        redirect_count: 0,
        text,
        checks: {
          public_destination_enforced: true,
          network_egress_policy_enforced: true,
          login_required: false,
          download_attempted: false,
          output_sanitized: true,
        },
        threat_intelligence: 'not_checked',
        source_authenticity: 'unverified',
      };
    },
  };
}

function authChecker() {
  const calls: string[] = [];
  return {
    calls,
    authorize: async (input: { action: string }) => {
      calls.push(input.action);
    },
  };
}

describe('Evidence Gateway P0', () => {
  let db: Database | undefined;
  afterEach(() => db && (db as { close?: () => void }).close?.());

  it('排队只返回 opaque job；处理区不接收 Principal，预览不含原 URL', async () => {
    const n = await setup();
    db = n.db;
    const calls = authChecker();
    let received: ProcessorTask | undefined;
    const processor = readyProcessor();
    const wrapped: SourceProcessor = {
      available: processor.available,
      process: async (task) => {
        received = task;
        return processor.process(task);
      },
    };
    const service = new EvidenceGatewayService(db, {
      policy: staticSourcePolicy(['example.org']),
      processor: wrapped,
      authorize: calls.authorize,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    const job = await service.enqueue({
      case_id: 'case_a',
      case_revision: 1,
      source_id: 'source_a',
      url: 'https://example.org/policy',
      idempotency_key: 'idem-source-a-001',
      authorization: fetchAuth,
    });
    expect(job.state).toBe('fetchable_under_policy');
    expect(JSON.stringify(job)).not.toContain('example.org/policy');
    const result = await service.run(job.job_id);
    expect(result.state).toBe('sanitized_preview_ready');
    expect(received).toEqual({
      task_id: job.job_id,
      source_id: 'source_a',
      policy_version: 'wfd-fetch-static-1.0',
    });
    expect(JSON.stringify(received)).not.toContain('principal_a');
    const preview = await service.preview(result.preview_id!, {
      ...fetchAuth,
      capability: 'case.read_public_source',
    });
    expect(preview.text).toBe('公开制度文本');
    expect(JSON.stringify(preview)).not.toContain('https://example.org/policy');
    expect(preview.raw_html_available_to_reviewer).toBe(false);
    expect(calls.calls).toEqual(['source.fetch', 'source.fetch', 'source.fetch', 'source.read']);
  });

  it('未知域和凭据 URL 在网络请求前转人工；无隔离处理器真实失败', async () => {
    const n = await setup();
    db = n.db;
    const calls = authChecker();
    const service = new EvidenceGatewayService(db, {
      policy: staticSourcePolicy(['example.org']),
      authorize: calls.authorize,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    const unknown = await service.enqueue({
      case_id: 'case_a',
      case_revision: 1,
      source_id: 'source_unknown',
      url: 'https://unapproved.invalid/page',
      idempotency_key: 'idem-source-unknown',
      authorization: fetchAuth,
    });
    expect(unknown.state).toBe('needs_manual_triage');
    expect(unknown.error_code).toBe('DOMAIN_NOT_ALLOWED');
    const credential = await service.enqueue({
      case_id: 'case_a',
      case_revision: 1,
      source_id: 'source-secret',
      url: 'https://example.org/page?token=secret',
      idempotency_key: 'idem-source-secret',
      authorization: fetchAuth,
    });
    expect(credential.state).toBe('needs_manual_triage');
    expect(credential.error_code).toBe('CREDENTIAL_IN_URL');
    const allowed = await service.enqueue({
      case_id: 'case_a',
      case_revision: 1,
      source_id: 'source-safe',
      url: 'https://example.org/page',
      idempotency_key: 'idem-source-safe',
      authorization: fetchAuth,
    });
    const failed = await service.run(allowed.job_id);
    expect(failed.state).toBe('failed');
    expect(failed.error_code).toBe('SAFE_PROCESSOR_UNAVAILABLE');
  });

  it('同幂等键同负载只建一条记录，异负载返回冲突', async () => {
    const n = await setup();
    db = n.db;
    const calls = authChecker();
    const service = new EvidenceGatewayService(db, {
      policy: staticSourcePolicy(['example.org']),
      authorize: calls.authorize,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    const input = {
      case_id: 'case_a',
      case_revision: 1,
      source_id: 'source-a',
      url: 'https://example.org/a',
      idempotency_key: 'idem-same-source',
      authorization: fetchAuth,
    } as const;
    const first = await service.enqueue(input);
    const second = await service.enqueue(input);
    expect(second.job_id).toBe(first.job_id);
    await expect(
      service.enqueue({ ...input, url: 'https://example.org/b' }),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(await db.all('SELECT id FROM source_fetch_jobs')).toHaveLength(1);
  });

  it('净化 HTML，删除脚本、iframe、SVG 和源站链接，只输出文本', () => {
    const policy = staticSourcePolicy(['example.org']);
    const result = sanitizeStaticBody({
      content_type: 'text/html; charset=utf-8',
      body: new TextEncoder().encode(
        '<h1>制度</h1><script>alert(1)</script><p>双休 &amp; 年假</p><iframe src="x">登录</iframe><svg>bad</svg><a href="https://evil.example">外链</a>',
      ),
      final_url: 'https://example.org/policy',
      redirect_count: 0,
      policy,
    });
    expect(result.text).toContain('制度');
    expect(result.text).toContain('双休 & 年假');
    expect(result.text).toContain('外链');
    expect(result.text).not.toMatch(/alert|iframe|<svg|<a /i);
  });

  it('DNS 全候选地址逐一验证，映射 IPv6 私网被阻断', async () => {
    await expect(
      resolvePublicAddresses('example.org', async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
      ]),
    ).rejects.toThrow('SSRF_BLOCKED');
    await expect(
      resolvePublicAddresses('example.org', async () => [{ address: '1.1.1.1', family: 4 }]),
    ).resolves.toHaveLength(1);
  });
});

