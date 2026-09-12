import React, { useCallback, useEffect, useState } from 'react';
import { AuthenticatorPanel } from './AuthenticatorPanel';

type Account = {
  user_id: string;
  email: string;
  name: string;
  principal_id: string | null;
  person_id: string | null;
  account_status: string | null;
  person_status: string | null;
};

type AccountResult = {
  email: string;
  initial_password: string;
};

const errorMessages: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '请先登录管理员账号。',
  CAPABILITY_DENIED: '当前账号没有建立审核员账号的权限。',
  MFA_SETUP_REQUIRED: '请先设置并验证动态验证码。',
  WEBAUTHN_STEP_UP_REQUIRED: '请先完成本次操作的 WebAuthn 敏感操作确认。',
  ORIGIN_REJECTED: '请求来源未通过校验。',
  INVALID_INPUT: '请检查邮箱、人员编号和姓名。',
  EMAIL_ALREADY_EXISTS: '该邮箱已经存在。',
  PERSON_ALREADY_EXISTS: '该人员编号已经绑定。',
  BODY_TOO_LARGE: '请求内容过大。',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
};

function readableError(error: unknown): string {
  const code = error instanceof Error ? error.message : 'SERVICE_UNAVAILABLE';
  return errorMessages[code] ?? '操作未完成，请稍后重试。';
}

async function parseResponse(response: Response): Promise<Record<string, any>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw Error('SERVICE_UNAVAILABLE');
  }
  if (!response.ok) {
    const code =
      value && typeof value === 'object' && 'error' in value
        ? (value as { error?: { code?: unknown } }).error?.code
        : undefined;
    throw Error(typeof code === 'string' ? code : 'SERVICE_UNAVAILABLE');
  }
  return value as Record<string, any>;
}

async function accountsApi(path: string, init?: RequestInit) {
  const response = await fetch('/admin/v1/' + path, {
    credentials: 'same-origin',
    ...init,
  });
  return parseResponse(response);
}

function downloadCredentials(result: AccountResult) {
  const blob = new Blob(
    [JSON.stringify({ email: result.email, initial_password: result.initial_password }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'sxgo-reviewer-login.json';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AccountManagement() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState('');
  const [personId, setPersonId] = useState('');
  const [name, setName] = useState('');
  const [newCredentials, setNewCredentials] = useState<AccountResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const result = await accountsApi('accounts');
    setAccounts(Array.isArray(result.items) ? (result.items as Account[]) : []);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(readableError(e)));
  }, [refresh]);

  async function refreshAccounts() {
    setError('');
    try {
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setNewCredentials(undefined);
    try {
      const result = (await accountsApi('accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, person_id: personId, name }),
      })) as AccountResult;
      setNewCredentials(result);
      setEmail('');
      setPersonId('');
      setName('');
      setNotice('审核员账号已建立，仍需完成独立人员确认和激活。');
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="demo-strip">审核与治理 · 私密工作区 · 账号建立不发送邮件</div>
      <header>
        <nav className="community-nav" aria-label="后台导航">
          <a href="/admin">后台工作台</a>
          <a href="/admin/accounts" aria-current="page">
            账号管理
          </a>
          <a href="/member/contributions">我的贡献与资格</a>
          <button
            className="ghost"
            onClick={async () => {
              try {
                await accountsApi('auth/sign-out', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}',
                });
                location.assign('/admin');
              } catch (e) {
                setError(readableError(e));
              }
            }}
          >
            退出登录
          </button>
        </nav>
      </header>
      <main className="admin-layout">
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
        <section className="panel">
          <h1>审核员账号管理</h1>
          <p>
            只有完成动态验证码和本次 WebAuthn
            敏感操作确认的账号管理员可以建立账号。新账号先处于待激活状态，不会自动获得审核权限。
          </p>
          <AuthenticatorPanel />
          <button className="ghost" type="button" onClick={() => void refreshAccounts()}>
            刷新账号列表
          </button>
          <form onSubmit={(event) => void createAccount(event)}>
            <label>
              邮箱
              <input
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <label>
              人员编号
              <input
                name="person_id"
                pattern="person_[a-z0-9_-]{3,120}"
                placeholder="例如 person_reviewer_001"
                value={personId}
                onChange={(event) => setPersonId(event.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <label>
              姓名
              <input
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <button disabled={busy}>{busy ? '正在建立…' : '建立待激活审核员账号'}</button>
          </form>
        </section>
        {newCredentials && (
          <section className="panel" aria-live="polite">
            <h2>新账号私密登录信息</h2>
            <p>初始口令只在本次结果中提供。请下载并交给指定人员，然后清除页面上的口令。</p>
            <dl>
              <dt>邮箱</dt>
              <dd>{newCredentials.email}</dd>
              <dt>初始口令</dt>
              <dd>
                <code>{newCredentials.initial_password}</code>
              </dd>
            </dl>
            <div className="community-nav">
              <button onClick={() => downloadCredentials(newCredentials)}>下载私密登录信息</button>
              <button className="ghost" onClick={() => setNewCredentials(undefined)}>
                清除初始口令
              </button>
            </div>
          </section>
        )}
        <section className="panel">
          <h2>账号与人员绑定</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>姓名</th>
                <th>人员编号</th>
                <th>账号状态</th>
                <th>人员状态</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.user_id}>
                  <td>{account.email}</td>
                  <td>{account.name}</td>
                  <td>{account.person_id ?? '未绑定'}</td>
                  <td>{account.account_status ?? '未绑定'}</td>
                  <td>{account.person_status ?? '未绑定'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!accounts.length && <p>尚无账号记录。</p>}
        </section>
      </main>
    </>
  );
}
