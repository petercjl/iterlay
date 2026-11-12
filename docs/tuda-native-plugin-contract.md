# Tuda 原生画板插件合同 v1

状态：候选实现已写入，2026-11-12。当前文档是 Tuda 与 codex-own 的接入边界；验收证据见 `tuda-board-plugin-acceptance.md`。

## 职责

codex-own 自己通过 ToAPIs CLI 生成/编辑图片。Tuda 插件只管理画板目录、导入已有本地图片、排版、编辑文字节点、查看与导出。插件不注册生成、模型配置、Pi Agent、代码执行或通用调用工具；服务端也执行相同白名单。

## 包与启动

- 复用 npm 包 `@petercjl/tuda`；通过 npm 的 `next` 渠道发布，宿主默认内置并自动更新。
- 新入口：宿主自己的 Node 执行 `<package>/dist/board-plugin.js`，stdio MCP。宿主内置该包，不要求用户安装 CLI 或 Skill。
- `TUDA_USER_DATA_PATH`：显式目标工作区目录；Dev 必须指定独立测试目录。未指定使用当前用户正式 Tuda 数据目录。
- `TUDA_APP_PATH`：Tuda 应用根目录（Mac `.app`，Windows 包含 `Tuda.exe` 的目录）；未指定按标准安装目录发现。
- `TUDA_NO_LAUNCH=1`：只连接已有后台。
- `TUDA_PLUGIN_SPACE=enterprise` 固定企业空间；`TUDA_SPACE` 是优先级更高的同义变量，冲突空间请求会被插件与服务端拒绝。
- `TUDA_EMBEDDED_HOST=codex-own` 使打包桌面使用显式工作区、精简图文画板界面，跳过全局 CLI 自动安装和协议注册；宿主提供 `TUDA_COMPANY_URL` 作为可信授权服务 origin。
- 插件复用 Tuda 桌面后台，并非自带独立 Electron。宿主负责准备经校验的兼容桌面制品或明确报告缺失；仅内置 npm CLI 不等于完成桌面运行时内置。
- stdout 仅 MCP；诊断写 stderr。宿主可以先传尚不存在的交接文件路径：首次 tools/list 不启动桌面；首个业务调用前由宿主签发并创建私有文件，插件随后连接、兑换。宿主先调用 `desktop prepare` 等待就绪，取得 instanceId 后签发绑定实例的一次性交接文件，再发起业务调用。后台实例变化时重新交接；工具发现始终离线。

## 首版工具

复用：status、get_space、get_board_library、manage_board_library、list_boards、get_active_board、get_board、get_board_layout、open_board、fit_board_view、focus_nodes、move_image、resize_image、arrange_images、duplicate_images、trash_images、restore_image、list_assets、read_asset、export_assets、open_tuda。

新增：create_board、rename_board、trash_board、list_trashed_boards、restore_board；import_board_images（本地文件数组，运行时转为dataURL）、write_board_text（创建/更新）、move_board_nodes（图片/文字批量移动）。精确 schema 由 MCP tools/list 返回。

新增批量导入与文字写入使用 `operationId`，从其派生稳定节点 ID，并在当前账号/空间的任务目录保存输入摘要和结果回执；同ID同输入重复调用返回已有结果及 reused=true，不重复追加，异参拒绝。成功回执不依赖界面保留节点内部元数据；进程中断且结果无法核实时返回 OPERATION_OUTCOME_UNKNOWN，要求先检查画板。相对/自动布局在Tuda服务侧计算，保留已有节点位置。写入使用画板 revision，冲突明确返回，由调用者重新读取，禁止覆盖并发修改。

导图单批最多30张，总原始字节最多20MiB。运行时读取绝对本地文件并转成内部dataURL；模型只传文件路径。默认自动避让已有内容；相对位置是一次性计算，移动图片后文字不会自动跟随。

所有工具可显式传 `space=personal|enterprise`；宿主企业模式必须固定企业空间，不能失败后回退个人空间。删除画板使用现有回收站语义。

## 本地接口

