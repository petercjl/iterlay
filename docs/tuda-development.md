# Tuda · 图塔开发与交付

## 应用身份

品牌配置唯一入口为 `shared/brand.json`。应用 ID 为 `io.github.petercjl.tuda`，桌面名称为 Tuda，中文昵称为图塔；能力包为 `@petercjl/tuda`，CLI 为 `tuda`，配套 Skill 为 `using-tuda`。初始独立版本为 `0.1.0`。

选定的蓝绿 T 图标以 `resources/branding/tuda-master.svg` 为干净的矢量实现；`scripts/build-brand.mjs` 生成界面 PNG、Windows ICO 和 macOS Dev 图标。原始选图保存在同目录。`pnpm brand:check` 核对品牌、包和应用身份。

## 本地开发

使用 Node.js 22.12+、pnpm 10。macOS 运行 `pnpm electron:dev`，完整编译使用 `pnpm build`。桌面开发数据为 `tmp/desktop-dev/user-data/`，可通过 `TUDA_DESKTOP_DEV_USER_DATA` 选择其他目录。网页诊断使用独立的 `tmp/browser-dev/user-data/`。

正式应用显式选择当前用户的 Tuda 应用数据目录，CLI 与应用使用同一个目录规则。原版工作区通过画板包显式导入，不自动接管原版目录或凭证。旧 `.itb` / `.irb` 和模板文件保留导入兼容；Tuda 导出的格式标识独立命名。

## 验证入口

- `pnpm test`：单元与契约测试。
- `pnpm typecheck`、`pnpm lint`：类型和代码检查。
- `node scripts/test-cli-package.mjs`：真实 tarball 安装、目标管理、编辑保护、同版本修复和物理隔离测试。
- `node scripts/playwright-electron-smoke.mjs`：独立工作区中的桌面 CLI 布局、拖动保存、关闭重开与离线模型任务测试。macOS 可用 `scripts/prepare-playwright-electron.sh` 准备独立测试 App，设置 `TUDA_E2E_ELECTRON` 指向其可执行文件。
- `node scripts/validate-cli-package.mjs`：打包版本、Skill 版本、许可证及更新清单检查。

桌面 smoke 使用本机离线响应，不调用付费服务，每次在独立目录保存截图与失败证据。测试环境使用 Node 22，避免宿主较新 Node 全局 Web Storage 行为影响 DOM 测试。

## Agent 安装与能力边界

`tuda capabilities --json` 声明能力、安装与更新契约。`skill source` 返回规范源，`skill install/status/update --target <绝对路径>` 操作当前 Agent 的确切 `using-tuda` 目录。具名适配与通用适配描述能力，不构成 Agent 白名单。

托管 Skill 自带物理复制的 `.runtime/`，保留版本与 SHA-256 回执。已有未托管目录或本地修改会阻止覆盖；同版本缺失可修复；升级备份旧目标。包安装、宿主发现和桌面可用性分别验证。桌面 GUI 的安装只作用于用户明确选择的 Agent，启动应用不会扫描并同步全部 Agent。

## 外部服务清单

| 能力 | 默认状态与归属 | 行为 |
| --- | --- | --- |
| 画板、素材、设置、任务记录 | 当前用户本地 | 基础操作独立可用 |
| 模型生成、编辑和对话 | 用户配置的服务商 | 仅按用户操作发送必要提示词与参考素材 |
| 授权 | 本地开放访问实现 | 不依赖原版激活服务器 |
| 反馈与模板贡献 | 自己的 GitHub 仓库 | 打开草稿页面，用户决定是否提交 |
| 在线分享 | `ONLINE_SHARING_AVAILABLE=false` | 后端接管前不提供托管分享 |
| 推荐奖励与原商业 Provider | 不作为本产品可用能力 | 本地画板不依赖这些入口 |
| 管理服务、统计客户端 | 地址默认空 | 仅未来显式配置并验收后启用；空配置不发送统计请求 |
| 灵感目录 | 本地清单中的外部网站 | 用户主动打开后访问 |
| 视频工具 | 已有版本化 macOS ARM64 清单 | Windows 视频工具尚无已验收产物；需要工具的能力由运行时检查并明确报错 |
| 更新 | 自己的 npm 包与 Windows 安装器 | macOS Dev 不获取客户安装器 |

FFmpeg 的既有 macOS 产物仍是声明来源的上游依赖，未虚构改名后的下载地址。Windows 图片画板与 CLI 不依赖 FFmpeg；Windows 视频导出支持需单独完成工具产物验证。

## Windows 构建与 npm 更新

Windows 关闭最后一个窗口后，托盘保留本地 CLI 服务和后台任务；双击图标或选择“打开 Tuda”恢复窗口，选择“退出 Tuda”正常保存并退出。

正式构建只生成 Windows 安装器，入口为 `pnpm release --arch x64`。`scripts/release-windows.mjs` 在 Windows 上执行品牌检查、源码构建、NSIS 打包与包体检查。安装路径、应用标识和用户数据与原版分离。

`publish-npm.yml` 先在 GitHub 托管 Windows runner 构建并验证，再通过 OIDC 发布。npm 包携带版本与 `tudaRelease` 清单；Windows 安装器以不可变的 `tuda-v<版本>` GitHub Release 承载。桌面更新器按自身架构选择清单，核对 HTTPS、版本、大小和 SHA-256，再交给已有安装驱动替换和重启。客户点击桌面更新无需 Node.js。

`latest` 用于稳定版本，`next` 用于测试渠道。npm 包和安装器版本应对应；未来管理器独立更新时，先建立明确的兼容及产物复用证据。CI 的 `npm-release` 环境负责正式发布授权，验证失败阻止发布。

新 npm 包发布前需按 `npm-release-kit` 完成一次性包初始化及 Trusted Publisher 设置。本地开发与构建不等于已发布，registry 精确版本和真实安装结果是发布完成依据。Windows 实机上的安装、点击更新、升级保留数据与恢复测试，单独记入验收记录。

## 上游同步

`origin` 保持指向自己的 Fork，`upstream` 保持原作者仓库。在同步分支合并上游，保留原作者版权、第三方许可证和真实历史。每次同步回归品牌配置、身份隔离、CLI/Skill、文件导入、画板同步和 Windows 更新契约。

参见 [改造计划](tuda-transformation-plan.md) 和项目 `AGENTS.md`。
