import { build } from "esbuild";
await build({ entryPoints: ["enterprise/src/main.ts"], outfile: "enterprise/dist/server.js", bundle: true, platform: "node", format: "esm", target: "node22", packages: "external" });
