export interface DesktopDevListener {
  command: string;
  cwd: string | undefined;
}
export function desktopLaunchPlan(root: string, listeners: DesktopDevListener[]): "start" | "reuse";
export function inspectListeners(): DesktopDevListener[];
export function launchDesktopDev(): Promise<void>;
