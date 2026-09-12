import { z } from 'zod';
import ipaddr from 'ipaddr.js';

export const id = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
export const date = z.iso.date();
export const instant = z.iso.datetime({ offset: true });
export const text = z.string().trim().min(1).max(500);
export const httpsURL = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(host)) {
      let address = ipaddr.parse(host);
      if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress())
        address = (address as ipaddr.IPv6).toIPv4Address();
      if (address.range() !== 'unicast') return false;
    }
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !/^(localhost|.*\.localhost|.*\.local)$/i.test(u.hostname) &&
      ![...u.searchParams.keys()].some((k) =>
        /^(token|receipt|password|secret|auth|access_token)$/i.test(k),
      )
    );
  }, '仅允许无凭据的公开 HTTPS 地址');
export const evidenceStatus = z.enum([
  'unknown',
  'self_declared',
  'source_checked',
  'practice_corroborated',
  'needs_recheck',
  'expired',
]);
export const listingState = z.enum([
  'active',
  'recheck_required',
  'suppressed',
  'expired',
  'withdrawn_from_directory',
]);
export const claimSchema = z
  .strictObject({
    claim_id: id,
    scope_id: id,
    dimension: z.enum([
      'rest_schedule',
      'written_contract_policy',
      'working_hours_policy',
      'overtime_payment_practice',
      'salary_policy',
      'social_insurance_policy',
      'annual_leave_policy',
      'extra_leave',
      'safety_policy',
    ]),
    value: z.union([
      z.string().max(300),
      z.strictObject({
        usual_rest_days_per_week: z.number().int().min(0).max(7),
        usual_rest_days: z
          .array(
            z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
          )
          .max(7),
        holiday_adjustments_excluded: z.boolean(),
      }),
      z.null(),
    ]),
    evidence_status: evidenceStatus,
    source_ids: z.array(id).max(30),
    checked_on: date.nullable(),
    valid_from: date.nullable(),
    valid_until: date.nullable(),
    rule_version: id,
  })
  .superRefine((v, ctx) => {
    if (v.evidence_status === 'unknown' && (v.value !== null || v.source_ids.length))
      ctx.addIssue({ code: 'custom', message: '未知项目必须为空值且无佐证来源' });
    if (
      ['source_checked', 'practice_corroborated'].includes(v.evidence_status) &&
      (!v.checked_on || !v.valid_until || !v.valid_from || !v.source_ids.length || v.value === null)
    )
      ctx.addIssue({ code: 'custom', message: '已核对项目必须有来源和有效期' });
  });
