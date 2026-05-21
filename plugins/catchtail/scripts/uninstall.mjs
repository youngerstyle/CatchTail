#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const removeAgentsBlock = args.includes("--remove-agents-block");
const purge = args.includes("--purge");
const projectArg = args.find((arg) => !arg.startsWith("-"));
const projectRoot = resolve(projectArg ?? process.cwd());
const agentsPath = resolve(projectRoot, "AGENTS.md");
const agentsCatchTailPath = resolve(projectRoot, "AGENTS.catchtail.md");
const skillDir = resolve(projectRoot, ".agents", "skills", "catchtail-interactive");
const stateDir = resolve(projectRoot, ".catchtail");
const hooksPath = resolve(projectRoot, ".codex", "hooks.json");
const start = "<!-- CatchTail:START -->";
const end = "<!-- CatchTail:END -->";

process.stdout.write(
  [
    "CatchTail uninstall helper",
    `Project: ${projectRoot}`,
    "",
    "Please delete the managed CatchTail block from AGENTS.md:",
    `${start} ... ${end}`,
    "",
    "If you want this helper to remove that block now, run:",
    "node ./plugins/catchtail/scripts/uninstall.mjs <project-path> --remove-agents-block",
    "",
    "If you want this helper to remove CatchTail hooks, generated skill files, and local CatchTail state, run:",
    "node ./plugins/catchtail/scripts/uninstall.mjs <project-path> --purge",
    "",
    "Also review .codex/hooks.json and remove UserPromptSubmit/Stop entries if they belong only to CatchTail."
  ].join("\n") + "\n"
);

if ((removeAgentsBlock || purge) && existsSync(agentsPath)) {
  const existing = readFileSync(agentsPath, "utf8");
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  writeFileSync(agentsPath, existing.replace(pattern, "").trimEnd() + "\n");
  process.stdout.write("Removed CatchTail managed block from AGENTS.md.\n");
}

if (purge) {
  removeCatchTailHooks();
  removePath(skillDir, "Removed .agents/skills/catchtail-interactive.");
  removePath(agentsCatchTailPath, "Removed AGENTS.catchtail.md.");
  removePath(stateDir, "Removed .catchtail state.");
} else if (existsSync(hooksPath)) {
  process.stdout.write(`Hook config still exists at ${hooksPath}; remove CatchTail hook entries manually if desired.\n`);
}

function removeCatchTailHooks() {
  if (!existsSync(hooksPath)) return;
  const config = readJson(hooksPath, { hooks: {} });
  for (const [eventName, entries] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = entries
      .map((entry) => removeCatchTailHooksFromEntry(entry))
      .filter((entry) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);
    if (kept.length > 0) {
      config.hooks[eventName] = kept;
    } else {
      delete config.hooks[eventName];
    }
  }
  writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write("Removed CatchTail hook entries from .codex/hooks.json.\n");
}

function removeCatchTailHooksFromEntry(entry) {
  if (!Array.isArray(entry?.hooks)) return entry;
  return {
    ...entry,
    hooks: entry.hooks.filter((hook) => !String(hook?.command ?? "").includes("catchtail-hook.js"))
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function removePath(path, message) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  process.stdout.write(`${message}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
