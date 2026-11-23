/** Authentication is required for business IPC in every storage space. */
const LOGIN_COMMANDS = new Set([
  "enterprise:status", "enterprise:login", "enterprise:loginPoll", "enterprise:loginCancel", "enterprise:logout", "enterprise:refreshModels",
  "enterprise:configure"
]);
export function companyLoginCommandAllowed(channel: string, authenticated: boolean): boolean {
  return authenticated || LOGIN_COMMANDS.has(channel) || /^(window:|update:|license:|licensing:)/.test(channel);
}
