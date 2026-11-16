# Tuda 公司登录与模型能力

日期：2026-11-13。设备身份、生图和存储使用 company-v1；文本配置使用该命名空间内 contract=2 的直连合同。公司授权服务与桌面分别验收。

本文直连与员工个人生图凭据合同适用于钉钉员工。账号密码访客使用独立身份域、服务端文本和图片代理，以及独立本地空间；上游 Key 保留服务端，NAS 授权关闭，详见 [账号密码登录与访客媒体](tuda-guest-login.md)。

## 职责与配置

“东轩AI授权”提供统一的企业钉钉身份入口。公司授权服务核验组织及稳定员工身份，管理各应用的设备会话、模型目录与直连配置、员工 ToAPIs Key 绑定及 NAS 存储授权。Tuda 使用 `appId=tuda`；其他应用拥有各自独立的设备会话和本地数据。

Tuda 主进程负责浏览器设备授权、模型配置领取、协议适配、Agent 工具循环及 ToAPIs 执行。NAS 负责公共画板、素材、协同状态及业务权限。本地空间由桌面独立管理。

公司部署安装包预置账号服务与 NAS 的默认连接地址，员工安装后可直接使用企业登录入口。默认地址由私有部署配置在 Windows 构建时注入，公共源码保留配置合同；组织标识、真实凭据和员工绑定记录由授权服务及用户私有目录管理。桌面“高级设置”支持用户显式设置连接地址，更换账号服务需要重新授权。

空间入口主要提供“NAS 空间 / 本地空间”两项选择，首次登录默认使用 NAS。连接地址和模型授权信息位于默认折叠的“高级设置”。全局账号入口位于左下角。本地空间使用桌面已有数据目录，与企业 NAS 分开保存。

部署默认值读取应用私有目录的 `company-defaults.json`（字段 `accountOrigin`、`nasUrl`），也支持部署资源目录中的同名文件；私有配置优先，开发环境可通过 `TUDA_COMPANY_URL`、`TUDA_NAS_URL` 覆盖。Windows 正式构建必须提供两个有效默认地址，打包后核对部署资源内容；旧配置的空地址自动使用默认值，用户已设置的非空地址继续保留。部署地址不写入公共源码。

## 登录与自动领取

1. 主进程产生随机 verifier，仅将 SHA-256 哈希交给 `/api/company/v1/auth/start`。
2. 校验授权地址的 HTTPS origin、路径、应用、请求标识及有效期后，用系统浏览器打开。
3. 员工通过企业钉钉身份验证并确认当前应用，主进程按服务间隔轮询并一次性领取设备会话。
4. 调用 `/session`、`/bootstrap` 和 `/direct-models`，核对 appId、sessionId、organization.id、member.id、subject 及文本配置摘要，校验服务商端点与目录后自动生成模型选项。
5. 首次登录连接默认 NAS；NAS 不可用时提示并进入独立本地空间。空间切换复用公司身份，各自保存画板、素材和对话。

会话、原始 bootstrap 与含文本 Key 的直连配置通过 Electron safeStorage 加密，保存在应用私有目录。渲染层、CLI 普通回执、素材 URL 和 NAS 只得到必要的公开状态。应用启动在线验证，每 120 秒续验；在线正向租约最多 300 秒且不超过设备会话期限。启动不恢复旧运行的租约，网络故障仅沿用剩余租约。退出、撤权、租约到期和文本配置变化取消受影响文本流；新的已校验配置供下一轮调用使用。NAS 存储权限不足保持公司登录及文本能力。网络错误与撤权分开处理，业务文件保留。

## 文本与 Agent

企业员工完成身份核验后，自动领取三个共享文本模型的真实服务商地址与 Key。设备 token 和 `X-Company-App-Id: tuda` 只用于公司接口。模型请求由员工电脑直接访问提供方；渲染层与普通设置不接收真实 Key，Pi SDK 使用占位凭据，由主进程受控 fetch 在固定服务商端点注入实际 Key，模型请求不携带公司设备 Token 或应用鉴权头。

