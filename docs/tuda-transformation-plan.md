# Tuda · 图塔项目改造计划

更新日期：2026-11-12  
源码基线：`fc13c2c`，上游应用版本 `0.1.70`  
执行状态：完成源码盘点，待分阶段实施。本文中的待办勾选框仅在有验收证据后勾选。

## 一、目标与已确认要求

将现有 Fork 改造为我们独立维护的电商视觉创作桌面应用 **Tuda**，中文昵称 **图塔**。核心用途是把商品图、参考图和生成结果放到无限画板中比较、排列与继续创作；人和 Agent 操作同一套画板能力。

| 项目 | 已确认要求 |
| --- | --- |
| 英文名称 | Tuda |
| 中文昵称 | 图塔 |
| Logo | 本文下方的蓝绿 T 字母图标；作为品牌资产制作的依据 |
| 产品形态 | 独立桌面应用，具备完整的手动画板操作和 CLI |
| 数据归属 | 每位用户的数据保存于自己的电脑，按操作系统用户隔离 |
| 当前开发 | macOS 编译、运行桌面 Dev 版本 |
| 正式交付 | Windows 桌面版本 |
| 更新方式 | npm 分发发布版本，用户在桌面端点击更新 |
| Windows 验证 | 项目约定的 `peter-new`，SSH 执行命令，远程桌面及 Computer Use 核对界面 |
| 源码维护 | 在自己的 Fork 开发，持续从上游同步更新 |

选定 Logo：

![Tuda · 图塔选定 Logo](../resources/branding/tuda-icon-option-c.png)

原图：`resources/branding/tuda-icon-option-c.png`，1254 × 1254 PNG。正式资产制作需清理透明外缘并核对小尺寸显示效果。

## 二、当前基线与盘点结论

### 已完成的基础工作

