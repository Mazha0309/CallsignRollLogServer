# 交接：跨账号会话共享

## 状态

- spec：已确认（中文）
- plan：已写好，**实现还没开始**
- 代码：无功能代码，只有文档 commit
- 未完成：计划里 Task 1–10 全部未勾选

## 仓库

- 服务端：`/home/mazha0309/Projects/OpenLogToolServer` 分支 `dev`
- 客户端：`/home/mazha0309/Projects/openlogtool` 分支 `dev`

## 必读（按这个顺序）

1. `docs/superpowers/specs/2026-09-13-account-session-sharing-design.md` — 用户确认过的设计
2. `docs/superpowers/plans/2026-09-13-account-session-sharing.md` — 实现计划
3. 用户原话要求：做完后必须把新接口写进项目文档（README + 独立 API 文档）；并保持本交接文件更新

## 用户拍板的产品语义

1. 共享不是双向同步，不要合并个人云 blob
2. B 指定 A 之后，A 必须先接受，会话才能进 A 的列表（防广告标题刷屏）
3. 互通 = 两条独立申请。接受 `B→A` 不得自动创建 `A→B`
4. 看见 ≠ 成员。加入 B **拥有** 的协作会话必须输入该会话固定口令
5. 默认范围：B 的个人云 + B 为 owner 的协作 + B 为 editor 的协作；B 仅 viewer 的永不给看
6. B 当 editor、主人是 C 的会话：A 只读，不能靠 B 的授权加入
7. 默认可加入角色 editor，授权上可改 viewer 或 none
8. 客户端会话页给共享会话加标识；授权/范围/拉黑/口令，Web 和客户端都能做
9. 撤销授权：立刻不能看；只拿掉 `join_source=account_share` 的成员；邀请码成员不动
10. 改记录继续走现有 `requireMembership`

## 从哪开始

计划 Task 1：服务端迁移 v29。用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务勾选执行。

## 验证（实现后）

```bash
# 服务端
npm test -- test/account-session-share-migration.test.ts \
  test/account-session-shares.test.ts \
  test/account-shared-sessions.test.ts \
  test/session-join-share.test.ts

# Web
npm --prefix web test -- SharingPage.test.tsx

# 客户端
flutter test test/screens/session_hub_page_test.dart \
  test/widgets/session_history_shared_badge_test.dart
```

全量：服务端 `npm run verify`。

## 文档债（实现结束前必须做）

- [ ] `docs/account-session-sharing-api-v1.md`
- [ ] `README.md` 接口表和 `accountSessionSharing` 能力说明
- [ ] 本文件更新为「已落地」并填入真实 commit hash
