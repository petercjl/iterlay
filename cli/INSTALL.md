# Install Tuda for the current Agent

Send your Agent: “Install @petercjl/tuda and its companion Skill for yourself.”

The Agent installs this package, runs `tuda capabilities --json` and `tuda skill source --json`, resolves its own exact `using-tuda` Skill directory, then runs `tuda skill install --target <absolute-directory> --agent <current-agent> --json`. Verify with `skill status` and load the installed Skill using the host’s native discovery. A package install alone is incomplete. Existing unmanaged or edited directories are preserved.

Each selected Skill receives a physical copy of the required bundled CLI under `.runtime/`; it can execute with Node.js 22.12+ independently of the bootstrap npm installation. Canvas operations require Tuda desktop. The package does not grant model access. Installation changes only the selected target. Host discovery is confirmed by the Agent, separately from package installation.
