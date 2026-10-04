# 跨账号会话共享 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做成账号对账号的申请制只读共享：先接受才进列表、互通要两条授权、加入协作会话必须口令；客户端会话页打「共享」标识。

**Architecture:** 服务端新增有向授权表、拉黑表、会话口令哈希和共享只读目录。改记录仍只走现有 `requireMembership`。Web `/app/sharing` 和 Flutter 会话页共用同一套 `/api/v1/account/session-shares*` 接口。共享会话不写进本地 Rust 库，直到口令加入成功后才按现有邀请码绑定路径落本地。

**Tech Stack:** TypeScript, Express, better-sqlite3, Node test runner, React + Ant Design, Flutter, Dart `flutter test`.

**Spec:** [`docs/superpowers/specs/2026-09-13-account-session-sharing-design.md`](../specs/2026-09-13-account-session-sharing-design.md)

**完成后必须做（用户明确要求）：**

1. 把新接口写进项目文档（`README.md` + 独立 API 文档）。
2. 留下交接文档，供下一位 AI 接着干。

---

## File Structure

服务端 `OpenLogToolServer`：

- `src/db/migrations.ts`：迁移 v29。
- `src/account-share/model.ts`：授权/拉黑/共享目录 DTO、状态、范围校验。
- `src/account-share/access.ts`：查找生效授权、会话是否在范围内、viewer 永不可见。
- `src/account-share/service.ts`：申请/接受/拒绝/取消/撤销/拉黑/改范围，同一事务写审计。
- `src/account-share/passphrase.ts`：口令哈希、校验、redeem 写入成员。
- `src/account-share/audit.ts`：账号共享审计追加。
- `src/api/account-session-shares-v1.ts`：授权、拉黑、共享目录路由。
- `src/api/session-join-share-v1.ts`：口令管理 + `join-with-share`。
- `src/api/server-info.ts`：`accountSessionSharing`。
- `src/app.ts`：挂载路由。
- `test/account-session-share-migration.test.ts`
- `test/account-session-shares.test.ts`
- `test/account-shared-sessions.test.ts`
- `test/session-join-share.test.ts`
- `web/src/types.ts`、`web/src/api.ts`、`web/src/i18n.ts`
- `web/src/pages/app/SharingPage.tsx`
- `web/src/pages/app/SharedSessionDetailPage.tsx`
- `web/src/App.tsx`、`web/src/components/AppShell.tsx`、`web/src/components/SessionBadges.tsx`
- `README.md`、`docs/account-session-sharing-api-v1.md`
- `docs/superpowers/handoffs/2026-09-13-account-session-sharing.md`

客户端 `openlogtool`（另一仓库，同一功能的后续任务）：

- `lib/models/account_share_dto.dart`
- `lib/services/server_api.dart`
- `lib/providers/account_share_provider.dart`
- `lib/screens/session_hub_page.dart`
- `lib/widgets/session_history_dialog.dart`
- `lib/l10n/app_zh.arb` 等
- `test/services/server_api_test.dart`
- `test/screens/session_hub_page_test.dart`
- `test/widgets/session_history_shared_badge_test.dart`

---

### Task 1: 迁移 v29

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `test/account-session-share-migration.test.ts`

- [ ] **Step 1: 先写迁移失败测试**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database';

