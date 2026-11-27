# Tuda 桌面 0.1.11 发布记录

2026-11-27（Asia/Shanghai），Tuda 0.1.11 发布到 npm 稳定标签 `latest`，原「检查更新」按钮提供最新版完整包。已有差分依赖精确起始版本。完整包使受支持的旧版可以越过中间版本直接升级。 [npm 精确版本](https://www.npmjs.com/package/@petercjl/tuda-desktop/v/0.1.11) · [构建源码](https://github.com/petercjl/iterlay/commit/9a5580922e1f85f270c5cda97351a0f6b3e9bc21)

- macOS arm64 分别实际使用 0.1.8 和 0.1.10，以原按钮选包并直升 0.1.11。校验签名，重新打开后核对画板、主题和原登录身份。
- Windows x64 分别实际使用 0.1.3 和 0.1.10，以原按钮选包并直升 0.1.11。远程测试框架重新运行客户端生成的安装助手，核对可执行文件哈希后重新打开隔离应用，验证画板、主题与原登录身份。
- 公司身份验证使用隔离测试会话。完整测试 2578 项通过、4 项跳过。六个 npm 分块、两个公开安装包、精确 npm 安装和旧版更新发现均核对。

| 平台 | 完整安装包字节数 | SHA-256 |
| --- | ---: | --- |
| darwin/arm64 | 139481169 | `64a7a8668bd47c12d9b8a145294d124f6d76cee8303ff215f1bbbd93be92fd2c` |
| win32/x64 | 122440577 | `3e100eab9cbbeb8da17e01c7b05b818319354d8c9df05419d20cc4fbe4793b38` |

npm 清单 SRI 为 `sha512-Qk7aX5h5z8BPLwbLQ94WdBSEQ1gzOw27oLFg205DzA12adFxCkw4eEI9BEvwAEH0jJGmVPq+aonbx7fz83L/+w==`。
