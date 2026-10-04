# OpenLogTool Server

OpenLogTool 的可选配套服务端，提供用户认证、Session/日志持久化、管理后台，以及协作 v1 的发布、成员和实时事件协议。
客户端的本地记录、词库、历史和导入导出不依赖服务器或账号；只在需要云同步、好友及多人协作时部署本项目。

完整协作协议见 [Session 协作 v1 设计](docs/superpowers/specs/2026-07-11-collaboration-v1-design.md)。
当前专项 API 文档采用“主题 + `api-v1`”的 kebab-case 文件名：

- [Personal Cloud Snapshot API v1](docs/personal-cloud-snapshot-api-v1.md)
- [Personal Dictionary Snapshot API v1](docs/personal-dictionary-snapshot-api-v1.md)
- [Account Excel Export Settings API v1](docs/account-excel-export-settings-api-v1.md)
- [Public Live Share Statistics API v1](docs/public-liveshare-statistics-api-v1.md)
- [Public Archive Lists API v1](docs/public-archive-lists-api-v1.md)
- [Account Session Sharing API v1](docs/account-session-sharing-api-v1.md)
- [好友、会话邀请与申请 API v1](docs/friends-collaboration-api-v1.md)

新版共享入口为“好友与协作”：添加好友、处理消息、邀请或申请加入会话。
好友不会自动获得个人云及历史记录权限；会话默认私有，可由所有者开启好友发现。
服务端声明 `friendCollaboration` 能力，旧 `accountSessionSharing` 保留兼容。

声明 `socialWebSocket` 的服务器提供账号级 `/ws/social` 通知通道，好友请求、会话邀请及申请
变化会通知相关账号，无需先成为会话成员。客户端和门户好友页不再定时轮询；首次连接与重连
都会获取最新列表。连接使用已登录 API 签发的一次性短期票据，不在 URL 中携带登录 token。
反向代理需允许 `/ws/social` 的 WebSocket Upgrade（与现有 `/ws/` 通道一并转发）。

服务端不再因会话闲置而自动结束共同记录或清除其草稿；结束由发起人明确操作，断线不等于结束。

## 技术栈

- TypeScript + Node.js 24 LTS + Express
- SQLite（better-sqlite3）
- WebSocket（ws）
- React 19 + Ant Design 6
- Docker

## 环境要求

- Node.js 24.18 或更高版本
- npm 10 或更高版本

## 配置

复制 `.env.example` 并设置独立随机密钥：

~~~bash
cp .env.example .env
openssl rand -hex 32 # JWT_SECRET
openssl rand -hex 24 # ADMIN_BOOTSTRAP_TOKEN
openssl rand -hex 32 # INVITE_HMAC_KEY
openssl rand -hex 32 # PUBLIC_SHARE_HMAC_KEY
~~~

把四个输出分别填入，四项不可复用同一个值：

~~~dotenv
JWT_SECRET=<至少 32 字节的随机值>
ADMIN_BOOTSTRAP_TOKEN=<至少 24 字节的随机值>
INVITE_HMAC_KEY=<至少 32 字节的独立随机值>
PUBLIC_SHARE_HMAC_KEY=<至少 32 字节的独立随机值>
~~~

生产启动不再接受默认 JWT 密钥。空数据库首次启动时也必须配置管理员初始化 token。

生产环境的 Web 门户 refresh cookie 强制使用 `Secure`。除浏览器认可的本机开发地址外，
必须在服务前配置 HTTPS 反向代理，并保持 `NODE_ENV=production`；不要通过局域网明文 HTTP
登录成员门户或管理后台。若代理终止 TLS，按实际代理层级配置 `TRUST_PROXY`。

## 安装与启动

### 统一客户端入口（可选）

服务端可同时提供 Flutter WebClient，无需另起一个站点或填写第二套服务器地址。
在有 Flutter/Rust Web 构建环境的机器上构建客户端，然后将产物交给服务端安装脚本：

~~~bash
cd ../openlogtool
bash tool/build_web.sh --base-href /client/
cd ../OpenLogToolServer
node scripts/install-web-client.mjs ../openlogtool/build/web
~~~

安装脚本校验必需文件，保留旧产物为 `web-client.backup-<时间>` 后切换新目录，不改数据库。
Node 服务默认读取 `./web-client`，也可用 `WEB_CLIENT_DIR` 指定绝对路径；Compose 已将
`./web-client` 只读挂载到容器。安装或替换产物后重启 Node，或执行
`docker compose up -d --force-recreate server` 重新挂载目录。

- `/connect`：连接说明、可复制地址和二维码；只有检测到客户端产物时才显示客户端按钮。
- `/client/`：记录客户端，首次配置默认使用当前站点的服务器地址，保留用户已有配置。
- `/app/friends`：成员门户的好友入口，和客户端操作同一套好友/邀请/申请数据。
- `/admin`：管理员后台，仍与普通成员操作分开。

桌面/手机客户端可直接在“服务器与账号”粘贴 `/connect`、`/client/` 或门户链接，
自动提取服务器地址后正常登录。二维码不含账号密码或 token，不会自动把门户登录态交给客户端。
WebClient 的 Rust 共享内存要求 HTTPS（或浏览器认可的 localhost）以及服务端已设置的
COOP/COEP 响应头；反向代理需保留这些头，并将 `/client/` 与 `/connect` 同样转发到服务端。
没有 WebClient 产物时，原来的 API、成员门户和管理后台不受影响。

### Docker 首次安装

~~~bash
mkdir -p data
sudo chown -R 1000:1000 data # 容器使用 node 用户（UID/GID 1000）
chmod 700 data
docker compose up -d --build
docker compose ps
~~~

Docker 构建默认使用 npm 官方源，并在 BuildKit 中复用下载缓存。网络访问官方源较慢时，
可以只为构建指定镜像源：

~~~bash
NPM_REGISTRY=https://registry.npmmirror.com docker compose build
docker compose up -d
~~~

Compose 默认只把服务发布到宿主机 `http://127.0.0.1:3000`，容器内仍监听
`0.0.0.0:3000`；SQLite 位于 `./data/openlogtool.db`。需要从其他机器访问时，优先在
本机部署 HTTPS 反向代理；确需直接发布时再修改 `.env` 中的 `BIND_ADDRESS`。

