# Cloudflare Workers + Supabase PostgreSQL staging：部署与回滚

本文是一个全新、封闭 staging 的操作手册。它描述仓库当前支持的本地准备流程，不代表 Cloudflare Worker、Hyperdrive 或 Supabase staging 已经部署；截至本文编写时没有云端部署、域名、邀请发放或远端 CI 验收结果可供声明。

目标拓扑如下：浏览器访问 Cloudflare Worker 和静态资源，Worker 通过一个关闭查询缓存的 Hyperdrive 连接到一个新的 Supabase PostgreSQL staging 数据库。原有 Sites/D1 和 SQLite 容器继续保留；本流程不导入、不复制真实私密数据，也不改变旧的 compose.yaml、Sites 或 SQLite 迁移。

    pilot browser
        │  HTTPS + application invite cookie
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

本文只使用占位符，不要把真实用户邮箱、账号标识或邀请清晰码写进本文、示例、构建日志或截图。account ID、Hyperdrive ID 和域名是资源标识，不是密码；按团队的普通配置访问规则保存即可。数据库连接串中的密码、角色密码及应用 secret 仍不得进入 Git、日志或 Worker vars。

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

把返回的真实 ID 仅注入本地 CLOUDFLARE_HYPERDRIVE_ID，不要提交到 apps/cloudflare/wrangler.jsonc。get 的结果应能核对该 config 的连接目标和 caching.disabled=true；如果平台返回的字段形态不同，以 Cloudflare 控制台/API 的 cache-disabled 状态为准。连接串中的密码不得进入 shell history、日志、Git 或 Worker vars。

当前 Worker 只有一个 HYPERDRIVE binding，因此这个 binding 必须关闭缓存。不要让认证/session/权限请求共用一个仍启用查询缓存的 config；缓存配置属于 Hyperdrive 资源，不是把 wrangler.jsonc 中的 binding ID 改名就能关闭的 Worker 变量。

## 5. 准备邀请入口和 Worker 配置

项目没有启用收费的 Cloudflare Access/Zero Trust 授权。staging pilot 使用应用内邀请 cookie 入口：PILOT_INVITE_HASHES 保存邀请码 SHA-256 摘要，PILOT_COOKIE_SECRET 用来签发/验证 cookie。它只是封闭 pilot 的应用门禁，不能替代正式身份、独立审核或生产边界；邀请码也不能被当作真实账号身份。

为全新 staging 生成本地凭据。脚本使用独占创建模式，发现已有文件就拒绝覆盖；它生成 10 个高熵邀请码和对应摘要，但不会发送邀请：

    pnpm exec tsx scripts/prepare-pilot-secrets.ts

生成的 .runtime/private/cloudflare-pilot/secrets.json 和 invitations.json 是本地私密文件，权限分别由脚本设为受保护模式，且 .runtime/ 已被 Git 忽略。清晰码只应保存在本地受保护密码管理器/文件中，再通过已经确认身份的渠道交给少量 pilot 测试人员；不要把真实邮箱、账号 ID 或邀请清晰码写入仓库、issue、日志或本文。数据库角色用户名和密码也只保存在本地受保护密码管理器、权限为 0600 的密码文件或 CI secret 中。

先进行配置生成和 Wrangler dry-run：

    export CLOUDFLARE_ACCOUNT_ID=<real-account-id>
    export CLOUDFLARE_HYPERDRIVE_ID=<cache-disabled-hyperdrive-id>
    export WFD_PUBLIC_ORIGIN=https://<staging-origin>
    pnpm cloudflare:deploy -- --dry-run

scripts/deploy-cloudflare.ts 会读取 tracked 的 apps/cloudflare/wrangler.jsonc，填入上述资源和 origin，始终将 INTAKE_ENABLED 写为 false，并生成 mode 0600 的 .runtime/cloudflare/wrangler.json。--dry-run 只调用 Wrangler 的 deploy --dry-run，不发布 Worker，也不创建付费资源。确认输出没有路径、placeholder origin 或错误 Hyperdrive ID 后，再安装 Wrangler secrets：

    pnpm exec wrangler secret bulk \
      .runtime/private/cloudflare-pilot/secrets.json \
      --config .runtime/cloudflare/wrangler.json

BETTER_AUTH_SECRET、PILOT_COOKIE_SECRET 和 PILOT_INVITE_HASHES 必须通过 Wrangler secrets 提供；不要写进 wrangler.jsonc、.runtime/cloudflare/wrangler.json 的 vars、Dockerfile 或 Git。ADMIN_ORIGIN、INTAKE_ORIGIN、INTAKE_ENABLED 是非机密配置变量。Supabase 数据库密码留在 Hyperdrive 受保护配置和本地 secret store 中，不要作为 Worker 明文变量传入。

