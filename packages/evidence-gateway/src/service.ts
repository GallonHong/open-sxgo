import type { Database, Query } from '../../db/src/adapter';
import { assert, DomainError } from '../../domain/src/index';
import { canonical, hash, utf8 } from '../../verifier/src/crypto';
import { assessSourceURL } from './policy';
import type {
  AuthorizationCheck,
  EnqueueSourceInput,
  EvidenceGatewayOptions,
  ProcessorResult,
  PublicFetchJob,
  PublicPreview,
  SourceAuthorization,
  SourceFetchState,
} from './types';
import type { ProcessorTask } from './types';

type JobRow = {
  id: string;
  case_id: string;
  case_revision: number;
  source_id: string;
  source_url: string;
  policy_version: string;
  state: SourceFetchState;
  attempt_count: number;
  redirect_count: number;
  error_code: string | null;
  preview_id: string | null;
  assignment_id: string | null;
  grant_id: string;
  claim_token: string | null;
  idempotency_key: string;
  request_hash: string;
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type PreviewRow = {
  id: string;
  job_id: string;
  source_id: string;
  case_id: string;
  case_revision: number;
  state: 'sanitized_preview_ready';
  display_domain: string;
  final_domain: string;
  fetch_policy: string;
  redirect_count: number;
  threat_intelligence: 'not_checked' | 'not_found_known_list';
  source_authenticity: 'unverified';
  text_ref: string;
  text_content: string;
  image_ref: string | null;
  raw_html_available_to_reviewer: number;
  public_destination_enforced: number;
  network_egress_policy_enforced: number;
  login_required: number;
  download_attempted: number;
  output_hash: string;
  captured_at: string;
  expires_at: string;
};

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const isoNow = (clock: () => Date) => clock().toISOString();
const guard = (): Query[] => [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];

function codeOf(error: unknown) {
  return error instanceof DomainError
    ? error.code
    : error instanceof Error && error.message
      ? error.message
      : 'AUTHORIZATION_STATE_UNAVAILABLE';
}

function asPublicJob(row: JobRow): PublicFetchJob {
  return {
    job_id: row.id,
    case_id: row.case_id,
    case_revision: row.case_revision,
    source_id: row.source_id,
    policy_version: row.policy_version,
    state: row.state,
    error_code: row.error_code,
    preview_id: row.preview_id,
    attempt_count: row.attempt_count,
    redirect_count: row.redirect_count,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function ensureAuthorization(
  authorization: SourceAuthorization,
  input: { case_id: string; case_revision: number; capability: SourceAuthorization['capability'] },
  now: Date,
) {
  assert(authorization.case_id === input.case_id, 'CAPABILITY_DENIED', 403);
  assert(authorization.case_revision === input.case_revision, 'REVISION_CONFLICT', 409);
  assert(authorization.capability === input.capability, 'CAPABILITY_DENIED', 403);
  assert(Date.parse(authorization.expires_at) > now.getTime(), 'ROLE_EXPIRED_OR_REVOKED', 403);
  assert(authorization.grant_id.length >= 3, 'CAPABILITY_DENIED', 403);
}

export class EvidenceGatewayService {
  private readonly clock: () => Date;

  constructor(
    private readonly db: Database,
    private readonly options: EvidenceGatewayOptions,
  ) {
    this.clock = options.now ?? (() => new Date());
  }

  private async authorize(input: AuthorizationCheck) {
    if (!this.options.authorize)
      throw new DomainError('AUTHORIZATION_STATE_UNAVAILABLE', 503);
    await this.options.authorize(input);
  }

  private async findJob(jobId: string) {
    const [job] = await this.db.all<JobRow>('SELECT * FROM source_fetch_jobs WHERE id=?', [jobId]);
    assert(job, 'NOT_FOUND', 404);
    return job;
  }

  private async markInitialFailure(
    job: JobRow,
    state: 'failed' | 'expired',
    error: string,
  ) {
    await this.db.batch([
      {
        sql: 'UPDATE source_fetch_jobs SET state=?,error_code=?,updated_at=?,revision=revision+1 WHERE id=? AND state=? AND revision=?',
        params: [state, error, isoNow(this.clock), job.id, job.state, job.revision],
      },
      ...guard(),
    ]);
    return asPublicJob(await this.findJob(job.id));
  }

  private async markClaimFailure(job: JobRow, error: string) {
    await this.db.batch([
      {
        sql: 'UPDATE source_fetch_jobs SET state=\'failed\',error_code=?,updated_at=?,revision=revision+1 WHERE id=? AND state=\'fetching\' AND claim_token=?',
        params: [error, isoNow(this.clock), job.id, job.claim_token],
      },
      ...guard(),
    ]);
    return asPublicJob(await this.findJob(job.id));
  }

  async enqueue(input: EnqueueSourceInput): Promise<PublicFetchJob> {
    const now = this.clock();
    ensureAuthorization(
      input.authorization,
      { case_id: input.case_id, case_revision: input.case_revision, capability: 'source.fetch' },
      now,
    );
    await this.authorize({
      action: 'source.fetch',
      source_id: input.source_id,
      case_id: input.case_id,
      case_revision: input.case_revision,
      grant_id: input.authorization.grant_id,
      assignment_id: input.authorization.assignment_id,
    });
    assert(input.idempotency_key.length >= 16 && input.idempotency_key.length <= 256, 'INVALID_SCHEMA');
    const request_hash = await hash(
      utf8(
        canonical({
          case_id: input.case_id,
          case_revision: input.case_revision,
          source_id: input.source_id,
          url: input.url,
          policy_version: this.options.policy.version,
        }),
      ),
    );
    const [existing] = await this.db.all<JobRow>(
      'SELECT * FROM source_fetch_jobs WHERE source_id=? AND case_revision=? AND idempotency_key=?',
      [input.source_id, input.case_revision, input.idempotency_key],
    );
    if (existing) {
      assert(existing.request_hash === request_hash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return asPublicJob(existing);
    }
    const assessed = assessSourceURL(input.url, this.options.policy);
    const state = assessed.state as SourceFetchState;
    const time = isoNow(this.clock);
    const job: JobRow = {
      id: newId('sfj'),
      case_id: input.case_id,
      case_revision: input.case_revision,
      source_id: input.source_id,
      source_url: input.url,
      policy_version: this.options.policy.version,
      state,
      attempt_count: 0,
      redirect_count: 0,
      error_code: assessed.code === 'ALLOWED' ? null : assessed.code,
      preview_id: null,
      assignment_id: input.authorization.assignment_id ?? null,
      grant_id: input.authorization.grant_id,
      claim_token: null,
      idempotency_key: input.idempotency_key,
      request_hash,
      revision: 1,
      created_at: time,
      updated_at: time,
      expires_at: new Date(
        now.getTime() + (this.options.job_ttl_seconds ?? this.options.policy.preview_ttl_seconds) * 1000,
      ).toISOString(),
    };
    try {
      await this.db.batch([
        {
          sql: 'INSERT INTO source_fetch_jobs(id,case_id,case_revision,source_id,source_url,policy_version,state,attempt_count,redirect_count,error_code,preview_id,assignment_id,grant_id,claim_token,idempotency_key,request_hash,revision,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          params: [
            job.id,
            job.case_id,
            job.case_revision,
            job.source_id,
            job.source_url,
            job.policy_version,
            job.state,
            job.attempt_count,
            job.redirect_count,
            job.error_code,
            job.preview_id,
            job.assignment_id,
            job.grant_id,
            job.claim_token,
            job.idempotency_key,
            job.request_hash,
            job.revision,
            job.created_at,
            job.updated_at,
            job.expires_at,
          ],
        },
        ...guard(),
        {
          sql: 'INSERT INTO audit(id,item_id,actor,action,reason,created_at) VALUES(?,?,?,?,?,?)',
          params: [newId('au'), job.id, input.authorization.principal_id, 'source_fetch_enqueue', state + ':' + assessed.code, time],
        },
      ]);
    } catch (error) {
      if (!/UNIQUE constraint/i.test(error instanceof Error ? error.message : '')) throw error;
      const [race] = await this.db.all<JobRow>(
        'SELECT * FROM source_fetch_jobs WHERE source_id=? AND case_revision=? AND idempotency_key=?',
        [input.source_id, input.case_revision, input.idempotency_key],
      );
      assert(race, 'REVISION_CONFLICT', 409);
      assert(race.request_hash === request_hash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return asPublicJob(race);
    }
    return asPublicJob(job);
  }

  async run(jobId: string): Promise<PublicFetchJob> {
    let job = await this.findJob(jobId);
    const now = this.clock();
    if (Date.parse(job.expires_at) <= now.getTime() && !['expired', 'sanitized_preview_ready'].includes(job.state))
      return this.markInitialFailure(job, 'expired', 'PREVIEW_OR_ACCESS_EXPIRED');
    if (['blocked', 'needs_manual_triage', 'failed', 'expired', 'sanitized_preview_ready'].includes(job.state))
      return asPublicJob(job);
    try {
      await this.authorize({
        action: 'source.fetch',
        job_id: job.id,
        source_id: job.source_id,
        case_id: job.case_id,
        case_revision: job.case_revision,
        grant_id: job.grant_id,
        assignment_id: job.assignment_id ?? undefined,
      });
    } catch (error) {
      return this.markInitialFailure(job, 'failed', codeOf(error));
    }
    if (!this.options.processor) return this.markInitialFailure(job, 'failed', 'SAFE_PROCESSOR_UNAVAILABLE');
    let processorAvailable = false;
    try {
      processorAvailable = await this.options.processor.available();
    } catch (error) {
      return this.markInitialFailure(job, 'failed', codeOf(error));
    }
    if (!processorAvailable)
      return this.markInitialFailure(job, 'failed', 'SAFE_PROCESSOR_UNAVAILABLE');
    const claimToken = newId('claim');
    await this.db.batch([
      {
        sql: 'UPDATE source_fetch_jobs SET state=\'fetching\',claim_token=?,attempt_count=attempt_count+1,revision=revision+1,updated_at=? WHERE id=? AND state IN (\'fetchable_under_policy\',\'queued\') AND revision=?',
        params: [claimToken, isoNow(this.clock), job.id, job.revision],
      },
      ...guard(),
    ]);
    const [claimed] = await this.db.all<JobRow>(
      'SELECT * FROM source_fetch_jobs WHERE id=? AND state=\'fetching\' AND claim_token=?',
      [job.id, claimToken],
    );
    if (!claimed) return asPublicJob(await this.findJob(job.id));
    job = claimed;
    let result: ProcessorResult;
    try {
      const task: ProcessorTask = {
        task_id: job.id,
        source_id: job.source_id,
        policy_version: job.policy_version,
      };
      result = await this.options.processor.process(task);
      await this.authorize({
        action: 'source.fetch',
        job_id: job.id,
        source_id: job.source_id,
        case_id: job.case_id,
        case_revision: job.case_revision,
        grant_id: job.grant_id,
        assignment_id: job.assignment_id ?? undefined,
      });
    } catch (error) {
      return this.markClaimFailure(job, codeOf(error));
    }
    if (result.outcome !== 'sanitized_preview_ready') {
      await this.db.batch([
        {
          sql: 'UPDATE source_fetch_jobs SET state=?,error_code=?,redirect_count=?,updated_at=?,revision=revision+1 WHERE id=? AND state=\'fetching\' AND claim_token=?',
          params: [
            result.outcome,
            result.error_code,
            result.redirect_count ?? 0,
            isoNow(this.clock),
            job.id,
            claimToken,
          ],
        },
        ...guard(),
      ]);
      return asPublicJob(await this.findJob(job.id));
    }
    if (
      !result.checks.network_egress_policy_enforced ||
      !result.checks.public_destination_enforced ||
      !result.checks.output_sanitized ||
      result.checks.login_required ||
      result.checks.download_attempted ||
      typeof result.text !== 'string' ||
      result.text.length === 0 ||
      result.text.length > this.options.policy.max_output_characters ||
      !Number.isInteger(result.redirect_count) ||
      result.redirect_count < 0 ||
      result.redirect_count > this.options.policy.max_redirects
    )
      return this.markClaimFailure(job, 'SAFE_PROCESSOR_UNAVAILABLE');
    let finalDomain: string;
    try {
      const finalAssessment = assessSourceURL(result.final_url, this.options.policy);
      if (finalAssessment.state !== 'fetchable_under_policy' || !finalAssessment.domain)
        return this.markClaimFailure(job, 'SOURCE_POLICY_MISMATCH');
      finalDomain = finalAssessment.domain;
    } catch {
      return this.markClaimFailure(job, 'INVALID_PROCESSOR_OUTPUT');
    }
    const previewId = newId('spv');
    const capturedAt = isoNow(this.clock);
    const expiresAt = new Date(
      this.clock().getTime() + this.options.policy.preview_ttl_seconds * 1000,
    ).toISOString();
    const outputHash = await hash(utf8(result.text));
    const displayDomain = (() => {
      try {
        return new URL(job.source_url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        return finalDomain;
      }
    })();
    await this.db.batch([
      {
        sql: 'INSERT INTO sanitized_previews(id,job_id,source_id,case_id,case_revision,state,display_domain,final_domain,fetch_policy,redirect_count,threat_intelligence,source_authenticity,text_ref,text_content,image_ref,raw_html_available_to_reviewer,public_destination_enforced,network_egress_policy_enforced,login_required,download_attempted,output_hash,captured_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          previewId,
          job.id,
          job.source_id,
          job.case_id,
          job.case_revision,
          'sanitized_preview_ready',
          displayDomain,
          finalDomain,
          this.options.policy.version,
          result.redirect_count,
          result.threat_intelligence ?? 'not_checked',
          result.source_authenticity ?? 'unverified',
          previewId + '_text',
          result.text,
          null,
          0,
          1,
          1,
          0,
          0,
          outputHash,
          capturedAt,
          expiresAt,
          capturedAt,
        ],
      },
      ...guard(),
      {
        sql: 'UPDATE source_fetch_jobs SET state=\'sanitized_preview_ready\',preview_id=?,redirect_count=?,error_code=NULL,updated_at=?,expires_at=?,revision=revision+1 WHERE id=? AND state=\'fetching\' AND claim_token=?',
        params: [previewId, result.redirect_count, capturedAt, expiresAt, job.id, claimToken],
      },
      ...guard(),
    ]);
    return asPublicJob(await this.findJob(job.id));
  }

  async status(jobId: string, authorization: SourceAuthorization) {
    const job = await this.findJob(jobId);
    const now = this.clock();
    ensureAuthorization(
      authorization,
      {
        case_id: job.case_id,
        case_revision: job.case_revision,
        capability: 'case.read_public_source',
      },
      now,
    );
    await this.authorize({
      action: 'source.read',
      job_id: job.id,
      source_id: job.source_id,
      case_id: job.case_id,
      case_revision: job.case_revision,
      grant_id: authorization.grant_id,
      assignment_id: authorization.assignment_id,
    });
    if (Date.parse(job.expires_at) <= now.getTime() && job.state !== 'expired')
      return this.markInitialFailure(job, 'expired', 'PREVIEW_OR_ACCESS_EXPIRED');
    return asPublicJob(job);
  }

  async preview(previewId: string, authorization: SourceAuthorization): Promise<PublicPreview> {
    const [preview] = await this.db.all<PreviewRow>('SELECT * FROM sanitized_previews WHERE id=?', [
      previewId,
    ]);
    assert(preview, 'PREVIEW_OR_ACCESS_EXPIRED', 410);
    const now = this.clock();
    ensureAuthorization(
      authorization,
      {
        case_id: preview.case_id,
        case_revision: preview.case_revision,
        capability: 'case.read_public_source',
      },
      now,
    );
    await this.authorize({
      action: 'source.read',
      job_id: preview.job_id,
      source_id: preview.source_id,
      case_id: preview.case_id,
        case_revision: preview.case_revision,
        grant_id: authorization.grant_id,
        assignment_id: authorization.assignment_id,
    });
    if (Date.parse(preview.expires_at) <= now.getTime()) {
      await this.db.batch([
        {
          sql: 'UPDATE source_fetch_jobs SET state=\'expired\',error_code=\'PREVIEW_OR_ACCESS_EXPIRED\',updated_at=?,revision=revision+1 WHERE id=? AND state=\'sanitized_preview_ready\'',
          params: [isoNow(this.clock), preview.job_id],
        },
        ...guard(),
      ]);
      throw new DomainError('PREVIEW_OR_ACCESS_EXPIRED', 410);
    }
    assert(preview.raw_html_available_to_reviewer === 0, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    assert(preview.public_destination_enforced === 1, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    assert(preview.network_egress_policy_enforced === 1, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    assert(preview.login_required === 0 && preview.download_attempted === 0, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    return {
      preview_id: preview.id,
      source_id: preview.source_id,
      case_id: preview.case_id,
      case_revision: preview.case_revision,
      state: preview.state,
      display_domain: preview.display_domain,
      final_domain: preview.final_domain,
      fetch_policy: preview.fetch_policy,
      redirect_count: preview.redirect_count,
      threat_intelligence: preview.threat_intelligence,
      source_authenticity: preview.source_authenticity,
      text_ref: preview.text_ref,
      text: preview.text_content,
      image_ref: null,
      raw_html_available_to_reviewer: false,
      checks: {
        public_destination_enforced: true,
        network_egress_policy_enforced: true,
        login_required: false,
        download_attempted: false,
        output_sanitized: true,
      },
      captured_at: preview.captured_at,
      expires_at: preview.expires_at,
    };
  }
}
