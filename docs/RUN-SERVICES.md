# 后端、容器镜像与 IPFS

## 从 GitHub 拉取镜像

公开镜像支持 Linux amd64 和 arm64，无需登录即可拉取：

```sh
docker pull ghcr.io/gallonhong/open-sxgo-mirror:latest
docker pull ghcr.io/gallonhong/open-sxgo-backend:latest
```

克隆仓库后，一键启动数据镜像：

```sh
git clone https://github.com/GallonHong/open-sxgo.git
cd open-sxgo
./scripts/mirror-up.sh
```

脚本先拉取预构建镜像，再等待健康检查通过，不需要本机编译。访问 http://127.0.0.1:8080/health；公共数据在 `/public/`。默认数据源是本仓库 `public-data/public/` 的 GitHub Raw 地址。设置 `MIRROR_SOURCE` 可使用其他兼容 HTTP 源。信任根来自 `bootstrap/demo-root.json`，不从未验证的镜像自动替换。

版本过期会保留旧副本，健康接口明确返回 `historical`；它是只读历史服务，不是当前推荐。首次获取遇到篡改或过期元数据不会启动有效副本。当前根仍属测试环境。不能通过放宽到期或签名规则恢复推荐，须发布有授权的新版本。

## 后端

Sites 的 `/health` 检查真实数据库；`/contribute`、`/receipt`、`/report` 连接 D1 持久数据库。站点保持仅所有者访问；没有公开注册或默认管理员。审核仍要求独立账号、MFA 与实际人员授权；部署不自动赋予治理权限。生产发布和推广开关保持关闭。

自托管后端：

```sh
docker compose --profile intake pull intake
docker compose --profile intake up -d --no-build intake
```

默认接口只绑定本机，私密数据在持久卷。需要对外服务时配置可信 HTTPS 入口、`WFD_ADMIN_ORIGIN` 和 `WFD_INTAKE_ORIGIN`。`WFD_MODE=production` 禁止旧演示权限，`WFD_INTAKE_ENABLED=false` 可暂停新投稿。后端与公共数据镜像不可共享私密卷。

## IPFS

```sh
pnpm ipfs:publish
```

此命令先验证全部公共文件、摘要、签名和暂停清单，再将恢复白名单加入 Kubo 并递归固定。它不会发布整个仓库或私密数据库。CID 与本机网关链接保存在 `.runtime/ipfs/latest.json`。Kubo 数据使用持久卷，重启不丢失固定内容；RPC 管理端口不向宿主机开放。

本轮备份：`bafybeicg4g7u3usil6erpcnrphvzabcj4ktgpswhc47zeequwlb2ga4hjq`。

本机读取： http://127.0.0.1:8081/ipfs/bafybeicg4g7u3usil6erpcnrphvzabcj4ktgpswhc47zeequwlb2ga4hjq/ 。独立 Kubo 节点可用 `ipfs pin add <CID>` 保存副本。公开网关是否能找到提供节点取决于网络、NAT 和节点在线情况；CID 不等于永远在线。长期托管需保持提供节点运行，或额外配置独立固定服务。

2026-09-12 实测：第二个空 Kubo 节点经 P2P 拉取并固定相同 CID，恢复后重新通过本项目签名验证。本轮两个节点处于同一台机器上的独立容器，不能据此宣称已有两个独立运营者或异地灾备。测试时暂时放行 Docker 子网以便直连；生产 `server` 网络过滤随后恢复。

### 有效期与故障处理

当前测试包元数据在 **2026-09-14 10:25 UTC** 到期。已同步副本可继续作为历史服务；到期后全新节点不能把它当成当前可信发布启动。尚未配置长期签名人员及自动续签服务，不能承诺这个测试包永久保持当前有效。IPFS CID 仍可读取，重新发布需要有授权的签名流程。

如同步进程被强制终止，遗留 `sync.lock` 会阻止后续同步。先停止使用该卷的所有镜像进程，确认无同步进行，再删除该卷内的 `sync.lock`，随后重启。不要在同步运行时删除锁。更换信任根会返回 `TRUST_ANCHOR_CHANGED`；保留旧卷，使用新卷并通过可信渠道确认新根后重新启动，不能自动接受上游新根。

IPFS 的恢复包根目录供浏览；镜像与验证器的数据源应以 `/ipfs/<CID>/public/` 结尾。当前已实测 ipfs.io 公共网关读取成功，但网关及提供节点在线率不是本项目能保证的。

一键脚本按本地可信根的指纹选择持久卷。升级本地根时会使用另一只卷，旧副本保留，不会将旧根的数据误报为新根校验成功。

## 2026-09-12 受邀测试准备更新

苹果资料补充后生成了新的隔离测试根与公开恢复包，当前代码和 `public-data/` 配套使用该根，详见 [试运行清单](PILOT.md)。新的 IPFS CID：`bafybeiheubgeovl2hra6jrdmtq7yiwvcexwdx226vhdqhmxettorvjr4pi`；网关镜像源应使用 `/ipfs/<CID>/public/`。本文前述旧 CID、旧根、旧有效期及拉取结果为当时的验证记录，不应解释为新包已完成全部同等演练。新包有效至 `2026-09-14T12:33:21.103Z`（北京时间 9 月 14 日 20:33）。旧镜像保持历史副本；测试新包需拉取配套新版客户端/镜像并运行按根分卷的启动脚本。这是演示重置，不是生产根轮换或自动续期。