### Docker Compose 一键部署

目标机器已安装 Git、Docker 与 Docker Compose v2 时，可以不安装宿主机 Node.js，直接
执行：

~~~bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Mazha0309/OpenLogToolServer/main/deploy-docker.sh \
  | bash -s -- 3000
~~~

[`deploy-docker.sh`](deploy-docker.sh) 会从 `main` 克隆或安全快进代码，生成并保留四项独立
密钥、构建镜像、重建容器并等待健康检查。已有数据库会在镜像成功构建后停服，并备份到
`~/OpenLogToolServer-backups/<时间>/`；脚本不会强制覆盖本地代码或静默轮换已有密钥。
可通过 `OPENLOGTOOL_BRANCH=dev` 测试其他分支，通过 `OPENLOGTOOL_PROJECT_DIR` 和
`OPENLOGTOOL_BACKUP_DIR` 修改代码及备份目录。更新时省略端口参数会保留 `.env` 中已有的
`HOST_PORT`。

### 一键部署脚本（原生 Node.js）

`deploy.sh` 默认从远端 `main` 分支安装或快进更新代码，保留已有 `.env` 和
`./data/openlogtool.db`，随后依次安装依赖、构建后端与两个 Web 前端并重启服务：

~~~bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/Mazha0309/OpenLogToolServer/main/deploy.sh \
  | bash -s -- 3000
~~~

这条命令要求目标机器已经安装 Git、Node.js 24.18 或更高版本和 npm；缺少依赖时脚本会
明确退出，不会擅自修改系统软件源或安装系统级软件。若机器已安装 PM2，脚本会通过 PM2
启动；否则使用 `nohup` 并将日志写入 `server.log`。需要临时测试其他远端分支时可显式
设置，例如 `OPENLOGTOOL_BRANCH=dev bash deploy.sh 3000`。
仓库存在未提交的已跟踪文件修改或无法快进时，脚本会停止，不会强制覆盖本地改动。

### 更新已有部署

更新前不要删除或重新生成 `.env` 中现有的密钥，否则既有登录、邀请或 Live Share
链接可能失效。使用上述 Docker Compose 一键脚本时，重新执行同一条 `curl` 命令即可安全
快进、备份和重建。手动维护的 Docker 部署建议先完成镜像构建，再短暂停服并备份 SQLite，
最后重建容器：

~~~bash
cd ~/OpenLogToolServer
git fetch origin main
git switch main
git pull --ff-only origin main
docker compose build server
docker compose stop server
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
docker compose up -d --force-recreate server
docker compose ps
curl -fsS http://127.0.0.1:3000/api/v1/server-info
~~~

若 `.env` 中自定义了 `HOST_PORT`，最后的健康检查地址也要改成对应端口。数据库迁移在新
版本进程启动时自动执行；不要同时运行新旧两个进程访问同一个 SQLite 文件。仅修改环境
变量时不必重新构建镜像，执行 `docker compose up -d --force-recreate server` 即可。

原生 Node.js/PM2 部署可在备份 `./data` 后重新运行相同的一键部署命令。部署 `dev` 仅用于
测试；生产环境应使用默认的 `main`。

### HTTPS 反向代理与 WebSocket

若只有一层可信 HTTPS 反向代理，在 `.env` 中设置：

~~~dotenv
TRUST_PROXY=1
~~~

也可以在管理后台的“服务器设置 → 可信代理层数”中填写 `1`；后台保存的数据库覆盖值
优先于 `.env`，两种方式任选其一，随后都需要重启服务。

代理必须把站点根路径下的 `/live`、`/api` 和 `/ws` 都转发到 OpenLogTool Server，
并为 `/ws` 启用 HTTP/1.1 WebSocket Upgrade。根路径的通用代理还必须原样保留
`/BR5AI` 和 `/BR5AI/session/<id>` 这类公开归档别名路径；归档读取不需要
Upgrade。可直接参考
[`deploy/nginx-openlogtool.conf.example`](deploy/nginx-openlogtool.conf.example)。修改
`TRUST_PROXY` 后必须重启服务：

~~~bash
docker compose up -d
~~~

若 Live Share 能载入已有记录，却一直显示“连接中断，正在自动重连”，在浏览器开发者
工具的 Network/WS 中检查 `/ws/public`：

- `403`：通常是 `TRUST_PROXY`、`Host` 或 `X-Forwarded-Proto` 配置错误；
- `404`、`200` 或 `502`：通常是代理没有转发 `/ws` 或没有启用 Upgrade；
- `101` 后关闭：请求已到达 Node，应继续根据 WebSocket 关闭码检查服务端事件流。

当代理已经发送转发头但 `TRUST_PROXY` 仍未启用时，服务端也会以最多每分钟一次的频率
写入明确的 WebSocket 配置警告，避免重连请求刷满日志。

不要在不可信客户端可直接访问 Node 端口时盲目设置 `TRUST_PROXY=true`；应填写实际可信
代理跳数，并继续让 Compose 端口仅绑定在 loopback 或受防火墙保护的代理网络。

### 直接运行

~~~bash
npm ci

(cd web && npm ci)
(cd live && npm ci)

npm run verify
npm start
~~~

开发模式：

~~~bash
npm run dev
~~~

## 首个管理员

不再由“第一个公网注册者”自动成为管理员。空数据库初始化时调用：

~~~bash
curl -X POST http://127.0.0.1:3000/api/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Secret: <ADMIN_BOOTSTRAP_TOKEN>' \
  -d '{"username":"admin","password":"replace-with-a-strong-password"}'
~~~

初始化只能成功一次。之后是否允许普通用户注册由管理后台的注册开关决定。

