import React, { useState } from 'react';
import type { Dataset, Claim } from '../../../packages/protocol/src/public';
export function ProposalEditor({
  submissionId,
  initial,
  onSubmit,
}: {
  submissionId: string;
  initial: unknown;
  onSubmit: (value: unknown) => Promise<void>;
}) {
  const body = (initial && typeof initial === 'object' ? initial : {}) as Record<string, unknown>;
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const f = new FormData(e.currentTarget),
            co = 'co_' + crypto.randomUUID().replaceAll('-', ''),
            scopeId = 'sc_' + crypto.randomUUID().replaceAll('-', ''),
            sourceId = 'src_' + crypto.randomUUID().replaceAll('-', ''),
            now = new Date().toISOString().slice(0, 10),
            until = new Date(Date.now() + 170 * 86400000).toISOString().slice(0, 10);
          const restId = 'cl_' + crypto.randomUUID().replaceAll('-', ''),
            contractId = 'cl_' + crypto.randomUUID().replaceAll('-', '');
          const checked = f.get('rest') !== 'unknown',
            contract = f.get('contract') === 'source_checked';
          const common = { scope_id: scopeId, rule_version: 'cn-demo-v1' };
          const claims: Claim[] = [
            {
              ...common,
              claim_id: restId,
              dimension: 'rest_schedule',
              value: checked
                ? {
                    usual_rest_days_per_week: 2,
                    usual_rest_days:
                      f.get('rest') === 'weekend'
                        ? ['saturday', 'sunday']
                        : ['tuesday', 'wednesday'],
                    holiday_adjustments_excluded: true,
                  }
                : null,
              evidence_status: checked ? 'source_checked' : 'unknown',
              source_ids: checked ? [sourceId] : [],
              checked_on: checked ? now : null,
              valid_from: checked ? now : null,
              valid_until: checked ? until : null,
            },
            {
              ...common,
              claim_id: contractId,
              dimension: 'written_contract_policy',
              value: contract ? '公开书面合同制度' : null,
              evidence_status: contract ? 'source_checked' : 'unknown',
              source_ids: contract ? [sourceId] : [],
              checked_on: contract ? now : null,
              valid_from: contract ? now : null,
              valid_until: contract ? until : null,
            },
          ];
          const data: Dataset = {
            schema_version: '1.0',
            demo: true,
            companies: [
              {
                company_id: co,
                legal_name: String(f.get('legal_name')),
                jurisdiction: 'CN',
                public_identifier: String(f.get('identifier')),
                aliases: [],
                industry: String(f.get('industry')),
                entity_status: f.get('entity_checked') ? 'checked' : 'pending',
                brand_ids: [],
                official_website_link_id: null,
                scopes: [
                  {
                    scope_id: scopeId,
                    company_id: co,
                    city: String(f.get('city')),
                    city_code: String(f.get('city_code')),
                    site_label: String(f.get('scope')),
                    job_group: String(f.get('scope')),
                    employment_type:
                      f.get('employment') === 'full_time_employee'
                        ? 'full_time_employee'
                        : 'unknown',
                    work_time_regime:
                      f.get('regime') === 'standard' ? 'standard' : 'special_regime_pending_review',
                    listing_state: 'active',
                    claims,
                    limitations: [
                      '仅为封闭演示中的公开资料核对，不代表实际执行。',
                      '未覆盖其他城市、岗位、加盟或外包。',
                    ],
                    record_revision: 1,
                  },
                ],
              },
            ],
            sources: [
              {
                source_id: sourceId,
                url: String(f.get('source')),
                title: String(f.get('source_title')),
                publisher: String(f.get('legal_name')),
                published_on: f.get('published_on') ? String(f.get('published_on')) : null,
                checked_on: now,
                source_family: 'family_' + crypto.randomUUID().replaceAll('-', ''),
                kind: 'company',
                supported_claim_ids: claims
                  .filter((c) => c.evidence_status === 'source_checked')
                  .map((c) => c.claim_id),
              },
            ],
            brands: [],
            relations: [],
            stores: [],
            products: [],
            links: [],
            rules: [
              {
                rule_version: 'cn-demo-v1',
                jurisdiction: 'CN',
                effective_from: now,
                effective_to: null,
                reviewed_on: now,
                sources: [],
                policy_ttl_days: 180,
                practice_ttl_days: 90,
                warning_days: 30,
                metadata_ttl_hours: 48,
                demo: true,
              },
            ],
            decisions: [],
            mirrors: [],
          };
          await onSubmit({
            submission_id: submissionId,
            company: data.companies[0],
            public_data: data,
            expected_revision: 0,
            reason: f.get('reason'),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="notice">
        新主体候选。两项资料需逐项核对；不清楚时保持未知。重复主体和已有记录修改请使用版本化候选导入。
      </div>
      <label>
        核对后的法律主体全名
        <input name="legal_name" required defaultValue={String(body.legal_name ?? '')} />
      </label>
      <label>
        公开登记消歧标识
        <input name="identifier" required placeholder="封闭演示请使用虚构主体标识" />
      </label>
      <label>
        行业
        <input name="industry" required />
      </label>
      <div className="form-grid">
        <label>
          城市
          <input name="city" required defaultValue={String(body.city ?? '')} />
        </label>
        <label>
          城市行政区划代码
          <input name="city_code" pattern="[0-9]{6}" required placeholder="如：430100" />
        </label>
      </div>
      <label>
        岗位/场所范围
        <input name="scope" required defaultValue={String(body.scope ?? '')} />
      </label>
      <label>
        用工类型
        <select name="employment">
          <option value="unknown">未确认</option>
          <option value="full_time_employee">普通全日制劳动关系</option>
        </select>
      </label>
      <label>
        工时制度
        <select name="regime">
          <option value="pending">尚需专项核对</option>
          <option value="standard">已核对标准工时适用范围</option>
        </select>
      </label>
      <label>
        休息制度
        <select name="rest">
          <option value="unknown">暂无足够资料</option>
          <option value="weekend">公开资料支持周六日双休</option>
          <option value="rotating">公开资料支持周二三轮休（演示）</option>
        </select>
      </label>
      <label>
        合同制度
        <select name="contract">
          <option value="unknown">暂无足够资料</option>
          <option value="source_checked">公开书面合同制度已核对</option>
        </select>
      </label>
      <label>
        主体正式来源 URL
        <input
          name="source"
          type="url"
          required
          defaultValue={Array.isArray(body.source_urls) ? String(body.source_urls[0] ?? '') : ''}
        />
      </label>
      <label>
        来源标题
        <input name="source_title" required />
      </label>
      <label>
        来源发布日期（可留空）
        <input name="published_on" type="date" />
      </label>
      <label className="check">
        <input name="entity_checked" type="checkbox" required />
        已核对主体、来源及其适用范围，且不存在利益冲突。
      </label>
      <label>
        初审理由
        <textarea name="reason" required maxLength={500} />
      </label>
      <button disabled={busy}>提交独立复核</button>
    </form>
  );
}
