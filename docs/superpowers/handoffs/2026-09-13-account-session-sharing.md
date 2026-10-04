# 交接：跨账号会话共享

## 2026-10-04 补充：本地优先，服务器可选

用户强调服务器不是必要组件。此次继续更新以此为前提，不能把登录或连接服务器放到普通记录的必经流程中。

- 客户端会话首页突出本地新建/继续记录；未登录时不展示协作与公开分享操作，将服务器入口收在可选折叠区域。
- 历史增加本地/共同/已结束分类；分类只看已有数据，不要求联网，也不等于公开归档。会话 ID 收入详细信息。
- 当前协作会话可以直接邀请好友；本地转协作与好友页的开启协作共用上传确认，说明只操作当前会话，取消不上传。
- 邀请弹窗支持角色选择、失败重试、防重复提交和账号切换保护。既有协作副本不因离线或登出被当成普通本地会话放宽权限。
- 本轮没有新增服务端接口或数据库迁移；没有部署线上服务，也没有移除独立客户端的运行方式。个人云同步继续沿用既有规则。
- 验证：Flutter 全量 690 项通过，相关文件静态分析无问题，独立 WebClient（base href `/`）Release 构建通过；本地会话状态变化会立即刷新历史分类，无需等待网络消息。构建产物亦更新到本地可选 `web-client/`，前一版由安装脚本保留备份。真实浏览器与双设备验收仍未完成。

## 2026-10-03 更新：改为好友与逐会话协作

用户已明确要求重做共享，增加好友、邀请和申请，并减轻客户端与服务端的割裂；更名暂缓。
下方原方案作为旧共享兼容记录保留，不再是新交互的产品定义。

- 服务端旧 feature worktree 已安全快进合入主仓库 `dev`（基线 `9dbdf0d`）；原 handoff 本地改动保留，stash 备份未删除。
- 新实现仍为两个仓库 `dev` 的未提交修改：迁移 30、`/api/v1/social`、Web 好友页、Flutter 好友页，以及 `/connect` + 可选 `/client/` 同站部署。
- 默认所有会话私有，好友只能发现所有者明确开放的进行中会话元数据；接受邀请/申请后才建立日志访问所需的协作成员关系。
- 删除好友不会删除已授予的成员关系；转让会话会清除好友可见性和待处理请求。旧共享授权不会自动转成好友或被撤销。
- 已补升级保全、过期授权、邀请码成员来源、旧口令明文回执、账号切换与丢包重试等回归测试。
- 新接口文档：[好友与会话邀请 API v1](../../friends-collaboration-api-v1.md)。统一部署方式已写入服务端 README；客户端 README 同步说明新入口。
- 验证：服务端全量 243 项、Web 门户 61 项、Flutter 全量 678 项通过；`test:dist`、Web/Live 构建及 Flutter Web release 构建通过。实际生成的客户端已安装到本地 `web-client/`，使用内存数据库验证 `/connect`、客户端入口、JS 及 WASM 均返回正确状态和类型；没有启动常驻服务。
- 未发布到远端、未操作生产数据库、未做自动改名。真实双设备和浏览器人工验收仍需完成；本环境内置浏览器初始化失败，不能把组件测试当作实机验收。

## 状态

- spec：已确认（中文）
- plan：已写好
- 代码：服务端 + Web 已落地于 worktree `feature/account-session-sharing`（`a1eccd0` 及后续文档/迁移基线提交）
- 客户端：`openlogtool` 的 `dev` 有未提交草稿（DTO/provider/会话页标识），尚未合入
- 文档：`docs/account-session-sharing-api-v1.md` + README 接口表

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

- [x] `docs/account-session-sharing-api-v1.md`
- [x] `README.md` 接口表和 `accountSessionSharing` 能力说明
- [ ] 客户端共享标识合入 `openlogtool` `dev` 并跑 `flutter test`
- [ ] 服务端 worktree 合入主仓库 `dev` 后填最终 commit hash
