# Tuda 桌面 0.1.8 发布记录

2026-11-27（Asia/Shanghai），Tuda 桌面 0.1.8 发布到 npm 稳定渠道 `latest`。macOS arm64 和 Windows x64 安装包从同一提交构建。 [npm 版本](https://www.npmjs.com/package/@petercjl/tuda-desktop/v/0.1.8) · [构建源码](https://github.com/petercjl/iterlay/commit/c824bf3d253a15689d9f416617dfdc94774ef3cd)

## 生图渠道

- 生图使用当前保存的默认图片模型及渠道顺序。个人渠道设为默认时，画板和创作助手可以优先使用个人渠道，公司下发渠道可并行配置。
- 桌面端支持由 Tuda CLI 直接配置个人图片渠道、自定义提交和查询端点，以及根据任务 ID 查询异步生成结果。

## 验收

- macOS arm64 挂载 DMG，校验应用签名并在隔离目录验证从 0.1.7 到 0.1.8 的数据恢复。全量测试 2,570 项通过，4 项跳过。
- Windows x64 使用两个正式 NSIS 安装包完成覆盖升级，验证 0.1.7 的测试会话及画板在 0.1.8 恢复。另有 106 项定向测试和 2 项桌面发布契约测试通过。
- 两端使用隔离的模拟服务验证个人渠道优先、异步任务单次提交和结果回写。macOS 隔离运行使用测试凭据存储替身。
- 从官方 npm 下载并重组两个安装包，核对分块 SRI 和安装包 SHA-256。已核对清单精确版本、稳定标签、npm 精确安装及两个平台从 0.1.7 发现更新。

| 平台 | 安装包 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| darwin/arm64 | `Tuda-0.1.8-arm64.dmg` | 139489934 | `df396e195517df6eb4d2d73d2af5449f014261e0d73b4dfe83776ac43dbfcf7a` |
| win32/x64 | `Tuda-0.1.8-x64.exe` | 122438263 | `84408018375edf35a8ade1cd8cb9cf1a2fb578707277871d2fa0d4665607fb57` |

npm 清单 SRI 为 `sha512-oz7DaJI0Y7dAdVhG8Tf38FpI1qdr72zjVy6JNFW9vZlADNEZC5oKM6zycVv9cGWHKHsky9eJ+/tNABa2bNSCew==`。
