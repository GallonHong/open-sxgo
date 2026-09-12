# 治理业务签名 v2（P0）

本目录只实现 P0 的 `role.revoke` 执行签名。它把登录认证、治理业务签名和 TUF 发布签名分开：WebAuthn 只证明当前会话完成了认证，不能被宣传为个人 Ed25519 业务签名；TUF 仍按自己的元数据格式验证。旧版 `wfd-reviewer-authority-v1` 的历史校验和公开字段保持不变，不能把 v2 的私密人员映射回填到旧公共投影。

## 信封和字节

治理信封的 `signed` 是严格 v2 负载，`event_id` 和 `signatures` 在外层。未知字段、重复 JSON 键、非安全整数、通配范围和超长数组由 Schema 拒绝。P0 负载必须包含 `event_type`、`purpose`、`environment`、`policy_version`、提案与目标版本、批准依据以及事件和目标授权的有效期。

```text
signed_bytes = UTF8("WFD-SIGNED-OBJECT-v1\n") || UTF8(JCS(payload))
event_id = "sha256:" + HEX(SHA256(signed_bytes))
signature = Ed25519.Sign(private_key, signed_bytes)
```

`event_id` 不进入 `signed` 的散列输入；每一位签署者必须对同一份规范负载签名。`governanceAuthority` 是私密的根委派授权声明，含 `person_id`、公钥、能力、范围、有效期、政策版本和修订号。它先由受信根 2-of-3 签名验证，再用于验证业务信封；它不属于 `governance-export` 的 PUB 数据。

可信根也绑定 `environment`；内存适配器直接读取 `AuthorityTrust.environment`，TUF 根则读取受信 `custom.environment`。缺少环境或环境与授权声明不一致时，根签名无效，因此 demo 根不能给 production 授权背书。

`role.revoke` 的目标同时签入 `grant_id` 和 `target_principal_id`，并签入角色、能力、完整范围及授权时间。授权签署者的 `scope.role_ids` 必须列出被撤的 `grant_id`；被撤授权自身可以使用 `case_ids` 等正常业务范围，不能要求它把自己的 grant id 填进 `role_ids`。执行时会重新读取当前 grant，确认这两个目标标识、角色、能力、范围和时间仍一致。

业务签名由登记的独立业务 Ed25519 公钥完成。信封至少需要两把来自不同 canonical person 的签名；同一个人更换或增加密钥不会增加人数。执行器还会在数据库中重新确认每位签署者的 active `principal_identity`、active business key、人员绑定、有效期、当前政策版本和包含目标 grant 的 `role.revoke` 授权。根声明的静态快照不能替代这些检查。

## 离线签署工具

工具一次只读取一个本地私有 JWK、一个完整待签负载、一个根验证后的授权信封来源文件和一个可信根文件，不访问网站、HTTP 服务或中央私钥库。输入文件在读取前检查为普通文件且不超过 1 MiB，并使用拒绝重复键的解析器。签名前会显示事件编号、目标成员标识、角色和能力、完整范围、授权及目标有效期、政策/提案/授权版本、依据、原因和完整 JCS 负载。

第一次签署生成一个明确的 partial 信封：

```sh
pnpm tsx scripts/governance-sign.ts \
  payload.json authority.json trust-root.json member-1.jwk.json \
  signed-1.json \
  --confirm-event-id sha256:<payload-event-id>
```

第二位独立人员读取第一份信封，重新查看同一内容并绑定同一个摘要：

```sh
pnpm tsx scripts/governance-sign.ts \
  payload.json authority.json trust-root.json member-2.jwk.json \
  signed-complete.json \
  --input-envelope signed-1.json \
  --confirm-event-id sha256:<payload-event-id>
```

确认值必须是完整 `event_id`；工具不接受没有摘要绑定的 `--yes` 或裸“确认”。有两把签名时，工具再次执行 v2 信封验证后才报告 `complete: true`；一把签名只报告 `partial`。输出文件使用 `0600` 且采用独占创建，私钥不会写入输出。

## 在线执行挂载

生产路由应把真实执行器注入 `GovernanceService.execute`，而不是接受请求体中的 `succeeded` 或执行结果：

```ts
const executor = createRoleRevokeExecutor({
  db,
  environment: config.mode === 'production' ? 'production' : 'demo',
  loadEnvelope: (input) => executionStore.read(input.proposal_id, input.proposal_revision),
  loadAuthorization: (input) => authorityStore.read(input.proposal_id, input.proposal_revision),
  authorityTrust: () => trustStore.read(),
  policyVersion: () => livePolicy.policy_version,
  authorizeCurrent: async (input) => {
    const identity = await resolveExecutionIdentity(input.actor_principal_id);
    return authorize(db, identity, {
      capability: 'role.execute',
      object_type: 'role',
      object_id: input.object_id,
      scope: { role_ids: [input.object_id] },
      required_assurance: 'webauthn_step_up',
    });
  },
});
```

`loadAuthorization` 返回的授权声明必须由当前部署的可信根验证；如果部署使用外部根验证器，可以注入 `verifyAuthorization`，但它仍需在每次执行返回当前可信声明。`authorizeCurrent` 必须只在服务端根据 session 身份解析，不能信任请求中的 actor、范围或资格。

撤权执行器在同一个数据库事务中比较 `governance_proposals` 的 `ready_to_execute` 状态、提案修订和 `payload_digest`，再撤销 grant、会话、业务密钥、案件/任务授权，写出站事件、审计和 `governance_execution_receipts`。迁移 `0007_governance_execution.sql` 使同一 `execution_id` 的重试返回原结果；同 key 的不同提案版本或摘要会拒绝，另一个 execution key 不能重复执行同一提案版本。若事务或可信授权不可用，默认拒绝。

## 上线边界

这是 P0 的治理签名协议和 `role.revoke` 真实执行切片，不代表完整 G4 或生产信任已经启用。生产仍需三名真实且独立的根保管人、独立业务密钥登记、独立授权人员、两个独立副本和恢复演练；缺少这些人员或信任根时保持封闭演示/只读。成熟选举、附件和 3-of-5 迁移不属于此实现。任何 v2 业务签名都不能单独证明事实正确，也不能绕过当前撤销、回避、政策版本或发布门槛。
