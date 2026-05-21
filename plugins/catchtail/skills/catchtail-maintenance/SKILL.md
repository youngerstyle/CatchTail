---
name: catchtail-maintenance
description: 当用户要求安装、更新、刷新、重装、卸载或清理 CatchTail 插件时使用。也适用于用户说“更新 CatchTail 插件”、“CatchTail 还是旧版本”、“插件 cache 没刷新”等维护场景。
---

# CatchTail 插件维护

用户不需要知道 Codex marketplace、插件缓存目录或版本刷新细节。收到安装、更新、刷新、重装、卸载、清理 CatchTail 的请求时，AI 必须自己处理并验证结果。

## 安装

- 如果 CatchTail marketplace 不存在，添加 `https://github.com/youngerstyle/CatchTail`。
- 通过 Codex 的插件安装/启用机制安装或启用 `CatchTail`。
- 安装后验证 `~/.codex/plugins/cache/catchtail/catchtail/<version>/.codex-plugin/plugin.json` 存在，并读取其中的 `version`。
- 不要把目标项目当成安装目录，不要把 CatchTail clone 到用户目标项目里。

## 更新

- 先更新 marketplace 源，例如运行 `codex plugin marketplace upgrade catchtail`。
- 然后验证已安装插件 bundle，而不是只看 marketplace 的 `last_revision`。
- 必须检查 `~/.codex/plugins/cache/catchtail/catchtail/` 下的最高版本目录，并读取 `.codex-plugin/plugin.json` 的 `version`。
- 如果 marketplace 已经更新，但插件 cache 里仍然没有新版本，不能报告“已更新成功”。继续使用 Codex 的插件安装/启用机制刷新 `CatchTail`，必要时先禁用/卸载旧的 `CatchTail`，再重新安装/启用。
- 成功标准是：已启用的 CatchTail 插件 cache 版本等于 marketplace 中最新 CatchTail manifest 版本。
- 更新成功后清理 `~/.codex/plugins/cache/catchtail/catchtail/` 下的旧版本目录，只保留当前启用的 CatchTail 版本；不要让用户看到多个历史版本并存。
- 回复用户时报告三项证据：marketplace revision、实际已加载/已缓存的 CatchTail 插件版本，以及旧版本 cache 已清理。

## 卸载

- 通过 Codex 的插件卸载/禁用机制卸载或禁用 `CatchTail`。
- 如果用户要求清理 marketplace，移除 `catchtail` marketplace。
- 清理 `~/.codex/plugins/cache/catchtail/catchtail/` 下的 CatchTail 插件缓存；卸载后不应残留旧版本目录让用户误以为仍已安装。
- 如果用户要求清理运行状态，只删除目标项目里的 `.catchtail/`；不要删除用户项目本身。

## 失败处理

- 如果当前环境没有可调用的插件安装/启用机制，不要假装成功。
- 明确说明已经完成了哪些步骤、卡在哪一步、当前 marketplace revision 是什么、插件 cache 版本是什么。
- 不要让用户手动理解 cache 目录；只在需要交互式授权或当前工具无法操作 `/plugins` 时，才请求用户打开 `/plugins` 完成授权或启用。
