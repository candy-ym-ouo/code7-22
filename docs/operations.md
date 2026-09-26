# 部署与运维

## 健康检查

所有服务返回统一结构：`status`、`service`、`version`、`env`、`uptimeSeconds`、`time` 和逐项 `checks`（含 `latencyMs` 与失败原因）。

- API 存活：`GET /health/live`（不依赖外部服务，数据库故障不会触发重启循环）
- API 就绪：`GET /health/ready`（探测 PostgreSQL、Redis、隔离桶和公开桶；任一失败返回 503 与失败项）
- Worker 存活：`GET http://<worker>:3100/health/live`
- Worker 就绪：`GET http://<worker>:3100/health/ready`（依赖项同 API；Worker 在就绪前不消费任何任务）
- PostgreSQL：`pg_isready`
- Redis：`redis-cli ping`
- MinIO：`mc ready local`
- ClamAV：`clamdcheck.sh`

编排器应使用就绪探针控制滚动发布与流量切换，使用存活探针决定是否重启。单个依赖探针超时由 `HEALTH_CHECK_TIMEOUT_MS`（默认 2000ms）限定。

## 配置校验与启动顺序

API、Worker 和所有数据库 CLI 共用 `@map/shared` 的环境加载与校验逻辑（`loadEnvFile`/`loadConfig`），从同一个 `.env` 解析，保证开发、测试与生产行为一致：

- 缺少或格式错误的变量在进程启动时一次性列出全部问题，退出码为 1，且不输出任何密钥值。
- `NODE_ENV=production` 下强制：`JWT_ACCESS_SECRET` 至少 32 字符且不得为默认/占位值（包含 `example`、`change-me`、`development` 等字样一律拒绝）、`COOKIE_SECURE=true`、`APP_ORIGIN` 与 `PUBLIC_MEDIA_BASE_URL` 必须是 `https://`。
- 完整变量清单见仓库根目录 `.env.example`。

启动顺序保证（先校验、后连接、再服务）：

1. 配置 schema 校验失败立即退出。
2. 等待 PostgreSQL 可达（`DB_CONNECT_TIMEOUT_SECONDS`，默认 30s，容忍容器启动顺序）。
3. 校验数据库版本与本发行包迁移文件**完全一致**（见下节）。
4. 校验密钥可用；临时短连接探测 Redis 与两个 S3 桶。
5. 以上全部通过后才创建长连接池/BullMQ Worker、绑定端口或开始消费任务。

任何依赖在启动期不可达都使用有界短连接探测，失败时进程以非零码快速退出，不会产生重连风暴或悬挂进程。

## 数据库迁移与版本一致性

迁移文件位于 `packages/db/migrations/`，每个 up 迁移必须配对 `down/<name>.down.sql`。记录表 `schema_migrations` 同时保存每个已应用文件的 SHA-256 校验和。

```bash
pnpm db:migrate     # 应用所有待处理迁移，每个迁移在独立事务中提交
pnpm db:rollback    # 回滚最近一个迁移（可加 --steps=N）
pnpm db:status      # 比对数据库与本发行包，一致退出 0，不一致退出 2
```

应用/Worker 启动时执行与 `db:status` 相同的校验，以下任一情况都会**阻止启动**：

- pending：数据库落后于代码（先跑 `pnpm db:migrate`）；
- drifted：已应用迁移文件在发行包中被改动（校验和不符，默认拒绝迁移，除非显式 `MIGRATE_ALLOW_DRIFT=true`）；
- unknown：数据库含本发行包不认识的迁移（例如新代码尚未部署、数据库已被更新版本迁移）。

新增迁移必须升序编号（`0003_xxx.sql`）并补齐对应 down 文件；迁移测试会校验二者配对、up 创建的每张表都在 down 中删除。

## 日志

所有进程（API、Worker、数据库 CLI）通过 `@map/shared/logging`（pino）输出**行分隔 JSON**，字段固定包含 `level`、`time`（ISO-8601）、`app`、`version`、`env`，开发与生产结构一致。日志级别由 `LOG_LEVEL` 控制（生产默认 `info`）。`authorization`、`cookie`、`set-cookie` 以及 `password`/`secret`/`token` 等字段自动脱敏为 `[redacted]`。

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

## 发布与回滚

1. 构建并锁定 API、Worker、Web 镜像（CI 统一使用 Node 22 + pnpm 11，与本地一致）。
2. 备份数据库。
3. 执行一次 `migrate` 容器（`pnpm db:migrate`）。单个迁移失败会在事务内自动回滚，数据库停留在上一版本，发布中止。
4. 启动新 API 和 Worker；它们只有在数据库版本与镜像内迁移文件一致、且 Redis/S3 全部可达后才进入就绪。
5. 验证就绪检查、登录、地图查询和媒体处理。
6. 再切换 Caddy 流量。
7. 保留上一版本镜像与迁移文件用于回滚。

回滚步骤：

1. 将流量切回上一版本镜像。若数据库未做不兼容迁移，旧镜像启动校验直接通过。
2. 若新版本包含数据库迁移，先停新版本服务，再执行 `pnpm db:rollback`（按需 `--steps=N`）；每个 down 迁移同样在事务内执行，失败会恢复到回滚前状态。
3. 回滚完成后 `pnpm db:status` 应为退出码 0，再启动旧版本镜像。

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

