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