## API v1 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/server-info` | 服务端实例 ID、协议范围和已启用能力 |
| POST | `/api/v1/auth/bootstrap` | 初始化第一个管理员 |
| POST | `/api/v1/auth/register` | 注册普通用户 |
| POST | `/api/v1/auth/login` | 登录并取得 access/refresh token |
| POST | `/api/v1/auth/refresh` | 轮换 refresh token |
| POST | `/api/v1/auth/logout` | 撤销 refresh token |
| GET | `/api/v1/auth/me` | 当前用户 |
| POST | `/api/v1/auth/complete-password-change` | 使用一次性短期凭据完成临时密码强制修改 |
| POST | `/api/v1/web-auth/bootstrap|register|login|refresh|logout` | Web 门户认证；refresh token 仅存 HttpOnly、SameSite=Strict Cookie |
| GET/PATCH | `/api/v1/account` | 当前账户资料 |
| PATCH | `/api/v1/account/username|password` | 修改当前账户用户名或密码 |
| GET/DELETE | `/api/v1/account/devices...` | 查看并撤销自己的设备会话 |
| GET/PUT | `/api/v1/account/excel-export-settings` | 读取或保存当前账户的客户端兼容 Excel 导出样式、文件名与抬头规则 |
| GET/PUT | `/api/v1/account/personal-snapshot` | 读取元数据或按 revision 原子替换个人记录云快照 |
| GET | `/api/v1/account/personal-snapshot/download` | 下载个人记录云快照；与协作 Session 完全分离 |
| GET | `/api/v1/account/personal-snapshot/sessions/:sessionId/database-backup-v7` | 将自己的单个快照会话及其记录导出为客户端可恢复的数据库备份 v7 JSON |
| GET/PUT | `/api/v1/account/personal-dictionary-snapshot` | 读取元数据或按 revision 原子替换词库用户改动快照 |
| GET | `/api/v1/account/personal-dictionary-snapshot/download` | 下载用户词条及默认词条删除覆盖；不传输完整内置词库 |
| GET | `/api/v1/admin/overview` | 管理员读取服务器与用户、Session 的非识别聚合概览 |
| GET/PATCH | `/api/v1/admin/settings` | 管理员读取或幂等更新普通用户注册开关 |
| GET | `/api/v1/admin/users?q=&role=&page=&pageSize=` | 管理员分页搜索账户 |
| GET | `/api/v1/admin/personal-snapshots?q=&page=&pageSize=` | 管理员分页查看各账户个人云快照元数据；不属于协作 Session |
| GET | `/api/v1/admin/personal-snapshots/:userId` | 管理员只读查看并审计某账户的完整个人云快照 |
| GET | `/api/v1/admin/personal-snapshots/:userId/sessions/:sessionId/database-backup-v7` | 管理员审计后导出指定账户的单个快照会话 v7 JSON |
| GET | `/api/v1/admin/personal-dictionary-snapshots?q=&page=&pageSize=` | 管理员分页查看账户词库改动快照元数据 |
| GET | `/api/v1/admin/personal-dictionary-snapshots/:userId` | 管理员只读查看并审计账户词库改动快照 |
| PATCH | `/api/v1/admin/users/:userId/role` | 幂等变更账户角色并撤销其活动 refresh token |
| POST | `/api/v1/admin/users/:userId/revoke-refresh-tokens` | 幂等撤销账户的活动 refresh token |
| PATCH | `/api/v1/admin/users/:userId/login-expiration` | 管理员为其他账户开启或关闭“登录永不过期”策略 |
| GET | `/api/v1/admin/audit-events?...` | 按稳定 cursor 查询运行时管理审计 |
| GET | `/api/v1/admin/collaboration-metrics` | 管理员读取进程 CPU/内存、运行环境资源、请求、连接和数据库聚合指标 |
| GET | `/api/v1/admin/public-liveshare-stats?limit=` | 管理员读取 Live Share 当前连接与有效打开统计；列表响应 `schemaVersion: 1` |
| GET | `/api/v1/admin/public-liveshare-stats/:publicShareId` | 管理员读取单个 Live Share 的统计及按 IP 聚合的访客详情；详情响应 `schemaVersion: 4` |
| GET | `/api/v1/admin/session-event-retention/preview` | 管理员只读预演 Session 事件裁剪 |
| POST | `/api/v1/admin/session-event-retention/prune` | 管理员显式、幂等执行有界 Session 事件裁剪 |
| POST | `/api/v1/admin/elevate` | 当前密码复核，签发 5 分钟危险操作 elevation |
| GET/POST/DELETE | `/api/v1/admin/users/:id...` | 账户详情、临时密码、禁用/启用与匿名化删除 |
| GET/PATCH/POST/DELETE | `/api/v1/admin/sessions...` | 全局 Session、Log、成员、邀请和公开分享治理 |
| GET | `/api/v1/admin/governance-audit-events` | 分页查询敏感读取与治理审计 |
| GET/PATCH | `/api/v1/admin/operational-settings` | 读取/修改可编辑运行参数，并明确返回是否需重启 |
| POST | `/api/v1/admin/sessions/:id/export` | 审计后下载 CSV 或 JSON |
| POST | `/api/v1/admin/database-backup` | 审计后在线生成并下载一致性 SQLite 备份 |
| GET | `/api/v1/admin/database-recovery` | 管理员查看恢复能力与最近结果 |
| POST | `/api/v1/admin/database-recovery/preview` | 重新认证后上传 SQLite 文件校验，不修改当前数据 |
| POST | `/api/v1/admin/database-recovery/confirm` | 二次确认恢复任务，重启期间先自动备份再以事务替换数据 |
| POST | `/api/v1/admin/database-recovery/safety-backup` | 重新认证并填写原因，下载最近一次恢复前自动备份 |
| GET/PUT | `/api/v1/sessions`、`/api/v1/sessions/:id` | 成员 Session 列表与幂等发布初始化 |
| GET | `/api/v1/sessions/catalog` | 当前成员可访问 Session 的分页目录 |
| GET | `/api/v1/sessions/:id/logs` | 当前成员的分页日志；返回逐条 `ownedByCurrentUser`/`canMutate` |
| POST | `/api/v1/sessions/:id/bootstrap/logs` | 分批写入发布快照（最多 500 条/批） |
| POST | `/api/v1/sessions/:id/activate` | 校验记录数并激活 Session |
| GET | `/api/v1/sessions/:id/snapshot` | 一致性完整快照 |
| GET | `/api/v1/sessions/:id/membership` | 当前成员权限 |
| DELETE | `/api/v1/sessions/:id/membership` | Editor/Viewer 幂等主动离开 Session |
| GET/PATCH/DELETE | `/api/v1/sessions/:id/members...` | Owner 成员管理 |
| POST | `/api/v1/sessions/:id/transfer-ownership` | 事务性转移所有权 |
| GET/POST/DELETE | `/api/v1/sessions/:id/invites...` | Owner 邀请管理 |
| GET | `/api/v1/sessions/:id/audit-events?...` | Owner 按稳定 cursor 查询协作安全审计 |
| GET/POST/DELETE | `/api/v1/sessions/:id/public-shares...` | Owner 创建、列出和撤销公开 Liveshare capability |
| POST | `/api/v1/collaboration-invites/redeem` | 原子、幂等兑换邀请码 |
| POST | `/api/v1/public-shares/:id/exchange` | 用公开链接 secret 换取 5 分钟 public access token |
| GET | `/api/v1/public/sessions/:id/snapshot` | 获取严格裁剪的公开完整快照 |
| POST | `/api/v1/public/sessions/:id/ws-ticket` | 创建 60 秒、单次使用的公开 WebSocket ticket |
| GET/POST | `/api/v1/public-archive-lists` | 认证后的公开归档列表分页、创建与列表管理 |
| GET/PATCH/DELETE | `/api/v1/public-archive-lists/:listId` | 读取、改标题或删除归档列表 |
| POST | `/api/v1/public-archive-lists/:listId/publish|unpublish` | 发布或取消发布归档列表 |
| GET/PUT/DELETE | `/api/v1/public-archive-lists/:listId/members|sources...` | 管理归档成员与来源账户（所有者/管理员），支持按用户名精确添加 |
| GET | `/api/v1/public-archive-lists/:listId/candidate-accounts?kind=` | 可添加账户候选列表（所有者仅见共享协作会话账户，管理员见全部） |
| GET/POST/PATCH/PUT/DELETE | `/api/v1/public-archive-lists/:listId/available-sessions|sessions...` | 读取可用已关闭会话、创建/刷新/排序/删除快照 |
| PUT/DELETE | `/api/v1/admin/public-archive-lists/:listId/alias` | 管理员设置、替换或删除根路径别名 |
| GET | `/api/v1/public/archive-lists/:listId...` | 无 token 的公开归档列表及会话快照读取 |
| GET | `/api/v1/public/archive-aliases/:alias...` | 无 token 的公开归档别名读取 |
| POST | `/api/v1/sessions/:id/mutations` | 批量提交独立原子的 Log/Session mutation |
| GET | `/api/v1/sessions/:id/events?afterSeq=N` | 按连续 Session seq 补拉规范事件 |
| POST | `/api/v1/sessions/:id/ws-ticket` | 创建 60 秒、单次使用的鉴权 WebSocket ticket |
| GET/PATCH/DELETE | `/api/v1/sessions/:id/live-draft` | 读取、字段更新或幂等丢弃当前共享点名草稿 |
| POST/DELETE | `/api/v1/sessions/:id/live-draft/locks...` | 获取、续租或释放 30 秒字段租约 |
| POST | `/api/v1/sessions/:id/live-draft/commit` | 幂等提交草稿为正式 Log 并切换到下一位 |

