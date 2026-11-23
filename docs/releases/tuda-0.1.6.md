# Tuda 桌面 0.1.6 发布记录

2026-11-23（Asia/Shanghai），桌面更新包 [`@petercjl/tuda-desktop@0.1.6`](https://www.npmjs.com/package/@petercjl/tuda-desktop/v/0.1.6) 已发布至 npm 稳定渠道 `latest`。首次安装支持 Windows x64 和 macOS arm64。两份安装器均从[同一源码提交](https://github.com/petercjl/iterlay/commit/bd6788286791a707f5a11b477a04db24bf5302b0)构建。

## 变更

- 接入山海 OMNI 企业账号和模型配置。正式安装包使用 OMNI 正式服务，并支持浏览器授权入口。
- 优化画板连线的标签、走线、箭头和配色。单击图片用于选中，视频的「生成声音」开关开启时显示蓝色。
- 独立插件、CLI 和 Skill 包 `@petercjl/tuda` 继续保持 0.1.2。

## 验收

- 类型检查和 ESLint 通过，2,560 项单元测试通过、4 项跳过。官网 13 项检查和桌面发布契约通过。
- 从实际 DMG 挂载复制，完成摘要、ad-hoc 签名、启动和 OMNI 正式授权发起验证。通过离线服务验证四类模型同步、渠道回退和授权配置撤销。
- 在 peter-new 构建 Windows 安装器，105 项专项测试和 2 项发布契约通过。通过实际 NSIS 首装、应用启动、OMNI 正式授权发起和 Pi 加载验证。确认同版本重装后，隔离测试会话和画板仍可恢复。
- 两台验收设备均走浏览器授权入口。生产账号实际授权确认和付费模型调用未纳入本次验收，未执行旧版安装到 0.1.6 的完整升级演练。Mac 安装包未做 Apple Developer ID 签名和公证。
- 六个公开 npm 分块的完整性与准备制品一致。两份安装器均通过公开下载重建、字节数和 SHA-256 校验。另从 public registry 精确安装清单包，验证 `latest` 及两个平台的更新选择。

## 不可变制品

| 平台 | 安装器 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| macOS arm64 | `Tuda-0.1.6-arm64.dmg` | 139472140 | `992dfe7e88fd2a40ba2e05400326ded425956bd511c7b540c886b653264bc634` |
| Windows x64 | `Tuda-0.1.6-x64.exe` | 122437351 | `b2ea5f5b96d43d118ca71688cd66625f7ac6d2617aa0a548ae4af2a895189a7d` |

npm 清单归档 SRI 为 `sha512-dPOjswF87X7gRpgDpq6AgEk9BLUxH0k7JctJRuc+lTLzMT3o9WaLnCJNNp/N2OFtJi2tUZVO81zyfzVpFcB1hg==`。安装器分块与平台绑定见 [发行清单](../../desktop-package/release-manifest.json)。
