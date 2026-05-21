# CatchTail

CatchTail 让你在 Codex 长时间执行任务时，仍然可以继续给它发送消息、文件和上下文提示。

它不会修改 Codex 本体。CatchTail 只是在本地增加一个 sidecar：队列、会话历史、文件上传、本地网页控制台，以及一组 Codex hook 协议，让当前回合在你明确停止前保持可交互。

## 快速开始

1. 在 Codex 中打开你要工作的目标项目或文件夹。
2. 对 Codex 说：

   ```text
   安装并初始化 https://github.com/youngerstyle/CatchTail
   ```

3. 如果 Codex 提示是否信任 hook，请先查看命令，再选择信任。CatchTail 依赖 Codex hook 维持交互循环，这一步由 Codex 的安全机制控制，CatchTail 不会绕过它。
4. 打开本地控制台：

   ```text
   http://127.0.0.1:3787
   ```

5. 对 Codex 说：

   ```text
   启动交互式工作流
   ```

之后你就可以在本地控制台继续发送消息、上传文件、补充上下文，或者停止当前交互队列。

## 安装

普通用户不需要手动复制本地路径，也不需要自己拼命令。打开目标项目后，直接对 Codex 说：

```text
安装并初始化 https://github.com/youngerstyle/CatchTail
```

Codex 应该负责完成这些事：

1. 把 CatchTail 克隆或更新到一个持久的本地插件目录。不要使用临时目录，因为生成的 hook 会引用这个本地 checkout。
2. 对当前打开的目标项目运行 CatchTail 安装器。
3. 启动本地控制台。
4. 告诉用户控制台地址，并提醒用户在 Codex 弹出 hook 信任提示时确认。

安装是一次性的项目设置步骤，不是 CatchTail 运行时 skill。安装完成后，目标项目会得到 hook 配置、项目内运行时 skill，以及一段由 CatchTail 管理的 `AGENTS.md` 指令块。

## 更新

在目标项目里直接对 Codex 说：

```text
更新 CatchTail
```

Codex 应该更新持久本地 checkout，重新对当前项目运行安装器，并重启本地控制台。更新后重新运行安装器很重要，因为它会刷新 `AGENTS.md` 管理块、项目 skill 和 hook 配置，让已有项目拿到新的协议修复。

## 卸载

在目标项目里直接对 Codex 说：

```text
卸载 CatchTail
```

Codex 应该对当前项目运行 CatchTail 的 purge 卸载流程。purge 会移除 CatchTail 自己写入的内容，包括：

- `.codex/hooks.json` 中的 CatchTail hook entries
- `AGENTS.md` 中的 CatchTail 管理块
- `.agents/skills/catchtail-interactive/`
- `AGENTS.catchtail.md`
- 本地 `.catchtail/` 运行状态

卸载流程会保留用户其它 hook，不会清空整个 Codex 配置。

## 基本工作流

1. 在 Codex 中打开目标项目。
2. 对 Codex 说 `安装并初始化 https://github.com/youngerstyle/CatchTail`。
3. 对 Codex 说 `启动交互式工作流`。
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
.codex-plugin/plugin.json        插件 manifest
hooks.json                       hook 声明
skills/catchtail-interactive/    运行时 workflow skill
scripts/install.mjs              项目安装器
scripts/uninstall.mjs            项目卸载辅助
bin/catchtail.js                 CLI 入口
src/                             runtime、hook、CLI 和控制台
docs/protocol.md                 协议细节
```

运行时数据会写入目标项目：

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

修改 hook 或 runtime 协议后，发布前运行：

```powershell
node --test
npm pack --dry-run
```

## 限制

- CatchTail 是本地 sidecar，不是 Codex 核心循环补丁。
- Codex 仍然控制权限、sandbox 和工具审批。
- 如果当前 Codex 环境完全不能运行 hook，CatchTail 就无法重新进入 Codex。

## 许可证

MIT
