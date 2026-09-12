# 来源处理与独立双审记录

日期：2026-09-12。本文记录 G2 当前封闭演示实现，不代表生产隔离或上线门槛已经完成。

当前闭环是：`case.prepare` 创建 `current_revision=1` 的公开候选（初始
`source_preview_ids` 可以为空）→ 来源任务只保存私密原始 URL 并返回 opaque
`job_id` → 允许域静态来源在独立处理区生成 text-only 净化预览 →
`case.prepare` 将未过期且同 case/revision 的 `sanitized_preview_ready` 预览绑定到
初稿 → identity 服务以 `case_assignments` 分配 primary/secondary → initial 与
independent 对同一 revision 和候选摘要分别作决定。没有有效净化预览时，决定接口
返回 `SOURCE_PREVIEW_REQUIRED`；同一 `person_id` 不能占两席。改版会使旧 revision
失效并重新要求分配和双审，未解决隐私、主体、来源伪造、钓鱼、范围或重大利益冲突
时不得发布。

审核 API 由 `createReviewRoutes(db, resolveIdentity, options)` 提供，宿主通常挂载在
`/admin/v1` 下。`GET /cases` 只返回当前 session 对应人员的当前分配；候选、决定、
预览和绑定接口不接受请求体内的 actor。直接路径包含 `/cases`、
`/cases/:id/decision`、`/cases/:id/previews`、`/sources/:sourceId/fetch` 和
`/sources/:sourceId/preview`，旧 `/review/*` 路径保留兼容。生产适配器每次重新检查
Better Auth 映射后的 identity、WebAuthn step-up、实时 grant、范围、assignment、
冲突和有效期；跨进程处理任务只传 `task_id`、`source_id`、`policy_version`。

P0 来源策略仅允许显式 allowlist 域名的 HTTP/HTTPS 80/443 静态 HTML、纯文本和
JSON。未知域、凭据 URL、登录、异常跳转、动态渲染、二进制下载、附件和审核员直达
外部页面均阻断或转人工。处理器逐跳校验 DNS A/AAAA 的公共地址、TLS 主机名和最多
三次跳转，并限制单任务 30 秒、单响应解压后 10 MiB、任务网络 30 MiB、100 个请求
和一次重试。原购买链接检查器仍是独立边界，继续使用 10 秒与 2 MiB 响应限制；两组
额度不能互换。

当前 `EvidenceGatewayService` 在没有处理器或处理器没有明确 isolation/egress
attestation 时将任务置为 `SAFE_PROCESSOR_UNAVAILABLE`，不会模拟抓取成功。
`infra/source-sandbox/runtime-policy.json` 和 README 只是部署准入记录，**不是已
部署的隔离证明**。目前尚未在独立 microVM/出口代理上验收凭据、挂载、网络、DNS
重绑定、逐跳 SSRF 和故障恢复；未完成这些实测前，动态/未知来源保持关闭，真实数据
不得开放。测试中注入的 fixture processor 只用于协议测试，不能替代生产处理区。

本次目标测试共 22 项：`tests/evidence-gateway.test.ts`、
`tests/review-workflow.test.ts` 和 `tests/review-api.test.ts`（SQLite 与 Miniflare
D1 API 场景）。本地 `pnpm typecheck`、三份目标 Vitest 文件和 `pnpm build` 已通过；
完整 AC、独立机器验收、部署证明和 GATE-01～GATE-10 仍以阶段验收记录为准。

## 集成复查修正

来源任务和预览读取必须通过当前人员的同案件、同版本、未过期分配检查，省略 assignment_id 不会跳过检查。无权访问和不存在的案件、任务、预览统一返回 NOT_FOUND，避免枚举对象存在性。新增测试也使用真实 session assurance、grant 与 assignment 验证生产适配器。
