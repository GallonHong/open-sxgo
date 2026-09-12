import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { AuthenticatorPanel } from './AuthenticatorPanel';
type Row = {
  id: string;
  domain?: string;
  work_type?: string;
  status?: string;
  state?: string;
  target_role?: string;
  version?: number;
  decision_reason?: string | null;
};
const domains = [
  ['data', '资料与纠错'],
  ['review', '审核'],
  ['code_doc', '代码与文档'],
  ['infrastructure', '基础设施'],
  ['security_governance', '安全与治理'],
];
const status: Record<string, string> = {
  submitted: '已提交',
  deduplicated: '已归并，等待评估',
  under_assessment: '评估中',
  accepted_pending: '异议窗口',
  recognized: '已认定',
  duplicate: '重复工作',
  needs_info: '需要补充',
  not_qualified: '未获认定',
  challenged: '异议处理中',
  approved: '资格评估通过，尚需授权',
  rejected: '未通过',
  expired: '已到期',
  confirmed: '已确认',
  adjusted: '已更正',
  revoked: '已撤销',
};
async function request(path: string, body?: unknown, receipt?: string) {
  const response = await fetch('/private/v1/' + path, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), ...(receipt ? { 'X-WFD-Receipt': receipt } : {}) },
          body: JSON.stringify(body),
        }),
  });
  const value = z
    .object({
      error: z.object({ code: z.string() }).optional(),
      items: z
        .array(
          z.object({
            id: z.string(),
            domain: z.string().optional(),
            work_type: z.string().optional(),
            status: z.string().optional(),
            target_role: z.string().optional(),
            version: z.number().optional(),
            decision_reason: z.string().nullable().optional(),
          }),
        )
        .default([]),
      grants: z
        .array(
          z.object({
            grant_id: z.string(),
            role: z.string(),
            expires_at: z.string(),
            status: z.string(),
          }),
        )
        .default([]),
    })
    .parse(await response.json());
  if (!response.ok) throw Error(value.error?.code ?? 'REQUEST_FAILED');
  return value;
}
export function MemberWorkspace() {
  const [rows, setRows] = useState<Row[]>([]),
    [qualifications, setQualifications] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [member, setMember] = useState<{
    grants: { grant_id: string; role: string; expires_at: string; status: string }[];
  }>();
  async function refresh() {
    try {
      const [identity, contributions, applications] = await Promise.all([
        request('member'),
        request('contributions/mine'),
        request('qualifications/mine'),
      ]);
      setMember(identity);
      setRows(contributions.items);
      setQualifications(applications.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function submit(path: string, body: unknown, receipt?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(path, body, receipt);
      setNotice('已保存，请等待独立处理。');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="demo-strip">成员私密工作区 · 开发演示 · 请勿提交真实私人材料</div>
      <header>
        <a className="wordmark" href="/">
          <span className="mark">w</span>open sxgo / 成员
        </a>
        <a href={import.meta.env.DEV ? '/' : '/admin'}>审核员登录与工作台</a>
      </header>
      <main className="page">
        <div className="eyebrow">MY CONTRIBUTIONS</div>
        <h1>我的贡献与申请</h1>
        <p>这里记录工作、评估与申请。贡献认定不会自动开启生产权限。</p>
        {error && (
          <div className="message error" role="alert">
            {['CAPABILITY_DENIED', 'AUTHENTICATION_REQUIRED'].includes(error)
              ? '请先在受控入口登录，并完成项目成员登记。旧演示账号不会自动获得新权限。'
              : error}
          </div>
        )}
        {notice && (
          <div className="message" role="status">
            {notice}
          </div>
        )}
        {member && (
          <>
            <AuthenticatorPanel />
            <div className="community-grid">
              <section className="panel">
                <h2>记录一项工作</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void submit('contributions', {
                      domain: f.get('domain'),
                      work_type: f.get('work_type'),
                      subject_ref: f.get('subject'),
                      scope_ref: f.get('scope'),
                      fact_cycle: f.get('cycle'),
                      source_family: f.get('family'),
                      work_fingerprint: f.get('summary'),
                      source_ref: null,
                      materiality: 'routine',
                      public_summary_allowed: f.get('public') === 'on',
                      coauthor_principal_ids: [],
                    });
                  }}
                >
                  <label>
                    贡献领域
                    <select name="domain">
                      {domains.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    工作类型
                    <input
                      name="work_type"
                      placeholder="例如：来源核对、文档纠错"
                      required
                      maxLength={200}
                    />
                  </label>
                  <label>
                    相关工作对象
                    <input name="subject" required maxLength={200} />
                  </label>
                  <label>
                    适用范围
                    <input name="scope" required maxLength={200} />
                  </label>
                  <label>
                    资料所属周期
                    <input name="cycle" type="month" required />
                  </label>
                  <label>
                    来源家族或协作任务
                    <input name="family" required maxLength={200} />
                  </label>
                  <label>
                    实质工作说明
                    <textarea name="summary" required maxLength={500} />
                  </label>
                  <label>
                    <input type="checkbox" name="public" />
                    我自愿允许经过隐私审核的汇总，不公开具体案件关联。
                  </label>
                  <button disabled={busy}>提交认定</button>
                </form>
              </section>
              <section className="panel">
                <h2>申请下一项责任</h2>
                <p>培训、工作样本和两名独立评估者缺一不可。也可以申请专业等效评估。</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void submit('qualifications/apply', {
                      target_role: f.get('role'),
                      scope: [String(f.get('scope'))],
                      evidence_refs: String(f.get('evidence')).split('\n').filter(Boolean),
                      training_modules: [],
                      equivalent_route: f.get('equivalent') === 'on',
                    });
                  }}
                >
                  <label>
                    申请职责
                    <select name="role">
                      <option value="review_apprentice">见习审核员</option>
                      <option value="public_reviewer">公开资料审核员</option>
                      <option value="code_maintainer">代码与文档维护者</option>
                      <option value="infra_maintainer">基础设施维护者</option>
                    </select>
                  </label>
                  <label>
                    申请范围
                    <input name="scope" required maxLength={200} />
                  </label>
                  <label>
                    工作样本或认定记录编号
                    <textarea name="evidence" required maxLength={1000} />
                  </label>
                  <label>
                    <input name="equivalent" type="checkbox" />
                    申请专业等效通道
                  </label>
                  <button disabled={busy}>提交资格申请</button>
                </form>
                <h3>当前授权</h3>
                {member.grants.length ? (
                  member.grants.map((g) => (
                    <p key={g.grant_id}>
                      {g.role} · {g.status} · 至 {g.expires_at.slice(0, 10)}
                    </p>
                  ))
                ) : (
                  <p className="muted">尚无生产授权。你仍可提交工作和资格申请。</p>
                )}
              </section>
            </div>
            <section className="panel">
              <h2>我的记录</h2>
              {[...rows, ...qualifications].length ? (
                [...rows, ...qualifications].map((row) => (
                  <article key={row.id} className="message">
                    <strong>{row.work_type ?? row.target_role}</strong>
                    <p>
                      {status[row.status ?? ''] ?? row.status} · {row.id}
                    </p>
                    {row.decision_reason && <p>{row.decision_reason}</p>}
                    {!row.target_role && <details><summary>认领匿名投稿关联</summary>
                      <p>这会把回执对应的投稿关联到你的私密贡献记录。关联不会公开，也不会自动认定贡献。</p>
                      <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void submit('contributions/claim',{contribution_id:row.id,confirm_link:true,consent_version:'claim-1',expected_revision:row.version},String(f.get('receipt')));e.currentTarget.reset()}}>
                        <label>投稿回执<input name="receipt" type="password" autoComplete="off" required pattern="[a-f0-9]{64}" minLength={64} maxLength={64}/></label>
                        <label className="check"><input type="checkbox" required/>我同意建立这项私密关联</label>
                        <button disabled={busy || !row.version}>确认关联</button>
                      </form>
                    </details>}
                    <details>
                      <summary>对这项决定提出申诉</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void submit('appeals', {
                            subject_type: row.target_role ? 'qualification' : 'contribution',
                            subject_id: row.id,
                            reason: f.get('reason'),
                            evidence_refs: [],
                          });
                        }}
                      >
                        <label>
                          申诉理由
                          <textarea name="reason" required maxLength={500} />
                        </label>
                        <button disabled={busy}>私密提交</button>
                      </form>
                    </details>
                  </article>
                ))
              ) : (
                <p className="muted">还没有提交记录。</p>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
