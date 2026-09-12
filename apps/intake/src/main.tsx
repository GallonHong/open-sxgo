import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import '../../web/src/style.css';
async function request(path: string, body: unknown, receipt?: string, key?: string) {
  const response = await fetch('/private/v1/' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(receipt ? { 'X-WFD-Receipt': receipt } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = JSON.parse(await response.text());
  if (!response.ok) throw Error(result.error?.message ?? result.error?.code ?? '请求失败');
  return result;
}
function App() {
  return (
    <>
      <div className="demo-strip">可信投稿站 · 封闭演示，请勿提交真实个人信息</div>
      <header>
        <a className="wordmark" href="http://127.0.0.1:5173">
          <span className="mark">w</span>劳动友好目录
        </a>
        <nav>
          <Link to="/contribute">推荐企业</Link>
          <Link to="/receipt">查看投稿</Link>
          <Link to="/report">变化与纠错</Link>
          <a
            href={
              (import.meta.env.VITE_ADMIN_ORIGIN || 'http://localhost:5175') +
              '/member/contributions'
            }
          >
            贡献与资格
          </a>
        </nav>
      </header>
      <main className="auth-shell">
        <Routes>
          <Route path="/receipt" element={<Receipt />} />
          <Route path="/report" element={<Report />} />
          <Route path="*" element={<Contribute />} />
        </Routes>
      </main>
    </>
  );
}
function Contribute() {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ id: string; receipt: string | null }>(),
    [enabled, setEnabled] = useState(false);
  const key = useRef(crypto.randomUUID() + crypto.randomUUID());
  useEffect(() => {
    fetch('/private/v1/config')
      .then(async (r) => JSON.parse(await r.text()))
      .then((c) => setEnabled(c.intake_enabled))
      .catch(() => setError('投稿服务暂不可用，尚未保存任何内容。'));
  }, []);
  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    const urls = String(f.get('source_urls'))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      setResult(
        await request(
          'submissions',
          {
            legal_name: f.get('legal_name'),
            city: f.get('city'),
            scope: f.get('scope'),
            employment_type: f.get('employment_type'),
            conditions: [
              {
                dimension: 'rest_schedule',
                value: f.get('known'),
                description: f.get('condition'),
              },
            ],
            source_type: f.get('source_type'),
            source_urls: urls,
            notes: f.get('notes'),
          },
          undefined,
          key.current,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (result)
    return (
      <section className="panel">
        <div className="eyebrow">线索已安全保存</div>
        <h1>谢谢你的推荐。</h1>
        <p>工单号：{result.id}</p>
        <p>提交成功不代表企业已经通过核验。审核员会核对主体、来源和适用范围。</p>
        {result.receipt ? (
          <>
            <h2>保存你的私密回执</h2>
            <div className="receipt">{result.receipt}</div>
            <p>回执相当于访问钥匙，只显示于此。请勿分享给他人。丢失且无恢复文件时无法找回。</p>
            <button
              onClick={() => {
                const b = new Blob(
                  [
                    JSON.stringify({
                      format: 'wfd-receipt-v1',
                      id: result.id,
                      receipt: result.receipt,
                    }),
                  ],
                  { type: 'application/json' },
                );
                const u = URL.createObjectURL(b);
                const a = document.createElement('a');
                a.href = u;
                a.download = 'wfd-receipt.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(u), 1000);
              }}
            >
              下载本地恢复文件
            </button>
          </>
        ) : (
          <div className="notice">
            这是此前已保存的重复请求。请使用首次返回的回执；服务器不保存回执明文。
          </div>
        )}
        <Link className="brand-link" to="/receipt">
          凭回执查看进度 →
        </Link>
      </section>
    );
  return (
    <>
      <div className="eyebrow">CONTRIBUTE A PUBLIC SOURCE</div>
      <h1>推荐一家企业。</h1>
      <p className="muted">从你知道的公开资料开始。不清楚的项目，保持未知。</p>
      <div className="notice">
        不要填写姓名、手机号、身份证、工号、精确入离职日期、内部账号或同事信息。第一版不接收附件。
      </div>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      <form className="panel" onSubmit={submit}>
        <div className="form-grid">
          <label>
            完整企业名称
            <input name="legal_name" required maxLength={200} placeholder="请填写法律主体全名" />
          </label>
          <label>
            城市
            <input name="city" required maxLength={80} placeholder="如：长沙" />
          </label>
          <label>
            岗位或场所范围
            <input name="scope" required maxLength={200} placeholder="如：自营研发岗位" />
          </label>
          <label>
            用工类型
            <select name="employment_type">
              <option value="unknown">不清楚</option>
              <option value="full_time_employee">普通全日制劳动关系</option>
              <option value="other">其他，需专项核对</option>
            </select>
          </label>
          <label>
            休息安排资料
            <select name="known">
              <option value="unknown">不清楚</option>
              <option value="known">有公开资料支持</option>
            </select>
          </label>
          <label>
            所知制度
            <input name="condition" maxLength={300} placeholder="如：公开招聘页写明周末双休" />
          </label>
          <label>
            来源类型
            <select name="source_type">
              <option value="company">企业官网公开资料</option>
              <option value="recruitment">招聘平台</option>
              <option value="report">公开报告</option>
              <option value="personal_lead">个人线索（不授予实践标签）</option>
              <option value="business">企业代表提供公开资料</option>
            </select>
          </label>
          <label className="wide">
            公开来源链接
            <textarea
              name="source_urls"
              maxLength={10000}
              placeholder="https://… 每行一个公开 HTTPS 链接"
            />
          </label>
          <label className="wide">
            给审核员的说明（选填，最多 500 字）
            <textarea name="notes" maxLength={500} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" required />
          我了解此处仅接收公开来源线索，且演示环境不应提交真实个人资料。
        </label>
        <button type="submit" disabled={busy || !enabled}>
          {busy ? '正在保存…' : enabled ? '提交推荐' : '投稿暂未开放'}
        </button>
      </form>
    </>
  );
}
function Receipt() {
  const [receipt, setReceipt] = useState(''),
    [result, setResult] = useState<{
      id: string;
      state: string;
      version: number;
      messages: { author: string; body: string }[];
    }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(action: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      await request('submissions/' + action, body, receipt);
      setResult(await request('submissions/status', {}, receipt));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="eyebrow">PRIVATE RECEIPT</div>
      <h1>查看你的投稿。</h1>
      <p className="muted">公开工单号不能读取投稿。回执只通过受保护请求发送，不写入网址。</p>
      {error && (
        <div role="alert" className="message error">
          {error}
        </div>
      )}
      <section className="panel">
        <label>
          私密回执
          <input
            type="password"
            autoComplete="off"
            value={receipt}
            onChange={(e) => {
              setReceipt(e.target.value);
              setResult(undefined);
            }}
          />
        </label>
        <label>
          或读取本地恢复文件
          <input
            type="file"
            accept="application/json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 4096) {
                setError('恢复文件过大');
                return;
              }
              try {
                const data = JSON.parse(await f.text());
                if (data.format !== 'wfd-receipt-v1' || !/^[a-f0-9]{64}$/.test(data.receipt))
                  throw Error();
                setReceipt(data.receipt);
              } catch {
                setError('不是有效的回执恢复文件');
              }
            }}
          />
        </label>
        <p className="muted">文件仅在当前浏览器读取，不作为附件上传。</p>
        <button disabled={busy || receipt.length !== 64} onClick={() => run('status')}>
          查询进度
        </button>
      </section>
      {result && (
        <section className="panel">
          <h2>工单 {result.id}</h2>
          <p>当前状态：{result.state}</p>
          {result.messages.map((m, i) => (
            <div className="message" key={i}>
              <strong>{m.author === 'reviewer' ? '审核员' : '你的补充'}</strong>
              <p>{m.body}</p>
            </div>
          ))}
          {!['withdrawn', 'published', 'rejected'].includes(result.state) && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void run('supplements', {
                    message: f.get('message'),
                    source_urls: String(f.get('urls'))
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                }}
              >
                <label>
                  补充公开线索
                  <textarea name="message" required maxLength={500} />
                </label>
                <label>
                  公开来源链接
                  <textarea name="urls" />
                </label>
                <button disabled={busy}>提交补充</button>
              </form>
              <hr />
              <button
                className="ghost"
                disabled={busy}
                onClick={() => {
                  if (confirm('撤回将停止审核并清理未公开投稿内容，确定撤回？'))
                    void run('withdraw');
                }}
              >
                撤回未发布投稿
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}
function Report() {
  const [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <>
      <div className="eyebrow">CORRECTIONS & CHANGES</div>
      <h1>资料可能已变化？</h1>
      <p className="muted">反馈会进入私密核查，不直接公开原始内容，也不自动判断企业违法。</p>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {success ? (
        <div className="message" role="status">
          已收到反馈，工单号 {success}。感谢提供可核对的线索。
        </div>
      ) : (
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            const f = new FormData(e.currentTarget);
            try {
              const r = await request(
                f.get('kind') === 'privacy' ? 'privacy-requests' : 'change-reports',
                {
                  record_id: f.get('record') || null,
                  kind: f.get('kind'),
                  message: f.get('message'),
                  source_urls: String(f.get('urls'))
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              );
              setSuccess(r.id);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            反馈类别
            <select name="kind">
              <option value="change">劳动条件信息变化</option>
              <option value="link">错误或风险链接</option>
              <option value="impersonation">主体身份冒用</option>
              <option value="privacy">隐私或删除请求</option>
              <option value="appeal">对处理结果提出申诉</option>
            </select>
          </label>
          <label>
            相关公开记录 ID（选填）
            <input
              name="record"
              defaultValue={new URLSearchParams(location.search).get('record_id') ?? ''}
            />
          </label>
          <label>
            可以核对的线索
            <textarea name="message" required maxLength={500} />
          </label>
          <label>
            公开来源链接（每行一个）
            <textarea name="urls" />
          </label>
          <p className="muted">
            请勿提交身份证、同事信息或不必要的个人资料。隐私请求不会要求你再次提供过度身份证明。
          </p>
          <button disabled={busy}>提交反馈</button>
        </form>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
