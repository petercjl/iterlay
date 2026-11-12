import { protocol } from "electron";
import { createAssetResponse } from "./asset-response.js";
import { ASSET_PROTOCOL, type AssetStore } from "./storage/asset-store.js";

// This module must be statically imported by main.ts so registration happens
// before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

/** Registers the opaque-token asset protocol after Electron is ready. */
export async function registerAssetProtocol(assets: AssetStore, enterprise?: (request: Request) => Promise<Response>): Promise<void> {
  if (protocol.isProtocolHandled(ASSET_PROTOCOL)) return;
  protocol.handle(ASSET_PROTOCOL, (request) => {
    if (new URL(request.url).hostname === "enterprise") return enterprise ? enterprise(request) : new Response("Not found", { status: 404 });
    return createAssetResponse(request, (url) => { try {return assets.resolveAssetUrl(url);}catch{return null;} });
  });
}
