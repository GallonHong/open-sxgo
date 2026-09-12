import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/src/style.css';
import { ProposalEditor } from './ProposalEditor';
import { MemberWorkspace } from './MemberWorkspace';
import { OperationsWorkspace } from './OperationsWorkspace';
import { AccountManagement } from './AccountManagement';
type Item = {
  id: string;
  kind: string;
  state: string;
  version: number;
  created_at: string;
  body?: unknown;
};
type Proposal = {
  id: string;
  state: string;
  company_id: string;
  body: string;
  author_person: string;
  expected_revision: number;
};
async function api(path: string, body?: unknown) {
  const r = await fetch('/admin/v1/' + path, {
    credentials: 'same-origin',
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = JSON.parse(await r.text());
  if (!r.ok) throw Error(value.error?.code ?? value.code ?? value.message ?? '请求未完成');
  return value;
}
function App() {
  async function enterMemberWorkspace() {
    const session = await api('auth/get-session');
    if (!session?.user?.twoFactorEnabled) return;
    const response = await fetch('/private/v1/member', { credentials: 'same-origin' });
    if (response.ok) {
      const member = (await response.json()) as {
        grants?: { capabilities: string[]; status: string }[];
      };
      const administrator = member.grants?.some(
        (g: { capabilities: string[]; status: string }) =>
          g.status === 'active' && g.capabilities.includes('account.provision'),
      );
      location.assign(administrator ? '/admin/accounts' : '/member/contributions');
    }
  }
  const [me, setMe] = useState<{ person_id: string; roles: string[] }>(),
    [tab, setTab] = useState('queue'),
    [items, setItems] = useState<Item[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [selected, setSelected] = useState<Item>(),
    [metrics, setMetrics] = useState<unknown>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [totp, setTotp] = useState(false),
    [signedIn, setSignedIn] = useState(false),
    [mfaEnabled, setMfaEnabled] = useState(false),
    [setup, setSetup] = useState<{ totpURI?: string; backupCodes?: string[] }>(),
    [password, setPassword] = useState('');
  async function refresh() {
    try {
      const session = await api('auth/get-session');
      setSignedIn(!!session?.user);
      setMfaEnabled(!!session?.user?.twoFactorEnabled);
      if (!session?.user) return;
      if (!session.user.twoFactorEnabled) return;
      await enterMemberWorkspace();
      setMe(await api('me'));
      setItems((await api('work-items')).items);
      setProposals((await api('proposals')).items);
    } catch (e) {
      const code = (e as Error).message;
      if (
        [
          'AUTH_REQUIRED',
          'UNAUTHORIZED',
          'LEGACY_AUTHORIZATION_DISABLED',
          'CAPABILITY_DENIED',
        ].includes(code)
      ) {
        setNotice('登录验证已完成。账号的人员绑定或权限仍待管理员确认。');
      } else setError(code);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice('操作已保存');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="demo-strip">审核与治理 · 私密工作区 · 生产发布保持关闭</div>
      <header>
        <a href="/member/contributions">我的贡献与资格</a>
        <a href="/review/queue">独立双审</a>
        <a href="/governance/approvals">过渡治理</a>
        <a className="wordmark" href={import.meta.env.DEV ? 'http://127.0.0.1:5173' : '/'}>
          <span className="mark">w</span>WFD 审核工作台
        </a>
        {me && (
          <>
            <span className="muted">{me.person_id}</span>
            <button
              className="ghost"
              onClick={() =>
                action(async () => {
                  await api('auth/sign-out', {});
                  setMe(undefined);
                })
              }
            >
              退出
            </button>
          </>
        )}
      </header>
      <main className={me ? 'admin-layout' : 'auth-shell'}>
        {error && (
          <div className="message error" role="alert">
            {error === 'AUTH_REQUIRED'
              ? '请使用受邀审核员账号登录。'
              : error === 'MFA_REQUIRED'
                ? '请先完成双因素认证和独立人员登记。'
                : error}
          </div>
        )}
        {notice && (
          <div className="message" role="status">
            {notice}
          </div>
        )}
        {!me ? (
          <section className="panel">
            <h1>审核员登录</h1>
            <p>
              邀请制账号。密码登录后完成所需认证；审核和治理操作还需要安全密钥或通行密钥再次确认。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(async () => {
                  const r = await api('auth/sign-in/email', { email: f.get('email'), password });
                  if (r.twoFactorRedirect) setTotp(true);
                  else await enterMemberWorkspace();
                });
              }}
            >
              <label>
                邮箱
                <input name="email" type="email" required autoComplete="username" />
              </label>
              <label>
                密码
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <button>使用密码登录</button>
            </form>
            {(totp || setup) && (
              <>
                <hr />
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void action(async () => {
                      await api('auth/two-factor/verify-totp', { code: f.get('code') });
                      setTotp(false);
                      setSetup(undefined);
                      setPassword('');
                      await enterMemberWorkspace();
                    });
                  }}
                >
                  <label>
                    动态验证码
                    <input
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                    />
                  </label>
                  <button>验证并进入工作台</button>
                </form>
              </>
            )}
            {signedIn && !mfaEnabled && (
              <>
                <hr />
                <p>密码已验证。请设置个人验证器，再输入它生成的六位验证码。</p>
                {!password && <p>如刚刷新页面，请先在上方密码框重新输入账号密码。</p>}
                <button
                  className="ghost"
                  disabled={!password}
                  onClick={() =>
                    action(async () => {
                      setSetup(await api('auth/two-factor/enable', { password, method: 'totp' }));
                    })
                  }
                >
                  首次登录：设置验证器
                </button>
                {setup && (
                  <div>
                    <p>在你的身份验证器中添加以下 TOTP 地址，并输入生成的六位验证码完成设置。</p>
                    <pre>{setup.totpURI}</pre>
                    <h2>恢复码：请保存到个人密码管理器</h2>
                    <pre>{setup.backupCodes?.join('\n')}</pre>
                  </div>
                )}
              </>
            )}
            <p className="muted">
              账号由管理员建立；动态验证码来自本人绑定的验证器，不通过邮件发送。生产审核不得用同一自然人的多个账号代替独立复核。
            </p>
          </section>
        ) : (
          <>
            <div className="stack">
              {[
                ['queue', '待办队列'],
                ['review', '独立复核'],
                ['operations', '运营状态'],
                ['release', '发布候选'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? '' : 'ghost'}
                  onClick={() => {
                    setTab(key);
                    if (key === 'operations')
                      void action(async () => setMetrics(await api('metrics')));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'queue' && (
              <div className="detail-columns">
                <section className="panel">
                  <h2>待处理线索</h2>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>工单</th>
                        <th>类型</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.id.slice(0, 14)}…</td>
                          <td>{item.kind}</td>
                          <td>{item.state}</td>
                          <td>
                            <button
                              className="ghost small"
                              onClick={() =>
                                action(async () => setSelected(await api('work-items/' + item.id)))
                              }
                            >
                              查看
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!items.length && <p>尚无待处理线索。</p>}
                </section>
                <section className="panel">
                  <h2>线索核对</h2>
                  {selected ? (
                    <>
                      <p>{selected.id}</p>
                      <p>
                        状态 {selected.state} / 版本 {selected.version}
                      </p>
                      <pre>{JSON.stringify(selected.body, null, 2)}</pre>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void action(async () => {
                            await api('work-items/' + selected.id + '/transition', {
                              state: f.get('state'),
                              expected_revision: selected.version,
                              reason: f.get('reason'),
                            });
                            setSelected(await api('work-items/' + selected.id));
                          });
                        }}
                      >
                        <label>
                          处理结果
                          <select name="state">
                            <option value="triaged">完成分流</option>
                            <option value="in_review">进入初审</option>
                            <option value="needs_info">请求补充</option>
                            <option value="out_of_scope">超出范围</option>
                            <option value="rejected">不予采用</option>
                          </select>
                        </label>
                        <label>
                          内部理由
                          <textarea name="reason" maxLength={500} required />
                        </label>
                        <button>保存处理</button>
                      </form>
                      <hr />
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const f = new FormData(e.currentTarget);
                          void action(() =>
                            api('work-items/' + selected.id + '/message', {
                              message: f.get('message'),
                            }),
                          );
                        }}
                      >
                        <label>
                          给推荐人的问题
                          <textarea name="message" required maxLength={500} />
                        </label>
                        <button className="ghost">保存补充请求</button>
                      </form>
                      <hr />
                      <h2>提交公开候选</h2>
                      <ProposalEditor
                        key={selected.id}
                        submissionId={selected.id}
                        initial={selected.body}
                        onSubmit={(value) => action(() => api('proposals', value))}
                      />
                      <details>
                        <summary>高级：导入版本化公开候选</summary>
                        <p>
                          仅粘贴已核对的公开白名单对象。包含私密字段或不完整关系的内容会被拒绝。
                        </p>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const f = new FormData(e.currentTarget);
                            void action(() =>
                              api('proposals', JSON.parse(String(f.get('proposal')))),
                            );
                          }}
                        >
                          <label>
                            候选 JSON
                            <textarea name="proposal" required rows={10} />
                          </label>
                          <button>提交独立复核</button>
                        </form>
                      </details>
                    </>
                  ) : (
                    <p>选择一条线索开始。主体、来源、适用范围和利益关系应逐项核对。</p>
                  )}
                </section>
              </div>
            )}
            {tab === 'review' && (
              <section className="panel">
                <h2>独立复核</h2>
                {proposals.map((p) => (
                  <section className="source" key={p.id}>
                    <h2>{p.company_id}</h2>
                    <p>
                      {p.state} / 初审人员 {p.author_person} / 基础版本 {p.expected_revision}
                    </p>
                    <details>
                      <summary>查看拟公开对象</summary>
                      <pre>{JSON.stringify(JSON.parse(p.body), null, 2)}</pre>
                    </details>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void action(() =>
                          api('proposals/' + p.id + '/review', {
                            action: f.get('action'),
                            reason: f.get('reason'),
                          }),
                        );
                      }}
                    >
                      <label>
                        复核意见
                        <textarea required name="reason" maxLength={500} />
                      </label>
                      <label>
                        决定
                        <select name="action">
                          <option value="return">退回修改</option>
                          <option value="approve">批准公开候选</option>
                          <option value="reject">否决</option>
                        </select>
                      </label>
                      <button
                        disabled={p.state !== 'second_review' || p.author_person === me.person_id}
                      >
                        保存独立复核
                      </button>
                    </form>
                  </section>
                ))}
                {!proposals.length && <p>暂无候选。无独立第二人时保持待审核。</p>}
              </section>
            )}
            {tab === 'operations' && (
              <section className="panel">
                <h2>运营状态</h2>
                <pre>{JSON.stringify(metrics, null, 2)}</pre>
                <p>生产开关关闭。真实额度、独立镜像、人员排班和上线审查尚待配置与演练。</p>
              </section>
            )}
            {tab === 'release' && (
              <section className="panel">
                <h2>生成批准对象导出</h2>
                <p>仅导出完成双人审核的公开对象。候选不等同于已签名发布。</p>
                <button
                  onClick={() =>
                    action(async () => {
                      const result = await api('releases/build', {});
                      const u = URL.createObjectURL(
                        new Blob([JSON.stringify(result.approved, null, 2)], {
                          type: 'application/json',
                        }),
                      );
                      const a = document.createElement('a');
                      a.href = u;
                      a.download = 'wfd-approved-public-input.json';
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(u), 1000);
                    })
                  }
                >
                  下载批准的公开候选
                </button>
                <p>发布还需独立签名、两个副本校验和上线门槛。后台不持有生产私钥。</p>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  location.pathname === '/admin/accounts' ? (
    <AccountManagement />
  ) : location.pathname.startsWith('/member/') ? (
    <MemberWorkspace />
  ) : location.pathname.startsWith('/review/') || location.pathname.startsWith('/governance/') ? (
    <OperationsWorkspace />
  ) : (
    <App />
  ),
);
