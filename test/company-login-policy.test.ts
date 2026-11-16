import { expect, it } from "vitest";
import { companyLoginCommandAllowed } from "../electron/company/login-policy";
it("requires company login for all business operations, including personal storage and Pi", () => {
  for (const channel of ["boards:list", "boards:save", "settings:get", "image:generate", "assistant:collaborate", "pi-agent:resources:list", "enterprise:selectSpace", "enterprise:members"]) expect(companyLoginCommandAllowed(channel, false)).toBe(false);
  for (const channel of ["enterprise:status", "enterprise:login", "enterprise:loginPoll", "enterprise:refreshModels", "enterprise:logout", "update:getState"]) expect(companyLoginCommandAllowed(channel, false)).toBe(true);
  expect(companyLoginCommandAllowed("boards:save", true)).toBe(true);
});
