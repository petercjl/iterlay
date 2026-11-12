# Tuda · 图塔改造验收记录

验证日期：2026-11-12。应用及本地能力包版本：`0.1.0`。本次为开发候选版本，正式 npm 发布单独执行。

## 交付内容

Tuda 独立品牌、选定蓝绿 T 标志、应用 ID、数据目录、协议、CLI、可移植 Skill、Windows 构建和 npm 更新适配已写入源码。Fork 保留上游远端、许可证和第三方署名；当前维护分支为 `feature/tuda-app`。

主要实现提交为 `d117540`；后续提交补齐桌面包中的 CLI 元数据、npm 启动器识别、CI 数据隔离与 Windows 托盘生命周期。

源码恢复点位于项目忽略目录 `tmp/tuda-transformation-backup-20261112/`，其中 `manifest.json` 记录了 1366 个备份文件。进一步修订的恢复点也保存在 `tmp/`。用户原有画板与自定义数据保留，包括已存在的演示画板名称。

## 已有验证

| 项目 | 结果与证据 |
| --- | --- |
| 完整源码构建 | `pnpm build` 通过；包含前端、Electron、preload、CLI 与插件 |
| 类型及代码检查 | 四个项目的 TypeScript 检查通过；ESLint 检查通过 |
| 单元与契约测试 | 最终完整测试 **2320 通过、0 失败、4 跳过**，报告 `tmp/tuda-unit-final.json` |
| 真实桌面 smoke（Mac） | CLI 导入、复制、缩放、排列在 UI 与持久化中一致；拖动后立即关闭保存；重开；关闭窗口期间离线任务完成；WebP 缩略图读取通过；sandbox、contextIsolation 开启 |
| npm tarball 消费测试 | 脚本禁用安装、任意宿主名、目标显式选择、重复安装无变化、同版本修复、本地编辑保护、未托管目标保护通过；移除安装源及另一个宿主后，自带运行时仍可用 |
| 能力及 Skill 契约 | 结构化发现验证通过；maintenance 验证确认包及安装一致，原生宿主自动发现状态仍为 pending；Skill 基础及可移植性验证无错误 |
| 本机安装 | 本地候选 tarball 安装于用户级 npm prefix；仅同步 Codex 的 `using-tuda`。目标版本一致、current=true；目标自带运行时 doctor 通过，当前会话已实际读取 Skill |
| 网站 | 13 项测试、类型、构建及 SEO 链接检查通过；42 页、784 条链接。官网部署未执行 |
| macOS Dev | 已实际启动 Tuda 原生桌面，CLI 可连接独立开发工作区；已检查画板库、画布、设置、Coding Agent、更新入口 |
| Windows 构建 | Windows x64 的 NSIS 安装器构建、包体检查、tarball CLI 消费、WebP 缩略图与桌面生命周期测试均通过；[最终应用源码验证运行 43151101759](https://github.com/petercjl/iterlay/actions/runs/43151101759)，对应提交 `0579d4a`。随后提交仅更新验收文档与正式发布工作流的精确版本输入 |

Mac 桌面截图位于 `output/playwright/`：`tuda-library-verified.png`、`tuda-settings-verified.png`、`tuda-system-verified.png`、`tuda-update-verified.png`。完整桌面 smoke 截图为 `tuda-smoke-z9XIKW/electron-smoke.png`。这些文件是本机忽略的验证产物。

## 应用能力与服务边界

| 能力 | 当前处理 |
| --- | --- |
| 图片画板、比较、导入、排列、导出 | 核心能力保留，无模型配置可用 |
| 图片生成、视频、助手 | 保留；按用户配置调用对应服务，验证使用离线响应，没有付费测试调用 |
| 模板与插件 | 保留；历史画板、模板读取兼容；插件 API v1 wire 标识保持兼容，SDK 提供旧别名 |
| 在线托管分享、原商业奖励入口 | 未接管的服务不作为当前可用能力；在线分享开关关闭 |
| 反馈与下载 | 指向自己的 Fork 与发布入口；正式产物可用性由发布记录决定 |
| Windows 关闭窗口 | 托盘保留本地服务及后台任务，提供恢复窗口和正常退出入口 |
| Windows 视频工具 | 现有 FFmpeg 清单仅有 macOS ARM64 产物；Windows 依赖该工具的功能尚待工具产物验证 |

服务请求的归属、触发和离线行为见 [开发与交付说明](tuda-development.md)。模型凭证及用户设置位于包外，没有复制原版凭证。

## 发布与更新方案

npm 包 `@petercjl/tuda` 承载版本、CLI、Skill 和更新清单；Windows 安装器由自己的不可变 `tuda-v<version>` GitHub Release 承载。客户端验证版本、平台架构、HTTPS、文件大小、SHA-256，再调用 Windows 安装驱动。客户桌面更新无需安装 Node.js。

正式发布工作流使用 GitHub 托管 runner、Windows 构建与 OIDC npm Trusted Publishing。`npm-release-kit doctor --root . --package-dir cli --workflow publish-npm.yml --json` 八项检查通过；这不代表 npm 账号侧已配置 Trusted Publisher。发布前仍需新包一次性初始化和 Trusted Publisher 配置。当前 registry 查询为 404，**没有执行 npm 正式发布**。本机已安装的是源码产生的候选 tarball。

Windows 安装器目前未配置代码签名证书；安装提示与企业环境策略需要真机验收。默认按用户安装并保留卸载后的应用数据。

## 未完成的外部验收

1. **peter-new 真机**：当前 SSH 和远程桌面均不可达，Windows App 显示连接错误 `0x104`；证据为 `tmp/peter-new-connection.png`。Git、pnpm 补齐及真机安装交互尚未执行。此前记录内核 `10.0.17763`、x64，不视作当前桌面兼容通过。
2. **真实升级闭环**：需正式建立发布源后，验收旧版发现新版、下载校验、安装重启、保留画板和升级失败恢复；现有适配及测试不能替代这项实测。
3. **Windows 视觉与并存**：任务栏及不同 DPI 图标、原版并存、协议注册和安装提示待真机检查。
4. **回归扩展**：关闭重开与后台任务已在 Mac 验证；Windows 已由修复后的 CI 验证关闭重开与后台任务，断连恢复和撤销重做的完整手工组合用例另列待验收。

这些项目在 [改造计划](tuda-transformation-plan.md) 保留未勾选状态。日常 Mac 试用可直接运行 `pnpm electron:dev`，其数据位于 `tmp/desktop-dev/user-data/`，与正式用户目录隔离。
