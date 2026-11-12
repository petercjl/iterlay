export type SpaceKind = "personal" | "enterprise";
export type EnterpriseRole = "admin" | "editor" | "viewer";
export interface EnterpriseMember { id: string; name: string; role: EnterpriseRole }
export interface EnterprisePresence extends EnterpriseMember {
  connectionId: string;
  boardId?: string;
  cursor?: { x: number; y: number };
  selectedNodeIds?: string[];
}
export interface EnterpriseStatus {
  accountMode?: "shared";
  storageKind?: "nas" | "local";
  localFolder?: string;
  storageUrl?: string;
  nasPendingWrites?: number;
  textModels?: number;
  imageModels?: number;
  imageConfigured?: boolean;
  imageReason?: string;
  configVersion?: string;
  configured: boolean;
  serverUrl: string;
  activeSpace: SpaceKind;
  authenticated: boolean;
  organizationName?: string;
  user?: EnterpriseMember;
  connected: boolean;
  pendingWrites: number;
  peers: EnterprisePresence[];
  error?: string;
  history?: { boardId: string; canUndo: boolean; canRedo: boolean };
}
export interface EnterpriseLogin { loginId: string; verifier: string; authorizeUrl: string; expiresAt: string }
export interface EnterpriseSession {
  token: string;
  expiresAt: string;
  organizationId: string;
  organizationName: string;
  user: EnterpriseMember;
}
export const ENTERPRISE_ASSET_PREFIX = "tuda-enterprise:";
export const ENTERPRISE_STATE_EVENT = "enterprise:state";
export const ENTERPRISE_COMMANDS = {
  enterpriseStatus: "enterprise:status",
  configureEnterprise: "enterprise:configure",
  beginEnterpriseLogin: "enterprise:login",
  pollEnterpriseLogin: "enterprise:loginPoll",
  enterpriseLogout: "enterprise:logout",
  selectSpace: "enterprise:selectSpace",
  enterprisePresence: "enterprise:presence"
} as const;

export interface EnterpriseProviderMetadata { enabled: boolean; baseUrl: string; model: string; hasKey: boolean }
export interface EnterpriseProviderAssignment { userId: string; kind: "image" | "text"; enabled: boolean; baseUrl?: string; model?: string; apiKey?: string }
