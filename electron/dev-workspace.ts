import path from "node:path";

/** Keep visible desktop development separate from installed and browser workspaces. */
export function resolveDesktopDevelopmentUserData(options: {
  isPackaged: boolean;
  isBrowserDev: boolean;
  appPath: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (options.isPackaged || options.isBrowserDev) return undefined;
  const testPath = options.env.ITERLAY_PLAYWRIGHT === "1"
    ? options.env.ITERLAY_E2E_USER_DATA?.trim()
    : undefined;
  return path.resolve(testPath || options.env.ITERLAY_DESKTOP_DEV_USER_DATA?.trim()
    || path.join(options.appPath, "tmp", "desktop-dev", "user-data"));
}