服务发现复用目标目录 `local-api.json`，本机随机 bearer token。新接口 `POST /board-plugin/call`：`{method,args}`，返回 `{result}` 或 `{error}`。该接口只接受插件白名单。通用CLI的 `/call` 保持兼容。

## 鉴权联调

公司云端由 codex-own 对话维护以下 appId 隔离的授权交接合同：

1. 宿主先执行 `desktop prepare --app-path <root> --user-data-path <private> --startup-timeout 120 --json`，核对 `data.ready=true` 并读取 `data.instanceId`。随后生成32字节随机PKCE verifier，向 `/api/company/v1/handoff/issue` 提交 `{targetAppId:"tuda",verifierHash}`，使用自己的会话和 `X-Company-App-Id:codex-own`。
2. 宿主在私有目录创建0600交接文件，结构 `{contract:1,origin,appId:"tuda",code,verifier,expiresAt,instanceId}`；码有效60秒，内容不进入模型，宿主负责清理。
3. 插件通过 bearer 认证的 `/board-plugin/auth` 送入主进程。Tuda 校验已配置可信 origin、appId、格式和时限，向 `/api/company/v1/handoff/exchange` 提交 `{appId:"tuda",code,verifier}`，仅带 `X-Company-App-Id:tuda`，不携带 codex-own token。
4. Tuda 兑换自己的设备会话，核验 `/session` 和 `/bootstrap` 后仅保存在内存；每个后台新实例重新交接。独立应用登录仍使用原有安全存储。派生会话的文本/图片模型配置均禁用，云端拒绝模型代理；普通独立Tuda登录保留原能力。
5. 沿用已有企业存储；首次内嵌且未配置存储时建立按账号隔离的私有本地公司空间。已有NAS配置不可用则明确失败，不回退个人空间。
6. 每次固定企业空间的工具调用都由主进程重新核验公司会话与权限，源账号退出、停用或网络验证失败时拒绝调用。宿主换号/退出时重建或关闭插件进程。

## 宿主退出

`POST /board-plugin/host/quit` 使用本地 bearer、body `{}`，仅 `TUDA_EMBEDDED_HOST=codex-own` 可用。主进程先flush界面及存储，返回 `{result:{quitting:true}}` 后进入正常 `app.quit` 生命周期。宿主等待端口关闭再更新或退出；保存失败保留进程并报告错误。该端点不在模型工具目录内。

## 嵌入界面

内嵌桌面展示画板库/文件夹管理、图片和文字画布、导入导出；画布创建菜单及快捷键仅开放文字节点。生成、AI对话、创作助手、模型设置和服务配置弹层不进入该界面。独立Tuda的原有界面与生成能力保持原有行为。

## 责任边界

- Tuda 项目：受限工具、stdio运行时、本地接口、画板操作与鉴权接收、npm封装与发布、兼容及自动更新合同、包级必要验证。
- codex-own 项目：插件原生加载与内置分发、私有Node、云端交接接口、宿主登录状态、ToAPIs路由、桌面制品准备、默认安装、内部授权与私有安装目录的自动更新消费。功能按需要逐步联调。
- 安装/发布/真实云端部署按相应任务授权和项目门禁执行；不以模拟测试代替真实验收。

## npm 与自动更新

发布身份为 `@petercjl/tuda@0.1.0`，初始渠道 `next`。`nativePlugin.desktopCompatibility` 声明 contract1、protocolVersion1、最低桌面0.1.0。宿主按 `nativePlugin.updates` 检查、完整性验证并缓存兼容更新；24小时节流、1500ms元数据超时，同0.x minor或1.x以上同major自动安装。候选通过准备/鉴权/桌面兼容检查后原子切换，新连接生效；失败保留当前版本。用户无需操作安装或授权。

npm 发布使用独立 `publish-plugin-npm.yml` 工作流，通过 GitHub Actions OIDC；它不构建或发布 Windows 桌面安装器。桌面运行时由宿主内置，变更协议时需要宿主先升级。具体画板功能的逐项调试与npm安装授权交付分别记录。