| protocol | 请求路径 | 桌面行为 |
| --- | --- | --- |
| `anthropic-messages` | `/messages` | 适配系统提示、对话、图片参考和原生 SSE |
| `openai-responses` | `/responses` | 适配 instructions/input、多模态输入和原生 SSE |
| `openai-chat-completions` | `/chat/completions` | 复用现有 Chat Completions 传输 |

创作助手和画板右侧对话共用 Pi SDK 原生 Agent 工具循环，由 Tuda 应用层提供授权、模型连接与画板工具。协议适配保留工具说明、结果回执和图片参考；主进程执行通过校验的工具调用。公司会话的 Agent 资源目录与应用私有配置按账号隔离。

模型授权属于当前登录账号，切换个人空间或公司空间后仍可使用；画板、素材、历史和对话的存储随当前空间隔离。

### 直连合同与权限续验

`GET /api/company/v1/direct-models` 仅接受独立 Tuda 设备会话，返回 `contract=2`、`transport=direct`、appId、sessionId、员工/组织、subject、configVersion、默认 model 和 provider 字典。provider 包含 wire_api、服务商 baseURL/apiKey 及模型目录。`GET /session` 保持 contract=1，附加相同 subject/configVersion 和 `authorization={validForSeconds:300,refreshAfterSeconds:120}`。board-only 宿主连接沿用存储权限，不领取文本凭据。

主进程校验身份、期限、摘要、协议、默认模型和 HTTPS 地址，拒绝公司代理地址及设备 Token 冒充服务商 Key。模型调用绑定开始时的账号、配置版本和服务商路径；HTTPS 重定向被拒绝，退出或配置变更取消旧流。加密配置在下次启动需重新在线验证，不能作为离线授权租约。系统加密保护静态副本，本机运行实际持有 Key；第三方长期 Key 的立即失效仍需服务商撤销或轮换。

位置：`electron/company/direct-models.ts` 负责目录校验与公开投影，`account.ts` 负责领取、短期续验和受控 fetch，`desktop.ts` 负责系统加密、账号与存储隔离；`electron/ipc.ts` 为两个 Agent 入口提供相同受控文本传输。Anthropic 的 Pi SDK 连接使用无末尾 `/v1` 的 SDK baseURL，由 SDK 构造 `/v1/messages`；实际请求仍核对配置中的完整 API 路径。

## 生图

桌面内置固定依赖 `@petercjl/toapiscli@0.1.1`，通过 Electron 自带 Node 运行 CLI，再由 CLI 通过 ToAPIs MCP 执行。员工无需另行安装全局工具。

`bootstrap.image` 只包含本人已通过稳定身份核验的凭据。姓名、拼音或文件名不能建立授权绑定。未绑定或未核验时显示未获生图授权，文本模型独立可用。

凭据按账号及凭据修订建立独立的 `TOAPISCLI_CONFIG_DIR`，经 CLI `auth import` 免费验证权限。CLI 凭据文件遵循其用户私有文件合同；原始 bootstrap 使用系统加密存储。凭据不放入所选公司文件夹、NAS、提示词或任务记录。

当前批准模型为 `doubao-seedream-5-5`、`gemini-nano-banana-2.1`、`gpt-image-2.6-sunburst`，实际选项取员工授权子集。每次生成一张；参考图保留原字节。画板尺寸映射为模型的分辨率档位与比例，参考图编辑未指定画幅时从原始字节读取比例，显式尺寸优先；模型不支持的参数明确报错。

桌面关闭 CLI 的独立包自动更新，由桌面版本统一管理依赖。付费任务使用稳定请求身份和私有任务目录；同一请求再次进入适配器时只查询原任务。提交结果不明时保留记录，不自动重新生成。

## 公司存储

### 本地空间

本地空间由桌面独立保存；企业公共空间固定使用 NAS。NAS 失败时员工可切换本地空间继续工作，原企业本地文件夹保留为历史恢复资料。空间切换不自动合并画板与素材。异步操作固定开始时的账号、空间和工作目录，NAS 待同步增量保留在原命名空间。

