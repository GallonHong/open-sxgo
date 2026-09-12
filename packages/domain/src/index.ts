import {
  datasetSchema,
  type Dataset,
  type Scope,
  type Claim,
  type OutboundLink,
} from '../../protocol/src/public';
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const day = (now = new Date()) => now.toISOString().slice(0, 10);
export function assert(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
export function validClaim(c: Claim, now = new Date()) {
  return (
    ['source_checked', 'practice_corroborated'].includes(c.evidence_status) &&
    !!c.valid_until &&
    !!c.valid_from &&
    c.valid_until >= day(now) &&
    c.valid_from <= day(now)
  );
}
export function eligible(s: Scope, now = new Date()) {
  if (
    s.listing_state !== 'active' ||
    s.employment_type !== 'full_time_employee' ||
    s.work_time_regime !== 'standard'
  )
    return false;
  const claims = s.claims.filter((c) => validClaim(c, now));
  return (
    new Set(claims.map((c) => c.dimension)).size >= 2 &&
    claims.some((c) =>
      [
        'rest_schedule',
        'written_contract_policy',
        'working_hours_policy',
        'salary_policy',
        'social_insurance_policy',
        'annual_leave_policy',
      ].includes(c.dimension),
    ) &&
    claims.some(
      (c) =>
        c.dimension === 'extra_leave' ||
        (c.dimension === 'rest_schedule' &&
          typeof c.value === 'object' &&
          c.value !== null &&
          c.value.usual_rest_days_per_week >= 2),
    )
  );
}
export function restMatch(s: Scope, filter: string, now = new Date()) {
  return s.claims.some(
    (c) =>
      c.dimension === 'rest_schedule' &&
      validClaim(c, now) &&
      typeof c.value === 'object' &&
      c.value !== null &&
      c.value.usual_rest_days_per_week === 2 &&
      (filter !== 'weekend' ||
        (c.value.usual_rest_days.includes('saturday') &&
          c.value.usual_rest_days.includes('sunday'))),
  );
}
export function usableLink(link: OutboundLink, d: Dataset, now = new Date(), promotion = false) {
  if (
    link.status !== 'active' ||
    link.valid_until < day(now) ||
    !link.linked_scope_ids.some((id) =>
      d.companies.some(
        (c) =>
          c.company_id === link.seller_company_id &&
          c.scopes.some((s) => s.scope_id === id && eligible(s, now)),
      ),
    )
  )
    return false;
  if (link.store_id) {
    const store = d.stores.find((s) => s.store_id === link.store_id);
    if (
      !store ||
      store.verification_state !== 'approved' ||
      store.valid_until < day(now) ||
      store.seller_company_id !== link.seller_company_id
    )
      return false;
    if (
      !d.relations.some(
        (r) =>
          r.brand_id === store.brand_id &&
          r.company_id === store.seller_company_id &&
          r.valid_until >= day(now),
      )
    )
      return false;
  }
  return !promotion || link.ad_label.startsWith('广告');
}
export function privacyScan(value: unknown) {
  const encoded = JSON.stringify(value);
  assert(
    !/(WFD_PRIVATE_CANARY|PRIVATE[_ -]EVIDENCE|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|receipt_token|投稿回执|员工工号)/i.test(
      encoded,
    ),
    'PRIVACY_BLOCKED',
  );
  assert(
    !/(?:\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(encoded),
    'PRIVACY_BLOCKED',
  );
}
export function validateDataset(input: unknown, now = new Date()): Dataset {
  const d = datasetSchema.parse(input);
  privacyScan(d);
  const objects = [
    ...d.companies.map((x) => x.company_id),
    ...d.companies.flatMap((x) => x.scopes.map((s) => s.scope_id)),
    ...d.companies.flatMap((x) => x.scopes.flatMap((s) => s.claims.map((c) => c.claim_id))),
    ...d.sources.map((x) => x.source_id),
    ...d.brands.map((x) => x.brand_id),
    ...d.relations.map((x) => x.relation_id),
    ...d.stores.map((x) => x.store_id),
    ...d.products.map((x) => x.product_id),
    ...d.links.map((x) => x.link_id),
  ];
  assert(new Set(objects).size === objects.length, 'DUPLICATE_ID');
  const sources = new Map(d.sources.map((s) => [s.source_id, s]));
  const companies = new Set(d.companies.map((c) => c.company_id));
  const scopes = new Set(d.companies.flatMap((c) => c.scopes.map((s) => s.scope_id)));
  const brands = new Set(d.brands.map((b) => b.brand_id));
  for (const co of d.companies) {
    assert(
      co.brand_ids.every((b) => brands.has(b)),
      'MISSING_BRAND',
    );
    if (co.official_website_link_id)
      assert(
        d.links.some(
          (l) => l.link_id === co.official_website_link_id && l.seller_company_id === co.company_id,
        ),
        'MISSING_WEBSITE',
      );
    for (const s of co.scopes) {
      assert(s.company_id === co.company_id, 'SCOPE_MISMATCH');
      for (const c of s.claims) {
        assert(c.scope_id === s.scope_id, 'CLAIM_SCOPE_MISMATCH');
        assert(
          c.source_ids.every(
            (id) => sources.has(id) && sources.get(id)!.supported_claim_ids.includes(c.claim_id),
          ),
          'MISSING_SOURCE',
        );
        const rule = d.rules.find((r) => r.rule_version === c.rule_version);
        assert(rule, 'MISSING_RULE');
        if (validClaim(c, now)) {
          assert(
            rule.effective_from <= day(now) &&
              (!rule.effective_to || rule.effective_to >= day(now)),
            'RULE_NOT_EFFECTIVE',
          );
          assert(c.valid_from! >= rule.effective_from, 'RULE_BEFORE_EFFECTIVE');
          const ttl =
            c.evidence_status === 'practice_corroborated'
              ? rule.practice_ttl_days
              : rule.policy_ttl_days;
          assert(
            Date.parse(c.valid_until!) - Date.parse(c.checked_on!) <= ttl * 86400000,
            'TTL_EXCEEDED',
          );
          if (c.evidence_status === 'practice_corroborated') {
            const evidence = c.source_ids.map((id) => sources.get(id)!);
            assert(
              evidence.some((e) => e.kind === 'independent_practice') &&
                new Set(evidence.map((e) => e.source_family)).size >= 2,
              'PRACTICE_NOT_INDEPENDENT',
            );
          }
        }
      }
      if (eligible(s, now)) {
        assert(co.entity_status === 'checked', 'ENTITY_UNCHECKED');
        assert(
          s.claims.some(
            (c) =>
              validClaim(c, now) && c.source_ids.some((id) => sources.get(id)?.kind === 'company'),
          ),
          'OFFICIAL_SOURCE_REQUIRED',
        );
      }
    }
  }
  for (const r of d.relations)
    assert(
      companies.has(r.company_id) &&
        brands.has(r.brand_id) &&
        r.source_ids.every((id) => sources.has(id)),
      'INVALID_RELATION',
    );
  for (const s of d.stores)
    assert(
      companies.has(s.seller_company_id) &&
        brands.has(s.brand_id) &&
        s.source_ids.every((id) => sources.has(id)),
      'INVALID_STORE',
    );
  for (const l of d.links) {
    assert(
      companies.has(l.seller_company_id) &&
        l.linked_scope_ids.every((id) => scopes.has(id)) &&
        l.relation_source_ids.every((id) => sources.has(id)),
      'INVALID_LINK',
    );
    if (l.store_id)
      assert(
        d.stores.some(
          (s) => s.store_id === l.store_id && s.seller_company_id === l.seller_company_id,
        ),
        'SELLER_MISMATCH',
      );
  }
  for (const p of d.products)
    assert(
      brands.has(p.brand_id) &&
        d.stores.some((s) => s.store_id === p.store_id && s.brand_id === p.brand_id) &&
        d.links.some((l) => l.link_id === p.link_id && l.store_id === p.store_id),
      'INVALID_PRODUCT',
    );
  return d;
}
export const statusLabels: Record<string, string> = {
  unknown: '暂无足够资料',
  self_declared: '企业自报',
  source_checked: '公开资料已核对',
  practice_corroborated: '实践有交叉佐证',
  needs_recheck: '核验更新中',
  expired: '资料已过期',
  active: '有效记录',
  suppressed: '当前暂停推荐',
  recheck_required: '资料更新中',
  withdrawn_from_directory: '历史记录',
};
export const dimensionLabels: Record<string, string> = {
  rest_schedule: '休息安排',
  written_contract_policy: '书面合同制度',
  working_hours_policy: '工时制度',
  overtime_payment_practice: '加班报酬实际支付',
  salary_policy: '发薪制度',
  social_insurance_policy: '社保制度',
  annual_leave_policy: '年休假制度',
  extra_leave: '额外带薪假',
  safety_policy: '安全制度',
};
