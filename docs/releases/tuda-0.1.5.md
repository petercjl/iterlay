# Tuda 桌面 0.1.5 发布记录

2026-11-16（Asia/Shanghai），`@petercjl/tuda-desktop@0.1.5` 已公开发布并核验为 npm `latest`。同一桌面清单提供 Windows x64 和 macOS arm64 安装内容，客户端按系统和 CPU 精确选择。

[npm 精确版本](https://www.npmjs.com/package/@petercjl/tuda-desktop/v/0.1.5) · [原生源码](https://github.com/petercjl/iterlay/commit/238913e209b6d2108d236d8e31aa13b263554b6a)

## 交付内容

- 保留钉钉登录，增加管理员分配的账号密码登录；访客使用独立本地工作区，模型请求经授权服务执行，上游 Key 保存在服务端，公司 NAS 权限由服务端拒绝。
- Windows 安装器为 `Tuda-0.1.5-x64.exe`；M 系列 Mac 首装包为 `Tuda-0.1.5-arm64.dmg`，含 Applications 安装快捷入口。
- Mac 使用 ad-hoc 签名，通过本机签名完整性检查，尚未完成 Apple Developer ID 签名及公证；首次打开按系统提示允许。
- 独立插件、CLI 与 Skill 包 `@petercjl/tuda` 保持 0.1.2；本次发布仅涉及桌面分发包及其不可变安装分块。

## 已执行验证

- 最终源码类型检查、ESLint、2501 项单元测试通过，4 项跳过；官网 13 项测试、构建及 42 页 SEO 检查通过。Windows 专项测试 97 项及两平台各 2 项发布契约测试通过。
- Mac 从实际 DMG 挂载并复制 App，核对 App/ASAR/默认配置哈希，检查 DMG 和签名；实际登录、三次退出重登、会话恢复、画板进程重启恢复、访客 NAS 隐藏、内置 CLI 连接和 Pi 运行时导入均通过。
- Windows 在 peter-new 原生构建，真实 NSIS 安装及重装，在隔离数据目录完成相同登录、退出重登、画板保留、CLI 和 Pi 检查；验收后卸载测试 App，并恢复已有 Agent 目录和系统协议配置。两平台截图已目视核对。
- 包审计通过：Mac App 350.08 MiB、Windows App 432.20 MiB，ASAR 均 119.03 MiB；排除桌面端不使用的浏览器 SDK 文件。未发现私有 Key 或初始密码进入源码及已检查的 App 资源。
- 六个公开安装分块的 SHA-512 均与 npm-release-kit 固定制品一致；从公开 npm 下载分块，验证分块 SHA-256，按顺序验证完整安装器 SHA-256。
- npm 精确版本、`latest`、完整绑定清单及归档 SRI 一致；按包名精确安装公开 0.1.5 并执行包内校验通过。当前更新客户端分别选择正确 Mac/Windows 安装器，Windows 验证机实际发现 0.1.5。

真实付费模型生成、Intel Mac 和旧版到 0.1.5 的完整升级安装未在本次进行实机验收；Windows 已验证同版本重装保留画板。

## 不可变制品

| 平台 | 安装器字节数 | SHA-256 |
| --- | ---: | --- |
| macOS arm64 | 139386982 | `57db47798e6f7e51f3ce9f7e0eb611eb0887ca47a7169415c31d4c1d55ab8899` |
| Windows x64 | 122378447 | `7415903f0545aa231f743cb4a04f6577253d3821476645eec0235f19ab392f4c` |

桌面 npm 归档 SRI：`sha512-VOjEaS5WhyScEhLjTyzTBU/zwZhfyAL8P1i07ItQ8+fmTktNt7rd7OKbBTmMlArZ0zmZi4pQZKPMZgYthIH8sg==`。

原生构建输入：803 个文件，SHA-256 `59096df2188a162e0548e08678a436a77e32eb1cbc103f8c660e154b2aaf8d90`；Mac 和 Windows 输入指纹一致。正式源码标签为 `tuda-desktop-v0.1.5`。

## 发布与恢复记录

本机通过 npm-release-kit 的固定 tarball 流程发布；GitHub 保存源码，自动 Actions 触发已停用，手动工作流保留。用户及其他 Agent 的配置保持各自管理。

验收中的共享访客账号触发登录频率限制，按时间窗口等待后，同一安装器重登验证通过。npm 浏览器验证失效时保留原版本和制品，重新取得有效验证链接；仅在普通 Google Chrome 完成身份验证。分块获得接收回执后只读等待公开生效，再发布正式清单，未对已接收版本盲目重复上传。

公开下载校验改为分块并行，分别限制连接、传输空闲、总时间和大小。Windows 单块直连下载超时后，使用本机已配置代理从同一官方 npm URL 下载，六个分块及两份完整安装器均校验通过。支持该参数的 Node 可用 `node --use-env-proxy scripts/verify-npm-release.mjs <manifest>` 复用本机代理配置。
