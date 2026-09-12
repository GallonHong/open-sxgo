import React, { useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

async function post(path: string, body: unknown) {
  const response = await fetch('/admin/v1/security/webauthn/' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = JSON.parse(await response.text());
  if (!response.ok) throw Error(result.error?.code ?? 'AUTHENTICATION_FAILED');
  return result;
}
export function AuthenticatorPanel() {
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(register: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const path = register ? 'registration' : 'step-up';
      const challenge = await post(path + '/options', {});
      const response = register
        ? await startRegistration({ optionsJSON: challenge.options })
        : await startAuthentication({ optionsJSON: challenge.options });
      await post(path + '/verify', { challenge_id: challenge.challenge_id, response });
      setMessage(
        register ? '认证器已登记。请另行登记独立的备用认证器。' : '已完成本次会话的敏感操作认证。',
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>认证器与敏感操作</h2>
      <p>敏感操作需要安全密钥或通行密钥确认。业务签署使用另行登记的签名密钥。</p>
      <div className="community-nav">
        <button disabled={busy} onClick={() => void run(false)}>
          验证本次操作
        </button>
        <button className="ghost" disabled={busy} onClick={() => void run(true)}>
          登记认证器
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      <p className="muted">账号恢复不会自动恢复职责。请只在预先保存的受控入口操作。</p>
    </section>
  );
}
