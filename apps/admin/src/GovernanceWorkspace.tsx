import React, { useEffect, useState } from 'react';

type Proposal = {
  id: string;
  title: string;
  proposal_type: string;
  state: string;
  revision: number;
  public_summary: string;
  body_json: string;
  timelock_until: string | null;
};

type GovernanceWorkspaceProps = {
  apiBase?: string;
};

const proposalTypes = [
  ['rule_change', '规则变更'],
  ['review_policy', '审核政策'],
  ['contribution_policy', '贡献政策'],
  ['role_grant', '职责授权'],
  ['role_revoke', '职责撤销'],
  ['privacy_policy', '隐私政策'],
  ['node_policy', '节点政策'],
  ['targets_rotation', 'Targets 轮换'],
  ['root_rotation', 'Root 轮换'],
  ['charter_change', '章程变更'],
] as const;

const jsonList = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

async function request(base: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (path === 'governance/proposals') headers['Idempotency-Key'] = crypto.randomUUID();
  }
  const response = await fetch(`${base}/${path}`, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = {};
  }
  if (!response.ok) {
    const code =
      value && typeof value === 'object' && 'error' in value
        ? String((value as { error?: { code?: unknown } }).error?.code ?? 'REQUEST_FAILED')
        : 'REQUEST_FAILED';
    throw new Error(code);
  }
  return value;
}

