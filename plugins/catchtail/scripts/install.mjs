#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(process.argv[2] ?? process.cwd());
const codexDir = resolve(projectRoot, ".codex");
const skillDir = resolve(projectRoot, ".agents", "skills", "catchtail-interactive");
const hookPath = resolve(pluginRoot, "hooks", "catchtail-hook.js");
const binPath = resolve(pluginRoot, "bin", "catchtail.js");
const hooksJsonPath = resolve(codexDir, "hooks.json");
const agentsPath = resolve(projectRoot, "AGENTS.md");
const agentsCatchtailPath = resolve(projectRoot, "AGENTS.catchtail.md");
const skillPath = resolve(skillDir, "SKILL.md");
const cliPath = commandPathForProject(projectRoot, binPath);
const skillTemplatePath = resolve(pluginRoot, "templates", "catchtail-skill.md");

mkdirSync(codexDir, { recursive: true });
mkdirSync(skillDir, { recursive: true });
mkdirSync(resolve(projectRoot, ".catchtail", "sessions"), { recursive: true });

const existingHooks = readJson(hooksJsonPath, { hooks: {} });
const hookCommand = `node ${quoteCommandPath(commandPathForProject(projectRoot, hookPath))}`;
const hook = { type: "command", command: hookCommand, timeout: 600 };
existingHooks.hooks ??= {};
upsertCatchTailHook(existingHooks.hooks, "UserPromptSubmit", hook);
upsertCatchTailHook(existingHooks.hooks, "Stop", hook);
writeFileSync(hooksJsonPath, `${JSON.stringify(existingHooks, null, 2)}\n`);

const protocol = agentsProtocol(cliPath);
writeFileSync(agentsCatchtailPath, `${protocol}\n`);
writeFileSync(skillPath, `${skillProtocol(cliPath)}\n`);
patchAgentsFile(agentsPath, protocol);

process.stdout.write(
  [
    `CatchTail installed into ${projectRoot}`,
    "Created or updated .codex/hooks.json.",
    "Created AGENTS.catchtail.md and .agents/skills/catchtail-interactive/SKILL.md.",
    "Updated AGENTS.md with the CatchTail managed block.",
    `Run: node ${quoteCommandPath(cliPath)} serve`,
    "Then start Codex and say: 启动交互式工作流"
  ].join("\n") + "\n"
);

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function upsertCatchTailHook(hooksConfig, eventName, hook) {
  const entries = Array.isArray(hooksConfig[eventName]) ? hooksConfig[eventName] : [];
  hooksConfig[eventName] = [
    ...entries.filter((entry) => !containsCatchTailHook(entry)),
    { hooks: [hook] }
  ];
}

function containsCatchTailHook(entry) {
  return Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => String(hook?.command ?? "").includes("catchtail-hook.js"));
}

function patchAgentsFile(path, protocol) {
  const start = "<!-- CatchTail:START -->";
  const end = "<!-- CatchTail:END -->";
  const block = `${start}\n${protocol}\n${end}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : [existing, block].filter(Boolean).join("\n\n");
  writeFileSync(path, `${next}\n`);
}

function agentsProtocol(commandPath) {
  const cliCommandPath = quoteCommandPath(commandPath);
  return `# CatchTail Interactive Workflow

当用户说“启动交互式工作流”时，进入 CatchTail interactive mode。

规则：
- 使用 Codex hook payload 的 session_id 隔离运行状态；手动 CLI 默认使用 default。
- 每次停止前重新读取当前 session 的 .catchtail/sessions/<session_id>/state.json 和 queue.json。
- milestone 为 completed 是唯一自然退出条件。
- queue.json 只保存未被领取的消息；领取后即从 queue 移除。
- session.jsonl 保存完整历史。
- 待处理消息按 createdAt 顺序处理；不要只阅读 state 后口头总结。
- 处理用户消息时先运行 \`node ${cliCommandPath} claim\` 领取下一条消息。
- claim 到消息后，必须严格按这个格式打印：先打印 \`**处理队列消息：**\`，空一行后打印 \`---\`，再空一行打印正文；正文后打印 \`附件路径：\`，有附件时每行 \`- <绝对路径>\`，没有附件时打印 \`无\`；再打印 \`上下文提示：\`，有 refs 时逐行列出，没有时打印 \`无\`；最后空一行打印 \`---\`。不要把附件标题缩写成“附件：”，不要省略标题，不要用 fenced code block 或 blockquote 包裹正文。
- 回复或执行完该消息后，运行 \`node ${cliCommandPath} complete <id> <简短处理结果>\` 标记完成。
- complete 后如果 milestone 仍未 completed，立即运行 \`node ${cliCommandPath} wait\` 等待下一条消息；不要发送 final 结束当前回合。
- wait 运行期间不要在聊天里发送心跳式空闲更新；保持工具等待，只有收到消息、停止、超时或错误需要处理时再说话。
- 支持消息中的文件和图片路径；需要时用本地工具读取。
- 没有待处理消息时，依赖 \`node ${cliCommandPath} wait\` 或 Stop hook 的本地长轮询等待；不要在聊天里高频轮询。
- 不要把 hook 生成的续跑提示当成用户最终验收；它只是交互循环控制信号。
- 对高风险动作继续遵守 Codex 权限、sandbox 和用户批准规则。`;
}

function skillProtocol(commandPath) {
  return readFileSync(skillTemplatePath, "utf8").replaceAll("{{CLI_PATH}}", quoteCommandPath(commandPath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandPathForProject(root, target) {
  const relativePath = relative(root, target);
  const path = relativePath && !isAbsolute(relativePath) ? relativePath : target;
  return normalizeCommandPath(path);
}

function normalizeCommandPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  if (
    normalized.startsWith("./")
    || normalized.startsWith("../")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
  ) {
    return normalized;
  }
  return `./${normalized}`;
}

function quoteCommandPath(path) {
  return JSON.stringify(path);
}
