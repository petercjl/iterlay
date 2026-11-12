# Update Tuda for the current Agent

Send your Agent: “Update @petercjl/tuda and synchronize your companion Skill.”

Resolve the current Agent’s exact `using-tuda` directory. Read `tuda skill status --target <absolute-directory> --json`; if current, reuse it without reinstalling. Otherwise run `tuda update check --json` and, when authorized, `tuda update install --target <absolute-directory> --agent <current-agent> --json`. The update stages an exact npm version, validates and activates the selected target-owned runtime, and preserves a recoverable backup. It leaves the bootstrap installation unchanged and returns the active runtime entry. Use that entry for subsequent operations; a bootstrap package is not the installed runtime authority.

Local edits and unmanaged targets stop the operation. A failed staged update retains its directory for diagnosis; a failed activation restores the previous target. Recheck status and host discovery before reporting completion. Git checkouts update through Git. Offline or advisory update checks do not interrupt canvas work. Desktop releases use the in-app update button and retain local user data.
