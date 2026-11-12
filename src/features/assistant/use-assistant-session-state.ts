import { useEffect, useRef, useState } from "react";

import type { AssistantMemoryContextItem } from "@shared/types";

import type { AiAssistantInteractionState, AiAssistantMessage } from "@/components/assistant/AiAssistant";

import { type SceneCollaborationStreamHandle } from "@/lib/scene-collaboration-stream";

export type AssistantIntentSuggestionMode = "contextual" | "divergent";
export interface PendingAssistantInteraction {
  state: AiAssistantInteractionState;
  onConfirm?: () => void;
  onGenerateImmediately?: () => void;
  activityLabel?: string;
  generationActivityLabel?: string;
  dismissMessage?: string;
  agentInteractionId?: string;
}
export function useAssistantSessionState() {
  const [assistantHasUnreadResult, setAssistantHasUnreadResult] = useState(false);
  const [assistantValue, setAssistantValue] = useState("");
  const [assistantStreaming, setAssistantStreaming] = useState(false);
  const [assistantActivity, setAssistantActivity] = useState<string | null>(null);
  const [memorySuggestions, setMemorySuggestions] = useState<AssistantMemoryContextItem[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<AiAssistantMessage[]>([]);
  const [assistantConversationId, setAssistantConversationId] = useState<string>(() => crypto.randomUUID());
  const [assistantInteraction, setAssistantInteraction] = useState<PendingAssistantInteraction | null>(null);
  const assistantStreamRef = useRef<SceneCollaborationStreamHandle | null>(null);
  const assistantBackgroundRequestRef = useRef(false);
  const assistantRequestVersionRef = useRef(0);
  const assistantApplyTimerRef = useRef<number | null>(null);
  const assistantAutoPromptTimerRef = useRef<number | null>(null);
  const assistantReferenceSignatureRef = useRef("");
  const assistantAnalyzedContextSignatureRef = useRef("");
  const assistantSubmittedContextSignatureRef = useRef("");
  const pendingAssistantReferenceCountRef = useRef(0);
  const assistantPreviousGenerationPromptRef = useRef("");
  const assistantClarificationRoundsRef = useRef(0);
  const sendAssistantInstructionRef = useRef<(
    instruction: string,
    displayContent?: string,
    clearComposer?: boolean,
    showUserMessage?: boolean,
    background?: boolean
  ) => Promise<void>>(async () => { });
  const assistantBranchSignatureRef = useRef<string | null>(null);
  useEffect(() => () => {
    assistantRequestVersionRef.current++;
    assistantStreamRef.current?.dispose();
    assistantStreamRef.current = null;
    for (const timer of [assistantApplyTimerRef, assistantAutoPromptTimerRef]) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  return {
    assistantHasUnreadResult,
    setAssistantHasUnreadResult,
    assistantValue,
    setAssistantValue,
    assistantStreaming,
    setAssistantStreaming,
    assistantActivity,
    setAssistantActivity,
    memorySuggestions,
    setMemorySuggestions,
    assistantMessages,
    setAssistantMessages,
    assistantConversationId,
    setAssistantConversationId,
    assistantInteraction,
    setAssistantInteraction,
    assistantStreamRef,
    assistantBackgroundRequestRef,
    assistantRequestVersionRef,
    assistantApplyTimerRef,
    assistantAutoPromptTimerRef,
    assistantReferenceSignatureRef,
    assistantAnalyzedContextSignatureRef,
    assistantSubmittedContextSignatureRef,
    pendingAssistantReferenceCountRef,
    assistantPreviousGenerationPromptRef,
    assistantClarificationRoundsRef,
    sendAssistantInstructionRef,
    assistantBranchSignatureRef
  };
}