test('migration v29 creates account share tables', () => {
  const db = openDatabase(':memory:');
  for (const table of [
    'account_share_grants',
    'account_share_blocks',
    'session_join_passphrases',
    'account_share_audit_events',
  ]) {
    assert.ok(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table),
      table,
    );
  }
  const memberCols = db.pragma('table_info(session_members)') as Array<{ name: string }>;
  assert.ok(memberCols.some((col) => col.name === 'join_source'));
  assert.ok(memberCols.some((col) => col.name === 'account_share_grant_id'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/account-session-share-migration.test.ts`

Expected: FAIL，表不存在。

- [ ] **Step 3: 追加迁移 29，不要改旧 checksum**

在 `src/db/migrations.ts` 的 `migrations` 数组末尾追加。SQL 必须包含：

```sql
CREATE TABLE account_share_grants (
  id TEXT PRIMARY KEY,
  grantor_user_id TEXT NOT NULL REFERENCES users(id),
  grantee_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN (
    'pending','accepted','rejected','cancelled','revoked','expired'
  )),
  include_personal INTEGER NOT NULL DEFAULT 1 CHECK (include_personal IN (0,1)),
  include_owned INTEGER NOT NULL DEFAULT 1 CHECK (include_owned IN (0,1)),
  include_editor INTEGER NOT NULL DEFAULT 1 CHECK (include_editor IN (0,1)),
  can_join_as TEXT NOT NULL DEFAULT 'editor' CHECK (can_join_as IN ('editor','viewer','none')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  responded_at TEXT,
  revoked_at TEXT,
  expires_at TEXT,
  CHECK (grantor_user_id <> grantee_user_id),
  CHECK (include_personal + include_owned + include_editor >= 1)
);

CREATE UNIQUE INDEX idx_account_share_open_pair
ON account_share_grants(grantor_user_id, grantee_user_id)
WHERE status IN ('pending', 'accepted');

CREATE TABLE account_share_blocks (
  blocker_user_id TEXT NOT NULL REFERENCES users(id),
  blocked_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE session_join_passphrases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  passphrase_hash TEXT NOT NULL,
  passphrase_salt TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE account_share_audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  grant_id TEXT,
  target_user_id TEXT,
  session_id TEXT,
  request_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  occurred_at TEXT NOT NULL
);
```

`session_members` 用现有 `addColumnIfMissing` 加：

- `join_source TEXT NOT NULL DEFAULT 'invite'`
- `account_share_grant_id TEXT`

checksum 用现有 `checksum('29', 'account_session_sharing', SQL)`。

- [ ] **Step 4: 再跑迁移测试**

Run: `npm test -- test/account-session-share-migration.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts test/account-session-share-migration.test.ts
git commit -m "feat: add account session sharing schema"
```

---

### Task 2: 领域模型与授权服务

**Files:**
- Create: `src/account-share/model.ts`
- Create: `src/account-share/access.ts`
- Create: `src/account-share/audit.ts`
- Create: `src/account-share/service.ts`
- Test: `test/account-session-shares.test.ts`（先测纯函数/服务，路由下一任务再挂）

- [ ] **Step 1: 先写范围与状态机失败测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionVisibleThroughGrant, parseShareScope } from '../src/account-share/access';

test('viewer collaboration is never visible', () => {
  assert.equal(
    sessionVisibleThroughGrant({
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      source: 'collaboration',
      grantorRole: 'viewer',
    }),
    false,
  );
});

test('editor collaboration is visible but not joinable', () => {
  assert.equal(
    sessionVisibleThroughGrant({
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      source: 'collaboration',
      grantorRole: 'editor',
    }),
    true,
  );
});

test('scope cannot disable every source', () => {
  assert.throws(() => parseShareScope({
    includePersonal: false,
    includeOwned: false,
    includeEditor: false,
  }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/account-session-shares.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 model / access / audit / service**

`parseShareScope` 校验三项至少一项为 true，`canJoinAs` 只能是 `editor|viewer|none`。

`sessionVisibleThroughGrant`：

- `source=personal` 且 `includePersonal`
- `source=collaboration && grantorRole=owner` 且 `includeOwned`
- `source=collaboration && grantorRole=editor` 且 `includeEditor`
- `grantorRole=viewer` 恒 false

`createShareRequest` 在一个 SQLite 事务里：

1. 用 `username_identity` 找接收人，找不到 `404 ACCOUNT_SHARE_USER_NOT_FOUND`
2. 自己分享给自己 `400 ACCOUNT_SHARE_SELF`
3. 任一侧拉黑 `403 ACCOUNT_SHARE_BLOCKED`
4. 接收人 pending 已 50 条 `409 ACCOUNT_SHARE_INBOX_FULL`
5. 已有 pending/accepted 且范围相同：返回已有行
6. 范围不同：`409 ACCOUNT_SHARE_PENDING_EXISTS`
7. 插入 `status=pending`，`expires_at` 默认 now+14 天，写 `account_share.requested`

`acceptShareRequest`：仅接收人；pending→accepted；写 `account_share.accepted`。

`revokeShareGrant`：仅授权人且 accepted；同一事务把 `session_members.join_source='account_share' AND account_share_grant_id=该 id` 的成员 `removed_at` 设上，并写现有协作 `membership.removed` 审计。邀请码来的成员不动。

幂等：`requireIdempotencyKey` + 现有 `computeRequestHash` / `storeResponse`，路径用完整 URL。

- [ ] **Step 4: 跑测试**

Run: `npm test -- test/account-session-shares.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/account-share test/account-session-shares.test.ts
git commit -m "feat: add account share grant domain"
```

---

### Task 3: 授权 / 拉黑 HTTP API

**Files:**
- Create: `src/api/account-session-shares-v1.ts`
- Modify: `src/app.ts`
- Test: `test/account-session-shares.test.ts`

- [ ] **Step 1: 先写 HTTP 失败测试**

用 `createApp` + 内存库，两个用户 token（照 `test/personal-snapshot-v1.test.ts`）：

```ts
test('create then accept makes an active grant', async () => {
  const created = await post('/api/v1/account/session-shares', bobToken, {
    granteeUsername: 'alice',
    includePersonal: true,
    includeOwned: true,
    includeEditor: true,
    canJoinAs: 'editor',
  }, 'share-1');
  assert.equal(created.status, 201);
  const accepted = await post(
    `/api/v1/account/session-shares/${created.body.share.id}/accept`,
    aliceToken,
    {},
    'accept-1',
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.share.status, 'accepted');
});

test('accepting B-to-A does not create A-to-B', async () => {
  // 上面接受后
  const aliceOutbox = await get('/api/v1/account/session-shares?box=outbox', aliceToken);
  assert.equal(aliceOutbox.body.items.length, 0);
});
```

还要覆盖：未知用户 404、拉黑 403、inbox 满 409、非接收人 accept 403。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/account-session-shares.test.ts`

Expected: FAIL，404 路由不存在。

- [ ] **Step 3: 实现路由并挂到 `/api/v1/account`**

`createAccountSessionSharesV1Router`：

| 方法 | 路径 |
|---|---|
| POST | `/session-shares` |
| GET | `/session-shares` query `box=inbox\|outbox\|active` |
| POST | `/session-shares/:id/accept\|reject\|cancel\|revoke` |
| PATCH | `/session-shares/:id` |
| GET | `/session-share-blocks` |
| PUT | `/session-share-blocks/:username` |
| DELETE | `/session-share-blocks/:username` |

限流（`RATE_LIMIT_ENABLED` 时）：写操作 30/分钟/账号+IP。

`app.ts` 在 personal-snapshot 路由旁 `app.use('/api/v1/account', createAccountSessionSharesV1Router(...))`。

拉黑：取消入站 pending + 撤销入站 accepted，同一事务。

- [ ] **Step 4: 跑测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/api/account-session-shares-v1.ts src/app.ts test/account-session-shares.test.ts
git commit -m "feat: add account session share HTTP API"
```

---

### Task 4: 共享只读目录

**Files:**
- Modify: `src/account-share/access.ts`
- Modify: `src/api/account-session-shares-v1.ts`
- Test: `test/account-shared-sessions.test.ts`

- [ ] **Step 1: 先写可见性失败测试**

准备：B owner 会话、B editor（C owner）会话、B viewer 会话、B 个人云一条。A 接受默认范围授权。

```ts
test('shared catalog hides viewer sessions and marks editor read-only', async () => {
  const list = await get('/api/v1/account/shared-sessions', aliceToken);
  const ids = list.body.items.map((row) => row.sessionId);
  assert.ok(ids.includes(ownedId));
  assert.ok(ids.includes(editorId));
  assert.equal(ids.includes(viewerId), false);
  const editor = list.body.items.find((row) => row.sessionId === editorId);
  assert.equal(editor.canJoin, false);
  const owned = list.body.items.find((row) => row.sessionId === ownedId);
  assert.equal(owned.canJoin, false); // 还没设口令
});

test('shared visibility cannot mutate', async () => {
  const res = await post(`/api/v1/sessions/${ownedId}/mutations`, aliceToken, body);
  assert.equal(res.status, 403);
});
```

若 A 已是成员，同一会话应出现在成员 catalog，不出现在 shared catalog。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/account-shared-sessions.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现目录**

`GET /api/v1/account/shared-sessions`

- 找出 `grantee=当前用户 AND status=accepted` 且未过期的授权
- 个人云：解析授权人当前 snapshot，过滤未删会话
- 协作：`session_members` 中授权人 role in (owner, editor)，会话未删
- 应用 `sessionVisibleThroughGrant`
- 排除当前用户已有未移除 membership 的协作会话
- DTO 加 `visibility/grantId/grantorUsername/grantorRole/canJoin/joinRole`

`canJoin`：`grantorRole=owner && includeOwned && canJoinAs != none && session_join_passphrases 有行`。

详情和 logs：个人云复用 `personal-snapshot` 只读组装，但授权校验走共享 access；协作复用成员 snapshot/log 白名单，不发 WS ticket。

mutation / live-draft / invites 不改 `requireMembership`，共享用户本来就会 403/404。加测试锁死这一点即可。

- [ ] **Step 4: 跑测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/account-share src/api/account-session-shares-v1.ts test/account-shared-sessions.test.ts
git commit -m "feat: add shared session read catalog"
```

---

### Task 5: 加入口令与 join-with-share

**Files:**
- Create: `src/account-share/passphrase.ts`
- Create: `src/api/session-join-share-v1.ts`
- Modify: `src/app.ts`
- Test: `test/session-join-share.test.ts`

- [ ] **Step 1: 先写失败测试**

```ts
test('owner can set passphrase and grantee can join owned session', async () => {
  const put = await putJson(`/api/v1/sessions/${ownedId}/join-passphrase`, bobToken, {
    passphrase: 'net-join-ok',
  }, 'pw-1');
  assert.equal(put.status, 200);
  assert.equal(put.body.passphrase, 'net-join-ok');
  const join = await post(`/api/v1/sessions/${ownedId}/join-with-share`, aliceToken, {
    passphrase: 'net-join-ok',
  }, 'join-1');
  assert.equal(join.status, 200);
  assert.equal(join.body.membership.role, 'editor');
  assert.equal(join.body.membership.joinSource, 'account_share');
});

test('editor session cannot be joined through B grant', async () => {
  const join = await post(`/api/v1/sessions/${editorOwnedByC}/join-with-share`, aliceToken, {
    passphrase: 'whatever1',
  }, 'join-2');
  assert.equal(join.status, 403);
  assert.equal(join.body.error.code, 'ACCOUNT_SHARE_CANNOT_JOIN');
});

test('rotating passphrase keeps share-origin members', async () => {
  await putJson(`/api/v1/sessions/${ownedId}/join-passphrase`, bobToken, {
    passphrase: 'net-join-2x',
  }, 'pw-2');
  const membership = await get(`/api/v1/sessions/${ownedId}/membership`, aliceToken);
  assert.equal(membership.status, 200);
});

test('revoking grant removes share-origin membership only', async () => {
  await post(`/api/v1/account/session-shares/${grantId}/revoke`, bobToken, {}, 'rev-1');
  const membership = await get(`/api/v1/sessions/${ownedId}/membership`, aliceToken);
  assert.equal(membership.status, 404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/session-join-share.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现**

口令：trim 后 8–128 字符；`scrypt` 或 `pbkdf2` 加随机 salt；库中只存 hash/salt。GET 只返回 `{ configured, updatedAt }`。审计不写明文。

`join-with-share`：

1. 会话存在且未删
2. 当前用户不是 owner
3. 存在 accepted grant：`grantor=session.owner_user_id, grantee=actor`
4. grant `includeOwned` 且 `canJoinAs` in (editor, viewer)
5. 口令行存在且校验通过，失败码 `ACCOUNT_SHARE_PASSPHRASE_INVALID`
6. 写入/恢复 `session_members`，`join_source='account_share'`
7. 写 `account_share.joined` + 现有 membership 审计
8. 返回与邀请码 redeem 同形的 `{ session, membership }`

挂到 `/api/v1/sessions`。写限流：join 10/分钟/账号+IP，且 5/分钟/账号+会话。

- [ ] **Step 4: 跑测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/account-share/passphrase.ts src/api/session-join-share-v1.ts src/app.ts test/session-join-share.test.ts
git commit -m "feat: add share join passphrase"
```

---

### Task 6: server-info 能力位

**Files:**
- Modify: `src/api/server-info.ts`
- Test: 在 `test/account-session-shares.test.ts` 加一条

- [ ] **Step 1: 失败测试**

```ts
test('server-info advertises accountSessionSharing', async () => {
  const res = await get('/api/v1/server-info');
  assert.ok(res.body.features.includes('accountSessionSharing'));
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: features 数组加入 `'accountSessionSharing'`（迁移已应用即可，与 personalCloudSnapshots 一样常开）**

- [ ] **Step 4: 跑测试 PASS**

- [ ] **Step 5: Commit**

```bash
git add src/api/server-info.ts test/account-session-shares.test.ts
git commit -m "feat: advertise accountSessionSharing"
```

---

### Task 7: Web 门户

**Files:**
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/i18n.ts`
- Create: `web/src/pages/app/SharingPage.tsx`
- Create: `web/src/pages/app/SharedSessionDetailPage.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/AppShell.tsx`, `web/src/components/SessionBadges.tsx`, `web/src/pages/app/SessionsPage.tsx`
- Test: `web/src/pages/app/SharingPage.test.tsx`

- [ ] **Step 1: 失败测试**

SharingPage：能渲染收件箱接受按钮；点接受会调 `accountApi.acceptSessionShare`。

- [ ] **Step 2: 跑 `npm --prefix web test -- SharingPage.test.tsx` 确认失败**

- [ ] **Step 3: 实现**

`accountApi` 增加 session-shares / blocks / shared-sessions / join-passphrase / join-with-share。

`/app/sharing`：收件箱、发件箱、已生效（互通徽章）、发起申请、拉黑。

`/app/sessions`：合并 shared catalog，`SessionSourceTag` 增加 `shared`。点共享行去 `/app/sessions/shared/:source/:sessionId` 只读详情。`canJoin` 才显示加入并弹口令。

协作详情页（Owner）：口令卡片，GET 只显示是否已配置。

中英文都写在 `web/src/i18n.ts`。

- [ ] **Step 4: 跑 Web 测试 PASS**

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: add web account sharing UI"
```

---

### Task 8: Flutter 客户端

在 `/home/mazha0309/Projects/openlogtool` 做，不要和服务器提交混在一起。

**Files:**
- Create: `lib/models/account_share_dto.dart`
- Modify: `lib/services/server_api.dart`
- Create: `lib/providers/account_share_provider.dart`
- Modify: `lib/screens/session_hub_page.dart`, `lib/widgets/session_history_dialog.dart`, l10n
- Test: `test/services/server_api_test.dart`, `test/screens/session_hub_page_test.dart`

- [ ] **Step 1: 失败测试**

- `ServerApi.listSharedSessions` 解析 `visibility=shared`
- 会话历史共享行有 `Key('session-share-badge-${id}')`
- 待处理申请不出现在历史
- `features` 无 `accountSessionSharing` 时没有共享按钮

- [ ] **Step 2: `flutter test` 对应文件，确认失败**

- [ ] **Step 3: 实现**

`ServerApi` 封装 Task 3–5 的接口。

`AccountShareProvider`：inbox 计数、accept 后刷新共享列表。

`SessionHubPage`：加入协作按钮旁加共享入口。历史合并本地 + 协作 + 共享。共享行只读浏览（标题/状态/分页日志），不能保存、改名、关会话、开草稿。

`canJoin` 时「加入协作」输口令 → `joinWithShare` → 复用 `joinWithCode` 成功后的 snapshot 安装路径（从 redeem 结果改成 join-with-share 的 `{session, membership}`）。

- [ ] **Step 4: `flutter test` PASS**

- [ ] **Step 5: Commit（openlogtool 仓库）**

```bash
git commit -m "feat: show shared sessions on the sessions page"
```

---

### Task 9: 把新接口写进项目文档

用户要求：做完后必须更新项目文档，不要只留 spec。

**Files:**
- Create: `docs/account-session-sharing-api-v1.md`
- Modify: `README.md`（接口表 + features 说明）
- Modify: `web/README.md`（若有成员门户路由表则补 `/app/sharing`）

- [ ] **Step 1: 写 `docs/account-session-sharing-api-v1.md`**

必须包含：能力名、申请生命周期、范围表、错误码表、第 9 节全部路径、口令规则、限流、与邀请码/Live Share/个人云的边界。用中文，路径和错误码保持英文。

- [ ] **Step 2: `README.md` 接口表追加**

至少这些行，放在 `/api/v1/account/personal-snapshot...` 附近：

```md
| GET/POST | `/api/v1/account/session-shares...` | 跨账号会话共享申请：创建、收件箱/发件箱、接受、拒绝、取消、撤销、改范围 |
| GET/PUT/DELETE | `/api/v1/account/session-share-blocks...` | 拉黑与取消拉黑 |
| GET | `/api/v1/account/shared-sessions...` | 已接受授权下的只读共享会话目录、详情和分页日志 |
| GET/PUT/DELETE | `/api/v1/sessions/:id/join-passphrase` | Owner 设置、查看是否配置、清空加入口令 |
| POST | `/api/v1/sessions/:id/join-with-share` | 凭生效授权和会话口令加入，成为 editor/viewer |
```

`server-info.features` 说明补一句：`accountSessionSharing` 表示申请制跨账号只读共享和口令加入可用。

- [ ] **Step 3: README 能力段落**

写清：看见 ≠ 成员；互通要两条申请；viewer 会话不给看；撤销会拿掉共享来源成员、不动邀请码成员。

- [ ] **Step 4: Commit**

```bash
git add README.md web/README.md docs/account-session-sharing-api-v1.md
git commit -m "docs: document account session sharing API"
```

---

### Task 10: 给下一位 AI 的交接文档

用户要求：留下进度记录，方便下一任接着做。

**Files:**
- Create: `docs/superpowers/handoffs/2026-09-13-account-session-sharing.md`

- [ ] **Step 1: 写交接文档，必须包含下列段落**

```md
# 交接：跨账号会话共享

## 状态
- spec：已确认
- plan：本文对应的实现计划
- 代码：列出已合并的 commit（写的时候填真实 hash）
- 未完成：列出未勾选的 Task

## 仓库
- 服务端：/home/mazha0309/Projects/OpenLogToolServer  分支 dev
- 客户端：/home/mazha0309/Projects/openlogtool  分支 dev

## 必读
- docs/superpowers/specs/2026-09-13-account-session-sharing-design.md
- docs/superpowers/plans/2026-09-13-account-session-sharing.md
- docs/account-session-sharing-api-v1.md（Task 9 完成后）

## 关键约束（不要再改回去）
1. 共享不是双向同步，不要合并个人云 blob
2. 申请接受前不得进入对方会话列表
3. 互通 = 两条独立授权，接受 B→A 不得创建 A→B
4. 看见 ≠ 成员；加入必须会话口令
5. B 仅 viewer 的协作永不给 A 看
6. B 当 editor 的别人的会话只读，不能靠 B 的授权加入
7. 撤销授权只移除 join_source=account_share 的成员
8. 改记录继续走 requireMembership

## 验证
服务端：npm test -- test/account-session-share-migration.test.ts test/account-session-shares.test.ts test/account-shared-sessions.test.ts test/session-join-share.test.ts
Web：npm --prefix web test -- SharingPage.test.tsx
客户端：flutter test test/screens/session_hub_page_test.dart test/widgets/session_history_shared_badge_test.dart
全量：服务端 npm run verify；客户端按仓库习惯跑测试

## 下一刀从哪切
若服务端 API 已绿：先 Web 共享页，再 Flutter 标识。
若卡在可见性：先看 src/account-share/access.ts 的 sessionVisibleThroughGrant。
若卡在加入：join-with-share 必须 grantor=session.owner_user_id。
```

实现过程中每完成一个 Task，更新「代码 / 未完成」。全部完成后把状态改成「服务端+Web+客户端已落地，文档已写入 README」。

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/handoffs/2026-09-13-account-session-sharing.md
git commit -m "docs: add account sharing handoff"
```

---

## 自检

| Spec 条款 | 对应 Task |
|---|---|
| 先申请再接受、防广告刷屏 | 2, 3, 8 |
| 互通两条授权 | 3 |
| 看见 ≠ 成员 | 4, 5 |
| 个人云 / owner / editor / 永不 viewer | 4 |
| 口令加入、换口令不踢、撤销踢共享成员 | 5 |
| 拉黑 | 3 |
| Web `/app/sharing` | 7 |
| Flutter 共享标识 + 只读 | 8 |
| 能力位 | 6 |
| 项目文档 | 9 |
| 下一位 AI 交接 | 10 |