入口代码、pilot gate 和真实域名配置完成并审阅后，才可执行实际发布：

    pnpm cloudflare:deploy
    unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_HYPERDRIVE_ID WFD_PUBLIC_ORIGIN

在该命令成功前不要把 staging URL 当作已上线地址，也不要发放邀请。Worker required secrets 缺失时应停止部署；如果 pilot gate 的当前实现或配置入口仍在变更，继续保持未部署状态。

## 6. 发布前检查和本地验收

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

这些结果不能证明 Supabase、Hyperdrive、Worker、custom domain、workers.dev、远端 CI 或邀请流程已经验收。云端 staging 的接受条件还包括：真实资源 ID 的 dry-run、Hyperdrive caching.disabled 读回、运行时角色权限和 search path 读回、匿名 Supabase 角色无私密表权限、备份/恢复演练、真实 pilot 人员演练和日志/告警检查。

## 7. 当前功能开关和未完成阻塞

部署脚本强制 INTAKE_ENABLED=false，因此新投稿/变更报告保持关闭；不要通过手工修改生成配置绕过这个保护。PostgreSQL app 还固定为 production mode，promotionEnabled=false、productionReleaseEnabled=false。证据初始化接口返回 P1_DISABLED，生产发布接口返回 PRODUCTION_GATE_CLOSED，生产模式的 legacy authorization 也保持关闭。

docs/PILOT.md 和 docs/STATUS.md 中记录的人工与治理阻塞仍然有效，包括真实人员参与、两名独立审核员、冲突与身份复核、备份恢复和线上演练等。功能开关和邀请 cookie 只能形成封闭 pilot 入口，不能把未完成的 pilot 标记为完成，也不能据此迁移真实私密数据或开启生产发布。

## 8. 回滚

回滚先处理流量和凭据，再处理代码版本；数据库保留。Cloudflare Worker 回滚会立即创建一个新的 active deployment，且连接资源不会随 Worker 版本回滚而改变。按 Cloudflare 的 [Workers rollback 文档](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) 操作，先列出真实版本，再使用已核对的 version ID；不要猜测或在本文写入版本 ID：

    pnpm wrangler deployments list --name <worker-name>
    pnpm wrangler rollback <known-good-version-id> --name <worker-name>

如果没有可安全复用的版本，先停止 pilot 流量并保持 INTAKE_ENABLED=false，再发布已经通过 dry-run 的修复版本。轮换或撤销邀请摘要、cookie secret、Better Auth secret、数据库密码和 Hyperdrive 配置前，要记录影响范围：轮换 Better Auth secret 可能使现有 session/MFA 失效；撤销数据库凭据需要先准备新的最小权限凭据并验证连接。邀请清晰码、role 密码和新旧 secret 仍只保存在本地受保护存储，不要为了回滚把它们写入 Git。

数据库 rollback 遵循以下规则：

1. 不删除 Supabase database、wfd_private schema、表、备份或 wfd_migrations 元数据，不执行 DROP SCHEMA ... CASCADE。
2. 不删除或改写已经应用的 migrations-postgres/*.sql，也不清空摘要记录。摘要错误时恢复原文件，或经审阅创建新的递增 migration 向前修复。
3. 如果 schema 已经被错误 migration 改变，先暂停 Worker、保留数据库供取证和备份，再在全新隔离 staging database 验证修复；恢复数据前先做备份和权限复核。
4. 回滚应用版本不会回滚数据库结构。确认目标 Worker 版本仍兼容当前 schema；不兼容时保持流量关闭并采用 forward migration 或新的空 staging。

旧 Sites/D1、SQLite 容器、private-data volume、Supabase database 以及数据库备份都不因应用回滚而删除。完成回滚后重新检查 /health、/private/v1/config、current_schema()、角色权限和日志，再决定是否恢复少量 pilot 访问。

## 9. 记录格式

每次 staging 操作只记录不含秘密的事实：日期、代码提交、migration 文件名和摘要、schema 名、Hyperdrive config 的非敏感标识、Worker 版本、origin 类型（workers.dev 或 custom domain）、dry-run/测试命令及结果、回滚原因和下一步阻塞。不要记录真实用户邮箱、账号 ID、邀请清晰码、数据库连接串、role 密码、Better Auth secret 或 cookie secret。
