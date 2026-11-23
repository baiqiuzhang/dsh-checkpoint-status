# dsh-checkpoint-status

**[English](README.en.md) | 中文**

纯客户端 DSH 插件：给侧边栏每个会话加**状态图标**，并用一个**继承树面板**展示工作区里所有会话的血缘关系、统计数据和一句话简介。

零 host 代码、零额外依赖、不写任何后端路由——所有数据都来自 DSH 客户端已有的服务：

- `sessions`（`ctx.get('sessions')`）：会话列表快照 + 投影行（`turnOutline` / `todos` / `goal` / `sessionStats` / `sessionListMetadata` / `subagentCatalog`）
- `workspaces`（`ctx.get('workspaces')`）：工作区分组、归档操作

## 状态图标（侧边栏行首）

| 图标 | 含义 | 判定 |
| --- | --- | --- |
| 📌 继承 | 本会话是从别的会话的 checkpoint 接续来的 | 首轮 prompt 里引用了 `ckpt-*.md` 的路径 |
| ✓ 已检查点 | 本会话自己产出过 checkpoint | 某一轮 prompt 是 `/project-checkpoint` 或「写/生成检查点」 |
| ◷ 废弃 | 长期没有新的用户输入 | `sessionListMetadata.lastPromptAt` 早于 N 天（默认 7 天） |

「进行中」「等待交互」「子代理运行」「定时排队」由 DSH 原生已渲染的状态点/时钟承担，本插件不重复绘制，只在原生状态点为 idle（无任何状态）时才占位。

**废弃会话**：点击行首的废弃图标会弹出确认框，确认后调用 `workspaces.archiveSession(id)` 归档（可逆，不删除历史）。如果宿主回 `workspace/session-active`，弹框会列出仍在进行的活动（回合 / 后台任务 / 子代理 / 定时提醒），再点一次「停止活动并归档」才带 `stopActivity: true`——**被停掉的定时提醒不可恢复**，所以默认绝不先传这个参数。Esc 或点遮罩可关闭。

## 继承树面板

侧边栏底部新增一个树形按钮（`sidebar.footer.action` 槽位），点击打开全屏面板：

- 按工作区分组的森林视图，父会话折叠子代理（节点上标注子代理数量）
- 顶部统计条：会话总数 / 运行中 / 已检查点 / 废弃 / 归档 / 子代理 / 轮次 / 步骤 / token
- 每个节点除标题外有一行**简介**：目标（`goal.objective`）+ 末轮进展（`turnOutline` 的 response 摘要）+ 未完成 todo 数
- 继承边由「同 cwd + 新会话首轮 prompt 命中旧会话产出的 ckpt 文件名」推断

## 安装

```powershell
# 1) 把本目录加入 profile 依赖
#    ~/.dsh/profiles/desktop/package.json
#    "dependencies": { "dsh-checkpoint-status": "link:<你的插件目录>/dsh-checkpoint-status" }
#    "dsh": { "profile": { "bundles": [ ... , "dsh-checkpoint-status" ] } }

# 2) 安装（会把包链接进 profile 的 node_modules）
dsh plugin --profile desktop install --prefer-offline
```

安装后**需要重启 DSH 桌面应用**（client bundle 在启动期解析），再刷新页面。

## Token 成本：零

本插件不花任何模型 token，原因是它根本不参与模型调用：

- 没有 host 代码（`index.js` 是空 `apply`），不注册工具、不注册斜杠命令、不注册 provider，也不往 prompt / system prompt / 工具列表里加任何东西。
- 插件读的 `turnOutline`、`todos`、`goal`、`sessionStats`、`sessionListMetadata`、`subagentCatalog` 都是**已写入日志的事件折叠出来的投影**（`@deepseek-ai/dsh-session-turn-outline` 的包说明写明：`Model Experience: None`、`KV Cache effect: None；本包从不组装或发送提供方请求`）。
- 界面上的「简介」是拼接已有字段（目标 + 末轮摘要 + 未完成 todo），不是让模型重新概括。
- 唯一的数据成本是 IPC：按需 `refreshProjections`，缓存 5 分钟，树面板打开时才预热，并发 2。

真正花钱的是**随对话更新的标题**那个 bundle（每条用户消息触发一次 LLM 调用，输入 ≤4096 字节、输出 ≤64 token），它和本插件无关，是两个独立开关。

## 已知限制

- 继承关系靠 prompt 文本推断：如果新会话是用 `read` 工具静默读取 ckpt、而首轮 prompt 里没有写路径，就推不出继承边。
- 「已检查点」只看 prompt 文本，不看工具轨迹；因此手工让模型「写一份检查点」也能识别，但模型擅自生成 ckpt 时不会置位。
- 概览简介是纯拼接，不调用 LLM，所以不会重新概括整段对话。
- 投影数据按需加载（TTL 60 秒、并发 2），会话很多时打开面板首屏会有短暂的加载态。
