import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { ReviewWorkspace } from './ReviewWorkspace';
import { GovernanceWorkspace } from './GovernanceWorkspace';
import { AuthenticatorPanel } from './AuthenticatorPanel';
const assignment = z.object({
  case_id: z.string(),
  assignment_id: z.string(),
  revision: z.number(),
  stage: z.enum(['initial', 'independent', 'escalation']),
  expires_at: z.string(),
});
type Assignment = z.infer<typeof assignment>;
export function OperationsWorkspace() {
  const governance = location.pathname.startsWith('/governance/');
  const [items, setItems] = useState<Assignment[]>([]),
    [selected, setSelected] = useState<Assignment>(),
    [error, setError] = useState('');
  async function refresh() {
    try {
      const r = await fetch('/admin/v1/cases', { credentials: 'same-origin' });
      const value = JSON.parse(await r.text());
      if (!r.ok) throw Error(value.error?.code ?? 'REQUEST_FAILED');
      setItems(z.object({ items: z.array(assignment) }).parse(value).items);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!governance) void refresh();
  }, [governance]);
  return (
    <>
      <div className="demo-strip">受控工作区 · 开发演示 · 正式发布与未知来源抓取关闭</div>
      <header>
        <a className="wordmark" href="/">
          <span className="mark">w</span>WFD 审核与治理
        </a>
        <nav>
          <a href="/member/contributions">我的贡献</a>
          <a href="/review/queue">分配给我的案件</a>
          <a href="/governance/approvals">过渡治理</a>
          <a href="/">账号登录</a>
        </nav>
      </header>
      <main className="page">
        <AuthenticatorPanel />
        {governance ? (
          <GovernanceWorkspace />
        ) : (
          <>
            <div className="eyebrow">INDEPENDENT REVIEW</div>
            <h1>分配给我的案件</h1>
            <p>只显示你当前获授权的案件。第二次独立判断提交前，第一人的结论保持隐藏。</p>
            <button className="ghost" onClick={() => void refresh()}>
              刷新分配
            </button>
            {error && (
              <div role="alert" className="message error">
                {error}
              </div>
            )}
            <div className="community-grid">
              {items.map((item) => (
                <button
                  className="panel"
                  key={item.assignment_id}
                  disabled={item.stage === 'escalation'}
                  onClick={() => setSelected(item)}
                >
                  {item.stage === 'initial'
                    ? '初审'
                    : item.stage === 'independent'
                      ? '独立复核'
                      : '等待争议协调'}{' '}
                  · {item.case_id}
                  <br />
                  版本 {item.revision} · 至 {item.expires_at.slice(0, 10)}
                </button>
              ))}
            </div>
            {!items.length && !error && (
              <p className="muted">当前没有待处理分配。人数不足或来源未就绪时，案件会继续排队。</p>
            )}
            {selected && selected.stage !== 'escalation' && (
              <ReviewWorkspace
                key={selected.assignment_id}
                caseId={selected.case_id}
                assignmentId={selected.assignment_id}
                stage={selected.stage}
              />
            )}
          </>
        )}
      </main>
    </>
  );
}
