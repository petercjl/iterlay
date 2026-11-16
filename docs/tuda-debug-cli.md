# Tuda 调试 CLI

Tuda 的 CLI 包为 `@petercjl/tuda`，可执行名 `tuda`。画板读取与管理沿用已有入口；对话调试通过本机已认证桥接连接创作助手使用的同一个 Pi harness、账号授权、模型与工具，并保存到同一套创作会话存储。

## 当前开发入口

本次扩展已编译到本项目 `cli/dist/main.js`，尚未发布 npm，也没有修改其他宿主已安装的插件。Mac Dev 使用下面的入口；正式安装的 CLI 在后续版本发布后获得这些命令。

```bash
export TUDA_USER_DATA_PATH="/Users/pechen/AI/画板功能/iterlay/tmp/desktop-dev/user-data"
node "/Users/pechen/AI/画板功能/iterlay/cli/dist/main.js" debug chats list --no-launch --json
```

后续示例的 `tuda` 代表所选 CLI 入口。Dev 验证保持上述环境变量，并连接已经运行的唯一 Dev 实例。跨平台代码已实现，本次实际桌面验收为 macOS。

## 对话与过程

```bash
tuda debug chats create --name "调试对话" --json
tuda debug chats send <对话ID> --prompt "只读列出现有画板" --request-id <唯一请求ID> --async --json
tuda debug chats get <对话ID> --json
tuda debug chats events <对话ID> --json
tuda debug chats wait <对话ID> --timeout 120 --json
tuda debug chats result <对话ID> --json
tuda debug chats cancel <对话ID> --json
```

`send` 默认等待；`--async` 返回受理。`get` 返回用户消息、助手回复与可见工具调用；`events` 返回运行事件、流式活动、工具输入输出回执及助手历史。`result` 返回状态和最新回复。过程信息以可见活动和工具执行记录为准。

`waiting` 表示需要显式交互，可先检查 `result` 返回的问题，再根据授权通过 `respond` 提交或拒绝：

```bash
tuda debug chats respond <对话ID> --input '{"interactionId":"问题ID","action":"submit","values":{}}' --json
```

`action=dismiss` 表示拒绝。CLI 不自动同意确认项。超时只结束等待，取消需要再读取状态核对。相同请求 ID 在同一次桌面运行内复用相同结果；重启或结果不明时先查历史。界面会话列表重新加载后显示 CLI 保存的消息，使用独立调试对话以免与用户当前编辑竞争。中断运行保留在会话中供核对。

## 画板与元素

```bash
tuda boards list --json
tuda boards show <画板ID> --json
tuda tools list --json
```

`boards show` 返回画板结构、节点 ID、类型、位置、尺寸、素材路径与连线。指定当前账号和空间中真实存在的 ID。节点的属性按其类型返回。

## 直连证据

```bash
tuda debug network --conversation <对话ID> --json
```

来源为 Node Undici 的实际 HTTP 生命周期事件，记录请求域名、去除 query 的路径、方法、连接对端地址、端口、HTTP 状态及耗时，并关联对话 ID 与请求 ID。仅捕获应用托管的直连文本请求，进程内最多保留最近 500 条，重启清空。凭证、HTTP 头、query、提示词及回复正文不进入网络记录。

记录证明本机 HTTP 客户端连接的目标，不代表能够观察服务商内部转发。空记录不能证明直连。公司登录、授权续验和配置下发仍由公司账号服务承担，与模型推理请求区分。

## 2026-11-13 Mac Dev 验收

- 在真实创作助手中发送标记 `UI_WIRE_20261113` 的只读请求，调用 `list_boards` 后显示 4 个画板并返回 `UI_DIRECT_WIRE_OK`。
- 对话 ID：`64b5f0dd-bb58-4fa8-aaa7-e320eb2715c1`。
- 实际两次 `POST https://dashscope.aliyuncs.com/compatible-mode/v1/responses`，对端 `8.152.159.24:443`，HTTP 均为 200，耗时分别 1543 ms、1566 ms。两次请求对应工具调用及后续回答的 Agent 循环。
- CLI 创建对话 `92b9b6cf-93db-4b03-8696-0cd9d9fa6da5`，发送同类只读测试，读取工具回执并获得 `CLI_DIRECT_WIRE_OK`。创作助手重新进入后显示同一对话及回复。
- CLI 请求同样到 DashScope `/responses`，对端 `39.96.213.166:443`，两次 HTTP 200，1604 ms、1797 ms。
- 通过 `boards show` 读取「桌面端图片比较」4 个图片节点，包含实际尺寸、坐标及素材路径。

这些请求的实际模型目标为 DashScope，不经过公司账号服务的模型代理接口。本次调用未生成付费图片或视频。

## 发布前边界

本次为 Dev 功能验证。独立包结构审计仍报告原有的 CI runner、OIDC 和发布 QA 声明等缺口；本次未调整发布链路或宣称通过正式发布验收。Windows 运行与发布包安装验证单独执行。
