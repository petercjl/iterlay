# 宿主原生画板插件

宿主安装 `@petercjl/tuda@latest` 到自己的私有运行时目录，读取 `capabilities.json` 的 `nativePlugin` 合同，校验 contract、desktopCompatibility、prepare 与鉴权交接要求，再使用自己的 Node.js 执行 `dist/board-plugin.js`。原生入口无需安装 Skill 或全局 CLI；用户无需手动安装。Tuda 桌面应用独立安装和更新，宿主通过公开连接契约使用它；包不会隐式下载桌面或授予服务权限。首次内置包可作为离线回退。

# Install Tuda for the current Agent

Send your Agent: “Install @petercjl/tuda and its companion Skill for yourself.”

The Agent installs this package, runs `tuda capabilities --json` and `tuda skill source --json`, resolves its own exact `using-tuda` Skill directory, then runs `tuda skill install --target <absolute-directory> --agent <current-agent> --json`. Verify with `skill status` and load the installed Skill using the host’s native discovery. A package install alone is incomplete. Existing unmanaged or edited directories are preserved.

Each selected Skill receives a physical copy of the required bundled CLI under `.runtime/`; it can execute with Node.js 22.12+ independently of the bootstrap npm installation. Canvas operations require Tuda desktop. The package does not grant model access. Installation changes only the selected target. Host discovery is confirmed by the Agent, separately from package installation.
