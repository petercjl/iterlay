# Tuda · 图塔

[中文说明](README.zh-CN.md)

A local desktop infinite canvas for ecommerce visual work. Arrange and compare product images, references and generated assets, manually or through the same structured CLI used by your current Agent.

Customer releases target Windows. macOS provides the desktop development environment. Boards, assets and settings belong to the current OS user and stay on that computer. User-selected model providers handle generation and their own billing.

## Development

Node.js 22.12+, pnpm 10, and Xcode Command Line Tools on macOS.

```bash
pnpm install --frozen-lockfile
npm ci --prefix cli
pnpm electron:dev
```

Desktop development uses `tmp/desktop-dev/user-data/`. `pnpm build` compiles the renderer, Electron services and CLI. Windows installers are built on Windows through `pnpm release --arch x64`.

## Agent integration

Once the npm version is published, ask your current Agent: “Install @petercjl/tuda and its companion Skill for yourself.” The owning package exposes `tuda` and the portable `using-tuda` Skill, with explicit selected-target installation and structured capability discovery.

See [installation](cli/INSTALL.md), [updates](cli/UPDATE.md), [CLI](cli/README.md), [development](docs/tuda-development.md), and the [transformation plan](docs/tuda-transformation-plan.md). Release and actual platform acceptance are recorded separately.

## Attribution

Based on the MIT-licensed [Iterlay project](https://github.com/Davied-H/iterlay). Our [Fork](https://github.com/petercjl/iterlay) retains upstream synchronization. Preserve [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
