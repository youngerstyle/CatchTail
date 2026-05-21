# CatchTail

CatchTail 让你在 Codex 长时间执行任务时，仍然可以继续给它发送消息、文件和上下文提示。

它不会修改 Codex 本体。CatchTail 是一个 Codex marketplace plugin，通过本地 hook、队列、会话历史和网页控制台，让当前回合在你明确停止前保持可交互。

## 快速开始

把下面这句话发给 Codex，让 AI 帮你完成安装：

```text
请从 https://github.com/youngerstyle/CatchTail 安装并启用 CatchTail 插件
```

Codex 会自己添加 marketplace、下载插件、放到缓存目录，并在 `/plugins` 里安装或启用 `CatchTail`。

安装完成后，在你要工作的项目里对 Codex 说：

```text
启动 CatchTail 控制台并启动交互式工作流
```

AI 会为当前 Codex session 启动独立的本地控制台服务，并告诉你实际地址，例如：

```text
http://127.0.0.1:<port>
```

控制台服务启动后，你就可以在该 session 的本地控制台继续发送消息、上传文件、补充上下文，或者停止当前交互队列。

## 安装

推荐做法是直接让 Codex 安装：

```text
请从 https://github.com/youngerstyle/CatchTail 安装并启用 CatchTail 插件
```

AI 会使用 Codex plugin marketplace 完成安装。需要手动排障时，对应命令是：

```powershell
codex plugin marketplace add https://github.com/youngerstyle/CatchTail
```


安装过程由 Codex 插件系统负责。它会读取本仓库的 `.agents/plugins/marketplace.json`，把插件放到 Codex 的插件缓存位置，并按插件 manifest 加载 hooks 和 skills。目标项目不是安装目录，也不需要包含 CatchTail 的 marketplace 文件。

## 更新

让 Codex 帮你更新：

```text
请更新 CatchTail 插件
```

AI 会通过 Codex 插件系统更新 marketplace。需要手动排障时，对应命令是：

```powershell
codex plugin marketplace upgrade catchtail
```

更新后在 `/plugins` 确认 `CatchTail` 仍处于启用状态。

如果你曾经按旧文档添加过 `catchtail-local`，也可以直接让 Codex 清理：

```text
请移除旧的 catchtail-local marketplace，并重新安装 CatchTail
```

手动排障命令是：

```powershell
codex plugin marketplace remove catchtail-local
codex plugin marketplace add https://github.com/youngerstyle/CatchTail
```

## 卸载

让 Codex 帮你卸载并清理：

```text
请卸载 CatchTail 插件，并清理 CatchTail 的 marketplace 和本项目里的 .catchtail 运行状态
```

AI 会在 `/plugins` 中卸载或禁用 `CatchTail`，并按你的要求清理本项目的 `.catchtail/` 运行状态。如果要手动移除整个 marketplace，对应命令是：

```powershell
codex plugin marketplace remove catchtail
```

旧文档里的 marketplace 名称是 `catchtail-local`。如果你的环境里还有这个旧入口，也可以让 Codex 一并清理；手动命令是：

```powershell
codex plugin marketplace remove catchtail-local
```

标准插件卸载不会删除用户项目。CatchTail 运行时只会在当前项目写入 `.catchtail/` 状态目录；需要清掉历史队列和会话记录时，让 Codex 删除这个目录即可。早期项目级安装残留只在迁移时需要单独清理。

## 基本工作流

1. 对 Codex 说：`请从 https://github.com/youngerstyle/CatchTail 安装并启用 CatchTail 插件`。
2. 在 Codex 中打开目标项目。
3. 对 Codex 说 `启动 CatchTail 控制台并启动交互式工作流`。
4. 在本地控制台继续发送消息、附件或上下文提示。
5. Codex 领取队列消息，处理后标记完成，然后继续等待下一条消息。
6. 当你希望交互结束时，在控制台停止队列。

## 工作原理

CatchTail 把 Codex agent loop 当作黑盒，只在 Codex 暴露的生命周期点上增加本地交互层。

核心循环是：

```text
claim -> handle -> complete -> wait
```

`UserPromptSubmit` hook 负责启动交互模式并注入协议上下文。`Stop` hook 是兜底边界：如果队列还没有结束，它会让 Codex 继续留在循环里，而不是把当前回合当作已经结束。

## 目录结构

```text
.agents/plugins/marketplace.json                    Codex marketplace 入口
plugins/catchtail/.codex-plugin/plugin.json         插件 manifest
plugins/catchtail/hooks.json                        hook 声明
plugins/catchtail/bin/catchtail.js                  CLI 入口
plugins/catchtail/src/                              runtime、hook、CLI 和控制台
plugins/catchtail/docs/protocol.md                  协议细节
```

运行时数据会写入当前工作项目：

```text
.catchtail/sessions/<session_id>/state.json
.catchtail/sessions/<session_id>/queue.json
.catchtail/sessions/<session_id>/session.jsonl
.catchtail/uploads/<session_id>/
```

## 队列 API

第三方工具可以直接调用 CatchTail 的本地队列 API，不需要自动化浏览器界面：

```text
GET  /api/queue?sessionId=<id>
POST /api/queue?sessionId=<id>
POST /api/queue/claim?sessionId=<id>
POST /api/queue/cancel?sessionId=<id>
POST /api/queue/complete?sessionId=<id>
```

`sessionId` 必须显式提供。队列接口是普通本地 HTTP API，可被本地代码、CLI、脚本或 agent 进程直接调用；它不提供浏览器跨域 CORS。文件预览和文件打开接口只在本地 sidecar 内可用，并且只接受 `.catchtail/uploads/` 下的路径。

## 发布前验证

修改 marketplace、hook 或 runtime 协议后，发布前运行：

```powershell
node --test
npm pack --dry-run
```

## 限制

- CatchTail 是 Codex marketplace plugin，不是 Codex 核心循环补丁。
- Codex 仍然控制权限、sandbox 和工具审批。
- 如果当前 Codex 环境完全不能运行 hook，CatchTail 就无法重新进入 Codex。

## 许可证

MIT