### NAS

桌面按 `bootstrap.storage.scopes` 中已授予的权限通过 `/storage/token` 领取最长五分钟、`audience=tuda-nas` 的独立存储 token；只读员工请求读权限。NAS 使用自己的服务凭据在线调用 `/storage/introspect`，逐次核对有效性、应用、组织、到期时间与操作 scope。

NAS 只接收画板和素材的存储授权，设备/model token 与 ToAPIs Key 不发送到 NAS。公司云端组织 ID 经过验证后映射到现有 NAS 数据空间，保留原画板。Yjs 协同、保存回执、离线待确认增量和本人撤销沿用原有业务层。

文本模型调用由桌面直连服务商，生图沿用应用内 ToAPIs；公司服务发放身份与授权配置。生成图片在选择 NAS 时上传到 NAS 素材库，生成节点完成操作通过同一协同领域层回写。只读存储授权不能执行写入。

NAS 部署需要三个私有字段：`TUDA_COMPANY_ORIGIN`、`TUDA_COMPANY_ORGANIZATION_ID`、`TUDA_COMPANY_NAS_SERVICE_TOKEN`。服务凭据仅存在云端与 NAS。启用此模式后，NAS 的模型调用接口不接受存储 token。

## 验证

2026-11-13 直连开发验收：

- Tuda 57 项相关测试通过，前后端类型检查、渲染构建及 Mac Dev 主进程/预加载编译通过。覆盖身份和恶意配置拒绝、代理会话迁移、无 Shell 的统一 Agent、租约到期、断网、撤权、退出、配置轮换、凭据占位、协议路径、ToAPIs 与 NAS/宿主隔离。
- Mac Dev 复用已登录会话自动领取直连配置，Claude、DeepSeek Flash 和 DashScope DeepSeek 均真实回复；创作助手完成画板只读工具调用，画板右侧对话读取当前画板并返回三项已授权生图模型。默认选择已恢复为 DashScope DeepSeek。
- ToAPIs 使用实际 Tuda Electron Node 执行 `auth status`，返回已配置；凭据仍在账号私有目录，本轮未提交付费生成。公司会话文件仅含版本和加密载荷，权限为 0600。
- codex-rebuild 配套服务已部署；其独立 9 项测试及公网校验覆盖 Tuda 直连配置、300/120 秒续验、board-only/跨应用/撤销拒绝，并保留 ToAPIs 和 NAS 存储委托。
- 当前 Mac 对 NAS 地址连接超时，桌面提示并使用独立本地空间，公网登录和文本模型继续可用。NAS 桌面实际读写待网络恢复后验收；本轮未发布 Windows 或 npm。

- 新增设备授权、身份与直连端点边界、撤权、原生文本协议、现有 Agent harness、ToAPIs 请求恢复及存储隔离单元测试。
- 桌面离线模拟验证登录、三个文本模型、生图目录、Agent、生成结果读取、公司本地文件夹保存及个人空间隔离；不产生真实模型费用。
- 真实 PostgreSQL 验证存储内省、读写降权、设备 token 拒绝、NAS 模型操作拒绝和图片原字节往返。
- 原 NAS PostgreSQL 协同与持久化集成回归通过。
- 真实 Mac Dev 完成统一钉钉登录，自动领取三个文本模型；原生文件夹选择、本地公司空间及 NAS 存储切换已验证，NAS 原画板可见且协同连接正常。云端三个文本模型与云端到 NAS 的只读授权链路均已真实验证。

验收账号已完成本人 ToAPIs Key 的稳定身份绑定。真实 Mac Dev 已自动导入应用私有凭据，文件权限为 600，内置 CLI 的免费认证及模型目录检查通过，三个批准生图模型均显示已授权。未提交真实生图。Windows 正式交付与真实生成内容分别验收；模拟证据不代表真实生图已经完成。
