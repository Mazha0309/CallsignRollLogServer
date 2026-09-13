# 跨账号会话共享设计

> 状态：待你确认
> 日期：2026-09-13
> 仓库：`OpenLogToolServer`、`openlogtool`
> 能力名：`accountSessionSharing`

## 1. 这是干什么的

登录账号可以把**自己范围内的会话只读分享**给另一个登录账号。对方如果要真正加入你拥有的协作会话，还得输入该会话的**固定口令**。

共享是账号对账号的关系。不是把数据再拷一份，不是两边个人云对拷，也不是自动变成协作成员。

「双向」= 两条独立的单向授权。没有「一键双向」开关。B 不能在 A 没申请、没同意的情况下看见 A 的会话。

## 2. 已经定下来的规则

1. **先申请，再接受。** B 填了 A 的用户名，A 的会话列表不会马上出现 B 的会话。A 必须点接受。拒绝、取消、撤销、拉黑后，那些会话立刻消失。
2. **授权是有方向的。** `B → A` 只表示 A 能看 B。`A → B` 是另一条申请。两边都接受了，才算互通。
3. **看见不等于成员。** 共享过来的会话默认只读。要改记录，必须用该会话口令加入。
4. **口令加入只对「授权人拥有的协作会话」有效。** B 只是别人会话的 editor 时，A 能看，但不能靠这条授权加入。
5. **客户端和 Web 后台用同一套接口。** 申请、列表、接受、拒绝、取消、撤销、拉黑，Flutter 和门户都能做。
6. **默认加入角色是 editor。** 每条授权可改成 viewer，或 `none`（纯只读，不能加入）。
7. **防刷是 v1 的一部分。** 收件箱、先接受再可见、拉黑、待处理上限、限流，都要做。

## 3. 明确不做

- 两边个人云快照合并或互相同步对拷
- 悄悄把对方写进你现在/以后每一个会话的成员表
- 把你只是 viewer 的会话透给对方
- 取代邀请码、Live Share、公开归档
- 跨服务器实例共享
- 保证已经下载到对方手机上的数据能远程擦掉

## 4. 名词

| 说法 | 意思 |
|---|---|
| 授权人 | 把会话给别人看的账号（B） |
| 接收人 | 可能看到这些会话的账号（A） |
| 申请 | 授权人发出、等接收人处理的那条记录 |
| 授权 | 已经接受的申请。看见权跟着这条走，直到撤销 |
| 互通 | 两条都接受了：`B→A` 和 `A→B` |
| 共享会话 | A 因为授权才看到的条目，不是协作成员 |
| 加入口令 | 每个协作会话由 Owner 设置的固定密码 |
| 共享来源成员 | 靠「授权 + 口令」加进去的成员 |

## 5. 流程

```text
B 向 A 发申请
        │
        ▼
  待处理（A 的收件箱）
        │
   ┌────┴────┐
   ▼         ▼
接受     拒绝 / 过期 / B 取消 / A 拉黑
   │
   ▼
生效中的授权  ──撤销 / 拉黑──►  结束
   │
   └── A 的会话列表出现 B 范围内的会话，并打「共享」标识
```

规则：

- 同一对 `(授权人, 接收人)` 同时只能有一条待处理或已接受。重复提交且范围相同，返回已有那条（靠 `Idempotency-Key`）。已接受后再改范围，用 PATCH，不要再发一条新申请。
- 拒绝、取消、过期、撤销的记录留在审计里。没被拉黑的话，授权人可以再发新申请。
- A 拉黑了 B，B 再申请返回 `403 ACCOUNT_SHARE_BLOCKED`。用户名不存在仍返回 `404 ACCOUNT_SHARE_USER_NOT_FOUND`。
- 待处理申请默认 14 天过期。已接受的授权默认不过期，除非授权人自己设了 `expiresAt`。

互通：

- 两条都接受了，界面可以显示「已互通」。
- 反向申请必须对方自己发。A 接受 `B→A` **不会**自动创建 `A→B`。

## 6. 能看见什么

A 接受 `B → A` 之后，共享列表里是 B 范围内、且 B **不是仅 viewer** 的会话。

默认三项全开：

| 来源 | 给不给看 | A 能不能用口令加入 |
|---|---|---|
| B 的个人云会话 | 看 | 不能 |
| 协作会话，B 是 owner | 看 | 能（授权的 `canJoinAs` 不是 `none` 时） |
| 协作会话，B 是 editor | 看 | 不能 |
| 协作会话，B 是 viewer | 永远不给看 | 不能 |

