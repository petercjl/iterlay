# Tuda 企业服务

独立部署的公共画板协同与素材服务。公司身份和模型授权由公网“东轩AI授权”服务负责；桌面通过独立短期存储 token 访问 NAS。架构见 [公司授权与模型能力](../docs/tuda-shared-account-models.md)。

## 配置

新建部署目录，使用 `compose.yaml`，将源码放在 `source/`。在源码目录之外新建 `config/runtime.env`，按 [environment.example](environment.example) 填写，并设置权限 600。

- 设置 `TUDA_COMPANY_ORIGIN` 为公网账号服务的 HTTPS origin、`TUDA_COMPANY_ORGANIZATION_ID` 为授权服务的组织 ID，以及独立 `TUDA_COMPANY_NAS_SERVICE_TOKEN`。三个字段都保存在私有运行配置中。
- 在云端登记 `tuda-nas` audience，并按员工授权 `boards:read/write`、`assets:read/write`。NAS 每次在线内省，无法验证时拒绝存储操作；桌面仍可使用公司本地文件夹。
- `DINGTALK_CORP_ID` 保留现有 NAS 数据空间映射。钉钉应用配置与本人信息权限由共用授权服务管理。
- 数据库密码与 `TUDA_MASTER_KEY` 分别使用独立随机值。主密钥至少 40 个随机字符，恢复时必须保留。

未配置 `TUDA_COMPANY_ORIGIN` 的旧部署保持独立钉钉认证模式，使用自己的 `DINGTALK_CLIENT_ID/SECRET`、`openid corpid`、`Contact.User.Read` 和 `<TUDA_PUBLIC_URL>/auth/dingtalk/callback`。该模式的验收依据见 [历史实现记录](../docs/tuda-enterprise-space-architecture.md)。共用账号模式中的模型调用由桌面与公网服务承担，NAS 存储 token 无权调用旧模型接口。
- `TUDA_DEFAULT_ROLE` 为新成员默认权限，支持 editor、viewer。
- 管理员登录桌面后，可在“企业成员与权限”中为每名员工分配图片/对话服务、模型与密钥。图片接口支持 OpenAI-compatible `/images/generations` 与 `/images/edits`，服务地址通常包含 `/v1`。
- 企业密钥由服务端使用，不需要配置到员工桌面。图片任务提交时冻结员工的服务配置。

正式环境配置 HTTPS/WSS。仅在明确的内网开发环境启用 `TUDA_ALLOW_HTTP_LOGIN=true`；桌面地址与钉钉回调地址应一致。

## 启动

以下命令面向部署维护人员，在部署目录执行：

```bash
docker compose --env-file config/runtime.env build server
docker compose --env-file config/runtime.env up -d
docker compose --env-file config/runtime.env ps
```

默认镜像为 Node 22 bookworm slim。Dockerfile 支持 `NODE_IMAGE` 构建参数，用于经过验证且满足 Node >=22.12 的替代基础镜像。

`storage/postgres` 是独立数据库目录，`storage/assets` 是服务数据目录。容器以 node 用户 UID 1000 运行，素材目录应赋予该用户访问权限。数据库不向宿主机开放端口。API 与 worker 使用同一镜像，worker 通过数据库锁保持唯一运行。

桌面开发可使用 `TUDA_ENTERPRISE_URL` 设定初始服务地址，或在桌面空间菜单中连接；已有服务配置不会被环境变量覆盖。个人 Dev 工作区与正式用户目录隔离。

## 备份与恢复

以具有 Docker 和部署目录权限的账号执行：

```bash
bash source/enterprise/scripts/backup.sh /path/to/deployment
```

备份生成全新快照目录，包含数据库 dump、素材归档、运行配置、Compose、镜像 ID 和 SHA256 清单。运行配置含秘密及解密主密钥，按敏感备份保护。备份不自动删除旧快照。

恢复先核对 SHA256，在临时数据库执行 `pg_restore --exit-on-error` 并验证成员、画板及素材引用。正式恢复时停止 API 和 worker 的写入，另行保留当前数据库与目录恢复点，再恢复数据库、素材和匹配的运行配置。确认应用版本及主密钥一致后启动服务。

## 开发验证

项目根目录使用 Node 22：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:enterprise
pnpm test:enterprise
```

集成测试使用 `TUDA_TEST_POSTGRES_URL` 指向测试用 PostgreSQL 管理连接，默认本机端口 55432。测试创建并删除自己随机命名的独立数据库，不使用部署数据库。`TUDA_TEST_DESKTOP=1` 加启真实双 Electron 桌面验证；测试身份仅由测试进程依赖注入提供，生产服务没有测试登录接口。模型测试使用离线响应，不提交付费任务。
