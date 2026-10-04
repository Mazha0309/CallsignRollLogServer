# 好友与会话邀请 API v1

服务端通过 `/api/v1/server-info` 的 `features` 声明 `friendCollaboration`。
新交互使用好友关系和逐会话邀请/申请；`accountSessionSharing` 是保留的旧协议，不自动转换为好友。

## 权限与默认行为

- 好友关系必须由接收人接受，接受后双向生效。用户名沿用已有 Unicode、大小写归一化规则。
- 成为好友不会公开个人云记录、历史会话或协作日志。已有会话默认 `private`。
- Owner 可以把自己拥有的协作会话设为 `friends`；好友只能发现进行中的会话标题、所有者和状态，不能读取日志。
- Owner 可邀请好友加入私有或好友可发现的会话；好友只能申请加入设为 `friends` 的会话。
- 角色只能为 `editor` 或 `viewer`，不能通过邀请/申请获得 Owner。
- 邀请由受邀好友接受，申请由 Owner 接受。接受时重新检查好友关系、账号可用性、当前所有者及会话状态。
- 接受后建立普通协作成员关系，继续使用原来的成员、快照、事件及实时同步接口；客户端首次打开原子安装快照，已有副本保留待同步修改。
- 删除好友或拉黑会取消双方尚未处理的请求，不撤销已经授予的协作成员权限。需要移除成员时，由 Owner 在会话成员管理中单独操作。
- 设回私有会取消未处理的加入申请，不移除成员、不取消 Owner 主动发出的邀请。会话转让会恢复私有并取消全部未处理会话请求。

## 鉴权与重试

所有接口要求现有 v1 Access Token，响应 `Cache-Control: no-store`。不能使用公开 Live Share token。

除短期 WebSocket 票据外，所有写接口要求 `Idempotency-Key`，JSON 对象不接受未知字段。业务修改、审计和成功响应在同一个 SQLite immediate transaction 中提交；同账号同请求重试返回原响应，不重复授权，也不重复通知实时连接。
同一个 key 不得用于另一种请求。响应丢失时复用 key；确认成功后，下一次独立操作使用新 key。

请求在 14 天后过期；每人每类最多 50 个待处理请求，最多 200 位已接受好友。开启服务器限流时，同账号/IP 的本路由每分钟最多 120 次请求。拉黑是单向设置、双向阻止新的好友和协作请求。

## 接口

基路径：`/api/v1/social`。成功状态均为 `200`，返回 JSON 对象。

| 方法 | 路径 | JSON / 行为 |
| --- | --- | --- |
| GET | `/` | 获取好友工作区 |
| POST | `/ws-ticket` | `{}`，签发账号通知连接的一次性短期票据，无需幂等 key |
| POST | `/friend-requests` | `{ "username": "friend" }`，发送好友请求 |
| POST | `/friend-requests/:id/:action` | `{}`，`accept` / `reject` / `cancel` |
| DELETE | `/friends/:userId` | `{}`，删除好友并取消双方待处理请求 |
| PUT / DELETE | `/blocks/:username` | `{}`，拉黑 / 解除拉黑，用户名作为 URL segment 编码 |
| GET / PUT | `/sessions/:sessionId` | Owner 读取 / 设置 `{ "visibility": "private"或"friends" }` |
| POST | `/sessions/:sessionId/invitations` | `{ "username": "friend", "role": "editor"或"viewer" }` |
| POST | `/sessions/:sessionId/applications` | `{ "role": "editor"或"viewer" }` |
| POST | `/session-requests/:id/:action` | `{}`，`accept` / `reject` / `cancel` |

只有请求发送人能取消，只有接收人能接受或拒绝。同一对用户同时互加好友会返回同一待处理请求，不自动接受。同一会话、同一待加入用户不会同时产生两条待处理邀请/申请。

### 工作区响应

```json
{
  "friends": [{ "userId": "user-id", "username": "friend" }],
  "friendRequests": [],
  "sessionRequests": [],
  "sessions": [{
    "sessionId": "session-id", "title": "周末点名", "status": "active",
    "ownerId": "owner-id", "ownerUsername": "owner", "visibility": "friends"
  }],
  "blocks": []
}
```

`friends` 和 `blocks` 使用相同的用户摘要结构。

请求字段：`id`, `senderId`, `senderUsername`, `recipientId`, `recipientUsername`, `status`, `createdAt`, `expiresAt`。
会话请求额外含 `sessionId`, `sessionTitle`, `kind`（`invitation`/`application`）及 `role`。
写入请求接口返回 `{ "request": ... }`；接受会话请求还返回原协作协议的 `membership` DTO。

