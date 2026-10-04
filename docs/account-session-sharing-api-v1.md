# Account Session Sharing API v1

账号对账号的申请制只读共享。共享不是个人云对拷，也不是自动成为协作成员。

能力位：`GET /api/v1/server-info` 的 `features` 含 `accountSessionSharing`。

所有写操作要求 `Idempotency-Key`。未知 JSON 字段返回 `422 VALIDATION_FAILED`。响应 `Cache-Control: no-store`。

## 语义

1. `B → A` 只表示 A 能看 B 范围内的会话。互通需要两条独立授权。
2. 接收人必须先接受，共享会话才会进列表。
3. 看见 ≠ 成员。加入授权人**拥有**的协作会话必须输入该会话固定口令。
4. 授权人仅 viewer 的协作永不给接收人看。授权人当 editor、主人为他人的会话只读，不能靠这条授权加入。
5. 撤销授权立刻不可见，并只移除 `join_source=account_share` 的成员；邀请码成员不动。

## 授权

Base: `/api/v1/account`

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/session-shares` | 向 `granteeUsername` 发申请 |
| `GET` | `/session-shares?box=inbox\|outbox\|active` | 收件箱 / 发件箱 / 已接受 |
| `POST` | `/session-shares/:id/accept` | 接收人接受 |
| `POST` | `/session-shares/:id/reject` | 接收人拒绝 |
| `POST` | `/session-shares/:id/cancel` | 授权人取消待处理申请 |
| `POST` | `/session-shares/:id/revoke` | 授权人撤销已接受授权 |
| `PATCH` | `/session-shares/:id` | 授权人改范围或 `canJoinAs` |
| `GET` | `/shared-sessions` | 因授权可见的会话目录 |
| `GET` | `/shared-sessions/:source/:sessionId` | `source` 为 `personal` 或 `collaboration` |
| `GET` | `/shared-sessions/:source/:sessionId/logs` | 只读日志 |
| `GET` | `/session-share-blocks` | 拉黑列表 |
| `PUT` | `/session-share-blocks/:username` | 拉黑 |
| `DELETE` | `/session-share-blocks/:username` | 取消拉黑 |

`POST /session-shares` body:

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

默认三项范围全开，且至少一项为 true。`canJoinAs` 为 `editor` | `viewer` | `none`。`expiresAt` 默认 null；待处理申请最多保留 14 天，显式更早的到期时间也会生效。已接受授权在显式 `expiresAt` 到期后失效。

Grant DTO: `id`, `grantorUserId`, `granteeUserId`, `status`, `includePersonal`, `includeOwned`, `includeEditor`, `canJoinAs`, `createdAt`, `updatedAt`, `respondedAt`, `revokedAt`, `expiresAt`。

`status`: `pending` | `accepted` | `rejected` | `cancelled` | `revoked` | `expired`。

## 口令加入

Base: `/api/v1/sessions`

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/:sessionId/join-passphrase` | Owner 查看是否已设口令（不返回明文） |
| `PUT` | `/:sessionId/join-passphrase` | Owner 设置/更换口令，8–128 字符 |
| `DELETE` | `/:sessionId/join-passphrase` | Owner 清除口令 |
| `POST` | `/:sessionId/join-with-share` | 接收人凭生效授权 + 口令加入 |

`POST .../join-with-share` body: `{ "passphrase": "..." }`。

仅当授权人是该协作会话 owner、范围允许、且 `canJoinAs` 不是 `none` 时才能加入。成员写入 `join_source=account_share`。换口令不踢现有共享成员。

已有有效的邀请码/好友成员再次走旧共享加入时保留原成员来源，撤销旧授权不会移除独立加入的成员。设置口令仅首次响应包含明文，幂等回执和重放仅含配置状态及更新时间。

新版客户端以[好友与会话邀请](friends-collaboration-api-v1.md)为主入口；本协议保留用于已有授权兼容。

## 错误码

| Code | HTTP | 含义 |
|---|---|---|
| `ACCOUNT_SHARE_USER_NOT_FOUND` | 404 | 用户名不存在（不泄露是否被拉黑） |
| `ACCOUNT_SHARE_BLOCKED` | 403 | 对方已拉黑申请人 |
| `ACCOUNT_SHARE_SELF` | 422 | 不能分享给自己 |
| `ACCOUNT_SHARE_FORBIDDEN` | 403 | 无权处理该授权 |
| `ACCOUNT_SHARE_NOT_JOINABLE` | 403 | 不能靠该授权加入（非 owner / viewer / none） |
| `ACCOUNT_SHARE_PASSPHRASE_REQUIRED` | 400 | 未设口令或口令错误 |
| `ACCOUNT_SHARE_INBOX_FULL` | 429 | 待处理收件箱超过 50 |

改记录仍走现有 `requireMembership`，共享目录本身不可写。
