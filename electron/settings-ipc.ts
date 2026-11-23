import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { AppSettings, AppSettingsPatch, CodexAuthStatus, OnboardingState, OnboardingStatus } from "../shared/types.js";
import { CodexOAuthService } from "./auth/codex-oauth.js";
import { OnboardingStore } from "./storage/onboarding-store.js";
import { SettingsStore } from "./storage/settings-store.js";

import { assertManagedModelRouting, configureProvider, revealLocalModelChannelKey, saveLocalModelRouting } from "./provider-settings.js";
import type { NewModelChannel, SaveModelRoutingInput } from "../shared/contracts/settings.js";
import { isCompanyModelChannel } from "../shared/contracts/providers.js";

type SettingsPayload = AppSettings & { apiKeyByProviderId?: Record<string, string> };

interface SettingsIpcDependencies {
  settings: SettingsStore;
  onboarding: OnboardingStore;
  codexAuth: CodexOAuthService;
  isCompanyAccount?: () => boolean;
  onOnboardingCompleted: (key: string) => void;
  onBoardTrashRetentionChanged: () => void;
  onThemeChanged: (event: IpcMainInvokeEvent, theme: AppSettings["theme"]) => void;
  trackSettingsUpdated: () => void;
}

export function registerSettingsIpc({
  settings,
  onboarding,
  codexAuth,
  isCompanyAccount,
  onOnboardingCompleted,
  onBoardTrashRetentionChanged,
  onThemeChanged,
  trackSettingsUpdated
}: SettingsIpcDependencies): void {
  ipcMain.handle("settings:configureProvider", (_event, input: Record<string, unknown>) => configureProvider(settings, input));
  ipcMain.handle("settings:saveModelRouting", async (_event, input: SaveModelRoutingInput) => {
    await saveLocalModelRouting(settings, input);
    return { ok: true };
  });
  ipcMain.handle("settings:revealLocalModelChannelKey", (_event, kind: NewModelChannel["kind"], providerId: string) =>
    revealLocalModelChannelKey(settings, kind, providerId));
  ipcMain.handle("settings:get", () => {
    const current = settings.getSettings();
    const providerKeyStatus = settings.getKeyStatus();
    const codexAuthStatusByProviderId: Record<string, CodexAuthStatus> = {};
    for (const providerConfig of current.providers) {
      if (providerConfig.type !== "codex-oauth") continue;
      const status = codexAuth.getStatus(providerConfig.id);
      codexAuthStatusByProviderId[providerConfig.id] = status;
      providerKeyStatus[providerConfig.id] = status.state === "connected" || status.state === "refreshing";
    }
    for (const textProvider of current.textProviders) {
      if (textProvider.type !== "codex-oauth") continue;
      const authProviderId = textProvider.authProviderId || textProvider.id;
      const status = codexAuthStatusByProviderId[authProviderId] ?? codexAuth.getStatus(authProviderId);
      codexAuthStatusByProviderId[authProviderId] = status;
      providerKeyStatus[textProvider.id] = status.state === "connected" || status.state === "refreshing";
    }
    return {
      ...current,
      providers: current.providers.map(provider => isCompanyModelChannel(provider.id)
        ? { ...provider, ...(provider.id.includes("/sync/") ? { name: "山海管理" } : {}),
          baseUrl: "", generationEndpoint: "", referenceEndpoint: undefined, apiMode: undefined }
        : provider),
      textProviders: current.textProviders.map(provider => isCompanyModelChannel(provider.id)
        ? { ...provider, ...(provider.id.includes("/sync/") ? { name: "山海管理" } : {}),
          baseUrl: "", protocol: undefined, connectionName: undefined }
        : provider),
      videoProviders: current.videoProviders.map(provider => isCompanyModelChannel(provider.id)
        ? { ...provider, ...(provider.id.includes("/sync/") ? { name: "山海管理" } : {}), baseUrl: "", connectionProviderId: undefined } : provider),
      audioProviders: current.audioProviders?.map(provider => isCompanyModelChannel(provider.id)
        ? { ...provider, ...(provider.id.includes("/sync/") ? { name: "山海管理" } : {}), baseUrl: "", speechEndpoint: "", voice: "" } : provider),
      providerKeyStatus,
      codexAuthStatusByProviderId,
      setupComplete: settings.hasSavedSettings()
    };
  });

  ipcMain.handle("onboarding:get", (_event, legacyState?: OnboardingState) =>
    onboarding.getState(legacyState)
  );
  ipcMain.handle("onboarding:mark", async (_event, key: string, status: OnboardingStatus) => {
    const state = await onboarding.markSeen(key, status);
    if (status === "completed") onOnboardingCompleted(key);
    return state;
  });
  ipcMain.handle("onboarding:clear", (_event, key: string) => onboarding.clearSeen(key));

  ipcMain.handle("settings:save", async (event, payload: SettingsPayload) => {
    await settings.transaction(async () => {
    const current = settings.getSettings();
    const personal = current.personalModelRouting;
    const unchangedProjection = <T>(requested: T, projected: T) => JSON.stringify(requested) === JSON.stringify(projected);
    const imageRouting = personal && unchangedProjection(payload.imageRouting, current.imageRouting)
      ? personal.image : payload.imageRouting;
    const otherModelRouting = personal && unchangedProjection(payload.otherModelRouting, current.otherModelRouting)
      ? personal.other : payload.otherModelRouting;
    assertManagedModelRouting(current, { imageRouting, otherModelRouting });
    await settings.saveSettings({
      providers: payload.providers,
      activeProviderId: payload.activeProviderId,
      imageRouting,
      otherModelRouting,
      textProviders: payload.textProviders,
      activeTextProviderId: payload.activeTextProviderId,
      videoProviders: payload.videoProviders,
      activeVideoProviderId: payload.activeVideoProviderId,
      audioProviders: payload.audioProviders,
      activeAudioProviderId: payload.activeAudioProviderId,
      language: payload.language,
      theme: payload.theme,
      promptDockAutoCollapse: payload.promptDockAutoCollapse ?? false,
      canvasThumbnailPreview: Boolean(payload.canvasThumbnailPreview),
      canvasMinimapVisible: payload.canvasMinimapVisible,
      canvasImageToolbarOnHover: payload.canvasImageToolbarOnHover,
      wechatStickerExportEnabled: payload.wechatStickerExportEnabled,
      copyImageFormat: payload.copyImageFormat,
      boardSmartSuggestionsEnabled: payload.boardSmartSuggestionsEnabled,
      boardAssistantEnabled: payload.boardAssistantEnabled,
      boardAssistantAgentModeEnabled: payload.boardAssistantAgentModeEnabled,
      assistantAgentModeEnabled: payload.assistantAgentModeEnabled,
      piAgentBuiltinTools: payload.piAgentBuiltinTools,
      piAgentTudaTools: payload.piAgentTudaTools,
      piAgentSkillPaths: payload.piAgentSkillPaths,
      piAgentExtensionPaths: payload.piAgentExtensionPaths,
      piAgentCustomSkillPaths: payload.piAgentCustomSkillPaths,
      piAgentCustomExtensionPaths: payload.piAgentCustomExtensionPaths,
      piAgentMaxTurns: payload.piAgentMaxTurns,
      piAgentWebSearchMaxResults: payload.piAgentWebSearchMaxResults,
      boardAssistantAwarenessEnabled: payload.boardAssistantAwarenessEnabled,
      boardAssistantIntentSuggestionsEnabled: payload.boardAssistantIntentSuggestionsEnabled,
      boardAssistantIntentSuggestionCount: payload.boardAssistantIntentSuggestionCount,
      editSmartSuggestionsEnabled: payload.editSmartSuggestionsEnabled,
      memoryEnabled: payload.memoryEnabled,
      memoryUsageLevel: payload.memoryUsageLevel,
      editInfoMode: payload.editInfoMode,
      imageDoubleClickAction: payload.imageDoubleClickAction,
      downloadDirectory: payload.downloadDirectory,
      cliDefaultBoardId: payload.cliDefaultBoardId,
      defaultCodingAgent: payload.defaultCodingAgent,
      versionSeparationMode: payload.versionSeparationMode,
      generateButtonStyle: payload.generateButtonStyle,
      appIcon: payload.appIcon,
      boardTrashRetentionDays: payload.boardTrashRetentionDays
    });
    if (payload.apiKeyByProviderId) {
      for (const [providerId, apiKey] of Object.entries(payload.apiKeyByProviderId)) {
        if (typeof apiKey === "string") settings.setApiKey(providerId, apiKey);
      }
    }
    });
    if (payload.boardTrashRetentionDays !== undefined) onBoardTrashRetentionChanged();
    trackSettingsUpdated();
    onThemeChanged(event, payload.theme);
    if (!isCompanyAccount?.()) codexAuth.retainProviders(new Set(
      [
        ...payload.providers
          .filter((providerConfig) => providerConfig.type === "codex-oauth")
          .map((providerConfig) => providerConfig.id),
        ...payload.textProviders
          .filter((textProvider) => textProvider.type === "codex-oauth")
          .map((textProvider) => textProvider.authProviderId || textProvider.id)
      ]
    ));
    return { ok: true };
  });

  ipcMain.handle("settings:update", async (event, patch: AppSettingsPatch) => {
    await settings.transaction(() => {
      assertManagedModelRouting(settings.getSettings(), patch);
      return settings.updateSettings(patch);
    });
    if (patch.boardTrashRetentionDays !== undefined) onBoardTrashRetentionChanged();
    if (patch.theme) onThemeChanged(event, patch.theme);
    return { ok: true };
  });
}