授权人可以在 Web 或客户端关掉上面三项里的任意项。关掉后，对方下次刷新就看不到。之后新产生、又落在开启范围内的会话会自动出现在对方列表里——这是列表跟着变，不是把数据库拷过去。

个人云那部分读的是授权人**当前**快照版本，只读，不会因为共享变成协作会话。

B 当 editor、真正主人是 C 的会话：A 能看，标记为「来自 B 的共享」，不能用 B 的授权去加入 C 的会话。

如果 A 已经是某个协作会话的成员，成员身份优先：列表里按协作显示，不按共享显示，权限走原来的角色规则。

## 7. 加入口令

每个协作会话可以有一个由 Owner 管理的加入口令。

- Owner 在 Web 或客户端协作页设置、更换、清空。
- 服务端只存加盐哈希。明文只在设置成功那一次返回，以后再也读不出来。
- 没设口令 = 共享这边不能加入这个会话。原来的邀请码照常能用，互不影响。
- 用口令加入必须同时满足：有一条来自**该会话 Owner** 的生效授权、范围包含「拥有的协作」、`canJoinAs` 是 editor 或 viewer、口令对、会话没删、自己不是 owner。
- 成功后写入成员表：`join_source = account_share`，并记下授权 id。角色用 `canJoinAs`；如果已经有更高角色，保持更高的。
- 口令错误：`403 ACCOUNT_SHARE_PASSPHRASE_INVALID`，耗时和邀请码兑错一样，避免被用来探测。
- **换口令不会踢现有成员。** **撤销授权会：**同一事务里，靠这条授权加进去的成员拿掉；靠邀请码加进去的成员不动。

## 8. 数据表

迁移版本 v29。

```text
account_share_grants          -- 申请/授权
  id                    TEXT PRIMARY KEY
  grantor_user_id       TEXT NOT NULL REFERENCES users(id)
  grantee_user_id       TEXT NOT NULL REFERENCES users(id)
  status                TEXT NOT NULL
                        -- pending | accepted | rejected | cancelled
                        -- revoked | expired
  include_personal      INTEGER NOT NULL DEFAULT 1
  include_owned         INTEGER NOT NULL DEFAULT 1
  include_editor        INTEGER NOT NULL DEFAULT 1
  can_join_as           TEXT NOT NULL DEFAULT 'editor'
                        -- editor | viewer | none
  created_at            TEXT NOT NULL
  updated_at            TEXT NOT NULL
  responded_at          TEXT
  revoked_at            TEXT
  expires_at            TEXT
  CHECK (grantor_user_id <> grantee_user_id)

account_share_blocks          -- 拉黑
  blocker_user_id       TEXT NOT NULL REFERENCES users(id)
  blocked_user_id       TEXT NOT NULL REFERENCES users(id)
  created_at            TEXT NOT NULL
  PRIMARY KEY (blocker_user_id, blocked_user_id)
  CHECK (blocker_user_id <> blocked_user_id)

session_join_passphrases      -- 会话加入口令
  session_id            TEXT PRIMARY KEY REFERENCES sessions(id)
  passphrase_hash       TEXT NOT NULL
  passphrase_salt       TEXT NOT NULL
  updated_by            TEXT NOT NULL REFERENCES users(id)
  updated_at            TEXT NOT NULL

session_members.join_source          TEXT NOT NULL DEFAULT 'invite'
                                     -- invite | account_share | admin | bootstrap
session_members.account_share_grant_id TEXT NULL
```

进行中的一对账号只能有一条：

```sql
CREATE UNIQUE INDEX idx_account_share_open_pair
ON account_share_grants(grantor_user_id, grantee_user_id)
WHERE status IN ('pending', 'accepted');
```

`include_personal`、`include_owned`、`include_editor` 不能三项全关。viewer 协作没有单独开关，永远不给看。

## 9. 服务端接口

迁移完成后，`server-info.features` 里带上 `accountSessionSharing`。

全部要登录。`Cache-Control: no-store`。按用户名查找走现有的 `username_identity`。

### 9.1 申请 / 授权