export const scopeSchema = z.strictObject({
  scope_id: id,
  company_id: id,
  city_code: z.string().regex(/^\d{6}$/),
  city: text,
  site_label: text,
  job_group: text,
  employment_type: z.enum(['full_time_employee', 'other', 'unknown']),
  work_time_regime: z.enum(['standard', 'special_regime_pending_review']),
  listing_state: listingState,
  claims: z.array(claimSchema).max(50),
  limitations: z.array(text).max(20),
  record_revision: z.number().int().positive(),
});
export const companySchema = z.strictObject({
  company_id: id,
  legal_name: text,
  jurisdiction: z.literal('CN'),
  public_identifier: text,
  aliases: z.array(text).max(20),
  industry: text,
  entity_status: z.enum(['checked', 'pending']),
  scopes: z.array(scopeSchema).min(1).max(100),
  official_website_link_id: id.nullable(),
  brand_ids: z.array(id).max(100),
});
export const sourceSchema = z.strictObject({
  source_id: id,
  url: httpsURL,
  title: text,
  publisher: text,
  published_on: date.nullable(),
  checked_on: date,
  source_family: id,
  kind: z.enum(['company', 'third_party', 'independent_practice']),
  supported_claim_ids: z.array(id).max(100),
});
export const brandSchema = z.strictObject({
  brand_id: id,
  name: text,
  categories: z.array(text).max(20),
});
export const relationSchema = z.strictObject({
  relation_id: id,
  company_id: id,
  brand_id: id,
  relation_type: z.enum(['owned', 'authorized', 'subsidiary']),
  source_ids: z.array(id).min(1).max(30),
  valid_until: date,
});
export const storeSchema = z.strictObject({
  store_id: id,
  brand_id: id,
  platform: text,
  platform_store_id: text,
  seller_company_id: id,
  relation_type: z.enum(['owned', 'authorized']),
  verification_state: z.enum(['approved', 'pending', 'expired']),
  source_ids: z.array(id).min(1).max(30),
  valid_until: date,
});
export const linkSchema = z.strictObject({
  link_id: id,
  type: z.enum([
    'official_website',
    'official_careers',
    'brand_owned_store',
    'verified_authorized_store',
    'product_page',
    'service_page',
  ]),
  url: httpsURL,
  store_id: id.nullable(),
  seller_company_id: id,
  linked_scope_ids: z.array(id).min(1).max(100),
  relation_source_ids: z.array(id).min(1).max(30),
  checked_on: date,
  valid_until: date,
  ad_label: z.string().max(100),
  status: z.enum(['active', 'broken', 'risk_disabled', 'expired', 'withdrawn']),
});
export const productSchema = z.strictObject({
  product_id: id,
  brand_id: id,
  category: text,
  title: text,
  store_id: id,
  link_id: id,
  promotion_status: z.enum(['approved', 'disabled']),
  description: text,
});
export const ruleSchema = z.strictObject({
  rule_version: id,
  jurisdiction: z.literal('CN'),
  effective_from: date,
  effective_to: date.nullable(),
  reviewed_on: date,
  sources: z.array(httpsURL),
  policy_ttl_days: z.number().int().positive().max(180),
  practice_ttl_days: z.number().int().positive().max(90),
  warning_days: z.number().int().positive(),
  metadata_ttl_hours: z.number().int().positive().max(48),
  demo: z.boolean(),
});
export const decisionSchema = z.strictObject({
  decision_id: id,
  record_id: id,
  action: z.enum(['publish', 'correct', 'suppress', 'withdraw']),
  rule_version: id,
  reviewer_key_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2),
  publication_date: date,
});
export const mirrorSchema = z.strictObject({
  mirror_id: id,
  url: httpsURL,
  operator_group: id,
  provider_group: id,
  observed_on: date,
  capabilities: z.array(z.enum(['data', 'web', 'ipfs'])),
});
export const datasetSchema = z.strictObject({
  schema_version: z.literal('1.0'),
  demo: z.boolean(),
  companies: z.array(companySchema),
  sources: z.array(sourceSchema),
  brands: z.array(brandSchema),
  relations: z.array(relationSchema),
  stores: z.array(storeSchema),
  products: z.array(productSchema),
  links: z.array(linkSchema),
  rules: z.array(ruleSchema),
  decisions: z.array(decisionSchema),
  mirrors: z.array(mirrorSchema),
});
export const artifactSchema = z.strictObject({
  path: z
    .string()
    .regex(
      /^(?:index\/companies\.json|shards\/[a-f0-9]{64}\.json|directory\.(?:json|sqlite)|(?:rules|mirrors|approvals|reviewer-authority)\.json|(?:companies|public-changes)\.jsonl)$/,
    ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byte_length: z
    .number()
    .int()
    .nonnegative()
    .max(256 * 1024 * 1024),
  media_type: text,
});
export const manifestSchema = z
  .strictObject({
    protocol: z.literal('wfd-data'),
    schema_version: z.literal('1.0'),
    epoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    release_id: z.string().regex(/^[0-9a-z.-]+$/),
    issued_at: instant,
    expires_at: instant,
    previous_release_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    minimum_client_protocol: z.literal('1.0'),
    demo: z.boolean(),
    artifacts: z.array(artifactSchema).min(1).max(20000),
  })
  .refine(
    (m) => new Set(m.artifacts.map((a) => a.path)).size === m.artifacts.length,
    '重复文件路径',
  )
  .refine(
    (m) => m.artifacts.reduce((n, a) => n + a.byte_length, 0) <= 512 * 1024 * 1024,
    '发布包超过大小限制',
  );
export type Dataset = z.infer<typeof datasetSchema>;
export type Company = z.infer<typeof companySchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type OutboundLink = z.infer<typeof linkSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export const publicSchemas = Object.fromEntries(
  Object.entries({
    dataset: datasetSchema,
    manifest: manifestSchema,
    company: companySchema,
    scope: scopeSchema,
    claim: claimSchema,
    source: sourceSchema,
    brand: brandSchema,
    relation: relationSchema,
    store: storeSchema,
    link: linkSchema,
    product: productSchema,
    rule: ruleSchema,
    decision: decisionSchema,
    mirror: mirrorSchema,
  }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);
