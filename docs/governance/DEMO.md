# 封闭治理演示

这个演示只使用三个虚构成员、虚构授权和虚构案件。它用于验证身份绑定、范围授权、案件双席位和 WebAuthn 流程，不代表真实独立治理人员，也不授予生产发布资格。

从仓库根目录准备演示数据库：

```sh
pnpm exec tsx scripts/governance-demo.ts
```

数据库默认写入 `.runtime/private/governance-demo.db`，凭据写入同目录的 `governance-demo-credentials.txt`，模式文件写入 `governance-demo-mode.json`。这些文件在私密目录中；凭据和模式文件权限为 `0600`。脚本不会删除数据库、WAL 或 SHM 文件，重复运行只补齐缺少的演示记录，并保留已经发生的案件修改、撤权和分配状态。

如果迁移摘要已经变化，脚本会以 `MIGRATION_CHANGED` 停止并保留旧数据库。此时使用新的运行目录，不要删除旧文件：

```sh
run_dir="$PWD/.runtime/private/governance-demo-$(date +%Y%m%d-%H%M%S)"
WFD_GOVERNANCE_DEMO_DB="$run_dir/governance-demo.db" \
WFD_GOVERNANCE_DEMO_CREDENTIALS="$run_dir/credentials.txt" \
WFD_GOVERNANCE_DEMO_MODE="$run_dir/mode.json" \
pnpm exec tsx scripts/governance-demo.ts
```

从凭据文件读取一个虚构成员的邮箱和初始密码后，使用同一数据库启动私密 API。开发 API 默认绑定 `127.0.0.1:8787`；为浏览器 WebAuthn 演示，建议让管理 origin 使用 `localhost`，RP ID 和 origin 必须保持同一主机名：

```sh
export WFD_DB_PATH="$PWD/.runtime/private/governance-demo.db"
export WFD_ADMIN_ORIGIN="http://localhost:5175"
export WFD_INTAKE_ORIGIN="http://localhost:5174"
pnpm api
```

另开终端启动管理前台：

```sh
pnpm exec vite --config apps/admin/vite.config.ts --host localhost --port 5175
```

登录后进入 `/review/queue` 或 `/member/contributions`。首次认证器登记必须使用已批准的身份绑定；演示种子使用 `demo_seed` 绑定，仅用于封闭演示。高权限操作仍需要当前会话的 WebAuthn step-up。

可运行独立的 Chromium 虚拟认证器验收。该脚本会在自己的唯一临时目录创建数据库和 API，使用临时端口，完成真实浏览器 `navigator.credentials.create/get`、服务器签名校验、计数器更新和 session-bound step-up；结束时只清理自己创建的临时目录：

```sh
pnpm exec playwright install chromium
pnpm exec tsx tests/e2e-governance/webauthn.ts
```

本地 `http://localhost` 是 Chromium 认可的可信 WebAuthn origin；本次验证发现 Chromium 虚拟认证器拒绝把 `127.0.0.1` 用作该 RP ID，因此浏览器演示使用 `localhost`。真实部署必须使用 HTTPS、固定受控域名以及与配置完全匹配的 RP ID/origin。虚拟认证器不替代硬件认证器、跨浏览器测试或生产密钥验收。

演示不会启用生产发布、推广、真实来源抓取或真实人员登记。三个成员的 `person_id` 各不相同只是为了展示双席位数据结构，不能作为生产独立性证明。
