# CatchTail

CatchTail 让你在 Codex 长时间执行任务时，仍然可以继续给它发送消息、文件和上下文提示。

它不会修改 Codex 本体。CatchTail 是一个 Codex marketplace plugin，通过本地 hook、队列、会话历史和网页控制台，让当前回合在你明确停止前保持可交互。

## 快速开始

在你要使用 CatchTail 的 Codex 会话里，把下面这句话原样发给 AI：

```text
安装 CatchTail 插件：在 Codex 插件/marketplace 中添加并启用完整 GitHub 地址 https://github.com/youngerstyle/CatchTail，插件名 catchtail@catchtail-local；不要把源码下载到当前项目。
```

安装完成后，对 Codex 说：

```text
启动 CatchTail 控制台并启动交互式工作流
```

AI 会启动本地控制台服务，并告诉你实际地址，通常是：

```text
http://127.0.0.1:3787
```

控制台服务启动后，你就可以在本地控制台继续发送消息、上传文件、补充上下文，或者停止当前交互队列。

## AI 执行标准

当用户说“安装 CatchTail 插件”时，AI 应该通过 Codex 插件/marketplace 流程添加这个 GitHub marketplace。必须使用完整 GitHub 地址，不要只写 `youngerstyle/CatchTail`，因为安装过程需要让 Codex/Git 明确知道远程仓库在哪里：

```text
https://github.com/youngerstyle/CatchTail
```

安装完成必须确认两件事都成立：

```toml
[marketplaces.catchtail-local]
source_type = "git"
source = "https://github.com/youngerstyle/CatchTail.git"
```

并且插件已启用：

```toml
[plugins."catchtail@catchtail-local"]
enabled = true
```

不要把 CatchTail 当成普通源码项目下载到当前项目、桌面相邻目录或用户开发目录。`scripts/install.mjs` 只用于旧版项目级安装迁移、开发调试或没有 marketplace 能力的环境，不是标准安装入口。

如果某个环境里的 CLI marketplace add 在 Windows 上失败，AI 不能改成把源码放到当前项目旁边；应该改用 Codex 插件界面/marketplace 能力完成安装，或者明确告诉用户当前 Codex CLI 无法完成标准 marketplace 安装。

当用户说“启动 CatchTail 控制台并启动交互式工作流”时，AI 应该先使用已安装插件中的 CatchTail CLI 启动本地控制台服务，再发送或触发“启动交互式工作流”。启动后必须把实际控制台地址告诉用户；不要让用户在服务未启动时直接打开端口。

## 更新

让 AI 执行：

```text
更新 CatchTail 插件：通过 Codex 插件/marketplace 更新 catchtail-local，并确认 catchtail@catchtail-local 仍然启用；不要把源码下载到当前项目。
```

CLI 可用时，对应的 marketplace 命令是：

```powershell
codex plugin marketplace upgrade catchtail-local
```

## 卸载

让 AI 执行：

```text
卸载并清理 CatchTail 插件：先在当前项目运行 CatchTail 的 purge 清理，移除 CatchTail 写入的项目 hook、AGENTS 块、skill 和 .catchtail 状态；确认项目清理完成后，再从 Codex marketplace 移除 catchtail-local。
```

AI 不需要让用户手动找路径。它应该先使用已安装的 CatchTail 插件或插件缓存中的卸载辅助完成当前项目清理，再执行 marketplace 移除。清理范围只包括 CatchTail 自己写入的内容：

- `.codex/hooks.json` 中的 CatchTail hook entries
- `AGENTS.md` 中的 CatchTail 管理块
- `.agents/skills/catchtail-interactive/`
- `AGENTS.catchtail.md`
- 本地 `.catchtail/` 运行状态

最后再移除 marketplace：

```powershell
codex plugin marketplace remove catchtail-local
```

卸载流程会保留用户其它 hook，不会清空整个 Codex 配置，也不会删除用户项目。

## 基本工作流

1. 安装插件：把快速开始里的安装句子原样发给 AI。
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
plugins/catchtail/scripts/install.mjs               旧版项目级安装/迁移辅助
plugins/catchtail/scripts/uninstall.mjs             旧版项目级卸载/清理辅助
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

`sessionId` 必须显式提供。队列接口包含 CORS headers。文件预览和文件打开接口只在本地 sidecar 内可用，并且只接受 `.catchtail/uploads/` 下的路径。

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