好友请求只列待处理项；会话请求列待处理项及近 30 天已接受项（最多 200 条），便于接受后下载失败时再次打开。
`sessions` 最多列 500 个进行中的会话：自己拥有的，以及尚未成为成员的好友可发现会话。已加入的会话仍从正常会话目录/本地历史访问。
工作区是轻量发现入口，不替代分页历史目录。声明 `socialWebSocket` 能力时，客户端及 Web 好友页使用下述实时通知，不再定时轮询；客户端连接旧服务器时才保留 30 秒兼容刷新。仍支持手动刷新。

状态：`pending` → `accepted` / `rejected` / `cancelled` / `expired`；好友解除后为 `removed`。
已接受的会话请求不会因成员后来被移除而重新授权；旧请求的幂等重放不代表仍有访问权，打开时必须重新获取当前 membership。

### 账号级实时通知

登录后 POST `/api/v1/social/ws-ticket`，得到 `{ "ticket": "...", "expiresAt": "..." }`，
随后连接 `/ws/social?ticket=...`（HTTPS 对应 WSS）。票据最多有效 60 秒、不晚于当前 Access Token
过期时间，仅能用一次；重连必须重新签发。票据不持久化，服务重启后重新获取即可。

- 握手成功：`{ "type": "social.ready", "userId": "...", "serverInstanceId": "..." }`。
- 相关关系或请求变化：`{ "type": "social.changed" }`。业务事务提交后发送，幂等重放不再次发送。
- 心跳：`{ "type": "social.ping" }`，不要求重新读取数据；另有 WebSocket 协议层 ping/pong。

这是只收不发的账号通知通道，不需要会话成员身份，也不传递私有日志。客户端收到 ready（含重连）
或 changed 后通过 REST 获取当前权威状态；事件不是持久消息队列，断线期间变化通过重连刷新补齐。
正在刷新时收到新通知，必须再补一次刷新，不能丢弃通知。切换账号、退出登录时关闭旧连接并丢弃旧响应。
请求过期也会触发通知，心跳检查周期为 20 秒。多条通知允许合并，不以通知次数推算状态。

Origin、可信代理和握手限流沿用现有 WebSocket 规则；每账号最多 8 个连接、每 IP 最多 20 个。
禁用账号、撤销登录或鉴权过期后连接失效；通道不接受订阅其他用户或发送业务消息。

## 错误

| 错误码 | 含义 |
| --- | --- |
| `USER_NOT_FOUND` | 用户不存在、停用或已删除 |
| `FRIEND_SELF` | 不能添加/拉黑自己 |
| `FRIEND_BLOCKED` | 双方存在拉黑，不能加好友 |
| `FRIEND_REQUIRED` | 当前不是可用的双向好友 |
| `REQUEST_CLOSED` | 请求已处理或过期 |
| `ALREADY_MEMBER` | 目标已经是当前成员 |
| `REQUEST_LIMIT` / `FRIEND_LIMIT` | 达到待处理/好友数量限制 |
| `FORBIDDEN` / `NOT_FOUND` | 无处理权限，或不能访问该对象 |
| `SESSION_CLOSED` | 接受时会话已经关闭 |

另外沿用认证、限流、JSON 校验及幂等冲突错误。

## 升级与旧共享

迁移 30 新建独立好友、拉黑、可见性、会话请求和审计表；不合并个人云 blob、不移动日志、不把旧授权变为好友、不默认开放任何会话。
迁移还清理旧 `processed_mutations` 中顶层 `passphrase` 明文；新口令设置的幂等回执只存是否配置及更新时间。

旧 API 和授权仍保留；Web `/app/sharing` 转到新好友页，旧授权管理在 `/app/legacy-sharing`。客户端仍保留旧共享历史及有数据时的旧共享入口。迁移不会擅自撤销用户原先明确授予的旧共享权限，升级后仍应按需要检查这些授权。

升级生产服务前按 README 备份数据库；不要用旧服务进程同时访问升级后的 SQLite。回滚时应同时恢复匹配的数据库备份和旧代码。

## 验证

```bash
node --import tsx --test test/friends-collaboration.test.ts test/integrated-client.test.ts
npm --prefix web test -- FriendsPage.test.tsx
```

测试覆盖双向同意、私有数据不可见、跨账号访问、角色、过期、幂等重放、成员来源保留、迁移数据保全、所有权变更，以及统一入口的 SPA/WASM/隔离响应头。
