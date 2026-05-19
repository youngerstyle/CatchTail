# Install CatchTail

Use these instructions when the user asks Codex to:

```text
安装并初始化 https://github.com/youngerstyle/CatchTail
```

The current Codex workspace is the target project or folder.

1. Fetch or clone CatchTail from `https://github.com/youngerstyle/CatchTail`.
2. Run the project installer against the target workspace:

   ```powershell
   node <catchtail-repo>\scripts\install.mjs <target-project>
   ```

3. Start the local console from the target project:

   ```powershell
   node <catchtail-repo>\bin\catchtail.js serve
   ```

4. If Codex asks the user to trust hooks, let the user review and approve the
   hook command. Do not bypass Codex hook trust.
5. Tell the user to open `http://127.0.0.1:3787`.
6. To enter the runtime workflow, the user can tell Codex:

   ```text
   启动交互式工作流
   ```

