# Tuda 桌面 0.1.9 发布记录

2026-11-27（Asia/Shanghai），Tuda 桌面 0.1.9 发布到 npm 稳定渠道 `latest`。本次发布包含星港生图的模型 ID 解析修复。 [npm 精确版本](https://www.npmjs.com/package/@petercjl/tuda-desktop/v/0.1.9) · [构建源码](https://github.com/petercjl/iterlay/commit/3361c3273746f422feba4e9ab9c21a2cda587776)

## 升级验收

- macOS arm64 从 0.1.8 用原更新按钮下载整包升到 0.1.9，再用同一按钮差分升到 0.1.10。两次升级后都保留了测试画板和主题设置。验证了签名和组装后的应用内容。
- Windows x64 从 0.1.3 用原更新按钮下载整包升到 0.1.9，再用同一按钮差分升到 0.1.10。每段验证实际替换的可执行文件哈希，重新打开后读取同一测试画板和主题设置。远程验收进程在需要时重新运行桌面端生成的原安装助手，并重启隔离的测试应用。
- 星港修复通过打包桌面端的模拟服务验证，覆盖模型 ID 路由及生图结果返回。0.1.10 为隔离验收版本。
- 从正式 npm 下载并重组两个安装包，核对各分块 SRI、完整安装包 SHA-256、精确版本、稳定标签、精确安装及两平台的旧版更新发现。

| 平台 | 安装包 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| darwin/arm64 | `Tuda-0.1.9-arm64.dmg` | 139481354 | `fe7dcec52f6806f81f75bf838e403c46f7333cd119dba9c702a45462715b869c` |
| win32/x64 | `Tuda-0.1.9-x64.exe` | 122440796 | `df9eb61e53d309e55bd8c4a09d9d46cf9d6431a2b67ab45397298d289e934312` |

npm 清单 SRI 为 `sha512-qvybVsu0OStWiiEdRmjzylPVoaCTGL5VmliLWubqlzxyuigBCxrpUAAyXorD1wdYnYtEJ18lMHBxLuyeR6eKcw==`。