实时连接使用 `/ws/collaboration?ticket=...`。服务端先发送 `hello`，连续投递 ticket cursor 之后的 backlog，再发送 `ready` 并进入 live；业务写入始终走 REST。每个 accepted mutation 的 REST event、`events` 补拉对象、数据库事件和 WebSocket event 是同一个规范对象。ticket 会绑定签发时的成员角色和版本，权限变化后的旧 ticket 不能消费；WS backlog 超过 1000 条时客户端必须先用 REST 补拉，慢消费者缓冲超过 8 MiB 会被要求重新同步。

`server-info.features` 包含 `publicLiveshare` 时，公开 Liveshare v1 服务端能力可用。Owner 可以为 `active` 或 `closed` Session 创建、列出和撤销公开链接；每个 Session 同时最多 20 个未撤销且未过期的链接，默认有效 24 小时、最长 30 天，并最多保留 5,000 条包含 active、expired、revoked 状态的公开链接历史，达到历史上限后拒绝继续创建。`GET /api/v1/sessions/:id/public-shares` 使用 `limit`（默认且最大 50）与不透明 `after` cursor 分页，响应固定包含 `publicShares` 和可为 `null` 的 `nextCursor`。创建响应中的 secret 由独立 `PUBLIC_SHARE_HMAC_KEY` 派生且只在首次创建或链接仍 active 时的精确幂等重放中返回，数据库中的 capability 行、持久幂等记录和审计都不保存明文 secret。若配置密钥与数据库指纹不匹配，服务器继续提供其他能力，但不宣告 `publicLiveshare`，相关 API 返回 503。

公开页面应从 `/live/{publicShareId}#token={secret}` 的 fragment 读取 secret，在内存中调用 exchange；服务端返回最长 5 分钟、`type=public-share-access` 且 audience 为 `openlogtool-public-v1` 的独立 JWT。该 token 只能读取绑定 Session 的公开 snapshot 和换取公开 WS ticket，不能充当成员 token。公开 snapshot 同时硬限 20,000 条未删除 Log 和 8 MiB 序列化 UTF-8 JSON，任一超限均返回 `413 PUBLIC_SNAPSHOT_TOO_LARGE`；进行中的 snapshot 全局最多 8 个、同一 share 最多 2 个，容量已满时返回 `429 PUBLIC_SNAPSHOT_BUSY` 和 `Retry-After: 1`。随后客户端以 `highWatermarkSeq` 获取 ticket 并连接 `/ws/public?ticket=...`。服务端按 `hello → backlog → ready → live` 投递同一连续 seq，backlog 上限 1000；超过上限时必须重新获取完整公开快照。

