import { useEffect, useState } from "react";
import { getImageWorkbenchApi, hasImageWorkbenchApi } from "@/lib/image-workbench-api";
import type { EnterpriseStatus } from "@shared/enterprise";

export function useEnterpriseStatus() {
  const [status, setStatus] = useState<EnterpriseStatus | null>(null);
  useEffect(() => {
    if (!hasImageWorkbenchApi()) return;
    const api = getImageWorkbenchApi();
    if (typeof api.enterpriseStatus !== "function") return;
    let alive = true;
    void api.enterpriseStatus().then(value => { if (alive) setStatus(value); }).catch(() => undefined);
    const timer = window.setInterval(() => { void api.enterpriseStatus().then(value => { if (alive) setStatus(value); }).catch(() => undefined); }, 30_000);
    const dispose = api.onEnterpriseState(value => { if (alive) setStatus(value); });
    return () => { alive = false; window.clearInterval(timer); dispose(); };
  }, []);
  return status;
}
