# 部署与升级

当前仅封闭演示，无云端部署。Sites 技能用于界面/预览参考，没有注册 Sites 项目、没有转移既定的 Cloudflare/Docker 架构。

## 本地与容器

见根 README 的启动步骤。`compose.yaml` 的两个 profile 分别是公开镜像与私密 API；不要将私密数据卷挂载到镜像。

镜像容器：`docker compose --profile mirror up -d --build`。默认从宿主公开开发站读取虚构包，绑定本机 8080。镜像进程非 root，根文件只读，容器根文件系统只读。镜像数据卷仅含公共文件与验证高水位。若演示信任根重建，应用新的空演示卷，不要把重置高水位当作生产升级。

私密容器：先停止占用 8787 的本机 API，再运行 `docker compose --profile intake up -d --build`。卷包含会话、投稿和审计，必须单独配置访问/备份/清理。生产必须用独立域名和 TLS，源站不公开任意跨域访问。环境变量的 secret 不能进入镜像构建层。

升级前记录发布包与根指纹、数据库迁移版本、依赖锁摘要；复制私密数据库的一致性备份（SQLite 在线备份接口或停写后备份，不能只复制 WAL 模式下单个主文件）。恢复时先校验备份完整性，在隔离目录演练，再切换业务入口。每次迁移只新增版本，不修改已在生产执行的文件。

## Cloudflare D1

配置：`apps/api/wrangler.jsonc`，数据库 ID 目前是占位符。正式操作前建立独立 Cloudflare 账号/资源，填写受控域名、D1 绑定、秘密、日志策略和预算阈值。可先在本地运行：

```sh
pnpm worker:types
pnpm exec wrangler d1 migrations apply wfd-private-staging --local --config apps/api/wrangler.jsonc
pnpm worker:check
```

不要把 `--local` 替换为远端参数作为无人审核的一键上线。生产 D1 的容量、备份、事务与 MFA 必须在目标环境再测；当前自动测试使用 Miniflare。Worker 代码强制关闭生产发布与推广，正式开启需完成应用接入与门槛验收。

R2 适配器是 `packages/builder/src/stores.ts` 的 `r2Store`，只接收已准备的公共文件。发布桶和私密用途必须分开。当前没有已授权的 R2 资源或实际上传记录。

## 静态站

将 `dist/web`、`dist/intake`、`dist/admin` 分别部署到独立 origin。只有前台需要公开数据和 PWA。投稿站、后台私密接口应以同源代理访问各自允许的路径，不把管理员 API 代理给公开目录。

公共 `/public/*` 的缺失资源必须返回 404，不能回退到 SPA 的 HTML，否则会破坏 TUF 根探测。HTML、`sw.js`、根/时间戳/暂停清单使用重新验证或 no-store；不可变分片可长期缓存。设置 no-referrer、nosniff，禁止嵌套显示后台。生产 origin 不得保留代码中的本地演示链接。

## 链接检查隔离

`pnpm links:check <批准的公开数据文件> <报告文件>` 只进行公开 HTTPS GET，不执行脚本、不接收私密输入。正式运行需独立容器/账号、无数据库和签名秘密、网络出口禁止所有私网和元数据段，并将超时、重定向、重绑定用例在该网络环境实测。当前应用层验证不能代替这一层部署验收。