| 方法 | 路径 | 谁能调 |
|---|---|---|
| POST | `/api/v1/account/session-shares` | 授权人发申请 |
| GET | `/api/v1/account/session-shares?box=inbox\|outbox\|active` | 自己 |
| POST | `/api/v1/account/session-shares/:id/accept` | 接收人接受 |
| POST | `/api/v1/account/session-shares/:id/reject` | 接收人拒绝 |
| POST | `/api/v1/account/session-shares/:id/cancel` | 授权人取消待处理 |
| POST | `/api/v1/account/session-shares/:id/revoke` | 授权人撤销已接受 |
| PATCH | `/api/v1/account/session-shares/:id` | 授权人改已接受的范围 / 加入角色 / 过期 |

发申请的 body：

```json
{
  "granteeUsername": "alice",
  "includePersonal": true,
  "includeOwned": true,
  "includeEditor": true,
  "canJoinAs": "editor",
  "expiresAt": null
}
```

必须带 `Idempotency-Key`。用户名不存在：`404 ACCOUNT_SHARE_USER_NOT_FOUND`（耗时和查到了一样）。

### 9.2 拉黑

| 方法 | 路径 |
|---|---|
| GET | `/api/v1/account/session-share-blocks` |
| PUT | `/api/v1/account/session-share-blocks/:username` |
| DELETE | `/api/v1/account/session-share-blocks/:username` |

拉黑时同一事务：取消对方发来的待处理申请，并撤销对方已接受的入站授权。

### 9.3 共享会话目录

| 方法 | 路径 |
|---|---|
| GET | `/api/v1/account/shared-sessions` |
| GET | `/api/v1/account/shared-sessions/:source/:sessionId` |
| GET | `/api/v1/account/shared-sessions/:source/:sessionId/logs` |

`source` 是 `personal` 或 `collaboration`。分页参数和现有账号会话目录一样：`page`、`pageSize`、`q`、`status`，另外加 `grantorUsername`。

每条多这些字段：

```json
{
  "visibility": "shared",
  "grantId": "...",
  "grantorUserId": "...",
  "grantorUsername": "bob",
  "grantorRole": "owner",
  "canJoin": false,
  "joinRole": null
}
```

`canJoin` 为 true 仅当：这是授权人拥有的协作会话、授权允许加入、而且该会话当前设了口令。

个人云共享读授权人快照。协作共享读成员快照/日志那套字段（含已对成员开放的作者信息）。通过共享去做改记录、改草稿、管邀请、管公开链接：一律 `403 ACCOUNT_SHARE_READ_ONLY`。

v1 共享只走 REST：目录 + 快照 + 分页日志。不发成员 WebSocket ticket。以后如果要实时只读再加。

### 9.4 用口令加入

`POST /api/v1/sessions/:id/join-with-share`

```json
{ "passphrase": "..." }
```

必须带 `Idempotency-Key`。成功返回成员 DTO。客户端按现在「兑换邀请码」那条路绑定本地会话。

### 9.5 口令管理（仅 Owner）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/sessions/:id/join-passphrase` | `{ "configured": true, "updatedAt": "..." }` |
| PUT | `/api/v1/sessions/:id/join-passphrase` | `{ "passphrase": "..." }` |
| DELETE | `/api/v1/sessions/:id/join-passphrase` | 清空 |

PUT 成功时把口令返回这一次。去掉首尾空格后长度 8–128。审计日志里不写口令明文。

### 9.6 错误码

| 码 | 什么时候 |
|---|---|
| `ACCOUNT_SHARE_USER_NOT_FOUND` | 用户名不存在 |
| `ACCOUNT_SHARE_SELF` | 不能分享给自己 |
| `ACCOUNT_SHARE_BLOCKED` | 被拉黑 |
| `ACCOUNT_SHARE_PENDING_EXISTS` | 已经有待处理/已接受，且这次范围对不上幂等 |
| `ACCOUNT_SHARE_NOT_GRANTEE` | 不是接收人却去接受/拒绝 |
| `ACCOUNT_SHARE_READ_ONLY` | 想通过共享去改数据 |
| `ACCOUNT_SHARE_CANNOT_JOIN` | 不是 Owner 的会话、禁止加入、或没设口令 |
| `ACCOUNT_SHARE_PASSPHRASE_INVALID` | 口令错 |
| `ACCOUNT_SHARE_INBOX_FULL` | 对方收件箱满了 |

上限：待处理收件箱 50、待处理发件箱 50、自己发出且生效的授权 200、自己收到且生效的授权 200。

### 9.7 限流

开了实例限流时：