/** Private P0 transition-governance workspace. Mature voting controls are absent. */
export function GovernanceWorkspace({ apiBase = '/admin/v1' }: GovernanceWorkspaceProps) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const value = (await request(apiBase, 'governance/proposals')) as { items?: Proposal[] };
    setProposals(value.items ?? []);
  }

  useEffect(() => {
    void refresh().catch((reason) => setError((reason as Error).message));
  }, []);

  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refresh();
      setNotice('治理操作已保存。');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function proposalForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(() =>
      request(apiBase, 'governance/proposals', {
        proposal_type: String(form.get('proposal_type')),
        title: String(form.get('title')),
        background: String(form.get('background')),
        change: String(form.get('change')),
        affected_objects: jsonList(form.get('affected_objects')),
        current_policy_version: String(form.get('current_policy_version')),
        proposed_policy_version: String(form.get('proposed_policy_version')),
        risk: String(form.get('risk')),
        recusal_refs: jsonList(form.get('recusal_refs')),
        cost_summary: String(form.get('cost_summary')),
        execution_steps: jsonList(form.get('execution_steps')),
        rollback_steps: jsonList(form.get('rollback_steps')),
        public_summary: String(form.get('public_summary')),
        discussion_days: Number(form.get('discussion_days')),
        voting_days: Number(form.get('voting_days')),
        timelock_days: Number(form.get('timelock_days')),
      }),
    );
    event.currentTarget.reset();
  }

  return (
    <section className="panel">
      <div className="demo-strip">P0 过渡治理 · 双人审批 · 成熟社区投票入口保持关闭</div>
      <h1>治理工作区</h1>
      <p>提案、审批和执行均由当前会话身份决定。页面不会提交 actor、资格或执行结果字段。</p>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="message" role="status">
          {notice}
        </div>
      )}

      <details open>
        <summary>创建治理提案</summary>
        <form onSubmit={proposalForm}>
          <label>
            类型
            <select name="proposal_type" defaultValue="rule_change">
              {proposalTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            标题
            <input name="title" required maxLength={500} />
          </label>
          <label>
            背景
            <textarea name="background" required maxLength={500} />
          </label>
          <label>
            拟议变更
            <textarea name="change" required maxLength={500} />
          </label>
          <label>
            受影响对象（每行一个）
            <textarea name="affected_objects" required />
          </label>
          <div className="form-grid">
            <label>
              当前政策版本
              <input name="current_policy_version" defaultValue="wfd-gov-1-0" required />
            </label>
            <label>
              拟议政策版本
              <input name="proposed_policy_version" defaultValue="wfd-gov-1-1" required />
            </label>
          </div>
          <label>
            风险
            <textarea name="risk" required maxLength={500} />
          </label>
          <label>
            回避对象引用（每行一个）
            <textarea name="recusal_refs" />
          </label>
          <label>
            成本说明
            <textarea name="cost_summary" required maxLength={500} />
          </label>
          <label>
            执行步骤（每行一个）
            <textarea name="execution_steps" required />
          </label>
          <label>
            回滚步骤（每行一个）
            <textarea name="rollback_steps" required />
          </label>
          <label>
            公开摘要
            <textarea name="public_summary" required maxLength={500} />
          </label>
          <div className="form-grid">
            <label>
              讨论天数
              <input
                name="discussion_days"
                type="number"
                min={1}
                max={90}
                defaultValue={7}
                required
              />
            </label>
            <label>
              投票天数（P1 预留）
              <input name="voting_days" type="number" min={1} max={90} defaultValue={7} required />
            </label>
            <label>
              延迟执行天数
              <input
                name="timelock_days"
                type="number"
                min={1}
                max={90}
                defaultValue={7}
                required
              />
            </label>
          </div>
          <button disabled={busy}>提交提案</button>
        </form>
      </details>

      <h2>提案队列</h2>
      {!proposals.length && <p className="muted">暂无可见提案。</p>}
      {proposals.map((proposal) => (
        <article className="source" key={proposal.id}>
          <h3>{proposal.title}</h3>
          <p>
            {proposal.id} · {proposal.proposal_type} · {proposal.state} · 修订 {proposal.revision}
          </p>
          <p>{proposal.public_summary}</p>
          {proposal.timelock_until && <p>延迟至 {proposal.timelock_until}</p>}
          <details>
            <summary>查看提案内容</summary>
            <pre>{proposal.body_json}</pre>
          </details>
          {proposal.state === 'draft' && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request(apiBase, `governance/proposals/${proposal.id}/discussion`, {
                    expected_revision: proposal.revision,
                  }),
                )
              }
            >
              开始讨论
            </button>
          )}
          {proposal.state === 'discussion' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void action(() =>
                  request(apiBase, `governance/proposals/${proposal.id}/approval`, {
                    expected_revision: proposal.revision,
                    decision: String(form.get('decision')),
                    reason: String(form.get('reason')),
                  }),
                );
              }}
            >
              <label>
                委员会意见
                <select name="decision">
                  <option value="approve">批准</option>
                  <option value="reject">否决</option>
                </select>
              </label>
              <label>
                理由
                <textarea name="reason" required maxLength={500} />
              </label>
              <button disabled={busy}>提交委员会意见</button>
            </form>
          )}
          {proposal.state === 'timelocked' && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request(apiBase, `governance/proposals/${proposal.id}/ready`, {
                    expected_revision: proposal.revision,
                  }),
                )
              }
            >
              延迟期结束，标记可执行
            </button>
          )}
          {proposal.state === 'ready_to_execute' && (
            <button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  request(apiBase, `governance/proposals/${proposal.id}/execute`, {
                    expected_revision: proposal.revision,
                    execution_id: `execution_${crypto.randomUUID().replaceAll('-', '')}`,
                  }),
                )
              }
            >
              执行（由服务端执行器确认）
            </button>
          )}
        </article>
      ))}

      <details>
        <summary>评估资格申请</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action(() =>
              request(apiBase, `qualifications/${String(form.get('application_id'))}/assess`, {
                expected_revision: Number(form.get('expected_revision')),
                decision: String(form.get('decision')),
                reason: String(form.get('reason')),
              }),
            );
          }}
        >
          <label>
            申请编号
            <input name="application_id" required />
          </label>
          <label>
            当前版本
            <input name="expected_revision" type="number" min={1} required />
          </label>
          <label>
            决定
            <select name="decision">
              <option value="approve">批准</option>
              <option value="reject">拒绝</option>
              <option value="request_info">请求补充</option>
            </select>
          </label>
          <label>
            理由
            <textarea name="reason" required maxLength={500} />
          </label>
          <button disabled={busy}>提交资格评估</button>
        </form>
      </details>

      <details>
        <summary>评估申诉</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action(() =>
              request(apiBase, `appeals/${String(form.get('appeal_id'))}/resolve`, {
                expected_revision: Number(form.get('expected_revision')),
                decision: String(form.get('decision')),
                reason: String(form.get('reason')),
              }),
            );
          }}
        >
          <label>
            申诉编号
            <input name="appeal_id" required />
          </label>
          <label>
            当前版本
            <input name="expected_revision" type="number" min={1} required />
          </label>
          <label>
            决定
            <select name="decision">
              <option value="confirm">确认原决定</option>
              <option value="adjust">更正</option>
              <option value="reject">驳回申诉</option>
              <option value="pause">暂停处理</option>
            </select>
          </label>
          <label>
            理由
            <textarea name="reason" required maxLength={500} />
          </label>
          <button disabled={busy}>提交申诉评估</button>
        </form>
      </details>
    </section>
  );
}
