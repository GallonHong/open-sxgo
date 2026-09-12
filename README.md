# open sxgo

企业劳动条件资料目录。依据 `prd.md` 构建的封闭演示工程，包含独立公开站、可信投稿站、邀请制审核后台、D1/SQLite 服务、签名构建器和只读镜像。

**当前不是可上线的完整 P0。** 公开目录使用苹果中国大陆主体参考记录，已整理中国区官方劳动资料及适用边界，具体主体与岗位待遇仍待独立核实，签名仍使用测试信任根；真实独立治理、生产基础设施、生产人员与部署验收等尚未完成。工程状态和缺口见 [实施状态](docs/STATUS.md) 与 [逐项验收](docs/acceptance/AC.md)。三个浏览器中的测试通过不能代替全部 PRD 验收。

PRD2 本轮实现、验收边界和剩余工作见 [治理实施记录](docs/governance/STATUS.md) 与 [AC2 追踪](docs/governance/AC2.md)。

Sites 托管范围与资料来源见 [网站交付说明](docs/SITE-DELIVERY.md)。代码使用 MIT 许可，第三方内容与商标保留原有权利。

容器镜像拉取、后端部署与 IPFS 使用：[运行服务](docs/RUN-SERVICES.md)。

## Radicle 源码副本

公开源码也发布在 [Radicle · open-sxgo](https://radicle.network/nodes/rosa.radicle.network/rad:z4RgtcxwVYQrR4HNFVHNYdvVhhqdK)。仓库标识（RID）为 `rad:z4RgtcxwVYQrR4HNFVHNYdvVhhqdK`。

安装 [Radicle](https://radicle.dev/) 后，可通过点对点网络拉取：

```sh
rad clone rad:z4RgtcxwVYQrR4HNFVHNYdvVhhqdK
```

也可以使用普通 Git 从公共节点拉取：

```sh
git clone https://rosa.radicle.network/z4RgtcxwVYQrR4HNFVHNYdvVhhqdK.git open-sxgo
```

2026-09-12 首次发布时，Rosa、Iris 两个公共节点已同步；从远端重新克隆并完成 Git 完整性校验，提交为 `716e4ac3d2003831ebb10ebe0ce481694b2043fa`。这是该次发布的验证记录，不代表节点持续在线或始终包含最新提交。

GitHub 仍是主要开发入口，Radicle 目前手动同步，GitHub 更新不会自动传播。该副本仅包含公开 Git 仓库，不包含私密投稿数据库、审核账号或签名私钥；容器镜像仍通过 GHCR 分发，公开数据恢复包另通过 IPFS 分发。

苹果资料的证据与边界：[核对记录](docs/APPLE-RESEARCH.md)。5–10 人受邀测试的准备、步骤和阻塞项：[试运行清单](docs/PILOT.md)。

## 本地启动

需要 Node.js 24.15+、pnpm 11.9.0。安装依赖会编译 SQLite 原生模块；没有预编译产物时需要本机 C++ 构建环境。

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

- 公开目录：<http://127.0.0.1:5173>
- 匿名投稿：<http://127.0.0.1:5174/contribute>
- 审核后台：<http://localhost:5175>
- 私密 API：<http://127.0.0.1:8787>（浏览器经投稿站/后台自己的代理访问）

`pnpm demo` 重新生成真实主体参考资料与全新的测试信任根。旧浏览器缓存按根指纹隔离，旧镜像必须显式重置演示信任配置。这是重新开始演示，**不是生产根轮换**。生产密钥不应放入本仓库、CI、公开站或镜像。

## 审核演练

```sh
pnpm auth:invite reviewer.one@example.invalid person_demo_one
pnpm auth:invite reviewer.two@example.invalid person_demo_two
```

邀请工具仅用于本地演示；初始密码写入 `.runtime/private/invitation-<人员编号>.txt`，不输出到日志。登录后输入密码，使用“首次登录：设置验证器”，保存恢复码并验证 TOTP。随后从投稿站提交虚构公开线索，初审人员执行分流→初审→提交公开候选；另一个独立人员登录后复核。两个账号绑定同一人员编号不能凑双人阈值。

后台可以下载批准对象。在本地运行 `pnpm demo:publish`，仅从已批准候选生成独立演示包并登记公开版本。输出保存在 `.runtime/approved-demo/approved-*/public`，有自己的演示根；不会自动覆盖当前示例网站。真实生产构建使用 `packages/builder/src/publisher.ts`，需要人员授权、业务签名、Targets 阈值、全部门槛记录和两个独立存储；生产发布接口保持拒绝。

## 验证与镜像

```sh
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm verify http://127.0.0.1:5173/public/ bootstrap/demo-root.json
pnpm benchmark
pnpm worker:check

docker compose --profile mirror up -d --build
pnpm verify http://127.0.0.1:8080/public/ bootstrap/demo-root.json
pnpm recovery .runtime/public/public bootstrap/demo-root.json .runtime/recovery-01
```

恢复输出目录必须不存在。镜像只提供公共数据，端口 8080；本机与本机 Docker **不是两个独立运营副本**。`pnpm verify` 同时使用官方 `tuf-js` 与项目验证器，默认持久化高水位；清空验证状态会失去已见版本的回滚保护。

`pnpm build && pnpm preview` 提供安装版公共站（4173）；另一个终端运行 `pnpm check:offline` 验证真正断网重载。开发服务器不注册 Service Worker。

## 文件布局

| 路径                    | 用途                                         |
| ----------------------- | -------------------------------------------- |
| `apps/web`              | 公开 React/PWA，签名数据验证、本地搜索       |
| `apps/intake`           | 无附件匿名投稿、回执与补充撤回               |
| `apps/admin`            | 密码/TOTP、审核与复核、候选导出              |
| `apps/api`              | Hono，Workers/D1 与 Node/SQLite 入口         |
| `packages/protocol`     | 公开与私密独立严格 Schema                    |
| `packages/domain`       | 收录、范围、来源、时效、隐私与留存规则       |
| `packages/verifier`     | 浏览器验证核心、业务签名、官方 Node 验证入口 |
| `packages/builder`      | JSONL/SQLite/索引/分片、发布阈值、存储适配   |
| `packages/mirror-sync`  | 原子镜像同步、恢复包白名单生成               |
| `packages/link-checker` | DNS/IP 校验与固定 IP HTTPS 检查              |
| `migrations`            | D1/SQLite 共用迁移                           |
| `docs`                  | 状态、验收、部署、隐私、审核、事件处理       |

没有接入真实企业资料、外部 AI、分析统计或商业推广。演示代码没有替任何外部来源授予数据许可；正式使用前按来源逐项确认权利。