公开 snapshot 和 event 使用逐字段白名单 DTO：保留 Session 标题、状态及 Log 业务字段（包括电台设备字段 `device`），删除 actor、user/account ID、actor deviceId/sourceDeviceId、mutationId、entityVersion、成员、邀请和内部审计数据。同一 share 最多存在 8 张、同一 public JWT `jti` 最多存在 4 张未消费 ticket；签发前立即清理已过期 ticket，成功消费后在同一事务中删除 ticket 行。公开链接被 Owner 撤销、自然到期或所属 Session 删除后，exchange、REST、未消费 ticket 和现有 `/ws/public` 连接都会停止授权；Session 删除时，已连接页面先收到裁剪后的最终 `session.deleted` 再关闭。

管理员统计把 Live Share 的“当前观看连接”定义为当前进程内活动的公开 WebSocket 数，近似表示打开的页面/标签页，不代表可识别的独立人数；断网连接最多会在心跳检测后移除。“累计有效打开”由公开页面每次生命周期生成仅存内存的随机 ID，并在 secret 验证成功时登记，同一页面的 5 分钟 access token 续签不会重复累计。服务器只保存由 `PUBLIC_SHARE_HMAC_KEY` 派生的 HMAC 去重值，不保存原始页面 ID 或 User-Agent；迁移 v24 起还会为每个去重会话保存最近一次可信请求 IP，并在管理员详情接口中按 IP 聚合访问次数，IP 的准确性和安全边界取决于 `TRUST_PROXY`。服务端通过内置的 [`ip2region`](https://github.com/yourtion/node-ip2region) IPv4 数据库离线推断国家、省、市和运营商，不会把访客 IP 发送给外部定位服务；内网、保留地址或查询失败时显示为不可用。离线 IP 属地通常只精确到城市，不能可靠识别自然人或用于计费。分享撤销、过期或 Session 删除后清理去重和 IP 明细，但保留聚合计数。去重明细硬限制为每个分享 10,000 条、当前数据库 100,000 条；达到任一限制时计入触发限制的那次打开，随后停止增加该分享的累计数并在管理端标成下限值，避免公开链接造成无限数据库增长。聚合统计从迁移 v23 部署后开始，IP 明细从迁移 v24 部署后开始，均不回填历史访问；旧明细的 IP 可为 `null`。完整响应、范围和隐私约束见 [Public Live Share Statistics API v1](docs/public-liveshare-statistics-api-v1.md)。

从 `0.8.1` 起不再使用外部 IP 定位服务；旧 `.env` 中残留的 `BAIDU_MAP_AK` 会被忽略，
可以安全删除。

生产默认启用实例内存限流：公开链接管理按 actor/IP/Session 为 60 次/分钟，并另按 actor/Session 限制为 120 次/分钟；exchange 按 IP 为 30 次/分钟、按 IP+share 为 10 次/分钟；snapshot 与 public WS ticket 分别按 IP+Session 为 30 次/分钟、按 share 为 60 次/分钟。这些限流桶、snapshot 并发计数与实时 hub 都是单进程内状态，生产环境必须保持单 Node.js 进程；多副本部署前需实现共享限流状态和跨实例 pub/sub。

Mutation 单批最多 100 个操作和 1 MiB。每个操作使用独立 UUID `mutationId`，重试必须复用；服务端把首次 accepted/conflict/rejected 结果持久化。Log 支持 create/update/delete/restore，Session Owner 支持 title update/close/reopen/delete，全部使用严格 `baseVersion`。活动 Session 中的 Owner/Editor 可以修改、删除和恢复会话内任意 Log，Viewer 只读；`ownedByCurrentUser` 仅描述创建者关系，实际写权限以 `canMutate`、当前成员角色和 Session 状态为准。`created_by=NULL` 的历史记录不再被特殊锁定。Session 删除要求先关闭活动 Session；未完成发布的 `initializing` Session 可直接取消。成功删除会原子撤销邀请和 WS ticket、生成唯一最终 `session.deleted` 事件，并在广播终止事件后关闭该 Session 的实时连接。

`server-info.features` 包含 `collaborationSecurityAudit` 时，服务端支持 Session 级协作安全审计。审计记录成员、所有权、邀请、公开链接和 Session 删除的九种实际安全状态变化；公开链接对应 `public_share.created`、`public_share.revoked`。`GET /api/v1/sessions/:id/audit-events` 仅允许该 Session 的当前 Owner 调用；Session 软删除后，最终 Owner 仍可读取包含删除事件的审计记录。服务器全局 `admin` 身份不会旁路对象级 membership，未加入该 Session 时仍返回 `404 NOT_FOUND`。

协作审计查询支持 `action`、`actorUserId`、`targetUserId`、`from`、`to`、`cursor` 和 `limit`；`limit` 默认 50、最大 100，时间窗口为 `[from,to)`。结果按 `(occurredAt, auditEventId)` 倒序稳定分页，cursor 由服务端签名并绑定 Session、当前 Owner、过滤条件和分页边界，不能跨 Session、跨 Owner 或更换过滤条件复用。action 的 `before`、`after` 和 `details` 只接受严格白名单的安全元数据，不会从业务 payload 复制 Session 标题、Log 内容、邀请码或邀请链接、credential hash、密码/token、device、IP 或 User-Agent。

`requestId` 和 `mutationId` 是调用方提供并原样进入审计的关联标识；客户端必须使用随机 UUID，不得把邀请码、链接 token、密码或其他 secret 当作关联 ID。服务端的字段白名单用于阻断业务字段误写，不把允许任意 stable ID 的接口伪装成内容识别或数据防泄漏系统。

成员、所有权、邀请、公开链接及 Session 删除的业务变化、审计事件和幂等结果在同一个 SQLite 事务中提交；失败或精确重放不会产生重复审计。迁移 v10 不猜测或回填升级前的历史操作，只从迁移完成后开始记录；迁移 v11 保留既有审计并扩展公开链接 action；迁移 v12 保留既有管理审计并加入 `session_events.pruned`。审计表通过数据库 trigger 禁止普通 `UPDATE`/`DELETE`，用于阻止应用缺陷和常规 SQL 误改；这不是针对掌握宿主文件、服务进程或数据库管理权限者的防篡改存储，若有合规取证要求仍应外送到独立的追加式审计系统。

Access token 默认 15 分钟有效，refresh token 默认 30 天有效并在刷新时轮换。

原有 overview、账户分页、指标和事件裁剪接口仍保持最小 control-plane DTO，不泄露业务内容。新增的治理接口则显式授予当前全局管理员跨 Session 的调查和纠错能力：敏感详情读取会去重记入治理审计，业务修改复用规范 mutation/event 流，危险操作还必须提供原因、`Idempotency-Key` 和 5 分钟 elevation。普通成员 API 不会因为账户 `role=admin` 而绕过 membership 或 Session 状态规则。

活动 Session 若被未提交实时草稿或字段租约阻塞，管理员可调用 `POST /api/v1/admin/sessions/:id/close-discarding-live-draft`，提供 `expectedVersion`、审计原因、`Idempotency-Key` 和 elevation，在一个事务中丢弃草稿及设备重放状态并关闭 Session；成功后服务端清除内存字段锁并广播关闭事件。普通删除仍只接受 `closed` 或未完成发布的 `initializing` Session。

`collaborationOperationalMetrics` capability 对应的指标接口只返回固定维度：当前进程启动后的 HTTP、mutation、event、成员/公开 WebSocket 计数和延迟桶，以及当前数据库的 Session、Log、membership、活动 capability/ticket、事件保留量等聚合 gauge。它不返回 Session ID、标题、用户关联、Log 内容、IP 或 secret；进程计数在服务重启后从零开始，也不会跨 Node.js 实例合并。

`sessionEventRetention` capability 对应显式维护 API。preview 和 prune 的策略默认分别为保留 180 天、每个 Session 至少保留最新 10,000 条事件、单次最多纳入 100 个候选 Session，并由服务端再硬限单次最多删除 25,000 条；可请求的范围为 30..3650 天、1,000..1,000,000 条最低保留量和 1..100 个 Session。裁剪只删除严格早于 cutoff 的连续旧前缀，先单调推进 `min_retained_seq`，再删除对应 `session_events`；非规范时间（包括 SQLite 可解析但并非真实规范日期的值）、时间边界、序列缺口或并发游标变化都会阻止越界删除。`maxSessions` 限制纳入计划的候选数，不是 Session 元数据读取行数的硬预算；Session 目录极大时应先 preview，并把维护安排在低峰期。服务端不会自动调度裁剪，也不会顺带删除 Log/tombstone、幂等结果、审计、成员、邀请或公开链接，更不会自动执行 `VACUUM`。

`collaborationLiveDraft` capability 表示 active Session 可以使用一份服务端持久共享点名草稿，closed Session 仍可只读最后状态。Viewer 只能读取；Owner/Editor 先取得 30 秒字段租约，再用字段 revision 和每设备串行 `clientSeq` 原子 PATCH。设备重试只保留当前草稿代的最近一次序列/响应，空间按 Session、用户和设备有界；commit/discard 换代时清除旧代设备响应。commit 要求 `Idempotency-Key`、当前 draft version 和稳定 `syncId`，在一个事务内创建正式 Log、追加规范 `log.created`、保存响应并重置下一位草稿；双提交不会生成两条记录。含实际来台内容或仍有字段租约的草稿会阻止关闭 Session，必须先提交、显式丢弃或释放租约。草稿控制消息仅发送成员 `/ws/collaboration`，没有连续 seq，重连必须重新 GET；它们不进入公开 snapshot、`/ws/public`、`session_events` 或协作安全审计。启用实例限流时，同一成员/IP/Session 的 GET、锁操作、PATCH、commit/discard 分别限制为每分钟 120、180、600、60 次。

四类服务器管理写操作（settings PATCH、角色变更、refresh token 撤销、事件 prune）都要求 `Idempotency-Key` 和严格 JSON 对象；refresh token 撤销可以不带正文，但不会把携带非 JSON 正文的请求误当成空命令。相同管理员用同一 key 重试同一路径和请求体会精确重放首次成功响应，并返回 `Idempotent-Replay: true`；key 被其他管理员、路径或请求体复用时返回 `409 MUTATION_ID_REUSED`。对应业务写、审计事件和幂等响应位于同一个 `BEGIN IMMEDIATE` 事务中，任一步失败都会整体回滚。

管理员不能修改自己的角色：有其他管理员时，自我角色变更返回 `409 SELF_ROLE_CHANGE_FORBIDDEN`；若该账户同时是最后一名管理员，自我降级返回更具体的 `409 LAST_ADMIN_REQUIRED`。两种情况都执行零写入。角色实际变化会撤销目标账户仍有效的 refresh token，现有无状态 access token 最多继续到自身过期，但管理接口每次都会同时检查 token claim 和数据库当前角色，所以被降级账户会立即失去 control-plane 权限。晋升账户需要重新登录后取得带新角色的 access token。

“登录永不过期”会把开启时仍有效的 refresh/device session 转为持久会话，历史上已经到期的凭据不会恢复；短期 access token 仍照常轮换，账户禁用、密码修改、管理员撤销全部登录、设备撤销和主动退出仍会立即使对应凭据失效。关闭策略后，活动设备恢复服务器配置的普通 refresh 有效期。该策略只能由已重新验证的管理员为其他账户修改，并写入治理审计。

运行时管理审计记录注册开关、账户角色、refresh token 撤销和实际事件裁剪。只有 prune 确实删除事件时才写入 `session_events.pruned`，只记录删除数量、受影响 Session 数和策略，不记录 Session ID 或内容。`GET /api/v1/admin/audit-events` 支持 `action`、`actorUserId`、`targetUserId`、`from`、`to`、`cursor` 和 `limit`；时间窗口是 `[from,to)`，cursor 使用服务器密钥签名并与过滤条件、分页边界绑定，响应只返回管理事件白名单字段，不包含密码、token、IP、User-Agent 或协作数据。

旧 `/api/auth`、`/api/admin`、`/api/sessions`、`/api/shares`、旧 Liveshare 数据接口与无鉴权 `/ws` 均不再挂载。所有账户、管理和协作流量只走 `/api/v1`；迁移 v6 会统一撤销历史 `shares`，防止绕过 v1 成员权限、Session 状态校验、幂等与副本序列。

## 页面

- 登录、注册和首次初始化：`/login`、`/register`、`/bootstrap`
- 成员门户、我的会话与账户设备：`/app/*`
- 管理员治理与运维：`/admin/*`
- 安全公开大屏：`/live/{publicShareId}#token={secret}`
- 静态公开归档：`/live/list/:listId`、`/:alias` 及其 `/session/:archiveSessionId` 页面；不使用 token、cookie、轮询或 WebSocket

成员门户与管理后台是同一个响应式 React 应用，支持简体中文/英文、system/light/dark 主题、可折叠桌面侧栏和移动抽屉。公开 Liveshare 是独立最小 bundle：保留 URL fragment 但只在内存保存 secret/access/ticket，严格执行 exchange → snapshot → 单次 WS ticket → `hello/backlog/ready/live`，遇到序列缺口、过期、撤销或断线会重新同步。静态归档页面使用一次性 tokenless API 读取快照，不进入 LiveShare 实时或统计流程。

管理员“运行与维护”页面每 10 秒在前台可见时刷新，展示服务进程 CPU/RSS/堆内存、Node 可见的运行环境 CPU/内存与负载、可用时的 cgroup v2 内存、请求错误和成员/公开连接，并列出逐 Live Share 的当前连接和累计有效打开；进入单分享详情后还会显示访客最近可信请求 IP、首末访问时间及当前在线提示。进程计数和当前连接在服务重启后归零；累计打开保存在当前数据库。容器和宿主资源边界会随部署运行时而异，页面会明确标注统计范围，不会把它描述为跨实例监控。

## 备份与恢复

管理员入口：`/admin/backups`（侧边栏“备份与恢复”）。在线备份包含整个数据库，
**不包含 `.env`、部署文件或客户端本机数据**。备份含密码哈希等敏感信息，须安全保存。

网页恢复仅支持本服务器及其此前恢复实例的**同结构** SQLite 文件（最大 64 MiB）；
旧版本、跨服务器迁移或更大文件请停服后采用对应版本的离线恢复流程，不要直接替换运行中的数据库。
上传后展示数量、结构版本与 SHA-256，预览 15 分钟有效，绑定管理员登录会话；
再次验证密码、填写原因并输入 `RESTORE` 才能确认。原数据在确认后仍不会被在线替换。
服务停止后，下次启动在 HTTP/WS 监听前执行恢复。默认 Docker `restart: unless-stopped`
会自动拉起；原生进程需由管理员或进程管理器重新启动。

恢复前自动备份位于数据库同目录 `.database-recovery/before-<任务ID>.sqlite3`。
替换所有数据及完成审计在同一 SQLite 事务中提交，失败回滚，重复启动不会重复执行已完成任务。
保留发起管理员的**当前密码**，用户名以校验预览为准；撤销所有登录会话并更换服务器实例 ID，
客户端需重新登录、核对服务器连接，防止旧游标或待同步修改自动写回。结果可在备份恢复页查看。
恢复文件与安全备份不会自动删除，请按自己的保留策略离线管理，不要删除待执行任务的文件。

## 数据库迁移

迁移作为 TypeScript 模块编译进 `dist`，启动时按版本和 checksum 顺序执行，不依赖运行时复制 `schema.sql`。

基础迁移会：

- 创建稳定 `serverInstanceId`；
- 创建 refresh token 和迁移审计表；
- 增加 Session/Log 的版本基础字段；
- 无损处理旧库重复 Log；
- 建立 `UNIQUE(session_id, sync_id)`；
- 创建成员、邀请、兑换与持久幂等表，并回填旧 Session Owner；
- 创建连续 `session_events` 和仅存 hash 的单次 `ws_tickets`（迁移 v8）；
- 创建追加式运行时管理审计、角色约束与查询索引（迁移 v9）；
- 创建 Owner-only 的追加式协作安全审计及稳定查询索引（迁移 v10，不回填历史事件）；
- 创建只存 hash 的 `public_shares`、单次 `public_ws_tickets`，并无损扩展公开链接审计（迁移 v11）；
- 无损扩展管理审计的事件裁剪 action，并约束 Session 事件游标只能合法、单调前进（迁移 v12）；
- 创建单 Session 唯一的持久共享草稿和有界设备重放状态，并约束草稿版本单调前进（迁移 v13）；
- 增加账户禁用/删除、强制改密、鉴权版本和设备会话安全字段（迁移 v14）；
- 创建追加式管理员治理审计和服务器运行参数覆盖表（迁移 v15）；
- 将 refresh token 轮换链绑定到服务端生成的认证会话族（迁移 v16）；
- 将成员 WebSocket ticket 绑定到对应认证会话族（迁移 v17）；
- 绑定 refresh token 的凭据版本，并为旧式无会话 WebSocket ticket 固化 access 过期时间（迁移 v18）；
- 创建账户级个人记录云快照和用户词库改动快照（迁移 v19、v20）；
- 规范用户名的 Unicode 不区分大小写身份，并增加账户登录有效期策略（迁移 v21、v22）；
- 创建隐私安全的公开分享打开聚合与短期 HMAC 去重明细（迁移 v23）；
- 为公开分享访问明细记录最近可信请求 IP，并把页面会话关联到公开 WebSocket ticket（迁移 v24）；
- 创建公开归档列表及其成员、授权来源、不可变的已关闭 Session 快照/日志和根别名映射（迁移 v25）；
- 为 `public_archive_aliases` 增加并回填 `display_alias`，保留管理员选择的显示大小写，同时保持规范别名不区分大小写（迁移 v26）；
- 创建按账户持久化的客户端兼容 Excel 导出样式设置（迁移 v27）；
- 创建短期 Excel AI 校对预览、加密只写 LLM 凭据，并扩展 WebUI 可保存的 LLM 运行配置（迁移 v28）；
- 将邀请码 HMAC 密钥指纹绑定到服务器数据库，阻止静默错换密钥；
- 启用 WAL、外键和 5 秒 busy timeout。

迁移 v9 会在启用账户管理写接口前校验历史 `users.role`：只接受 `admin`/`user`，且非空用户库必须至少保留一名管理员。发现损坏数据时服务器会拒绝启动，不会静默选择或提升任意账户；修复前应先备份数据库并明确核对管理员身份。

修改生产数据库前应备份 `data/openlogtool.db`。

## 验证命令

~~~bash
npm run typecheck
npm test
npm run test:dist
npm run verify
~~~

`npm run verify` 会依次执行服务端 typecheck、全部 API/迁移测试、正式编译产物冒烟，以及 Web 门户和 Liveshare 的 lint、测试与生产构建。`test:dist` 会使用正式编译产物在临时目录创建数据库，验证迁移表、关键列、唯一索引、外键和 WAL，并演练备份下载、上传校验、确认停服、重启恢复、令牌撤销和重新登录；不访问生产数据库。

## Excel AI 校对

服务端可使用可选 LLM，把一份已经人工整理完成的 `.xlsx` 点名表与现有协作会话逐条比对。会话的 Owner/Editor 可在 Web 门户“记录”页选择 **AI 校对 Excel**；服务端管理员也可在管理后台的协作会话“记录”页操作任意未删除会话。已关闭会话仅 Owner 或服务端管理员可操作。工作流固定为“浏览器解析工作簿 → 服务端分段识别 → 显示逐字段差异 → 人工勾选确认 → 原子写入”，模型本身没有数据库写权限。确认时会再次检查每条 Log 的版本，任何并发修改都会拒绝整批写入并要求重新生成预览；管理员应用的批次还会写入治理审计日志。

提示词明确区分点名主控行与来台记录、RST 发/收及全部 11 个记录字段；表格内容一律按不可信数据处理，单元格中的指令不会执行。服务端不会保存原始文件或完整提示词，只短期保存 30 分钟的结构化差异预览。表格文字会发送给你配置的模型服务，因此生产部署前应确认服务商的数据处理条款。

协议、Base URL、模型、超时和 API Key 都可以由管理员在 WebUI“服务器设置 → 服务端 LLM”中填写。API Key 是只写字段，不会回显；服务端使用由 `JWT_SECRET` 派生的 AES-256-GCM 密钥加密后写入 SQLite。若更换 `JWT_SECRET`，需在 WebUI 重新填写 API Key。`LLM_API_KEY` 环境变量仍可作为首次部署或未保存 WebUI 密钥时的后备值；环境值变更后需要重启服务。示例：

接口、权限、限制和确认写入约束见 [Excel AI 校对 API v1](docs/excel-ai-corrections-api-v1.md)。

~~~env
LLM_PROVIDER=openai-chat
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL=your-model
LLM_API_KEY=your-secret
LLM_TIMEOUT_SECONDS=90
~~~

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `./data/openlogtool.db` | SQLite 路径 |
| `JWT_SECRET` | 无 | 必填，至少 32 字节 |
| `ADMIN_BOOTSTRAP_TOKEN` | 无 | 空库必填，至少 24 字节 |
| `INVITE_HMAC_KEY` | 无 | 必填，至少 32 字节；不得复用 JWT 密钥 |
| `PUBLIC_SHARE_HMAC_KEY` | 无 | 必填，至少 32 字节；独立派生公开链接 secret，不得复用 JWT/邀请密钥 |
| `JWT_ISSUER` | `openlogtool-server` | JWT issuer |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token 生命周期 |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token 生命周期 |
| `CORS_ORIGINS` | 空 | 允许的跨域浏览器 Origin，逗号分隔 |
| `TRUST_PROXY` | `false` | Express proxy 信任设置 |
| `JSON_BODY_LIMIT` | `1mb` | JSON body 上限 |
| `RATE_LIMIT_ENABLED` | `true` | 是否启用实例内存级基础限流；生产环境应保持启用 |
| `LLM_PROVIDER` | `disabled` | Excel AI 校对协议：`openai-responses`、`openai-chat`、`anthropic` 或关闭 |
| `LLM_BASE_URL` | 空 | 模型 API Base URL；服务端会按协议补齐端点路径 |
| `LLM_MODEL` | 空 | 模型名称 |
| `LLM_API_KEY` | 空 | 模型 API 密钥后备值；WebUI 保存的加密只写密钥优先，任何密钥均不会返回浏览器 |
| `LLM_TIMEOUT_SECONDS` | `90` | 单次分段识别请求超时，范围 10–300 秒 |
| `CONTAINER_MODE` | `false` | Compose 固定为 `true`；忽略数据库中的端口覆盖，防止容器映射失联 |

当 Flutter WebClient 与 API 使用不同 Origin 时，`CORS_ORIGINS` 应填写
WebClient 的完整 Origin，而不是 API 地址，例如
`CORS_ORIGINS=https://log.example.com`。多个 WebClient Origin 使用逗号分隔。
Android、Windows、Linux 和 macOS 原生客户端不受浏览器 CORS 限制；同源反向
代理也不需要填写。

Docker Compose 默认只将服务发布到 `127.0.0.1:3000`，并启用非 root 运行、只读根文件系统、权限收缩和健康检查。生产环境应在前方配置 HTTPS 反向代理；若只有一层可信代理，设置 `TRUST_PROXY=1`。首次启动或升级前必须先离线备份 `data/openlogtool.db` 和密钥配置；宿主机的 `data` 目录需要允许容器内 UID 1000 写入。

## 当前实施状态

协作 v1、账户安全、成员门户、管理员治理和安全公开 Liveshare 已形成完整单实例闭环：包含发布/快照、成员与邀请、角色及会话状态写权限、持久 mutation 去重、连续事件、REST/WS 追赶、共享草稿、公开分享、账户/设备管理、强制改密、治理审计、导出、备份与可控运行参数。快照接口支持 `includeDeleted=true`，供游标过期重装时在同一读事务返回活动 Log、tombstone 和 high watermark。

成员/公开实时 hub、字段租约、限流、并发计数和运行时指标仍是进程内状态，生产环境必须保持单 Node.js 实例。启用 cluster 或多副本前需要加入共享租约/限流状态、跨实例 pub/sub 与指标汇聚。数据库恢复刻意不提供在线 Web 操作：先停止服务并备份现库，再使用受控 CLI 替换和校验数据库。

## 版权与许可

Copyright © 2026 Mazha0309 与贡献者。

本项目是自由开源软件，按照 [GNU Affero General Public License v3.0](LICENSE) 发布。若将它部署为网络服务并修改程序，请按该许可证向对应用户提供修改后的完整源代码。