- [x] 已建立 [petercjl/iterlay Fork](https://github.com/petercjl/iterlay)。
- [x] 本地 `origin` 指向自己的 Fork，`upstream` 指向 [Davied-H/iterlay](https://github.com/Davied-H/iterlay)。
- [x] 已有 `dev/desktop-foundation` 分支，基础提交为 `fc13c2c`。
- [x] 已将项目开发流程写入 `AGENTS.md`。
- [x] macOS 桌面 Dev 版已启动过；桌面开发数据目录隔离已实现，并有六项单元测试。
- [x] 已验证 CLI 能连接桌面开发工作区并导入本地图片。
- [x] 已验证 Windows 测试机 SSH 连通。具体环境与历史结果见 [Fork 开发基线](fork-development-status.md)。

### 本次源码盘点发现

1. **改造涉及运行身份，而不只是名称替换。** 根包、主进程、启动页、菜单、CLI、Skill、协议、数据路径和安装器都含有原版身份。按 `git grep` 对旧名称及应用 ID 的检索，约 **432 个受 Git 跟踪文件**存在匹配，包含测试、历史记录和第三方声明；此数字用于衡量范围，不代表全部都应修改。
2. **更新仍读取原作者的发布源。** `electron/updater/github-api-client.ts` 指向原作者 GitHub Releases。根包为 `private: true`，现有发布工作流未建立我们的 npm Trusted Publishing 链路。
3. **本地授权与商业遗留需要分别处理。** `electron/licensing/service.ts` 当前是本地开放访问实现；分享、反馈、推荐和统计客户端等仍保留服务接口。`electron/main.ts` 中管理服务地址默认来自空值环境配置，不能把“存在接口”写成“已经向原作者上传数据”。
4. **已有更新服务和安装驱动可复用。** `UpdateApiClient`、`AppUpdateService`、`DirectDownloadDriver` 以及桌面更新 UI 已存在；最小缺口是自己的版本源、产物契约和可验证的 Windows 升级链路。
5. **核心协同有已观察到的缺口。** CLI 排列返回成功后，打开中的画板可能未同步，随后保存覆盖布局。原有桌面 smoke 也在“拖动后立即关闭的位置保存”断言失败，原因尚未确定。详细历史证据单独保留于基线记录。

## 三、改造边界与实现原则

### 责任划分

| 层 | 负责内容 | 本次最小改造 |
| --- | --- | --- |
| Tuda 桌面应用 | 品牌、交互、画板、本地数据、更新 UI | 统一品牌配置，独立应用身份，可靠保存与画板同步 |
| CLI 与本地能力 | 显式画板操作、参数校验、任务查询与恢复、结构化结果 | `tuda` 入口、Tuda 工作区发现、稳定能力契约 |
| 配套可移植 Skill | 指导当前 Agent 正确发现和调用 CLI | `using-tuda`，由拥有它的包统一分发与管理 |
| 分发与平台适配 | npm 版本发现、Windows 产物获取、校验、安装与恢复 | 适配现有更新接口，建立自己的 Windows 发布管线 |
| 电商应用方法 | 选图、比较、素材分组及具体业务流程 | 在画板与能力层稳定后迭代，可复用方法独立维护 |

固定的操作逻辑使用现有 CLI、主进程服务或确定性脚本；业务选择不下沉到供应商适配器。保留现有模块边界，逐步提取品牌配置，控制同步上游时的冲突范围。

### 兼容与数据原则

- 用户界面、操作系统身份和对外入口采用 Tuda 品牌。
- 存量画板、模板、任务及插件格式按版本制定兼容策略；读取旧字段与写出新字段可分阶段实现。
- 原作者与第三方的版权、许可证、必要署名及真实发布历史保留；它们不属于待清除的界面品牌。
- Tuda 与原版分别拥有应用 ID、数据目录、CLI 启动器和协议注册，验证可并存。
- 既有数据通过显式导入或经确认的迁移进入 Tuda；保留备份、版本标记和可重试恢复，避免自动接管原版工作区。
- 外部模型调用继续遵循用户选定的服务与授权，普通本地画板操作可独立使用。

## 四、分阶段执行清单

### P0：锁定身份与资产规范

**产出：** 品牌及应用身份清单，后续代码和发布配置共同引用。

- [ ] 固定显示规则：主名称 `Tuda`，中文产品介绍使用“图塔”。
- [ ] 从选定 Logo 制作干净的品牌母版、界面标志、Windows 多尺寸 `.ico`、macOS Dev 所需 `.icns` 与 PNG。
- [ ] 检查 16、24、32、48、256、512 像素和高 DPI 效果，覆盖白底、深底、Dock 与任务栏。
- [ ] 统一品牌配置入口，集中管理名称、应用 ID、协议、默认图标与帮助链接；主进程、前端、CLI 和构建配置使用明确的共享或生成契约。
- [ ] 确认独立应用 ID、npm 包身份、版本策略和发布可见性，登记后冻结。

以下为实施建议，尚未检查 npm 名称可用性，也尚未写入运行配置：

| 身份项 | 建议值或规则 |
| --- | --- |
| 产品名称 / 可执行文件 | `Tuda` / `Tuda.exe` |
| 应用 ID | `io.github.petercjl.tuda` |
| CLI 名称 / Skill 名称 | `tuda` / `using-tuda` |
| npm 主能力包 | `@petercjl/tuda`，正式使用前核验 registry 与账号权限 |
| 深链协议 | `tuda://`，正式注册前核验本机冲突 |
| 环境变量前缀 | `TUDA_`；旧参数按需要提供显式兼容映射 |
| 应用与能力包版本 | 建立版本对应表；仅更新管理器时可复用兼容的桌面产物 |

**验收：** 身份清单无歧义；母版与各尺寸导出可追溯；未覆盖原版品牌资产及用户自定义图标。

### P1：完成桌面品牌替换

**主要位置：** `index.html`、`electron/main.ts`、`electron/application-menu.ts`、`electron/startup-page.ts`、`electron/app-icon.ts`、`src/assets/`、`resources/app-icons/`、`build/`、`src/components/workbench/LibraryShell.tsx`、`src/components/onboarding/`、`src/components/update/`、`src/i18n/`。

- [ ] 更换窗口标题、菜单、启动屏、侧栏、设置、关于与版本信息、通知及错误提示中的产品名称。
- [ ] 更换 Dock、窗口、任务栏、安装器、快捷方式与应用内标志；检查自定义图标及原版 mascot 选项的处理。
- [ ] 同步中英文文案、无障碍标签、欢迎演示中的图文与品牌元素。
- [ ] 更新本应用的帮助、下载、反馈和版本说明入口，按已实现能力显示。
- [ ] 运行 macOS 桌面 Dev 版，逐屏检查启动、画板库、画布、设置及更新界面。

**验收：** 用户可见的应用品牌统一为 Tuda / 图塔，实际窗口与 Dock 使用选定 Logo；许可证及兼容说明中的原版名称按用途保留。

### P2：应用身份、本地数据与文件协议独立

**主要位置：** `package.json`、`electron/main.ts`、`electron/dev-workspace.ts`、`electron/workspace-migration.ts`、`electron/storage/`、`cli/src/paths.ts`、`shared/deep-link.ts`、`electron/deep-link.ts`、`electron/board-archive.ts`、`electron/scene-archive.ts`、`electron/renderer-security.ts`、`index.html`。

- [ ] 统一 `productName`、`appId`、`app.setName`、Windows AppUserModelID、安装器标识与进程/快捷方式名称。
- [ ] 明确 Windows 用户数据路径和 macOS Dev 路径，使桌面和 CLI 得到相同的工作区结果。
- [ ] 隔离缓存、日志、会话、任务、配置、回收站、模型凭证及开发测试目录。
- [ ] 检查 Electron `safeStorage` 等凭证加密与迁移边界；跨应用搬迁配置不等于凭证可直接复用。
- [ ] 审查启动迁移：原代码会查找更早的 `ImageRelay Studio` 工作区，按 Tuda 的显式迁移策略调整。
- [ ] 建立 `tuda://` 路由；本地素材协议与 CSP、素材存储、预加载及分享页面保持一致。
- [ ] 盘点 `.itb` / `.irb` 画板、`.itt` 模板、`iterlay-board` / `iterlay-template` 标识和插件包格式，定义导入兼容与导出策略。
- [ ] 处理 localStorage 键、布局、引导完成标记及 schema 版本，记录必要的旧键映射。

**验收：** 原版与 Tuda 可并存；CLI 连接正确实例；重启可恢复 Tuda 数据；历史示例可导入；用户数据迁移具有恢复点。

### P3：CLI 与 Agent 能力改造

**主要位置：** `cli/`、`electron/cli-installation.ts`、`electron/agent-integration.ts`、`electron/local-api.ts`、`electron/workspace-tools.ts`、`electron/application/`、`shared/agent-integration.ts`、`shared/agent-starter.ts`、`resources/skills/`、`resources/guard/`。

- [ ] 将安装入口、可执行命令、帮助、错误信息、App 定位及版本输出改为 Tuda，保留机器可解析的 JSON 结果。
- [ ] 提供能力发现、诊断及规范的 `skill source/status/install/update` 和包更新入口；每项声明真实输入、输出、副作用与失败恢复。
- [ ] 将伴随 Skill 变更纳入 `portable-skill-creator` 流程，建立 `using-tuda` 的规范源、资源引用和契约。
- [ ] 规范源位于所属 npm 包或源码 checkout；Agent 安装目录由包管理，不维护多份业务逻辑。
- [ ] 支持当前 Agent 解析自身 Skill 目录；具名适配封装宿主差异，通用入口以能力要求判断可用性。
- [ ] 安装、升级仅同步明确选定的 Agent，默认本机 Codex；移除继承的全 Agent 自动扫描/同步副作用。
- [ ] 安装前识别同名启动器、用户修改和托管所有权，提供备份与同版本修复；Tuda 安装不删除原版集成。
- [ ] 保持本地桥接仅监听 loopback，使用工作区令牌；确认多实例、端口及关闭窗口后的任务状态。
- [ ] 对 `open_iterlay` 等旧操作名和持久化配置字段建立版本映射，验证后再收敛内部命名。

**验收：** 当前 Agent 可用 `tuda` 创建画板、导入外部图片、移动/缩放/排列、查看任务及导出；CLI 与 Skill 均可验证已安装且版本一致；对其他 Agent 的兼容声明与实测记录分开。

### P4：画板与 CLI 协同可靠性

**主要位置：** `src/App.tsx`、`src/features/boards/`、`electron/application/workspace-commands.ts`、`electron/storage/board-store.ts`、`electron/window-lifecycle.ts`、对应单元测试与桌面 smoke。

- [ ] 建立可重复的 CLI 布局覆盖用例，分别测前台编辑中的画板和后台画板。
- [ ] 梳理修改前 flush、revision 校验、事件通知、前端重新载入及延迟保存的时序。
- [ ] 修复移动、缩放、排列等外部变更与 UI 保存之间的冲突，避免仅对单一移动操作打补丁。
- [ ] 排查“拖动后立即关闭”失败：确认引导层、测试命中位置、拖动是否发生和保存结果，再定位业务故障或测试缺陷。
- [ ] 验证关闭、重新打开、后台任务继续运行、断连恢复、撤销重做及结果关联。
- [ ] 完成核心链路：外部生成图片 → CLI 导入 → 排列比较 → 手动调整 → 关闭重开 → 再由 CLI 操作。

**验收：** UI 与 CLI 对同一节点的位置和尺寸一致；自动保存不回退外部修改；重启后结果保持；测试能证明真实交互和保存，而非只检查接口返回成功。

### P5：外部服务与电商产品入口整理

**主要位置：** `electron/main.ts`、`electron/licensing/`、`electron/*-client.ts`、`electron/sharing-ipc.ts`、`shared/contracts/legacy-commercial.ts`、`shared/inspiration-sources.json`、`shared/media-tools-manifest.json`、`src/components/workbench/`、`plugins/`、`packages/plugin-sdk/`。

- [ ] 建立服务清单，逐项标明默认启用状态、何时请求、发送哪些数据、服务归属、离线行为和处理方案。
- [ ] 核对反馈、推荐邀请、在线分享、模板投稿、统计和旧商业入口；未接管的服务设置为明确不可用并收敛对应入口，已接管的服务使用自己的配置。
- [ ] 核对内置灵感链接、服务商配置、登录回调及后台配置；模型账号与公司凭证保存在包外。
- [ ] 审查视频工具下载：当前清单引用上游 macOS ARM64 FFmpeg 产物。按实际保留的视频功能，补齐 Windows 工具或明确能力限制。
- [ ] 列出插件 ID、SDK 包名、内置短剧插件及示例素材的品牌引用；按兼容契约迁移，不凭产品改名推断 API 必须破坏性变更。
- [ ] 首次打开支持直接导入图片、粘贴和建立画板；配置模型服务服务于需要生成的操作。
- [ ] 将电商工作台的默认文案、示例和入口聚焦商品图、参考图、候选方案与素材比较。
- [ ] 视频、模板、助手及插件等既有能力单列保留/隐藏/后续改造清单，保持用户数据可恢复。

**验收：** 本地画板可在未配置模型时使用；外部请求及归属可核对；产品入口与真实能力一致。新增电商业务功能另建需求，按阶段交付。

### P6：Windows 构建、npm 分发与桌面更新

**主要位置：** `package.json`、`scripts/release.sh`、`scripts/verify-package-size.mjs`、`.github/workflows/`、`electron/updater/`、`shared/app-update.ts`、`src/components/update/UpdateManager.tsx`、npm 分发包。

- [ ] 确认 npm 包身份与可见性，定义应用版本、能力包版本、产物版本和 `latest` / `next` 的对应关系。
- [ ] 确定安装器承载方案：建议 npm 包发布版本及机器可读 manifest，引用校验过的不可变 Windows 安装器；安装器可由我们自己的 GitHub Releases 承载。若要求安装器字节也完全通过 npm 分发，先验证包体积、安装性能和 registry 约束，再选择平台产物包。最终方案作为本阶段决策记录。
- [ ] manifest 至少包含版本、Windows 架构、产物地址、大小、SHA-256、发布说明及兼容信息；更新器拒绝架构不匹配和完整性不一致的产物。
- [ ] 复用更新服务及安装驱动，新增 npm 版本源适配；客户端从自己的包发现版本，下载安装器后由 Windows 安装器完成替换与重启。
- [ ] 桌面点击更新不要求客户自行打开终端或安装 Node.js；Agent 的管理 CLI 可以有独立、明确的运行环境要求。
- [ ] Dev 运行不执行正式安装器替换；正式应用的检查、下载、取消、失败重试、退出保存与恢复按版本测试。
- [ ] 改造构建及正式发布工作流，只生成 Windows 正式产物；x64 首先在实机验证，ARM64 根据客户需求和真实环境另行纳入。
- [ ] 审查 `scripts/release.sh` 中存在 CLI 时自动生成发布配图的逻辑，将付费生图与必要构建步骤分离。
- [ ] 区分管理器变更和原生应用变更：兼容的管理器/Skill 更新可复用已有产物，原生依赖或构建规则变化走完整构建与验证。
- [ ] 通过 `npm-release-kit doctor`、工作流预览与核对建立 GitHub Actions OIDC 发布；新包按该技能的新包引导流程完成一次性初始化。
- [ ] 检查真实 packed 内容、许可证、敏感信息排除、CLI/Skill 一致性及失败恢复；发布成功以 registry 精确版本、dist-tag 和实际安装结果为证据。
- [ ] 评估 Windows 代码签名与安装提示，记录真实状态；对外说明与实测一致。

**验收：** 从一个已安装的 Tuda Windows 版本，在桌面发现测试版本、下载校验、安装重启到新版本，画板、素材和设置保留；更新失败时旧版仍可继续使用或按明确步骤恢复。

### P7：Windows 实机验收、文档与首个发布候选

- [ ] 在 `peter-new` 检查并补齐 Git、pnpm 及构建工具；验证实际版本、PATH 和可执行入口。
- [ ] 核对实机 Windows 版本与 Electron、Node、安装器的实际兼容性；当前记录为内核 `10.0.17763`、x64，仅 SSH 连通不算桌面兼容通过。
- [ ] 用独立目录和测试账号数据运行 Tuda，验收安装、启动、Logo、CLI、手动图片操作、重启恢复和更新。
- [ ] SSH 负责构建、日志与 CLI 验证；远程桌面负责安装器、任务栏和交互检查，必要时使用 Computer Use。
- [ ] Tuda 与原版并存测试，确认应用身份、快捷方式、协议与数据不会互相接管。
- [ ] 改写当前 README、中文 README、开发说明、CLI 使用说明及 Agent 自然语言提示词；保留上游来源与第三方声明。
- [ ] 盘点 `website/` 和 Pages 工作流中的旧品牌、SEO、域名及下载地址；先提供准确的 Tuda 入口，再决定官网上线范围。
- [ ] 打通 Windows 安装器、npm 精确版本、更新 manifest、CLI 和 Skill 的候选版本验证。
- [ ] 汇总验收记录、已知限制和恢复说明，形成可审查的首个发布候选；取得对应发布授权后执行正式发布。

**验收：** Windows 实机证据齐备；发布包可独立使用；关键能力与文档一致；失败项有明确处理结果。

## 五、实施顺序与每阶段交付

| 顺序 | 批次 | 交付结果 | 进入下一步的条件 |
| --- | --- | --- | --- |
| 1 | P0 + P1 | 用户可见的 Tuda 品牌、干净 Logo 资产和 macOS Dev 截图 | 品牌身份及界面核对通过 |
| 2 | P2 + P3 | 独立工作区、应用身份及 `tuda` / `using-tuda` 入口 | 数据隔离、兼容与 CLI 安装测试通过 |
| 3 | P4 | 人与 Agent 共同操作画板的可靠基线 | 核心比较流程、保存与重启验证通过 |
| 4 | P5 | 外部服务归属清单与电商工作台默认入口 | 本地使用独立、可用能力明确 |
| 5 | P6 | Windows 构建、npm 版本源和桌面更新闭环 | 测试版本更新与失败恢复通过 |
| 6 | P7 | Windows 实机验收及首个发布候选 | 全部必需验收完成后进入正式发布 |

执行每一批时，先列出本批文件与验收项，保留已有文件恢复点，使用范围清晰的提交。完成后更新本计划中的勾选状态，并把具体测试日期、命令结果、截图及问题写到独立验收记录中。

## 六、必须做出的实施决策

以下决策在对应阶段开始前解决，不妨碍先完成品牌资产和界面改造：

| 决策 | 建议 | 最晚确认阶段 |
| --- | --- | --- |
| npm 名称、可见性、应用 ID 与初始版本 | `@petercjl/tuda`、独立 Tuda ID，先核验再登记 | P0 |
| Windows 架构范围 | 优先 x64，依据客户实际需要扩展 | P6 |
| npm 与安装器的分发关系 | npm 版本/manifest + 不可变 Windows 安装器；承载方式单列核验 | P6 |
| 历史工作区导入 | 显式导入优先；凭证单独处理 | P2 |
| 画板/模板格式与插件兼容 | 先保证已有数据可读，再版本化导出契约 | P2 / P5 |
| 在线服务接管范围 | 本地画板先独立；远程能力按服务清单逐项决定 | P5 |
| 客户支持与官网入口 | 使用真实可用的渠道，文案与链接一同验收 | P5 / P7 |

## 七、验证范围与维护规则

1. **源码检查：** 对品牌、路径、协议、配置及发布规则做定向检查；旧名称允许项按版权、历史和兼容用途登记，避免用“全仓匹配为零”作为验收标准。
2. **能力检查：** 关键确定性操作用单元/契约测试；包与 Skill 用 packed 安装、更新和恢复用例，平台和宿主实测分别记录。
3. **应用检查：** macOS 桌面 Dev 验证交互，Windows 实机验证客户环境；测试返回成功与视觉/业务验收分别记录。
4. **上游同步：** 保留上游来源与版本映射，在同步分支合并；优先通过品牌配置和薄适配层承接差异，每次同步回归 Tuda 定制项。
5. **阶段边界：** 本次仅形成改造清单与计划。名称配置、Logo 接入、CLI 改名和发布链路将在相应实施批次完成后更新状态。

参考依据：当前源码 `package.json`、`electron/`、`cli/`、`shared/`、`src/`、`resources/`、`scripts/`、`.github/workflows/`、`LICENSE`、`THIRD_PARTY_NOTICES.md`，以及 [AGENTS.md](../AGENTS.md)、[开发说明](development.md) 和 [Fork 开发基线](fork-development-status.md)。npm/Agent 能力包按照当前 `cross-agent-npm-package-development`、Skill 改造按照 `portable-skill-creator`、发布按照 `npm-release-kit` 的契约分阶段执行。
