# CLI reference

Run `tuda help` and `tuda tools list --json` for the installed version's contract. `--json` prints `{ schemaVersion, ok, data }` or `{ schemaVersion, ok: false, error }`; progress goes to stderr.

```bash
tuda providers list --kind image --json
tuda models list --provider <provider-id> --json
tuda image generate --prompt "A quiet forest" --n 1 --out ./forest.png --json
tuda image edit --input ./forest.png --prompt "Change the season to autumn" --out ./autumn.png --json
tuda tasks get <task-id> --json
tuda tasks wait <task-id> --out ./result.png --json
tuda video generate --prompt "Slow camera movement over the forest" --async --json
tuda tasks wait <video-task-id> --kind video --json
tuda boards list --json
tuda boards show <board-id> --json
tuda call get_board_layout --input '{"boardId":"<board-id>"}' --json
tuda call arrange_images --input '{"boardId":"<board-id>","nodeIds":["<a>","<b>"],"mode":"grid"}' --json
tuda call generate_video --input '{"boardId":"<board-id>","prompt":"Slow camera movement","mode":"generate","referenceImagePaths":["<managed-path>"]}' --json
tuda assets export --path <managed-path> --out ./image.png --json
```

For JSON with shell-sensitive text, construct arguments with your shell's proper escaping. Never interpolate untrusted prompts into executable shell code. Shell-safe argument arrays are preferred when available.

Video and TTS configuration (requires an App version exposing `configure_provider`):

```bash
tuda providers show <provider-id> --json
tuda models set --kind video --provider <provider-id> --model <video-model-id> --json
tuda providers set --kind audio --provider narration --name "Narration" --base-url https://api.openai.com --model gpt-4o-mini-tts --voice nova --api-key-env OPENAI_API_KEY --default --json
tuda providers set --kind audio --provider narration --voice alloy --json
tuda providers default narration --kind audio --json
tuda providers remove narration --kind audio --json
```

`providers set` upserts by ID, generating one when omitted. New video providers require `--type ark|fal|openrouter|minimax`, `--base-url` and `--model`. Audio uses `openai-compatible`, with `--speech-endpoint /v1/audio/speech` by default; the endpoint is relative to the configured base URL. Audio configuration is persisted only; there is no speech-generation command yet. Repeated `--saved-model` replaces the saved list and includes the selected default model. Omitted fields, including credentials, are preserved. Use `--default` to select the service as its kind's default. Built-in official providers cannot be changed.

Credentials are accepted through `--api-key-env <variable>` or piped `--api-key-stdin`; never pass raw keys in arguments or `call --input`. `--clear-api-key` explicitly clears a key. These flags are mutually exclusive. Queries return only credential presence. `--connection-provider <image-provider-id>` reuses a matching fal/OpenRouter image connection for video, and cannot be combined with setting a standalone key. Use `--connection-provider none` to detach first. Configuration does not submit generation or verify remote availability.

`image generate` supports `--provider`, `--model`, `--size`, `--quality`, `--background`, `--style`, `--n`, repeatable `--reference`, `--board`, `--async`, `--request-id` and `--out`. Supported values depend on the App's provider adapter. `models list` returns saved configuration; it does not probe a remote catalogue.

File imports (`--reference`, edit `--input`, and `assets import --input`) accept non-empty files up to 20 MiB (20,971,520 bytes) each. Image/video data URLs have a separate decoded-byte budget; their Base64 text does not use the prompt's 100,000-character allowance. Imports preserve the original bytes without automatic compression. Oversize errors identify the file and byte limit; reduce the file or import it through the App and pass its managed path with `tuda call`. Provider-specific reference limits still apply. The App backend must include this fix; updating only the CLI cannot repair an older App's import validation.

Task states `succeeded` (images) and `completed` (video) indicate a generated result; `failed`, `interrupted` and `cancelled` are unsuccessful terminal states. Poll uncertain tasks rather than resubmitting them. `stop_video_polling` stops this App session's polling only.

`tuda call` exposes the entire native workspace operation catalogue, including board CRUD and layout, image/video generation, references, media import, exports and recoverable image trash. Import image/video operations accept explicit data URLs; they are intended for programmatic callers. Prefer file-based CLI imports in an agent workflow so base64 does not enter the conversation.

