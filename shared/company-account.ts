/** Public company contract. Credentials belong exclusively to the main process. */
export type CompanyTextProtocol =
  "anthropic-messages" | "openai-responses" | "openai-chat-completions";
export interface CompanyIdentity {
  id: string;
  name: string;
}
export interface CompanySession {
  contract: 1;
  appId: "tuda";
  sessionId: string;
  token: string;
  expiresAt: string;
  member: CompanyIdentity;
  organization: CompanyIdentity;
}
export interface CompanyBootstrap {
  contract: 1;
  appId: "tuda";
  sessionId: string;
  configVersion: string;
  member: CompanyIdentity;
  organization: CompanyIdentity;
  text: {
    enabled: boolean;
    reason?: string;
    defaultModel: string | null;
    providers: Array<{
      id: string;
      name: string;
      protocol: CompanyTextProtocol;
      baseUrl: string;
      models: Array<{
        id: string;
        name: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
      }>;
    }>;
  };
  image: {
    enabled: boolean;
    reason?: string;
    adapter?: "toapiscli";
    package?: "@petercjl/toapiscli";
    credential?: {
      schemaVersion: 1;
      site: "cn" | "com";
      apiKey: string;
      label?: string;
    };
    models: string[];
  };
  storage: {
    enabled: boolean;
    reason?: string;
    audience?: "tuda-nas";
    scopes?: string[];
  };
}
export const COMPANY_IMAGE_MODELS = [
  "doubao-seedream-5-5",
  "gemini-nano-banana-2.1",
  "gpt-image-2.6-sunburst",
] as const;
export interface CompanyAccountPublicStatus {
  origin: string;
  authenticated: boolean;
  configVersion?: string;
  organization?: CompanyIdentity;
  member?: CompanyIdentity;
  textModels: number;
  imageModels: number;
  imageReason?: string;
  error?: string;
}
