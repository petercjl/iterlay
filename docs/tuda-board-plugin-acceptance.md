# Tuda 画板原生插件候选验收

日期：2026-11-12。版本：应用与能力包 `0.1.0`，npm发布候选；初始发布渠道为next，Windows桌面正式发布独立处理。

## 交付范围

`@petercjl/tuda` 提供内置宿主可直接执行的 `dist/board-plugin.js` stdio MCP 入口，共29个画板工具。涵盖目录与画板管理、已有图片导入、自动与精确布局、可编辑文字、回收站、查看和导出。该入口没有生图、模型配置、Pi Agent、代码 Canvas 或通用任意操作工具，后台独立执行相同白名单。

codex-own 使用自己的 ToAPIs CLI 生成图片，再通过 Tuda 组织成画板。宿主内置插件、Node 和兼容桌面运行时；普通用户不需要另装 CLI 或 Skill。统一公司授权由宿主主进程与云端交接，Tuda 保存自己独立且仅限画板的会话。

详细环境、接口与鉴权合同见 [原生插件合同](tuda-native-plugin-contract.md)。

## 固定候选制品

| 制品 | 路径 / 身份 |
| --- | --- |
| npm tarball | `tmp/tuda-plugin-package-20261112-v8/petercjl-tuda-0.1.0.tgz`，177716字节 |
| tarball SHA-256 | `7be00f50e27e8a76f0b2b114614815eefccf09d0ea728c5ae26a4c8ad94d9ee9` |
| Mac ARM64 开发桌面 | `tmp/tuda-plugin-candidate-20261112-v8/mac-arm64/Tuda.app` |
| 候选源码摘要 | `tmp/tuda-plugin-candidate-20261112-v8/candidate.json`，记录实际源码与CLI摘要、Git基线及未提交状态 |
| 桌面包体审计 | 同目录 `package-size.json`；应用343.68MiB，ASAR113.78MiB，审计通过 |

Mac桌面使用 ad-hoc 开发签名，`codesign --verify --deep --strict` 通过；用于内置集成开发验证，不是新的 Mac 正式发布。npm包自带stdio入口依赖的运行代码与第三方许可证，运行时不需要临时下载SDK。

## Tuda 侧验证

| 项目 | 最终证据 |
| --- | --- |
| 全量单元及契约测试 | Node.js 22.22.2，**2378通过、0失败、4跳过**；`tmp/tuda-board-plugin-unit-final-v8.json` |
| 构建及静态检查 | renderer、Electron、preload、CLI构建通过；相关ESLint、前端/Electron/CLI类型检查与diff检查通过 |
| 真实stdio消费 | `scripts/test-board-plugin.mjs`：29工具、离线发现、拒绝生成工具、固定空间、延迟私有授权、原图文件导入均通过 |
| tarball消费与安装生命周期 | `scripts/test-cli-package.mjs`：禁用安装脚本、显式目录、任意宿主、重复安装、同版本修复、本地修改保护、未托管目标保护、实体运行时隔离通过 |
| 软件包依赖 | CLI工作区依赖审计0项已知漏洞；stdio使用SDK 1.32.2并附许可证 |
| 主进程授权边界 | 私有token校验、云端交接可信origin/appId/有效期、bootstrap身份验证、每次企业操作重新验证会话、非宿主退出拒绝均有测试 |
| 幂等与并发 | 输入摘要与结果持久回执；UI改写节点并移除内部标记后，重复请求仍不追加、不覆盖用户修改；异参拒绝；过期revision和锁定节点保护通过 |
| 真实打包桌面 | 创建画板→导入2图→文字→精确移动→立即安全退出→重启保持坐标→重复导入不追加→当前板回收与恢复→安全退出，连续3次无截图/诊断等待的快速退出验收通过 |
| 精简界面 | 实际打包窗口确认画板库、文件管理、图片、文字、导出可用；生成/视频/代码创建、AI对话及图片服务配置入口未展示 |

桌面验收入口：`scripts/playwright-board-plugin.mjs`。快速退出三轮报告分别位于 `output/playwright/board-plugin-DK3hVH/`、`board-plugin-P4Acxn/`、`board-plugin-qmeMYH/`（顺序以各报告内容为准）。完整截图与复测报告位于 `output/playwright/board-plugin-ZahIZp/`。

![内嵌图文画板开发候选](../output/playwright/board-plugin-ZahIZp/canvas.png)

上述测试使用独立工作区与仓库图片，没有提交付费媒体生成任务。源码恢复点位于 `tmp/tuda-board-plugin-backup-20261112-174910/`。工作区中另外出现的 `GenerationNode.tsx` 在途变更保留，候选摘要记录实际输入，未将其作为本轮插件修改。

## codex-own 与云端联调

由 `codex-rebuild` 项目对话负责内置注册、私有Node、完整桌面分发、授权云端、宿主开发构建及真实模型调用。交接台账为该项目的 `own/TUDA-INTEGRATION-HANDOFF.md`。

- 云端已由负责对话验证：一次性PKCE交接、错误verifier、重复领取、错误应用、退出撤销联动；派生会话为board-only，bootstrap不发放文本/图片模型凭证，模型代理拒绝。
- 首轮宿主真实 App Server 已发现29个Tuda工具，内置包禁用安装脚本消费通过。
- 最终v8桌面已交给宿主对话重新固定输入；最终宿主构建、三模型调用和目视验收结果待该对话回传后填写。前两项不能替代最终组合验收。

## 发布与平台边界

本轮发布npm能力包，采用独立 `publish-plugin-npm.yml`，跨平台包级校验通过后由GitHub Actions OIDC发布。初始版本0.1.0使用next渠道；registry与dist-tag核验完成后记录实际链接。包不携带新的桌面安装器。Windows桌面完整安装、升级与原生验收仍按桌面项目流程执行。画板功能逐步联调不阻塞包的默认安装与内部授权交付。

## 发布门禁与更新责任

Tuda维护npm运行代码、能力及兼容声明和OIDC发布流程；codex-own读取 `nativePlugin.updates`，管理自己的私有安装、内部鉴权、自动更新和安全切换。自动更新为next、24小时节流、1500ms元数据超时，兼容0.x同minor或1.x以上同major，失败保留活动版本，新连接启用。

包级本机检查：CLI类型检查、构建、prepack、真实stdio消费、禁脚本tarball安装与隔离生命周期均通过。此前无公开版本（npm registry返回404），不存在历史已发布updater需要迁移。新增CI会实际执行Linux、Windows、Mac包级校验，桌面原生支持证据另记。

v8冷启动prepare为2364ms；active、late-open、inactive三种真实打包无等待退出重启场景均通过，报告位于 `output/playwright/board-plugin-E6uhpu/`、`board-plugin-OqPIhv/`、`board-plugin-45KEpp/`。
