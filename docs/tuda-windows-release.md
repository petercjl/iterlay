# Tuda 桌面正式交付

桌面交付目标为 Windows x64 与 macOS arm64；各安装包在对应操作系统上构建并分别验收。Mac 日常开发继续运行固定的 Tuda Dev。

## 版本和配置

本次桌面发布版本为 `0.1.5`，由根目录与 `desktop-package/package.json` 共同校验，独立 npm 包为 `@petercjl/tuda-desktop`。插件、CLI 和 Skill 使用 `cli/` 中的 `@petercjl/tuda` 及独立版本。桌面清单和安装器分块仅进入桌面包。正式版本默认使用本机 npm-release-kit 完成检查、固定制品打包与发布；云端 Actions/OIDC 需要另行授权。

Pi Agent 的私有根目录为 `~/.tuda`（Windows 为 `%USERPROFILE%\.tuda`），开发使用 `dev`，正式使用 `stable`。`tuda-agent/<space>/<account-hash>/` 保存账号及空间隔离的 `auth.json`、`models.json`、`settings.json`、`sessions`、`skills`、`extensions` 与 npm 资源；文件按实际使用创建。日志在对应渠道的 `logs` 中，经验数据在 `pi-agent` 中。应用内的 Pi 设置与账号模型授权由应用设置服务管理。

首次启动导入旧应用目录中缺失的 Agent 文件，保留原目录和已有目标数据；迁移设置中的资源路径时保留恢复副本。应用升级保留用户目录。

正式构建从 `TUDA_COMPANY_DEFAULTS_JSON` 或 `--company-defaults` 指定的私有部署配置读取两个默认连接地址，并注入 `resources/company-defaults.json`。安装后企业空间直接显示默认账号服务与 NAS 地址；构建及实装验收检查默认值完整，升级保留用户显式设置。

## 首次安装与后续更新

本次首次安装文件为 Windows 的 `Tuda-0.1.5-x64.exe` 和 M 系列 Mac 的 `Tuda-0.1.5-arm64.dmg`。Windows 安装器按用户安装，支持选择目录并创建快捷方式；Mac 打开 DMG 后将 Tuda 拖入 Applications。当前 Mac 使用 ad-hoc 签名，尚未完成 Apple Developer ID 签名与公证，首次打开按系统提示在隐私与安全性中允许。NAS 中已有的 0.1.3 首装文件作为历史分发记录保留。

后续更新在应用内检查并由用户点击安装。0.1.3 首次升级时需使用能覆盖应用下载流量的代理；0.1.4 起版本检查和下载统一采用系统网络与代理设置，优先连接官方 npm，失败后自动尝试国内 npm 镜像。连接超时或传输长时间无数据时会切换来源，每个分块完整校验后才用于组装安装器。稳定版读取 npm `latest`，测试渠道读取 `next`。安装器按最大 48 MiB 分块，作为同一 npm 包的不可变内部数据版本发布：`0.0.0-payload.<sha256>`，使用 `payload` 标签。每块为包含 `payload.bin` 的 npm 归档；客户端限定 npm 来源、数据类型及大小，校验分块与完整安装包后执行安装。用户的日常更新通过应用内置能力完成。

## 构建和发布入口（开发者参考）

- 本机开发：`pnpm electron:dev`。
- Windows 构建：`pnpm release --arch x64`。
- Mac 构建：`pnpm release:mac --arch arm64`。
- Windows 本机发布验证：`scripts/windows-local-release.ps1`。平台构建均显式提供私有默认连接配置；只将两个公共连接地址写入 App。
- `scripts/prepare-release-manifest.mjs --platform win32 --arch x64` 或 `--platform darwin --arch arm64` 从实际安装器生成不可变分块和更新清单；`--merge <manifest>` 合并另一个平台的同版本清单，冲突时拒绝覆盖。元数据修改前自动备份。
- 公开下载校验可通过支持该参数的 Node 使用 `--use-env-proxy` 复用本机代理配置；校验分块和整包哈希后才开放更新。
- 两个平台验收后，依次通过 npm-release-kit doctor / prepare / publish 的本机流程发布固定分块，回读核验完整安装器后，最后发布稳定桌面清单。清单按 platform/arch 精确选择安装内容，保留 CLI/插件的独立版本。仓库工作流保留手动入口，不因源码推送自动消耗构建额度或部署网站。

0.1.5 已完成 Mac 与 Windows 实装验收、公开安装器重建校验和 npm latest 发布，详见 [0.1.5 发布记录](releases/tuda-0.1.5.md)。历史 0.1.3、0.1.4 分发和验收证据保留在 [发布台账](marketing/publications.md)。