- 申请/接受/拒绝/取消/撤销/拉黑：每分钟 30 次 / 账号+IP
- 读共享目录：每分钟 120 次 / 账号+IP
- 口令加入：每分钟 10 次 / 账号+IP，且每分钟 5 次 / 账号+会话

## 10. 和协作成员权限的关系

改记录、实时草稿、邀请、成员 WebSocket，仍然只认 `requireMembership`。

共享是另一条只读通道：

1. 找到已接受的授权 `授权人=B, 接收人=A`
2. 确认这个会话在范围内，且 B 不是仅 viewer
3. 返回只读数据

管理员治理接口不动。账号是 `admin` 也不会因为这个绕过成员或共享规则；管理员继续走现有 admin 路由。

## 11. 审计

单独一张只追加的账号共享审计，不塞进协作会话审计：

- `account_share.requested` 发出申请
- `account_share.accepted` 接受
- `account_share.rejected` 拒绝
- `account_share.cancelled` 取消
- `account_share.revoked` 撤销
- `account_share.updated` 改范围
- `account_share.blocked` 拉黑
- `account_share.unblocked` 取消拉黑
- `account_share.joined` 记下会话、授权、角色；不记口令

用口令加入成功时，还要写现有的协作成员审计，因为成员表真的变了。

## 12. Web 后台

新页面：`/app/sharing`

里面有：

- 收件箱：接受 / 拒绝
- 发件箱：待处理、取消
- 已生效：我给别人的、别人给我的；两边都有就显示「已互通」
- 发起申请：填用户名、勾选范围、选加入角色
- 拉黑名单
- 自己拥有的协作会话详情页：加入口令卡片

`/app/sessions` 里共享会话打共享标签，写授权人名字，点进去只读。只有 `canJoin` 为 true 才出现加入按钮，点了再输口令。

申请/接受：客户端和 Web 都能做。口令设置/清空：Web 会话详情和 Flutter 协作页（Owner）都能做。

## 13. Flutter 客户端

### 13.1 共享收件箱

会话页头部、加入协作码旁边加共享入口：

- 待处理入站数量
- 按用户名发申请
- 接受 / 拒绝 / 取消 / 撤销 / 拉黑

接受之后，用 `GET /api/v1/account/shared-sessions` 合并进会话历史。这些行**先不写进本地 Rust 会话表**；只有加入某个协作会话之后才按现有绑定逻辑落本地。

### 13.2 列表标识

历史里三种：

- 本地
- 协作（已有）
- **共享** — 授权人用户名 + 共享图标；点开只读（标题、状态、分页日志）。没有实时草稿、不能保存、不能改名、不能关闭。

之后若用口令加入，这条变成普通协作绑定，共享标识换成协作状态。

### 13.3 加入

共享且 `canJoin` 的会话，点「加入协作」输入该会话口令，调 `join-with-share`，然后走现在兑换邀请码的本地绑定。

会话页「用邀请码加入」保留，共享不取代它。

### 13.4 能力开关

`server-info.features` 没有 `accountSessionSharing` 就隐藏共享 UI。老服务器行为不变。

## 14. 测试要覆盖

服务端：

- 申请/接受/拒绝/取消/撤销/拉黑的幂等
- 互通必须两条都接受
- viewer 会话永不出现
- editor 会话只读且不能加入
- 个人云共享跟着最新快照版本
- PATCH 范围会显示/隐藏，不必重发申请
- 撤销只拿掉共享来源成员
- 换口令不踢人
- 拉黑会取消入站待处理并撤销入站已接受
- 收件箱上限和限流
- 通过共享改数据返回 403

客户端：

- 待处理申请不进历史列表
- 接受后有共享标识且只读
- 口令加入后变成协作绑定
- 没有该能力时隐藏入口

Web：

- 收件箱/发件箱/已生效，以及口令卡片
- 共享目录标签和只读详情

## 15. 上线顺序

1. 服务端迁移 v29、接口、能力开关、测试
2. Web 共享页和会话标签
3. Flutter 收件箱、历史标识、只读浏览、口令加入

不做历史回填。已有邀请码成员的 `join_source` 写成 `'invite'`。

## 16. 为什么这样拆

以前翻车，是把三件事揉成「同步」：看见、同一份权威协作、个人云备份。这次一件事一层。

必须申请，是为了避免有人建一堆广告标题会话，直接塞进别人列表。互通要两条申请，是为了谁也不能在对方没同意时看走对方历史。加入要口令，是为了「我能看见」不会自动变成「我是 editor」。
