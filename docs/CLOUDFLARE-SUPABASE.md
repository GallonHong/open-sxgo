# Cloudflare Workers + Supabase PostgreSQL staging：部署与回滚

本文是一个公开浏览测试环境的操作手册。下面的状态段记录 2026-09-12 已完成的 staging 部署与验证；其余章节保留从零初始化、日常检查和回滚步骤。审核权限、投稿、推广和生产发布仍受服务端规则限制，不能把该环境当作完整 pilot 或生产就绪证明。

## 当前状态（2026-09-12）

- 公开浏览入口已部署到 Cloudflare Worker：[open-sxgo-postgres-staging.gallonhong.workers.dev](https://open-sxgo-postgres-staging.gallonhong.workers.dev)。公开目录和 `/companies` 可直接访问；旧的 `/pilot` 入口实际返回 303 并跳转到 `/companies`。管理员和审核员仍由 Better Auth 负责认证与权限；具体 Worker 版本以 Cloudflare deployment history 为准。
- Supabase project `open-sxgo-staging` 已创建，`wfd_private` schema 已有 62 张表。迁移角色当前为 `wfd_migrator` 且 `NOLOGIN`；运行时角色为 `wfd_runtime`，无管理权限和 `BYPASSRLS`。`anon` 没有该 schema 的 `USAGE` 权限。
- 本机使用 Supabase CA 的 TLS `verify-full` 验证通过。Hyperdrive 使用直连数据库连接（不是 pooler），查询缓存已关闭，origin connection limit 为 5，并以自定义 CA 配置 `sslmode=verify-full`。
- 本轮线上 smoke 已验证：直接访问 `/companies` 和 `/admin` 返回 200；`/pilot` 返回 303 并跳转到 `/companies`；`/admin/v1/me` 和 `/admin/v1/work-items` 返回 403；认证后 `/health` 返回 200 且 `database: ready`；`/admin/v1/auth/get-session` 返回 200（空会话）；不存在的 `/public/missing.json` 返回 404；配置保持 `intake=false`、`promo=false`；投稿 POST 返回 `503 INTAKE_PAUSED`；无效回执状态 POST 返回 401，证明限流写库路径工作。
- 云端 PostgreSQL 的条件更新失败回滚测试通过，没有留下测试记录。线上发布包 `2026-09-12.1` 的元数据、8 个数据文件及暂停清单均通过验证；仍使用演示信任根，当前时间戳元数据于北京时间 2026-09-14 20:33 到期，持续试运行前须更新测试发布包。
- GitHub CI 对提交 `7919917` 成功；GHCR 的 mirror、backend、postgres 镜像已验证存在匿名可拉取的 amd64/arm64 manifest。Radicle RID `rad:z4RgtcxwVYQrR4HNFVHNYdvVhhqdK` 的 `7919917` 已同步到 1 个 seed。

尚未配置真实审核账号或两名独立审核员，因此不能宣称完整 pilot 已经 ready。本文不记录密码、真实用户邮箱或账号 ID；旧 Sites/D1 和 SQLite 容器仍保留，真实私密数据没有迁移。

目标拓扑如下：浏览器访问 Cloudflare Worker 和静态资源，Worker 通过一个关闭查询缓存的 Hyperdrive 连接到一个新的 Supabase PostgreSQL staging 数据库。原有 Sites/D1 和 SQLite 容器继续保留；本流程不导入、不复制真实私密数据，也不改变旧的 compose.yaml、Sites 或 SQLite 迁移。

    public browser
        │  HTTPS
        ▼
    Cloudflare Worker + static assets
        │  HYPERDRIVE (query caching disabled)
        ▼
    new Supabase PostgreSQL staging
        ├─ wfd_migrator  (temporary schema migration role)
        └─ wfd_runtime   (Worker least-privilege role)

    old Sites/D1 and SQLite containers ── retained, not migrated

Hyperdrive 的查询缓存默认开启；认证、session、权限和刚写入后必须立即读取的数据应使用关闭缓存的 Hyperdrive 配置。参见 Cloudflare 的 [Hyperdrive 查询缓存说明](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) 和 [Hyperdrive Wrangler 命令](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/)。

## 1. 开始前的边界

先确认这次操作针对一个新建的 Supabase staging project/database。不要把现有 SQLite 数据库、旧 D1 数据库或任何真实私密数据库的连接串交给 Hyperdrive，也不要运行 pg_dump、导入脚本或手工复制真实记录。staging 数据库从空库开始，只执行仓库中的 PostgreSQL DDL。

apps/cloudflare/wrangler.jsonc 只保存 binding、变量和资源占位符。真正部署由 scripts/deploy-cloudflare.ts 生成被 .gitignore 忽略的 .runtime/cloudflare/wrangler.json，并要求以下三个本地环境变量：

    CLOUDFLARE_ACCOUNT_ID=<32 位十六进制 account id>
    CLOUDFLARE_HYPERDRIVE_ID=<32 位十六进制、非全零 Hyperdrive id>
    WFD_PUBLIC_ORIGIN=https://<staging-origin>

本文只使用占位符，不要把真实用户邮箱或账号标识写进本文、示例、构建日志或截图。account ID、Hyperdrive ID 和域名是资源标识，不是密码；按团队的普通配置访问规则保存即可。数据库连接串中的密码、角色密码及应用 secret 仍不得进入 Git、日志或 Worker vars。

WFD_PUBLIC_ORIGIN 必须是完整的 HTTPS origin，不能带路径、查询串、片段或结尾斜杠。当前脚本支持两种入口：

- workers.dev：形如 https://<worker-name>.<account-subdomain>.workers.dev。当前配置的 Worker 名是 open-sxgo-postgres-staging，因此第一个 hostname label 必须与它一致。脚本会启用 workers_dev 并移除 routes。
- custom domain：使用已由团队控制、TLS 已就绪的域名。脚本会创建一个 custom_domain route，且 WFD_PUBLIC_ORIGIN 仍需是没有路径的精确 origin。

这两个 origin 会同时写入 Worker 的 ADMIN_ORIGIN 和 INTAKE_ORIGIN。如果管理员和投稿入口以后需要不同域名，应先修改并审阅部署脚本及 CORS/origin 策略，再部署；当前 staging 流程使用同一个 origin。

## 2. 创建数据库角色和隔离 schema

把迁移权限和运行时权限分开。wfd_migrator 只在初始化或经过审阅的 forward migration 时使用；wfd_runtime 才交给 Worker。两个角色必须有不同密码。不要让 Worker 使用 Supabase owner、postgres 或 service role。

使用 Supabase 提供的受保护 SQL 会话或其他受保护管理连接执行下面的结构示例。密码故意省略；通过交互式密码设置、本地密码管理器或 CI secret 注入，不要把密码写进 SQL 文件或 shell 历史。

    CREATE ROLE wfd_migrator LOGIN;
    CREATE ROLE wfd_runtime LOGIN;

    CREATE SCHEMA wfd_private AUTHORIZATION wfd_migrator;

    GRANT CONNECT ON DATABASE <staging_database> TO wfd_runtime;
    GRANT USAGE ON SCHEMA wfd_private TO wfd_runtime;

    ALTER ROLE wfd_migrator IN DATABASE <staging_database>
      SET search_path = wfd_private, public;
    ALTER ROLE wfd_runtime IN DATABASE <staging_database>
      SET search_path = wfd_private, public;

如果新 schema 已由管理角色创建，确认它的 owner 是迁移角色，或明确授予 wfd_migrator 创建表、索引、约束和执行迁移所需的权限。迁移完成后，为 Worker 只授予当前应用表所需的 DML 权限；本仓库的单一 PostgreSQL app 同时包含 Better Auth、治理和维护模块，因此首次 staging 可以针对迁移产生的当前表集合授予这四种权限，但不授予 DDL：

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA wfd_private TO wfd_runtime;

    -- 只在这些 Supabase 角色确实存在时执行；0007 migration 也会做受保护的撤权。
    REVOKE ALL ON ALL TABLES IN SCHEMA wfd_private FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA wfd_private FROM anon, authenticated;

    -- 若后续仍由 wfd_migrator 创建应用表，为新表延续相同的 DML 规则。
    ALTER DEFAULT PRIVILEGES FOR ROLE wfd_migrator IN SCHEMA wfd_private
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wfd_runtime;

wfd_runtime 不应拥有 CREATE、ALTER、DROP、CREATEROLE、CREATEDB、SUPERUSER、REPLICATION 或 BYPASSRLS。不要使用 GRANT ALL；没有使用 sequence 的表也不要凭习惯开放 sequence 权限。每次新增表或权限都应重新审阅这份清单。

迁移前后都用运行时角色验证 search path，而不是根据连接串猜测：

    SELECT current_user, current_schema(), current_setting('search_path');

预期是当前用户为 wfd_runtime，当前 schema 为 wfd_private，search path 包含 wfd_private, public。这也是 Drizzle PostgreSQL schema 和迁移脚本解析未限定表名的前提。检查私密表没有 Supabase 公共角色权限：

    SELECT grantee, table_schema, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'wfd_private'
      AND grantee IN ('anon', 'authenticated');

该查询应返回空结果。migrations-postgres/0007_governance_execution.sql 会在 anon 或 authenticated 角色存在时撤销其对私密 schema 的表、sequence 和默认权限；本地 PostgreSQL/CI 没有这些角色时 migration 仍应成功。

## 3. 初始化 PostgreSQL staging

先把迁移角色的 Supabase 连接信息放到受保护的本地 secret store 或 CI secret 中。scripts/migrate-postgres.ts 优先读取 DATABASE_URL，没有它时才读取 TEST_POSTGRES_URL；实际 staging 请明确使用迁移角色的 DATABASE_URL，不要把运行时连接串误用作迁移连接串。

    # DATABASE_URL 由本地受保护环境注入；不要把真实值写在命令、脚本或 Git 中。
    export PG_SCHEMA=wfd_private
    pnpm db:postgres:migrate
    unset PG_SCHEMA DATABASE_URL TEST_POSTGRES_URL

不需要指定路径时，CLI 使用 migrations-postgres/ 下的 7 个编号 migration。可选的第一个参数才是另一个 migration directory；不要把旧的 SQLite migrations/ 目录传给它。

迁移器对每个文件使用事务、advisory lock 和 wfd_migrations 摘要记录。并发运行会串行化；重复运行是幂等的；已经应用的 SQL 如果摘要变化会拒绝继续；某个 DDL 失败会回滚该 migration。遇到摘要不一致时，停止部署并恢复仓库中原来的文件或写一个新的编号 migration，不能删除 wfd_migrations 记录、手改已应用 SQL 后强行重跑，也不要写 destructive down migration。

迁移结束后用管理会话检查表数量、关键 Better Auth 标识符和角色权限；再用 wfd_runtime 连接执行上面的 current_schema() 查询。不要把含密码的连接串或完整私密表内容复制进验收记录。

## 4. 配置 Hyperdrive（关闭缓存）

Hyperdrive 的数据库目标应是刚初始化的 Supabase staging，连接角色应是运行时最小权限角色。先在受保护终端中创建或更新 Hyperdrive，并使用关闭查询缓存的选项：

    pnpm wrangler hyperdrive create <fresh-staging-config> \
      --connection-string="<SUPABASE_STAGING_RUNTIME_CONNECTION_STRING>" \
      --caching-disabled

    # 如果已经有仅供这个 staging 使用的 Hyperdrive config：
    pnpm wrangler hyperdrive update <hyperdrive-id> --caching-disabled
    pnpm wrangler hyperdrive get <hyperdrive-id>

把返回的 ID 注入部署环境；当前 deploy script 会把它写入被忽略的生成配置，tracked 的 apps/cloudflare/wrangler.jsonc 继续保留占位符。ID 本身不是密码，团队也可以按普通配置规则在受控部署记录中保存它。get 的结果应能核对该 config 的连接目标和 caching.disabled=true；如果平台返回的字段形态不同，以 Cloudflare 控制台/API 的 cache-disabled 状态为准。连接串中的密码不得进入 shell history、日志、Git 或 Worker vars。

当前 Worker 只有一个 HYPERDRIVE binding，因此这个 binding 必须关闭缓存。不要让认证/session/权限请求共用一个仍启用查询缓存的 config；缓存配置属于 Hyperdrive 资源，不是把 wrangler.jsonc 中的 binding ID 改名就能关闭的 Worker 变量。

## 5. 配置 Worker 与公开入口

Worker 的公开目录和 `/companies` 路径直接服务浏览请求；旧 `/pilot` 路径自动跳转到公开入口。管理员和审核员的私有请求仍须经过 Better Auth 会话和应用权限检查。投稿、推广和生产发布继续由服务端开关关闭；公开可读不等于私有数据可读。

部署脚本只接收 account、Hyperdrive 和 origin 资源配置，生成被 `.gitignore` 忽略的 `.runtime/cloudflare/wrangler.json`。Better Auth secret 仍通过 Wrangler secret 机制提供；数据库密码和应用 secret 不得写入 Git、日志、Worker vars 或 Dockerfile。公开目录不绕过 Better Auth 的私有权限检查。

先进行配置生成和 Wrangler dry-run：

    export CLOUDFLARE_ACCOUNT_ID=<real-account-id>
    export CLOUDFLARE_HYPERDRIVE_ID=<cache-disabled-hyperdrive-id>
    export WFD_PUBLIC_ORIGIN=https://<staging-origin>
    pnpm cloudflare:deploy -- --dry-run

scripts/deploy-cloudflare.ts 会读取 tracked 的 apps/cloudflare/wrangler.jsonc，填入上述资源和 origin，始终将 INTAKE_ENABLED 写为 false，并生成 mode 0600 的 .runtime/cloudflare/wrangler.json。--dry-run 只调用 Wrangler 的 deploy --dry-run，不发布 Worker，也不创建付费资源。确认输出没有路径、placeholder origin 或错误 Hyperdrive ID 后，再按当前 Wrangler 配置安装 Better Auth secret。

BETTER_AUTH_SECRET 必须通过 Wrangler secrets 提供；不要写进 wrangler.jsonc、.runtime/cloudflare/wrangler.json 的 vars、Dockerfile 或 Git。ADMIN_ORIGIN、INTAKE_ORIGIN、INTAKE_ENABLED 是非机密配置变量。Supabase 数据库密码留在 Hyperdrive 受保护配置和本地 secret store 中，不要作为 Worker 明文变量传入。

入口代码、公开跳转和真实域名配置完成并审阅后，执行实际发布：

    pnpm cloudflare:deploy
    unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_HYPERDRIVE_ID WFD_PUBLIC_ORIGIN

Worker required secrets 缺失时应停止部署；每次发布后都要重新验证公开目录、`/pilot` 跳转和 Better Auth 审核权限。

## 6. 发布前检查和验收

以下命令应在本地或 CI 中使用受保护的 TEST_POSTGRES_URL/secret 注入。示例不含真实连接串；不要把真实密码替换后提交到 shell script 或日志：

    pnpm install --frozen-lockfile
    TEST_POSTGRES_URL="<local-postgres-17-test-url>" pnpm test
    pnpm cloudflare:types
    pnpm cloudflare:check
    pnpm cloudflare:deploy -- --dry-run

如果要单独验证迁移，使用空的本地 PostgreSQL 17 数据库：

    TEST_POSTGRES_URL="<local-postgres-17-test-url>" PG_SCHEMA=wfd_private \
      pnpm db:postgres:migrate

pnpm cloudflare:types 会生成 Worker 类型；cloudflare:check 使用 tracked 的 placeholder config 做 dry-run，真实资源验收应使用 cloudflare:deploy -- --dry-run 生成的配置。

infra/postgres/Dockerfile 是 PostgreSQL API runtime image；仓库目前没有一个把它和 Supabase staging 自动连起来的 compose 文件。pnpm api:postgres/该镜像需要 DATABASE_URL、长度至少 32 的 BETTER_AUTH_SECRET、WFD_ADMIN_ORIGIN 和 WFD_INTAKE_ORIGIN；直接运行 pnpm api:postgres 默认监听 127.0.0.1:8788，Dockerfile 则设置 WFD_BIND_HOST=0.0.0.0。WFD_INTAKE_ENABLED 只有显式为 true 才开启。生产 PostgreSQL app 仍关闭 promotion 和 production release。

截至 2026-09-12，当前已完成的本地观察包括：

- PostgreSQL 17 迁移测试覆盖并发串行化、幂等重跑、摘要变更拒绝和失败 DDL 回滚，并在本机通过。
- infra/postgres/Dockerfile 的本机 arm64 构建和独立 smoke 数据库迁移通过；本机 /health 返回 status: ok、database: ready、mode: production。
- 本地最终检查通过：typecheck、28 个测试文件共 220 个测试、三个前端 build，以及 Cloudflare dry-run。

上述本地结果与“当前状态”中的线上 smoke、CI 和镜像验证共同证明 staging 链路已部署并可进行封闭测试，但不证明完整 pilot ready。仍需完成真实审核人员演练、双审核员和冲突/身份复核、备份/恢复演练、线上日志/告警检查，以及后续真实资源变更的 dry-run 与权限读回。

## 7. 当前功能开关和未完成阻塞

部署脚本强制 INTAKE_ENABLED=false，因此新投稿/变更报告保持关闭；不要通过手工修改生成配置绕过这个保护。PostgreSQL app 还固定为 production mode，promotionEnabled=false、productionReleaseEnabled=false。证据初始化接口返回 P1_DISABLED，生产发布接口返回 PRODUCTION_GATE_CLOSED，生产模式的 legacy authorization 也保持关闭。

docs/PILOT.md 和 docs/STATUS.md 中记录的人工与治理阻塞仍然有效，包括真实人员参与、两名独立审核员、冲突与身份复核、备份恢复和线上演练等。公开目录不会解除私有审核权限要求，也不能把未完成的 pilot 标记为完成，更不能据此迁移真实私密数据或开启生产发布。

## 8. 回滚

回滚先处理流量和凭据，再处理代码版本；数据库保留。Cloudflare Worker 回滚会立即创建一个新的 active deployment，且连接资源不会随 Worker 版本回滚而改变。按 Cloudflare 的 [Workers rollback 文档](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) 操作，先列出真实版本，再使用已核对的 version ID；不要猜测或在本文写入版本 ID：

    pnpm wrangler deployments list --name <worker-name>
    pnpm wrangler rollback <known-good-version-id> --name <worker-name>

如果没有可安全复用的版本，先停止新流量并保持 INTAKE_ENABLED=false，再发布已经通过 dry-run 的修复版本。轮换 Better Auth secret、数据库密码和 Hyperdrive 配置前，要记录影响范围：轮换 Better Auth secret 可能使现有 session/MFA 失效；撤销数据库凭据需要先准备新的最小权限凭据并验证连接。role 密码和新旧 secret 仍只保存在本地受保护存储，不要为了回滚把它们写入 Git。

数据库 rollback 遵循以下规则：

1. 不删除 Supabase database、wfd_private schema、表、备份或 wfd_migrations 元数据，不执行 DROP SCHEMA ... CASCADE。
2. 不删除或改写已经应用的 migrations-postgres/*.sql，也不清空摘要记录。摘要错误时恢复原文件，或经审阅创建新的递增 migration 向前修复。
3. 如果 schema 已经被错误 migration 改变，先暂停 Worker、保留数据库供取证和备份，再在全新隔离 staging database 验证修复；恢复数据前先做备份和权限复核。
4. 回滚应用版本不会回滚数据库结构。确认目标 Worker 版本仍兼容当前 schema；不兼容时保持流量关闭并采用 forward migration 或新的空 staging。

旧 Sites/D1、SQLite 容器、private-data volume、Supabase database 以及数据库备份都不因应用回滚而删除。完成回滚后重新检查 /health、/private/v1/config、current_schema()、角色权限和日志，再决定是否恢复少量 pilot 访问。

## 9. 记录格式

每次 staging 操作只记录不含秘密的事实：日期、代码提交、migration 文件名和摘要、schema 名、Hyperdrive config 的非敏感标识、Worker 版本、origin 类型（workers.dev 或 custom domain）、dry-run/测试命令及结果、回滚原因和下一步阻塞。不要记录真实用户邮箱、账号 ID、数据库连接串、role 密码、Better Auth secret 或其他应用 secret。
