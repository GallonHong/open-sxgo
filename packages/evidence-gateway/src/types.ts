import type { Database } from '../../db/src/adapter';

export type SourceFetchState =
  | 'queued'
  | 'fetching'
  | 'blocked'
  | 'needs_manual_triage'
  | 'fetchable_under_policy'
  | 'sanitized_preview_ready'
  | 'failed'
  | 'expired';

export type SourceOutcome = Exclude<
  SourceFetchState,
  'queued' | 'fetching' | 'expired'
>;

export type SourcePolicy = Readonly<{
  version: string;
  allowed_protocols: readonly ('http' | 'https')[];
  allowed_ports: readonly number[];
  allowed_domains: readonly string[];
  direct_reviewer_navigation: false;
  dynamic_rendering_enabled: false;
  unknown_domain_auto_fetch_enabled: false;
  max_redirects: number;
  max_task_seconds: number;
  max_response_bytes: number;
  max_task_network_bytes: number;
  max_network_requests: number;
  max_retries: number;
  same_destination_concurrency: 1;
  network_egress_policy_required: true;
  max_output_characters: number;
  preview_ttl_seconds: number;
}>;

export const staticSourcePolicy = (allowedDomains: readonly string[]): SourcePolicy => ({
  version: 'wfd-fetch-static-1.0',
  allowed_protocols: ['http', 'https'],
  allowed_ports: [80, 443],
  allowed_domains: allowedDomains,
  direct_reviewer_navigation: false,
  dynamic_rendering_enabled: false,
  unknown_domain_auto_fetch_enabled: false,
  max_redirects: 3,
  max_task_seconds: 30,
  max_response_bytes: 10 * 1024 * 1024,
  max_task_network_bytes: 30 * 1024 * 1024,
  max_network_requests: 100,
  max_retries: 1,
  same_destination_concurrency: 1,
  network_egress_policy_required: true,
  max_output_characters: 100_000,
  preview_ttl_seconds: 7 * 86400,
});

export type SourceAuthorization = Readonly<{
  principal_id: string;
  grant_id: string;
  capability: 'source.fetch' | 'case.read_public_source';
  case_id: string;
  case_revision: number;
  assignment_id?: string;
  expires_at: string;
}>;

export type AuthorizationCheck = Readonly<{
  action: 'source.fetch' | 'source.read';
  job_id?: string;
  source_id: string;
  case_id: string;
  case_revision: number;
  grant_id: string;
  assignment_id?: string;
}>;

export type AuthorizationChecker = (input: AuthorizationCheck) => Promise<void>;

/**
 * The task crossing into the source processor intentionally contains only
 * opaque identifiers.  It never contains a Principal, a session, or a
 * reviewer assignment.  The processor obtains the target from a scoped task
 * broker owned by the gateway.
 */
export type ProcessorTask = Readonly<{
  task_id: string;
  source_id: string;
  policy_version: string;
}>;

export type PreviewChecks = Readonly<{
  public_destination_enforced: true;
  network_egress_policy_enforced: true;
  login_required: false;
  download_attempted: false;
  output_sanitized: true;
}>;

export type ProcessorResult =
  | Readonly<{
      outcome: 'sanitized_preview_ready';
      final_url: string;
      redirect_count: number;
      text: string;
      checks: PreviewChecks;
      threat_intelligence?: 'not_checked' | 'not_found_known_list';
      source_authenticity?: 'unverified';
    }>
  | Readonly<{
      outcome: 'blocked' | 'needs_manual_triage' | 'failed';
      error_code: string;
      redirect_count?: number;
      final_url?: string;
    }>;

export interface SourceProcessor {
  available(): Promise<boolean>;
  process(task: ProcessorTask): Promise<ProcessorResult>;
}

export type EvidenceGatewayOptions = Readonly<{
  policy: SourcePolicy;
  processor?: SourceProcessor;
  authorize?: AuthorizationChecker;
  now?: () => Date;
  job_ttl_seconds?: number;
}>;

export type EnqueueSourceInput = Readonly<{
  case_id: string;
  case_revision: number;
  source_id: string;
  url: string;
  idempotency_key: string;
  authorization: SourceAuthorization;
}>;

export type PublicFetchJob = Readonly<{
  job_id: string;
  case_id: string;
  case_revision: number;
  source_id: string;
  policy_version: string;
  state: SourceFetchState;
  error_code: string | null;
  preview_id: string | null;
  attempt_count: number;
  redirect_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}>;

export type PublicPreview = Readonly<{
  preview_id: string;
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
  text: string;
  image_ref: null;
  raw_html_available_to_reviewer: false;
  checks: PreviewChecks;
  captured_at: string;
  expires_at: string;
}>;

export type GatewayDatabase = Database;
