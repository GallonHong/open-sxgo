# 账号管理员说明

首管理员由部署方按项目所有者的明确指定完成 bootstrap，并建立 active 的人员身份与账号绑定。
其首个授权只应是 `account.provision`，范围为明确的 `role_ids: ["reviewer"]`；不要同时授予审核、
签名或发布能力。

首次进入流程：

1. 管理员预建账号后，在 `/admin` 使用密码登录。
2. 首次登录设置 TOTP，并用动态验证码完成验证。
3. 进入 `/admin/accounts`，在受控页面登记通行密钥（AuthenticatorPanel）。
4. 点击“验证本次操作”完成 WebAuthn step-up，再刷新人员列表。

创建 reviewer 需要填写邮箱、名称和 `person_id`。同一个真实人员必须始终使用同一个
`person_id`，不得用多个账号制造独立审核员。初始口令只通过私密下载交付，不自动发送邮件；
口令和数据库配置不得提交 Git。

新 reviewer 初始状态为 pending：`principal_identities` 与 `principal_accounts` 都必须经过
独立身份核验后改为 active；没有 active grant 不能审核。后续还需按资格、范围、利益冲突和审批
流程授予最小的 reviewer 能力。当前未激活完整审核功能时，只能说明账号已开户或待授权，不能宣称
完整双审链路已可用。

通用的 pending reviewer 开户 CLI 只创建 pending 账号，不授予审核权；它不能替代首管理员 bootstrap：

```sh
pnpm exec tsx scripts/provision-reviewer.ts \
  --email <reviewer-email> \
  --person-id <person_id> \
  --database-config-file <private-pg-json> \
  --output <private-credentials-json>
```

数据库配置和输出 JSON 必须是私密文件；输出文件包含一次性初始口令，禁止覆盖已有文件、写入日志
或发送邮件。不要把真实邮箱、账号 ID、口令或其他 secret 写进文档。首管理员 bootstrap 与后续
权限激活由部署方按项目所有者批准完成；完整双审链路需在相应功能、资格授权和双人验收完成后另行确认。
