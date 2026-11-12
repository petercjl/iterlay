# Fork 开发基线

记录日期：2026-11-12。

## 仓库与开发入口

- Fork：<https://github.com/petercjl/iterlay>。
- 上游：<https://github.com/Davied-H/iterlay>，本轮基于提交 `876c03c`。
- `origin` 为 Fork，`upstream` 为原版；定制开发分支为 `dev/desktop-foundation`。
- macOS 日常使用 `pnpm electron:dev` 启动可见桌面应用。
- 桌面开发数据位于项目内 `tmp/desktop-dev/user-data/`，网页开发数据位于 `tmp/browser-dev/user-data/`。正式应用继续使用当前操作系统用户自己的应用数据目录。
- 上游同步在独立分支中进行，完成冲突处理及定制功能验证后再合并。

## 本轮验证

- Electron 主进程 TypeScript 检查通过。
- 桌面开发目录解析的六项测试通过，覆盖默认目录、自定义目录、测试目录优先级、非测试模式、正式包及网页模式隔离。
- 新增 TypeScript 文件通过 ESLint，`git diff --check` 通过。
- macOS 桌面 Dev 应用已启动；通过本机窗口列表与窗口截图确认真实桌面窗口存在。
- CLI 成功连接独立桌面开发工作区，并导入四张仓库 FIELD 示例图片。
- 仓库原有 Electron smoke 测试在“拖动后立即关闭，最终位置应保存”的断言失败；未完成该测试的后续项目。尚未确定为测试操作问题还是应用保存问题，不能据此宣称桌面生命周期验收通过。
- 在网页及桌面 Dev 模式均观察到：CLI 排列返回成功，打开的画板未同步布局，后续保存覆盖 CLI 布局。网页模式已验证先切到其他画板、CLI 排列后再切回可显示排列结果。人和 Agent 同时编辑的同步问题仍待修复。

## Windows 环境

- 已验证项目约定的 Windows 测试机 SSH 连通，架构为 x64；Windows 内核版本 `10.0.17763`。
- 已验证 Node.js `v22.17.0` 与 npm `10.9.2`，存在活动 RDP 桌面会话。
- 当前 SSH 环境未发现 Git、Git Bash 或 pnpm；常用 Git 安装路径也不存在。Windows 构建前需要安装并验证依赖。
- 本轮未构建或发布 Windows 安装包，未完成 Windows 桌面验收。

## npm 分发与更新的责任边界

- 桌面应用负责画板交互、本地数据、更新界面和调用现有更新服务。
- 分发能力负责 npm 版本发现、Windows 产物定位与完整性校验、安装恢复及与应用版本的对应关系。
- 复用现有 `UpdateApiClient`、更新服务与安装驱动接口；最小缺口是 npm 更新源适配及经验证的 Windows 产物发布契约。
- 当前更新源硬编码为原作者的 GitHub Releases，尚未接入我们的 npm 分发渠道。
- `npm-release-kit doctor` 已确认根包仍为私有开发包，缺少 npm 发布工作流及发布访问配置。
- 后续先确定 `@petercjl` 下的分发包身份、产物承载方式、版本渠道和恢复契约，再实现并验证 Windows 更新链路。npm 发布与 Windows 稳定版发布尚未执行。
