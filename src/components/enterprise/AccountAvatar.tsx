import { useState } from "react";
export function AccountAvatar({name, url}: {name: string; url?: string}) {
  const [failed, setFailed] = useState("");
  return <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-500/10 text-sm font-medium text-blue-600">
    {url && failed !== url ? <img className="h-full w-full object-cover" alt={`${name}的钉钉头像`} src={url} referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : Array.from(name)[0]}
  </span>;
}
