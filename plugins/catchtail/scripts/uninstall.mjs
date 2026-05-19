#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const agentsPath = resolve(projectRoot, "AGENTS.md");
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
    "node ./plugins/catchtail/scripts/uninstall.mjs --remove-agents-block",
    "",
    "Also review .codex/hooks.json and remove UserPromptSubmit/Stop entries if they belong only to CatchTail."
  ].join("\n") + "\n"
);

if (process.argv.includes("--remove-agents-block") && existsSync(agentsPath)) {
  const existing = readFileSync(agentsPath, "utf8");
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  writeFileSync(agentsPath, existing.replace(pattern, "").trimEnd() + "\n");
  process.stdout.write("Removed CatchTail managed block from AGENTS.md.\n");
}

if (existsSync(hooksPath)) {
  process.stdout.write(`Hook config still exists at ${hooksPath}; remove CatchTail hook entries manually if desired.\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
