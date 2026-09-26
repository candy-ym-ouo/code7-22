# 部署与运维

## 交付链总览

- 唯一环境样例：`.env.example`。本地 `pnpm dev`、`docker compose` 和生产部署读取同名变量，配置校验规则完全一致。
- 统一镜像：`infra/docker/server.Dockerfile` 构建 `api`、`worker`、`migrate` 三个 target，共享同一份生产依赖层；`infra/docker/web.Dockerfile` 构建 Web 静态资源镜像。
- 统一迁移器：`packages/db`（`pnpm db:migrate` / `docker compose run --rm migrate`），事务执行、校验和防漂移、`pg_advisory_lock` 防并发。
- 统一日志：所有服务输出 JSON 结构化日志（pino），敏感头与令牌字段自动脱敏，`LOG_LEVEL` 控制级别（默认生产 info、其他 debug）。
- 统一探针：所有长驻服务提供 `/health/live` 与 `/health/ready`；compose 中的每个服务都有 healthcheck 和启动依赖。

## 健康检查

- API 存活：`GET /health/live`（只证明进程可响应，不查依赖）
- API 就绪：`GET /health/ready`（数据库连通性 + 迁移版本 + Redis，任一失败返回 503 并逐项列出 `checks`）
- Worker 存活/就绪：`http://localhost:3100/health/live`、`/health/ready`（检查项与 API 相同）
- PostgreSQL：`pg_isready`
- Redis：`redis-cli ping`
- MinIO：`mc ready local`
- ClamAV：`clamdcheck.sh`

就绪探针中的 `migrations` 一项与启动校验使用同一套版本检查：代码期望的迁移集合必须与数据库完全一致。

## 启动校验（所有环境一致）

服务进程在监听端口之前按顺序执行：

1. 解析并校验环境变量（zod schema，缺失/非法时列出全部问题后退出）。
2. 密钥校验：`JWT_ACCESS_SECRET` 至少 32 字符；`NODE_ENV=production` 时拒绝已知占位/弱密钥，强制 `COOKIE_SECURE=true`、对外 Origin 使用 https，Worker 强制 `CLAMAV_ENABLED=true`。
3. 数据库版本校验：`schema_migrations` 与代码自带迁移逐一比对——缺少迁移、数据库比代码新、迁移文件被篡改（校验和不一致）都会拒绝启动并给出修复指引。

## 发布

1. 构建并锁定镜像：`docker compose build`，为镜像打上版本标签（如 `registry.example.com/map-api:1.4.0`）。
2. 备份数据库（见下节）。
3. 执行迁移：`docker compose run --rm migrate up`（或 `pnpm db:migrate`）。迁移只应做向后兼容变更。
4. 启动新 API 和 Worker：`docker compose up -d api worker`。
5. 验证就绪检查、登录、地图查询和媒体处理。
6. 再切换 Caddy 流量。
7. 保留上一版本镜像用于回滚。

## 回滚

应用回滚（迁移是向后兼容的，旧代码可以在新库上运行）：

1. 将 `api`、`worker`、`web` 镜像标签改回上一版本。
2. `docker compose up -d api worker web`。
3. 验证 `/health/ready` 与核心流程。

数据库回滚（仅当新迁移必须撤销时）：

```bash
docker compose run --rm migrate status   # 确认每个迁移的回滚能力
docker compose run --rm migrate down 1   # 回滚最近 1 个迁移（事务执行）
pnpm db:rollback                          # 非容器环境等价命令
```

- 回滚按应用顺序的逆序执行，每个迁移在独立事务中回退。
- 迁移文件必须提供 `-- migrate:down` 回滚段才可回滚；测试强制新迁移提供回滚段。
- 数据库回滚后必须部署与库版本匹配的代码（启动校验会阻止版本不一致的进程启动）。
- 数据有丢失风险时优先从备份恢复，而不是依赖 down 迁移。

## 关键监控

- API 错误率、p50/p95/p99 延迟。
- PostgreSQL 连接数、慢查询和磁盘使用率。
- Redis 内存、BullMQ 等待任务和失败任务。
- `media_assets` 中 `processing` 或 `failed` 数量。
- `manual_review` 媒体队列长度。
- `pending` 内容与评论队列长度。
- outbox `pending`、`failed` 数量。
- `delete_after <= now()` 的原图数量。
- 公开桶中是否存在未被数据库引用的对象。

## 备份

- PostgreSQL 每日全量备份并保留 WAL 或等价连续归档。
- MinIO 启用版本化和跨盘/跨区域容灾时，分别备份隔离桶和公开桶。
- `.env.production` 和密钥应保存在密钥管理系统，不进入镜像或仓库。
- 每季度执行一次恢复演练，验证数据库、公开媒体和迁移记录。

## 隐私事件

发现未模糊媒体或原图泄露时：

1. 立即停止相关媒体发布并删除公开对象。
2. 暂停媒体 Worker，防止继续复制到公开桶。
3. 根据对象访问日志确认影响范围。
4. 修复处理管线并执行全量扫描。
5. 删除或隔离受影响对象。
6. 记录事故、根因、修复和回归测试。
7. 按法律与运营要求通知用户。

## 数据保留

- 成功处理原图：24 小时。
- 失败处理原图：最多 7 天。
- 邮箱验证令牌：24 小时。
- 密码重置令牌：30 分钟。
- 过期刷新令牌：30 天清理。
- 账号删除冷静期：30 天。
- 审计与审核记录：默认 180 天，生产可按法务要求延长。
