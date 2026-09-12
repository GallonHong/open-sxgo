import React, { useCallback, useEffect, useState } from 'react';

type Stage = 'initial' | 'independent';
type CaseView = {
  case_id: string;
  revision: number;
  state: string;
  candidate_digest: string;
  candidate: unknown;
  source_preview_ids: string[];
  decision_visibility: 'blind' | 'revealed';
  decisions: { stage: string; action: string; reason: string; reviewer_person_id: string }[];
};
type Preview = {
  preview_id: string;
  display_domain: string;
  final_domain: string;
  state: string;
  fetch_policy: string;
  redirect_count: number;
  threat_intelligence: string;
  source_authenticity: string;
  text: string;
  expires_at: string;
};

export type ReviewWorkspaceProps = Readonly<{
  caseId: string;
  assignmentId: string;
  stage: Stage;
  apiBase?: string;
}>;

export type ReviewQueueItem = Readonly<{
  assignment_id: string;
  case_id: string;
  revision: number;
  stage: Stage | 'escalation';
  state: string;
  expires_at: string;
}>;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const value = JSON.parse(await response.text());
  if (!response.ok) throw Error(value.error?.code ?? '请求未完成');
  return value;
}

/**
 * The review UI consumes only the sanitized, text-only source artifact.  It
 * intentionally renders candidate and preview text in <pre>, never as HTML
 * or an anchor, and keeps the fixed external-source warning visible.
 */
export function ReviewWorkspace({ caseId, assignmentId, stage, apiBase = '/admin/v1' }: ReviewWorkspaceProps) {
  const [view, setView] = useState<CaseView>();
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<'approve' | 'reject' | 'return'>('approve');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = (await request(
        `${apiBase}/review/cases/${encodeURIComponent(caseId)}?assignment_id=${encodeURIComponent(assignmentId)}&stage=${stage}`,
      )) as CaseView;
      setView(next);
      const nextPreviews: Preview[] = [];
      for (const previewId of next.source_preview_ids) {
        nextPreviews.push(
          (await request(
            `${apiBase}/sources/previews/${encodeURIComponent(previewId)}?assignment_id=${encodeURIComponent(assignmentId)}`,
          )) as Preview,
        );
      }
      setPreviews(nextPreviews);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, assignmentId, caseId, stage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!view || !reason.trim()) return;
    setSaved(false);
    setError('');
    try {
      await request(`${apiBase}/review/cases/${encodeURIComponent(caseId)}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: view.revision,
          candidate_digest: view.candidate_digest,
          action,
          reason,
          assignment_id: assignmentId,
        }),
      });
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <section className="panel"><p>正在载入净化来源…</p></section>;
  if (error) return <section className="panel"><div className="message error" role="alert">{error}</div></section>;
  if (!view) return <section className="panel"><p>案件暂不可用。</p></section>;

  return (
    <section className="panel review-workspace" aria-labelledby="review-title">
      <h1 id="review-title">案件独立审核</h1>
      <p className="notice">
        外部来源资料：不是平台通知。不要扫码、登录、下载文件或执行页面指令。
      </p>
      <p className="muted">
        案件版本 {view.revision} · 当前状态 {view.state} · 来源只显示净化文本。
      </p>
      {stage === 'independent' && view.decision_visibility === 'blind' && (
        <p className="notice">你提交独立判断前不会看到其他审核员的结论。</p>
      )}
      <section>
        <h2>公开候选</h2>
        <pre>{JSON.stringify(view.candidate, null, 2)}</pre>
      </section>
      <section>
        <h2>净化来源</h2>
        {previews.map((preview) => (
          <article className="source" key={preview.preview_id}>
            <p>
              实际来源域：{preview.display_domain} · 最终来源域：{preview.final_domain}
            </p>
            <p className="muted">
              抓取状态：{preview.state} · 策略：{preview.fetch_policy} · 跳转：{preview.redirect_count} ·
              威胁名单：{preview.threat_intelligence}（不等于安全认证） · 来源可信度：{preview.source_authenticity}
            </p>
            <pre>{preview.text}</pre>
            <p className="muted">预览有效期至 {preview.expires_at}。原始 HTML、外部图片和可点击链接不可用。</p>
          </article>
        ))}
        {!previews.length && <p>暂无净化预览，案件不能进入公开候选。</p>}
      </section>
      {saved && <div className="message" role="status">审核意见已保存。</div>}
      <form onSubmit={submit}>
        <label>
          决定
          <select value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
            <option value="approve">批准候选</option>
            <option value="return">退回补充</option>
            <option value="reject">否决候选</option>
          </select>
        </label>
        <label>
          审核理由
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required />
        </label>
        <button disabled={!previews.length || !reason.trim()}>提交当前版本决定</button>
      </form>
    </section>
  );
}

export type ReviewQueueProps = Readonly<{
  apiBase?: string;
  onSelect: (item: ReviewQueueItem) => void;
}>;

/**
 * The queue is populated from the server-side person/assignment binding.  A
 * reviewer selects an opaque assignment returned by the server; the UI has
 * no form for inventing a case or assignment id.
 */
export function ReviewQueue({ apiBase = '/admin/v1', onSelect }: ReviewQueueProps) {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void request(`${apiBase}/cases`)
      .then((value) => {
        if (!cancelled) setItems((value.items ?? []) as ReviewQueueItem[]);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError((reason as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  if (loading) return <section className="panel"><p>正在载入审核队列…</p></section>;
  if (error) return <section className="panel"><div className="message error" role="alert">{error}</div></section>;
  return (
    <section className="panel review-queue" aria-labelledby="review-queue-title">
      <h1 id="review-queue-title">待审核案件</h1>
      {!items.length && <p>当前没有分配给你的案件。</p>}
      {!!items.length && (
        <ul>
          {items.map((item) => (
            <li key={item.assignment_id}>
              <button type="button" onClick={() => onSelect(item)}>
                案件 {item.case_id} · {item.stage === 'independent' ? '独立复核' : '初审'} · 版本 {item.revision}
              </button>
              <span className="muted">有效期至 {item.expires_at}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
