---
name: catchtail-init
description: Use when the user asks to 安装并初始化 https://github.com/youngerstyle/CatchTail, install, initialize, set up, or enable CatchTail in the current Codex project.
---

# CatchTail Init

Use this skill to install or initialize CatchTail for the current target project
when the user provides the GitHub repository URL or CatchTail is already
installed as a plugin.

Process:

1. Treat the current workspace as the target project unless the user names a
   different target directory.
2. Locate the CatchTail plugin root. It is the directory that contains this
   skill's `skills/` directory, plus `scripts/install.mjs` and `bin/catchtail.js`.
3. Run:

   ```powershell
   node <catchtail-plugin-root>\scripts\install.mjs <target-project>
   ```

4. Start the local console from the target project directory:

   ```powershell
   node <catchtail-plugin-root>\bin\catchtail.js serve
   ```

5. Tell the user to open `http://127.0.0.1:3787`, trust hooks if prompted, and
   say `启动交互式工作流` in Codex.

Do not ask the user to clone the repository when CatchTail is already installed
as a plugin.
