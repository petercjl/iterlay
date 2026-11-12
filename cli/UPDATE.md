# 宿主原生插件自动更新

`nativePlugin.updates` 是原生入口的更新合同。宿主在启动或新建连接时按24小时持久节流检查 `@petercjl/tuda@latest`，元数据请求最多1500毫秒；使用 npm registry 声明的完整性验证下载，将候选安装到私有不可变版本目录。自动更新限定0.x同minor、1.x以上同major，并校验 native contract、桌面协议与最低版本、准备和鉴权合同。通过验证后原子切换活动指针，新连接使用新版本；已有连接固定原版本。下载、校验或激活失败保留当前版本，离线继续工作。升级桌面合同或不兼容版本由宿主显式迁移。禁用、状态与策略由宿主管理，仅影响该宿主私有安装，不同步其他 Agent。

# Update Tuda for the current Agent

Send your Agent: “Update @petercjl/tuda and synchronize your companion Skill.”

Resolve the current Agent’s exact `using-tuda` directory. Read `tuda skill status --target <absolute-directory> --json`; if current, reuse it without reinstalling. Otherwise run `tuda update check --json` and, when authorized, `tuda update install --target <absolute-directory> --agent <current-agent> --json`. The update stages an exact npm version, validates and activates the selected target-owned runtime, and preserves a recoverable backup. It leaves the bootstrap installation unchanged and returns the active runtime entry. Use that entry for subsequent operations; a bootstrap package is not the installed runtime authority.

Local edits and unmanaged targets stop the operation. A failed staged update retains its directory for diagnosis; a failed activation restores the previous target. Recheck status and host discovery before reporting completion. Git checkouts update through Git. Offline or advisory update checks do not interrupt canvas work. Desktop releases use the in-app update button and retain local user data.
