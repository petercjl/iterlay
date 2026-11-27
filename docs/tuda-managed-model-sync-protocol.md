# 山海向 Tuda 同步企业模型

## 会话与读取

Tuda 主进程使用现有山海公司设备会话。请求继续使用 Authorization Bearer 设备凭据和 X-Company-App-Id: tuda。山海根据会话确定企业和员工，客户端不提交成员选择参数。管理员的配置入口独立校验企业管理员权限。

GET /api/company/v1/session 可返回 managedModelsVersion（不透明、非空字符串）。存在此字段时，客户端读取 GET /api/company/v1/managed-models。两处版本须一致。山海先原子发布配置，再更新版本。并发发布造成版本不一致时客户端重新读取。尚未部署此功能的旧服务省略 managedModelsVersion。已启用此功能但撤销全量模型时继续发布新版本，并返回四个空目录。

GET /api/company/v1/managed-models 返回现有的 {ok:true,data:...} 外层，响应设置 Cache-Control: no-store。数据结构如下。

```json
{
  "contract": 1,
  "appId": "tuda",
  "sessionId": "<当前设备会话 ID>",
  "organizationId": "<企业 ID>",
  "memberId": "<成员 ID>",
  "configVersion": "<配置版本>",
  "models": {
    "text": {
      "defaultModelId": "writing",
      "items": [
        {
          "id": "writing",
          "name": "写作助手",
          "channels": [
            {
              "id": "writing-primary",
              "name": "企业渠道 A",
              "adapter": "openai-chat-completions",
              "baseUrl": "https://relay.example.invalid/v1",
              "model": "upstream-model-id",
              "apiKey": "<此员工此渠道的凭据>"
            }
          ]
        }
      ]
    },
    "image": {"defaultModelId": null, "items": []},
    "video": {"defaultModelId": null, "items": []},
    "audio": {"defaultModelId": null, "items": []}
  }
}
```

每类最多 50 个模型，每个启用模型有 1–30 条启用渠道。渠道数组的顺序就是调用顺序。模型 ID 在类型内唯一，渠道 ID 在配置内唯一，ID 由 ASCII 字母、数字、连字符和下划线组成（1–96 字符）。同一类型内模型显示名唯一。发布时仅下发启用的条目。默认模型 ID 必须指向该类已发布的模型。空类型用 null。修改名字、顺序和密钥时保留 ID，模型和渠道删除后重建时使用新 ID。

| 类型 | adapter | 其他字段 |
| --- | --- | --- |
| text | openai-chat-completions、openai-responses、anthropic-messages | Base URL 使用对应协议的 API 根地址 |
| image | images、responses、openai-compatible（旧版兼容） | 可选 generationEndpoint、referenceEndpoint、supportsReferenceImages。OpenAI Images 的纯文本生图可另选 imageTaskProtocol、imageTaskEndpoint |
| video | ark、fal、openrouter、minimax、seedance-aipai、seedance-toapis | 可选 modelOption，结构见 shared/contracts/providers.ts 的 VideoProviderModelOption |
| audio | openai-speech | voice、speechEndpoint，缺省为 alloy、/v1/audio/speech |

文本和音频的 Base URL 使用 HTTPS，图片和视频支持 HTTP 与 HTTPS。Base URL 无内嵌凭证、查询串和片段。相对端点以单个斜线开头，限定使用同一服务来源。API Key 按企业、成员、渠道分配，仅进入 Tuda 主进程和所属厂商的请求。日志、普通设置、CLI 配置输出与对话不得暴露密钥或企业连接参数。

## OpenAI Images 生图任务协议

[机器可读协议目录](../shared/contracts/tuda-managed-channel-protocols.json)由 Tuda 维护。OMNI 按版本引入同份目录，桌面配置、账号服务校验与 `omni tuda protocols` 读取该快照。更新目录时按同一版本同步两端，OMNI 保留既有授权与凭据发布流程。

| `imageTaskProtocol` | 渠道契约 |
| --- | --- |
| `sync` | 提交成功后在本次响应的 `data` 中返回图片 |
| `task-id` | 提交返回 `object: "generation.task"` 和 `id`，Tuda 用 GET 查询原任务 |
| `business-id` | 接受请求体的 `client_business_id` 和同值 `Idempotency-Key`。状态接口同时接受服务端任务 ID 和业务 ID，丢失提交回执时可用业务 ID 只读恢复 |

异步状态支持 `queued`、`in_progress`、`completed`、`failed`、`cancelled` 和 `submission_unknown`。完成时通过 `result.data` 或 `response.data` 返回 OpenAI 图片项，每项提供 `url` 或 `b64_json`。默认查询地址为提交路径后追加 ID，也可通过 `imageTaskEndpoint` 配置同源路径模板，例如 `/v1/tasks/{id}`。显式选择协议后，Tuda 按协议执行。省略选择时兼容既有渠道行为。参考图、编辑及 Responses 沿用各自的接口契约。

任务协议和查询路径作为可选字段下发，启用前将受影响设备的 Tuda 升级至支持该协议目录的版本。网关返回格式不在所列协议中时，需要先在 Tuda 增加适配。

## 应用与失效

- Tuda 登录成功、恢复会话及续验时读取配置。「同步模型配置」复用同一读取流程。有效快照经整体校验后一并生效。暂时性网络错误可在既有授权租约内沿用已验证快照。到期、换号、退出、明确撤销或验证失败时，停止提交企业模型请求。
- 个人和企业配置分开存储。企业模型与个人模型同名时分别列出。企业路由只包含其自身渠道。当前渠道确认在受理前拒绝且属于适合换站的错误时，可用原参数提交下一条。结果不明时按原渠道和任务身份核对。
- 图片模型优先采用有可用渠道的本机默认模型，并按该模型的渠道顺序调用。本机默认无可用渠道时，采用已配置的企业默认模型。设置、创作助手和 CLI 使用同一份生效默认配置。
- 山海负责管理员操作、租户隔离、启停、加密存储及厂商密钥轮换。私有化部署可将配置存在企业 NAS 或自有数据库，通过同一山海应用接口提供给 Tuda。
- 对比验收使用模型类型、名称、默认项、渠道顺序、适配器、上游模型、能力和凭据配置状态。密钥值不进入对比报告。

## 山海管理员保存

沿用 GET/POST /v1/enterprise/members/{accountId}/apps/tuda。先 GET 当前应用授权，保留其他授权字段和 revision，将 managedModels 替换为 {enabled, models} 后 POST。管理员可在模型和渠道上分别保存 enabled 字段，排序以数组顺序为准。GET 只返回 keyConfigured。保留已有密钥时可省略 apiKey。更换 Base URL 或适配器时重新提供该渠道的 Key。

同时编辑导致 revision 不一致时，服务端返回 409。管理员刷新后再应用变更。关闭 managedModels.enabled 后发布新版本，设备接口返回四个空目录。