Without `--board`, generation uses the default board in Settings → Coding Agent; when unset it reuses or creates `CLI 创作`. An explicit `--board` overrides this preference. A deleted default board causes an error before submission; choose a new default or provide `--board`.

### 本地切图

```sh
tuda image slice --path <受管图片路径> --board <画板ID> --rows 3 --columns 4 --out ./avatars --json
tuda image slice --input ./sheet.png --rows 3 --columns 4 --margin 12 --gap 8 --json
tuda image slice --node <节点ID> --board <画板ID> --crops '[{"x":10,"y":20,"width":300,"height":300}]' --json
```

复用 App 本地切图，不调用模型；保留原图，切片保存为受管 PNG 并加入画板。源参数三选一，宫格与 crops 互斥；每轴最多 8 格、最多 64 个区域。坐标、边距和间距均为原图像素；不自动去底、识别主体或统一输出尺寸。返回 images、crops、nodeIds 和可选 exportedPaths；--out 为目录，已有文件默认不覆盖。高级入口为 `tuda call slice_image --input '<JSON>' --json`，精确 schema 见 tools list。

## Reusable image templates

Use `tuda templates list|show <id>` to inspect custom templates shared with the App. Create with `templates create --name <name> --prompt <fixed-rules>`; update with `templates update <id> --prompt <rules>` (optional `--expected-prompt <previous-rules>`). `--input <JSON-file>` supports structured fields. Saving templates does not call a model.

Use `image generate --template <id> --prompt <run-content>` to reuse fixed rules without editing the template. Edit-mode templates require `image edit --template <id> --input <file> --prompt <instruction>`. Generation retains the source template ID. Raw operations: `list_templates`, `get_template`, `create_template`, `update_template`; `generate_image`/`edit_image` accept `templateId`. Built-in presets are not included. Legacy local templates migrate when the upgraded workspace first opens; keep App and CLI versions aligned.


## Agent conversation debugging

Requires a logged-in desktop with the debug bridge capability. Use this only for an explicitly requested conversation or diagnostic task. Model messages execute the real Tuda Agent and may invoke tools; state the user's authorized scope in the message. The CLI shares the current account, selected storage space, model configuration and creative-assistant conversation store. It does not open a second agent runtime.

```sh
tuda debug chats list --json
tuda debug chats create --name "Connection verification" --json
tuda debug chats send <conversation-id> --prompt "Reply with DIRECT_OK. Do not modify boards or generate media." --request-id <unique-id> --async --json
tuda debug chats get <conversation-id> --json
tuda debug chats events <conversation-id> --json
tuda debug chats wait <conversation-id> --timeout 120 --json
tuda debug chats result <conversation-id> --json
tuda debug network --conversation <conversation-id> --json
tuda debug chats cancel <conversation-id> --json
```

`send` waits by default. `--async` returns acceptance; `wait` polls without submitting another message. `waiting` means an explicit interaction needs a response, not completion. After reviewing the interaction and obtaining the required user authorization, use `debug chats respond <id> --input '{"interactionId":"...","action":"submit","values":{}}'`; use `dismiss` to decline. Cancellation requests stop the run and require a subsequent result check. A timeout ends waiting only. Request IDs deduplicate identical sends within the running desktop; after an uncertain outcome or desktop restart inspect history before sending again.

`get` returns persisted user/assistant messages; `events` returns visible activity, tool receipts, structured interactions and assistant history. Internal model reasoning is not a debugging output contract. CLI-created conversations appear in the creative assistant when its session list reloads; use a separate conversation instead of editing one currently active in the UI. Interrupted runs remain visible on restart.

`debug network` reports actual Node HTTP request metadata, including host, path, peer address, response status and timing. It records only managed direct text calls, keeps the latest 500 requests in desktop memory, and resets on desktop restart. It excludes credentials, headers, query strings, request and response bodies. It is evidence of the local HTTP destination, not a trace of infrastructure behind that provider. Empty results are not proof of direct connection.

Read boards through `boards show <board-id> --json` (including nodes, dimensions, paths and connections); list boards first to resolve IDs. For Mac Dev, supply the existing Dev `--user-data-path <path> --no-launch` on every command. An older desktop without these methods must be upgraded. These methods are not exposed to board-only plugin sessions. Windows runtime validation is separate from Mac Dev verification.
