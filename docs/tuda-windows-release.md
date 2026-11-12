# Tuda Windows 正式交付

Mac 用于开发，日常运行固定的 Tuda Dev。正式桌面交付目标为 Windows x64；安装包在 Windows 上构建并验证。

## 版本和配置

桌面候选版本为 `0.1.3`，由根目录与 `desktop-package/package.json` 共同校验，独立 npm 包为 `@petercjl/tuda-desktop`。插件、CLI 和 Skill 使用 `cli/` 中的 `@petercjl/tuda` 及独立版本。桌面清单和安装器分块仅进入桌面包。新桌面包首次发布前需单独完成 npm 包引导和 Trusted Publisher 配置；当前仅准备发布流程。

Pi Agent 的私有根目录为 `~/.tuda`（Windows 为 `%USERPROFILE%\.tuda`），开发使用 `dev`，正式使用 `stable`。`tuda-agent/<space>/<account-hash>/` 保存账号及空间隔离的 `auth.json`、`models.json`、`settings.json`、`sessions`、`skills`、`extensions` 与 npm 资源；文件按实际使用创建。日志在对应渠道的 `logs` 中，经验数据在 `pi-agent` 中。应用内的 Pi 设置与账号模型授权由应用设置服务管理。

首次启动导入旧应用目录中缺失的 Agent 文件，保留原目录和已有目标数据；迁移设置中的资源路径时保留恢复副本。应用升级保留用户目录。

正式构建从 `TUDA_COMPANY_DEFAULTS_JSON` 或 `--company-defaults` 指定的私有部署配置读取两个默认连接地址，并注入 `resources/company-defaults.json`。安装后企业空间直接显示默认账号服务与 NAS 地址；构建及实装验收检查默认值完整，升级保留用户显式设置。

## 首次安装与后续更新

首次安装文件为 `Tuda-0.1.3-x64.exe`，通过 NAS“工具”共享中的 Tuda 目录交付。安装器按用户安装，支持选择目录并创建快捷方式。

后续更新在应用内检查并由用户点击安装。稳定版读取 npm `latest`，测试渠道读取 `next`。安装器按最大 48 MiB 分块，作为同一 npm 包的不可变内部数据版本发布：`0.0.0-payload.<sha256>`，使用 `payload` 标签。每块为包含 `payload.bin` 的 npm 归档；客户端限定 npm 来源、数据类型及大小，校验分块与完整安装包后执行安装。用户的日常更新通过应用内置能力完成。

## 构建和发布入口

- 本机开发：`pnpm electron:dev`。
- Windows 构建：`pnpm release --arch x64`。
- Windows 构建环境已有 Node/pnpm 时，可用 `scripts/windows-release-build.ps1` 执行依赖安装、相关测试、构建、清单、npm 打包和桌面 smoke；参数指定实际的 Node 目录与 pnpm 入口。
- `scripts/prepare-release-manifest.mjs --arch x64` 从实际安装器生成分块与更新清单，并备份将修改的元数据。
- 正式发布工作流为 `.github/workflows/publish-npm.yml`。Windows 构建和检查通过后，通过 GitHub Actions 的 npm Trusted Publishing 发布分块，验证 registry 中的完整安装文件，最后发布包含绑定清单的桌面包。

准备完成与公开发布分别记录。公开发布以 npm 中准确版本、dist-tag、完整安装文件校验和实际安装结果为准。
