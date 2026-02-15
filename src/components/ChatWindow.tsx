import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { BulutRuntimeConfig } from "../index";
import {
  agentTextChatStream,
  agentVoiceChatStream,
  agentResumeStream,
  startSttWebSocketStream,
  stopActiveAudioPlayback,
  speakText,
  type AudioStreamState,
  type StreamController,
  type AgentToolCallInfo,
  type SttWsController,
} from "../api/client";
import {
  executeSingleToolCall,
  parseAgentResponse,
  getPendingAgentResume,
  clearPendingAgentResume,
  type ToolCallWithId,
} from "../agent/tools";
import { getPageContext } from "../agent/context";
import {
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  POSITION_BOTTOM,
  POSITION_RIGHT,
  COLORS,
  TRANSITIONS,
  BORDER_RADIUS,
  SHADOW,
} from "../styles/constants";
import {
  logoContent,
  arrowPathIconContent,
  commandLineIconContent,
  cursorArrowRaysIconContent,
  faceSmileIconContent,
  handRaisedIconContent,
  mapIconContent,
  microphoneOutlineIconContent,
  queueListIconContent,
  stopOutlineIconContent,
  xMarkIconContent,
} from "../assets";
import { StreamingJsonParser } from "../utils/streamingJson";
import { playCue, type SfxName } from "../audio/sfxManager";
import { SvgIcon } from "./SvgIcon";

export interface ChatWindowHandle {
  startRecording: () => void;
  cancelRecording: () => void;
  stopTask: () => void;
}

interface ChatWindowProps {
  onClose: () => void;
  config: BulutRuntimeConfig;
  accessibilityMode?: boolean;
  onAccessibilityToggle?: () => void;
  hidden?: boolean;
  actionsRef?: { current: ChatWindowHandle | null };
  onRecordingChange?: (recording: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onPreviewChange?: (text: string | null) => void;
}

interface Message {
  id: number;
  text: string;
  isUser: boolean;
  /** "message" (default) | "tool" for tool call indicators */
  type?: "message" | "tool";
  toolKind?: "context" | "cursor" | "scroll" | "navigate" | "form" | "interact" | "unknown";
  toolLabel?: string;
  toolCount?: number;
}

type RecordingMode = "vad" | "press";

type StorageLike = {
  removeItem: (key: string) => void;
};

const STORAGE_KEY = "bulut_chat_history";
const TIMESTAMP_KEY = "bulut_chat_timestamp";
const SESSION_ID_KEY = "bulut_session_id";
const TTL_MS = 5 * 60 * 1000;
const VAD_THRESHOLD = 0.06;
const SILENCE_DURATION_MS = 500;
const ACCESSIBILITY_MIN_SPEECH_DURATION_MS = 1500;
export const HOLD_THRESHOLD_MS = 250;

const STATUS_LABELS = {
  ready: "Hazır",
  loading: "Bir saniye",
  micInitializing: "Mikrofonu hazırlıyorum",
  listening: "Sizi dinliyorum",
  accessibilityActive: "Erişilebilirlik Aktif",
  transcribing: "Düşünüyorum",
  thinking: "Düşünüyorum",
  playingAudio: ".",
  runningTools: "Siteyle ilgileniyorum",
} as const;

export const getGreetingText = (agentName: string): string =>
  `Merhaba, ben ${agentName}. Bu web sayfasında neler yapalım?`;

export interface StatusFlags {
  isBusy: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  isThinking: boolean;
  isRenderingAudio: boolean;
  isPlayingAudio: boolean;
  isRunningTools: boolean;
}

export const resolveStatusText = (flags: StatusFlags): string => {
  if (flags.isRecording) return STATUS_LABELS.listening;
  if (flags.isRunningTools) return STATUS_LABELS.runningTools;
  if (flags.isPlayingAudio) return STATUS_LABELS.playingAudio;
  if (flags.isThinking) return STATUS_LABELS.thinking;
  if (flags.isTranscribing) return STATUS_LABELS.transcribing;
  if (flags.isBusy) return STATUS_LABELS.loading;
  return STATUS_LABELS.ready;
};

export const hasActiveStatus = (
  flags: StatusFlags,
  statusOverride: string | null,
): boolean =>
  Boolean(
    statusOverride
    || flags.isBusy
    || flags.isRecording
    || flags.isTranscribing
    || flags.isThinking
    || flags.isRenderingAudio
    || flags.isPlayingAudio
    || flags.isRunningTools,
  );

export const formatDurationMs = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

export const classifyMicGesture = (
  durationMs: number,
  thresholdMs: number = HOLD_THRESHOLD_MS,
): "tap" | "hold" => (durationMs >= thresholdMs ? "hold" : "tap");

export const createInitialMessages = (agentName: string): Message[] => [
  {
    id: 1,
    text: getGreetingText(agentName),
    isUser: false,
  },
];

export const clearPersistedChatState = (storage: StorageLike | null): void => {
  if (!storage) {
    return;
  }

  storage.removeItem(STORAGE_KEY);
  storage.removeItem(TIMESTAMP_KEY);
  storage.removeItem(SESSION_ID_KEY);
};

export const scrollElementToBottom = (
  element: { scrollTop: number; scrollHeight: number } | null,
): void => {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
};

const normalizeError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return "Bilinmeyen hata";
};

const getNextMessageId = (messages: Message[]): number => {
  const maxId = messages.reduce((acc, message) => Math.max(acc, message.id), 0);
  return maxId + 1;
};

export interface AssistantPayloadResolution {
  displayText: string;
  toolCalls: ReturnType<typeof parseAgentResponse>["toolCalls"];
}

export const resolveAssistantPayload = (
  assistantText: string,
): AssistantPayloadResolution => {
  const parsed = parseAgentResponse(assistantText);
  return {
    displayText: parsed.reply || assistantText,
    toolCalls: parsed.toolCalls,
  };
};

export const shouldAutoListenAfterAudio = (
  accessibilityMode: boolean,
  expectsReply: boolean,
  isRecording: boolean,
  isBusy: boolean,
): boolean => (accessibilityMode || expectsReply) && !isRecording && !isBusy;

export const shouldAcceptVadSpeech = (
  speechDurationMs: number,
  enforceMinSpeechDuration: boolean,
  minSpeechDurationMs: number = ACCESSIBILITY_MIN_SPEECH_DURATION_MS,
): boolean => !enforceMinSpeechDuration || speechDurationMs >= minSpeechDurationMs;

interface ToolIndicatorMessage {
  text: string;
  kind: "context" | "cursor" | "scroll" | "navigate" | "form" | "interact" | "unknown";
}

const getToolIndicatorMessage = (
  call: AgentToolCallInfo,
): ToolIndicatorMessage => {
  if (call.tool === "getPageContext") {
    return { text: "Algılama", kind: "context" };
  }
  if (call.tool === "scroll") {
    return { text: "Kaydırma", kind: "scroll" };
  }
  if (call.tool === "navigate") {
    const url = typeof call.args.url === "string" ? call.args.url.trim() : "";
    return {
      text: url ? `Sayfa Geçişi: ${url}` : "Sayfa Geçişi",
      kind: "navigate",
    };
  }
  if (call.tool === "interact" && call.args.action === "move") {
    return { text: "Serbest İmleç", kind: "cursor" };
  }
  if (call.tool === "interact" && call.args.action === "type") {
    return { text: "Form Doldurma", kind: "form" };
  }
  if (call.tool === "interact" && call.args.action === "submit") {
    return { text: "Form Gönderme", kind: "form" };
  }
  if (call.tool === "interact" && call.args.action === "click") {
    return { text: "Tıklama", kind: "interact" };
  }
  if (call.tool === "interact") {
    return { text: "Etkileşim", kind: "interact" };
  }
  return {
    text: call.tool || "Araç",
    kind: "unknown",
  };
};

export const ChatWindow = ({
  onClose,
  config,
  accessibilityMode = false,
  onAccessibilityToggle,
  hidden = false,
  actionsRef,
  onRecordingChange,
  onBusyChange,
  onPreviewChange,
}: ChatWindowProps) => {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      const timestamp = localStorage.getItem(TIMESTAMP_KEY);

      if (saved && timestamp) {
        const timePassed = Date.now() - parseInt(timestamp, 10);
        if (timePassed < TTL_MS) {
          try {
            return JSON.parse(saved) as Message[];
          } catch {
            // Ignore parse error and continue with default.
          }
        } else {
          clearPersistedChatState(localStorage);
        }
      }
    }

    return createInitialMessages(config.agentName);
  });

  const [isBusy, setIsBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isRenderingAudio, setIsRenderingAudio] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isRunningTools, setIsRunningTools] = useState(false);
  const [isMicPending, setIsMicPending] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const statusFlags: StatusFlags = {
    isBusy,
    isRecording,
    isTranscribing,
    isThinking,
    isRenderingAudio,
    isPlayingAudio,
    isRunningTools,
  };
  const resolvedStatusText = resolveStatusText(statusFlags);
  const showStatus = hasActiveStatus(statusFlags, statusOverride);
  const statusText = showStatus ? (statusOverride ?? resolvedStatusText) : STATUS_LABELS.ready;

  const isBusyRef = useRef(isBusy);
  const isRecordingRef = useRef(isRecording);

  const nextMessageIdRef = useRef(getNextMessageId(messages));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const activeStreamControllerRef = useRef<StreamController | null>(null);
  const sessionIdRef = useRef<string | null>(
    typeof localStorage !== "undefined"
      ? (() => {
          const ts = localStorage.getItem(TIMESTAMP_KEY);
          if (ts && Date.now() - parseInt(ts, 10) < TTL_MS) {
            return localStorage.getItem(SESSION_ID_KEY);
          }
          return null;
        })()
      : null,
  );

  const silenceStartRef = useRef<number | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const discardNextRecordingRef = useRef(false);

  const micPressStartRef = useRef<number | null>(null);
  const micHoldTimeoutRef = useRef<number | null>(null);
  const micHoldTriggeredRef = useRef(false);
  const recordingModeRef = useRef<RecordingMode | null>(null);
  const pendingStopAfterStartRef = useRef(false);
  const startRecordingPendingRef = useRef(false);

  const assistantMessageIdRef = useRef<number | null>(null);
  const assistantTextBufferRef = useRef("");
  const transcriptionReceivedRef = useRef(false);
  const assistantDoneReceivedRef = useRef(false);

  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingTimerIntervalRef = useRef<number | null>(null);

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);

  const pendingUserTextRef = useRef<string | null>(null);
  const pendingAssistantTextRef = useRef<string>("");
  const streamingJsonParserRef = useRef<StreamingJsonParser | null>(null);
  const awaitingAssistantResponseRef = useRef(false);
  const activeSttWsRef = useRef<SttWsController | null>(null);
  const liveTranscriptionMessageIdRef = useRef<number | null>(null);
  const liveTranscriptionTextRef = useRef("");
  const autoListenSuppressedRef = useRef(false);
  const expectsReplyRef = useRef(true);
  const requestEpochRef = useRef(0);
  const sttSendCuePlayedRef = useRef(false);

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Report state changes to parent
  useEffect(() => { onRecordingChange?.(isRecording); }, [isRecording]);
  useEffect(() => { onBusyChange?.(isBusy); }, [isBusy]);

  // Derive and report preview text to parent
  useEffect(() => {
    if (!onPreviewChange) return;
    if (isRecording) {
      onPreviewChange(statusOverride ?? STATUS_LABELS.listening);
      return;
    }
    // When audio is rendering/playing, show the actual message text
    if (isRenderingAudio || isPlayingAudio) {
      const lastAssistant = [...messages].reverse().find(m => !m.isUser && m.type !== "tool");
      onPreviewChange(lastAssistant?.text ?? getGreetingText(config.agentName));
      return;
    }
    if (showStatus) {
      const st = statusOverride ?? resolveStatusText({
        isBusy,
        isRecording,
        isTranscribing,
        isThinking,
        isRenderingAudio,
        isPlayingAudio,
        isRunningTools,
      });
      onPreviewChange(st);
      return;
    }
    // Show last assistant message (or greeting)
    const lastAssistant = [...messages].reverse().find(m => !m.isUser && m.type !== "tool");
    onPreviewChange(lastAssistant?.text ?? getGreetingText(config.agentName));
  }, [
    isRecording,
    isBusy,
    isTranscribing,
    isThinking,
    isRunningTools,
    isPlayingAudio,
    isRenderingAudio,
    statusOverride,
    showStatus,
    messages,
  ]);

  const playSfx = (name: SfxName) => {
    playCue(name);
  };

  const beginRequestEpoch = () => {
    requestEpochRef.current += 1;
    return requestEpochRef.current;
  };

  const invalidateRequestEpoch = () => {
    requestEpochRef.current += 1;
  };

  const isCurrentRequestEpoch = (epoch: number): boolean =>
    requestEpochRef.current === epoch;

  const playSttSentCueOnce = () => {
    if (sttSendCuePlayedRef.current) {
      return;
    }
    sttSendCuePlayedRef.current = true;
    playSfx("sent");
  };

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      localStorage.setItem(TIMESTAMP_KEY, Date.now().toString());
    }
  }, [messages]);

  const scrollMessagesToBottom = () => {
    scrollElementToBottom(messagesContainerRef.current);
  };

  useLayoutEffect(() => {
    scrollMessagesToBottom();
  }, [messages, statusText, isBusy, isRecording]);

  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      scrollMessagesToBottom();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const stopRecordingTimer = () => {
    if (recordingTimerIntervalRef.current !== null) {
      window.clearInterval(recordingTimerIntervalRef.current);
      recordingTimerIntervalRef.current = null;
    }
    recordingStartedAtRef.current = null;
  };

  const startRecordingTimer = () => {
    stopRecordingTimer();
    recordingStartedAtRef.current = Date.now();
    setRecordingDurationMs(0);

    recordingTimerIntervalRef.current = window.setInterval(() => {
      const startedAt = recordingStartedAtRef.current;
      if (startedAt === null) {
        setRecordingDurationMs(0);
        return;
      }
      setRecordingDurationMs(Date.now() - startedAt);
    }, 200);
  };

  const resetProcessingFlags = () => {
    setIsTranscribing(false);
    setIsThinking(false);
    setIsRenderingAudio(false);
    setIsPlayingAudio(false);
    setIsRunningTools(false);
    setStatusOverride(null);
    assistantMessageIdRef.current = null;
    assistantTextBufferRef.current = "";
    transcriptionReceivedRef.current = false;
    assistantDoneReceivedRef.current = false;
    awaitingAssistantResponseRef.current = false;
    pendingUserTextRef.current = null;
    pendingAssistantTextRef.current = "";
  };

  const clearMicHoldTimeout = () => {
    if (micHoldTimeoutRef.current !== null) {
      window.clearTimeout(micHoldTimeoutRef.current);
      micHoldTimeoutRef.current = null;
    }
  };

  const cleanupVAD = () => {
    if (vadIntervalRef.current !== null) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    silenceStartRef.current = null;
  };

  const stopStreamTracks = () => {
    if (!streamRef.current) {
      return;
    }

    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const stopActiveStream = () => {
    if (!activeStreamControllerRef.current) {
      return;
    }

    activeStreamControllerRef.current.stop();
    activeStreamControllerRef.current = null;
  };

  const cancelActiveSttWs = () => {
    const activeSttWs = activeSttWsRef.current;
    activeSttWsRef.current = null;
    activeSttWs?.cancel();
    liveTranscriptionMessageIdRef.current = null;
    liveTranscriptionTextRef.current = "";
  };

  useEffect(
    () => () => {
      invalidateRequestEpoch();
      clearMicHoldTimeout();
      pendingStopAfterStartRef.current = false;

      stopActiveStream();
      stopActiveAudioPlayback();
      cancelActiveSttWs();
      cleanupVAD();
      stopStreamTracks();
      stopRecordingTimer();

      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
        recorderRef.current = null;
      }

      cancelActiveSttWs();
    },
    [],
  );

  // ── Resume agent loop after full-page navigation ────────────────
  useEffect(() => {
    const resumeState = getPendingAgentResume();
    if (!resumeState) return;

    clearPendingAgentResume();
    console.info("[Bulut] Resuming agent after navigation");

    // Restore session ID from resume state
    if (resumeState.sessionId) {
      sessionIdRef.current = resumeState.sessionId;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SESSION_ID_KEY, resumeState.sessionId);
      }
    }

    const requestEpoch = beginRequestEpoch();
    setIsBusy(true);
    isBusyRef.current = true;
    setIsRunningTools(true);
    setStatusOverride(STATUS_LABELS.thinking);

    const freshPageContext = getPageContext().summary;

    const resumeToolExec = async (
      call: AgentToolCallInfo,
    ): Promise<{ call_id: string; result: string }> => {
      const toolCall: ToolCallWithId = {
        tool: call.tool as "navigate" | "getPageContext" | "interact" | "scroll",
        call_id: call.call_id,
        ...call.args,
      } as ToolCallWithId;
      return executeSingleToolCall(toolCall);
    };

    const controller = agentResumeStream(
      config.backendBaseUrl,
      resumeState,
      freshPageContext,
      {
        onSessionId: (sid) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          if (sid && sid !== sessionIdRef.current) {
            sessionIdRef.current = sid;
            if (typeof localStorage !== "undefined") {
              localStorage.setItem(SESSION_ID_KEY, sid);
            }
          }
        },
        onAssistantDelta: (delta) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          setIsRunningTools(false);
          setIsThinking(true);
          setStatusOverride(null);

          pendingAssistantTextRef.current += delta;

          if (assistantMessageIdRef.current === null) {
            assistantMessageIdRef.current = appendMessage(
              pendingAssistantTextRef.current,
              false,
            );
          } else {
            updateMessageText(
              assistantMessageIdRef.current,
              pendingAssistantTextRef.current,
            );
          }
        },
        onAssistantDone: (assistantText, expectsReply) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          playSfx("completed");
          expectsReplyRef.current = expectsReply !== false;
          setStatusOverride(null);
          setIsThinking(false);
          setIsRenderingAudio(true);

          const finalDisplayText =
            assistantText || pendingAssistantTextRef.current;
          pendingAssistantTextRef.current = finalDisplayText;

          if (assistantMessageIdRef.current !== null) {
            updateMessageText(
              assistantMessageIdRef.current,
              finalDisplayText,
            );
          } else {
            assistantMessageIdRef.current = appendMessage(
              finalDisplayText,
              false,
            );
          }
        },
        onIntermediateReply: (text) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          void speakText(
            config.backendBaseUrl, text, config.voice,
            accessibilityMode, (state) => handleAudioStateChange(state, requestEpoch),
          ).catch((err) => console.warn("[Bulut] intermediate TTS failed", err));
        },
        onToolCalls: (calls) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          if (calls.length > 0) {
            playSfx("toolCall");
          }
          setIsRunningTools(true);
          setStatusOverride(STATUS_LABELS.runningTools);
          appendToolIndicatorMessages(calls);

          assistantMessageIdRef.current = null;
          pendingAssistantTextRef.current = "";
        },
        onToolResult: () => {},
        onIteration: () => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          playSfx("thinking");
          setIsThinking(true);
          setStatusOverride(STATUS_LABELS.thinking);
        },
        onAudioStateChange: (state) => {
          handleAudioStateChange(state, requestEpoch);
        },
        onError: (err) => {
          if (!isCurrentRequestEpoch(requestEpoch)) return;
          setStatusOverride(null);
          appendMessage(`Hata: ${err}`, false);
        },
      },
      resumeToolExec,
    );

    activeStreamControllerRef.current = controller;

    controller.done
      .catch(() => {})
      .finally(() => {
        if (!isCurrentRequestEpoch(requestEpoch)) return;
        setIsBusy(false);
        isBusyRef.current = false;
        setIsRunningTools(false);
        setIsThinking(false);
        setIsRenderingAudio(false);
        setIsPlayingAudio(false);
        setStatusOverride(null);
        pendingAssistantTextRef.current = "";
        assistantMessageIdRef.current = null;
        activeStreamControllerRef.current = null;

        if (
          !autoListenSuppressedRef.current &&
          shouldAutoListenAfterAudio(
            accessibilityMode,
            expectsReplyRef.current,
            isRecordingRef.current,
            false,
          )
        ) {
          void startRecording("vad");
        }
        // Reset for next turn
        expectsReplyRef.current = true;
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const appendMessage = (
    text: string,
    isUser: boolean,
    options?: {
      type?: "message" | "tool";
      toolKind?: Message["toolKind"];
      toolLabel?: string;
      toolCount?: number;
    },
  ): number => {
    const id = nextMessageIdRef.current++;
    setMessages((previous) => [
      ...previous,
      {
        id,
        text,
        isUser,
        type: options?.type,
        toolKind: options?.toolKind,
        toolLabel: options?.toolLabel,
        toolCount: options?.toolCount,
      },
    ]);
    return id;
  };

  const appendToolIndicatorMessages = (calls: AgentToolCallInfo[]) => {
    setMessages((previous) => {
      const next = [...previous];

      for (const call of calls) {
        const indicator = getToolIndicatorMessage(call);
        const last = next[next.length - 1];
        const previousToolText = typeof last?.text === "string"
          ? last.text.replace(/\s+\(\d+\)$/, "")
          : "";

        if (
          last
          && !last.isUser
          && last.type === "tool"
          && previousToolText === indicator.text
        ) {
          const extractedCount = Number.parseInt(
            (last.text.match(/\((\d+)\)\s*$/)?.[1] ?? "1"),
            10,
          );
          const safeCurrentCount = Number.isFinite(extractedCount) ? extractedCount : 1;
          const nextCount = safeCurrentCount + 1;
          const baseLabel = previousToolText || indicator.text;
          next[next.length - 1] = {
            ...last,
            toolLabel: baseLabel,
            toolCount: nextCount,
            text: `${baseLabel} (${nextCount})`,
          };
          continue;
        }

        const id = nextMessageIdRef.current++;
        next.push({
          id,
          text: indicator.text,
          isUser: false,
          type: "tool",
          toolKind: indicator.kind,
          toolLabel: indicator.text,
          toolCount: 1,
        });
      }

      // Force-persist messages to localStorage immediately so they
      // survive a full-page navigate that may happen next frame.
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          localStorage.setItem(TIMESTAMP_KEY, Date.now().toString());
        } catch { /* ignore full/blocked storage */ }
      }

      return next;
    });
  };

  const updateMessageText = (id: number, text: string) => {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id ? { ...message, text } : message,
      ),
    );
  };

  const upsertLiveUserTranscription = (text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    liveTranscriptionTextRef.current = normalized;
    if (liveTranscriptionMessageIdRef.current === null) {
      liveTranscriptionMessageIdRef.current = appendMessage(normalized, true);
      return;
    }
    updateMessageText(liveTranscriptionMessageIdRef.current, normalized);
  };

  const clearLiveUserTranscriptionState = () => {
    liveTranscriptionMessageIdRef.current = null;
    liveTranscriptionTextRef.current = "";
  };

  const handleAudioStateChange = (state: AudioStreamState, requestEpoch?: number) => {
    if (typeof requestEpoch === "number" && !isCurrentRequestEpoch(requestEpoch)) {
      return;
    }

    if (state === "rendering") {
      setIsRenderingAudio(true);
      setIsPlayingAudio(false);
      return;
    }

    if (state === "playing") {
      setIsRenderingAudio(false);
      setIsPlayingAudio(true);
      return;
    }

    if (state === "fallback") {
      setIsRenderingAudio(true);
      setIsPlayingAudio(false);
      return;
    }

    if (state === "done") {
      setIsRenderingAudio(false);
      setIsPlayingAudio(false);
      return;
    }

    setIsRenderingAudio(false);
    setIsPlayingAudio(false);
  };

  const finalizeStreamCycle = (requestEpoch?: number) => {
    if (typeof requestEpoch === "number" && !isCurrentRequestEpoch(requestEpoch)) {
      return;
    }

    awaitingAssistantResponseRef.current = false;
    setStatusOverride(null);
    setIsBusy(false);
    isBusyRef.current = false;
    setIsTranscribing(false);
    setIsThinking(false);
    setIsRenderingAudio(false);
    setIsPlayingAudio(false);
    setIsRunningTools(false);
    pendingUserTextRef.current = null;
    pendingAssistantTextRef.current = "";
    assistantMessageIdRef.current = null;
    if (activeStreamControllerRef.current) {
      activeStreamControllerRef.current = null;
    }
    if (
      !autoListenSuppressedRef.current &&
      shouldAutoListenAfterAudio(
        accessibilityMode,
        expectsReplyRef.current,
        isRecordingRef.current,
        false,
      )
    ) {
      console.info("[Bulut] chat-window auto-listen trigger after stream completion");
      void startRecording("vad");
    }
    // Reset for next turn
    expectsReplyRef.current = true;
  };

  const runAgentForUserText = async (userText: string) => {
    if (!config.projectId) {
      appendMessage("Hata: Project ID yapılandırılmamış.", false);
      return;
    }

    const normalizedUserText = userText.trim();
    if (!normalizedUserText) {
      appendMessage("Ses kaydı metne dönüştürülemedi. Lütfen tekrar deneyin.", false);
      return;
    }

    const requestEpoch = beginRequestEpoch();
    setIsBusy(true);
    isBusyRef.current = true;
    setIsTranscribing(false);
    setIsThinking(true);
    setIsRenderingAudio(false);
    setIsPlayingAudio(false);
    setIsRunningTools(false);
    setStatusOverride(STATUS_LABELS.thinking);
    awaitingAssistantResponseRef.current = true;

    try {
      pendingUserTextRef.current = normalizedUserText;
      upsertLiveUserTranscription(normalizedUserText);
      clearLiveUserTranscriptionState();

      stopActiveStream();
      const pageContext = getPageContext().summary;

      const handleToolExecution = async (
        call: AgentToolCallInfo,
      ): Promise<{ call_id: string; result: string }> => {
        const toolCall: ToolCallWithId = {
          tool: call.tool as
            | "navigate"
            | "getPageContext"
            | "interact"
            | "scroll",
          call_id: call.call_id,
          ...call.args,
        } as ToolCallWithId;
        return executeSingleToolCall(toolCall);
      };

      const controller = agentTextChatStream(
        config.backendBaseUrl,
        normalizedUserText,
        config.projectId,
        sessionIdRef.current,
        {
          model: config.model,
          voice: config.voice,
          pageContext,
          accessibilityMode,
        },
        {
          onSessionId: (sid) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            if (sid && sid !== sessionIdRef.current) {
              sessionIdRef.current = sid;
              if (typeof localStorage !== "undefined") {
                localStorage.setItem(SESSION_ID_KEY, sid);
              }
            }
          },
          onAssistantDelta: (delta) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            setIsTranscribing(false);
            setIsThinking(true);
            setIsRunningTools(false);
            if (awaitingAssistantResponseRef.current) {
              awaitingAssistantResponseRef.current = false;
              setStatusOverride(null);
            }

            pendingAssistantTextRef.current += delta;

            if (assistantMessageIdRef.current === null) {
              assistantMessageIdRef.current = appendMessage(
                pendingAssistantTextRef.current,
                false,
              );
            } else {
              updateMessageText(
                assistantMessageIdRef.current,
                pendingAssistantTextRef.current,
              );
            }
          },
          onAssistantDone: (assistantText, expectsReply) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            playSfx("completed");
            expectsReplyRef.current = expectsReply !== false;
            awaitingAssistantResponseRef.current = false;
            setStatusOverride(null);
            setIsThinking(false);
            setIsRenderingAudio(true);

            const finalDisplayText = assistantText || pendingAssistantTextRef.current;
            pendingAssistantTextRef.current = finalDisplayText;

            if (assistantMessageIdRef.current !== null) {
              updateMessageText(
                assistantMessageIdRef.current,
                finalDisplayText,
              );
            } else {
              assistantMessageIdRef.current = appendMessage(
                finalDisplayText,
                false,
              );
            }
          },
          onIntermediateReply: (text) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            void speakText(
              config.backendBaseUrl, text, config.voice,
              accessibilityMode, (state) => handleAudioStateChange(state, requestEpoch),
            ).catch((err) => console.warn("[Bulut] intermediate TTS failed", err));
          },
          onToolCalls: (calls) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            if (calls.length > 0) {
              playSfx("toolCall");
            }
            setIsRunningTools(true);
            setStatusOverride(STATUS_LABELS.runningTools);
            appendToolIndicatorMessages(calls);

            assistantMessageIdRef.current = null;
            pendingAssistantTextRef.current = "";
          },
          onToolResult: () => {},
          onIteration: () => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            playSfx("thinking");
            setIsThinking(true);
            setStatusOverride(STATUS_LABELS.thinking);
          },
          onAudioStateChange: (state) => {
            handleAudioStateChange(state, requestEpoch);
          },
          onError: (err) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            awaitingAssistantResponseRef.current = false;
            setStatusOverride(null);
            appendMessage(`Hata: ${err}`, false);
          },
        },
        handleToolExecution,
      );

      activeStreamControllerRef.current = controller;
      await controller.done;
    } catch (error) {
      if (!isCurrentRequestEpoch(requestEpoch)) return;
      awaitingAssistantResponseRef.current = false;
      setStatusOverride(null);
      if (error instanceof Error) {
        appendMessage(`Hata: ${error.message}`, false);
      }
    } finally {
      finalizeStreamCycle(requestEpoch);
    }
  };

  const handleAudioBlob = async (blob: Blob) => {
    if (!config.projectId) {
      appendMessage("Hata: Project ID yapılandırılmamış.", false);
      return;
    }

    const requestEpoch = beginRequestEpoch();
    setIsBusy(true);
    isBusyRef.current = true;
    setIsTranscribing(true);
    setIsThinking(false);
    setIsRenderingAudio(false);
    setIsPlayingAudio(false);
    setIsRunningTools(false);
    resetProcessingFlags(); // Start fresh
    setStatusOverride(STATUS_LABELS.thinking);
    awaitingAssistantResponseRef.current = true;

    try {
      const fileType = blob.type || "audio/webm";
      const extension = fileType.includes("ogg")
        ? "ogg"
        : fileType.includes("wav")
          ? "wav"
          : fileType.includes("mpeg") || fileType.includes("mp3")
            ? "mp3"
            : "webm";
      const file = new File([blob], `voice-input.${extension}`, {
        type: fileType,
      });

      stopActiveStream();

      const pageContext = getPageContext().summary;

      // Helper: bridge an AgentToolCallInfo to a ToolCallWithId
      const handleToolExecution = async (
        call: AgentToolCallInfo,
      ): Promise<{ call_id: string; result: string }> => {
        const toolCall: ToolCallWithId = {
          tool: call.tool as
            | "navigate"
            | "getPageContext"
            | "interact"
            | "scroll",
          call_id: call.call_id,
          ...call.args,
        } as ToolCallWithId;
        return executeSingleToolCall(toolCall);
      };

      const controller = agentVoiceChatStream(
        config.backendBaseUrl,
        file,
        config.projectId,
        sessionIdRef.current,
        {
          model: config.model,
          voice: config.voice,
          pageContext,
          accessibilityMode,
        },
        {
          onSttRequestSent: () => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            playSttSentCueOnce();
          },
          onTranscription: (data) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            if (data.session_id && data.session_id !== sessionIdRef.current) {
              sessionIdRef.current = data.session_id;
              if (typeof localStorage !== "undefined") {
                localStorage.setItem(SESSION_ID_KEY, data.session_id);
              }
            }

            const normalized = data.user_text.trim();
            if (normalized) {
              const previousUserText = pendingUserTextRef.current;
              pendingUserTextRef.current = normalized;
              if (liveTranscriptionMessageIdRef.current !== null) {
                updateMessageText(liveTranscriptionMessageIdRef.current, normalized);
                clearLiveUserTranscriptionState();
              } else if (previousUserText !== normalized) {
                appendMessage(normalized, true);
              }
            }

            setIsTranscribing(false);
            setIsThinking(true);
            setStatusOverride(STATUS_LABELS.thinking);
          },
          onSessionId: (sid) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            if (sid && sid !== sessionIdRef.current) {
              sessionIdRef.current = sid;
              if (typeof localStorage !== "undefined") {
                localStorage.setItem(SESSION_ID_KEY, sid);
              }
            }
          },
          onAssistantDelta: (delta) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            setIsTranscribing(false);
            setIsThinking(true);
            setIsRunningTools(false);
            if (awaitingAssistantResponseRef.current) {
              awaitingAssistantResponseRef.current = false;
              setStatusOverride(null);
            }

            // Agent returns plain text (not JSON), stream it directly
            pendingAssistantTextRef.current += delta;

            if (assistantMessageIdRef.current === null) {
              assistantMessageIdRef.current = appendMessage(
                pendingAssistantTextRef.current,
                false,
              );
            } else {
              updateMessageText(
                assistantMessageIdRef.current,
                pendingAssistantTextRef.current,
              );
            }
          },
          onAssistantDone: (assistantText, expectsReply) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            playSfx("completed");
            expectsReplyRef.current = expectsReply !== false;
            awaitingAssistantResponseRef.current = false;
            setStatusOverride(null);
            setIsThinking(false);
            setIsRenderingAudio(true);

            const finalDisplayText =
              assistantText || pendingAssistantTextRef.current;

            streamingJsonParserRef.current = null;
            pendingAssistantTextRef.current = finalDisplayText;

            if (assistantMessageIdRef.current !== null) {
              updateMessageText(
                assistantMessageIdRef.current,
                finalDisplayText,
              );
            } else {
              assistantMessageIdRef.current = appendMessage(
                finalDisplayText,
                false,
              );
            }
          },
          onIntermediateReply: (text) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            void speakText(
              config.backendBaseUrl, text, config.voice,
              accessibilityMode, (state) => handleAudioStateChange(state, requestEpoch),
            ).catch((err) => console.warn("[Bulut] intermediate TTS failed", err));
          },
          onToolCalls: (calls) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            if (calls.length > 0) {
              playSfx("toolCall");
            }
            setIsRunningTools(true);
            setStatusOverride(STATUS_LABELS.runningTools);
            appendToolIndicatorMessages(calls);
            assistantMessageIdRef.current = null;
            pendingAssistantTextRef.current = "";
          },
          onToolResult: (_callId, _toolName, _result) => {
            // Tool result sent back to agent automatically.
            // Could display detailed result here if needed.
          },
          onIteration: (_iteration, _maxIterations) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            // Agent started a new reasoning iteration
            playSfx("thinking");
            setIsThinking(true);
            setStatusOverride(STATUS_LABELS.thinking);
          },
          onAudioStateChange: (state) => {
            handleAudioStateChange(state, requestEpoch);
          },
          onError: (err) => {
            if (!isCurrentRequestEpoch(requestEpoch)) return;
            awaitingAssistantResponseRef.current = false;
            setStatusOverride(null);
            appendMessage(`Hata: ${err}`, false);
          },
        },
        handleToolExecution,
      );

      activeStreamControllerRef.current = controller;
      await controller.done;

      // Safety: Ensure messages are flushed if not already
      // (e.g. if audio 'done' event didn't fire for some reason or there was no audio)
      /* if (pendingUserTextRef.current || pendingAssistantTextRef.current) {
         // flushPendingMessages(); // Removed as we stream now
      } */
    } catch (error) {
      if (!isCurrentRequestEpoch(requestEpoch)) return;
      // Error already shown via onError callback — don't duplicate
      awaitingAssistantResponseRef.current = false;
      setStatusOverride(null);
    } finally {
      finalizeStreamCycle(requestEpoch);
    }
  };

  const stopRecording = (options?: { discard?: boolean }) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    if (options?.discard) {
      discardNextRecordingRef.current = true;
    }

    cleanupVAD();
    recorder.stop();
  };

  const setupVAD = (stream: MediaStream, recorder: MediaRecorder) => {
    const AudioCtx =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioCtx) {
      return;
    }

    const context = new AudioCtx();
    audioContextRef.current = context;

    const analyser = context.createAnalyser();
    analyser.fftSize = 256;

    const source = context.createMediaStreamSource(stream);
    sourceRef.current = source;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    silenceStartRef.current = null;
    let speechDetected = false;
    let speechStartedAt: number | null = null;
    const enforceMinSpeechDuration = accessibilityMode;

    vadIntervalRef.current = window.setInterval(() => {
      if (!isRecordingRef.current || recorder.state === "inactive") {
        cleanupVAD();
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (const value of dataArray) {
        sum += value;
      }
      const average = sum / dataArray.length;
      const volume = average / 255;

      if (volume < VAD_THRESHOLD) {
        if (!speechDetected) {
          speechStartedAt = null;
          silenceStartRef.current = null;
          return;
        }

        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now();
          return;
        }

        const silenceDuration = Date.now() - silenceStartRef.current;
        if (speechDetected && silenceDuration > SILENCE_DURATION_MS) {
          stopRecording();
        }
        return;
      }

      silenceStartRef.current = null;
      if (speechStartedAt === null) {
        speechStartedAt = Date.now();
      }

      if (!speechDetected) {
        const speechDuration = Date.now() - speechStartedAt;
        if (shouldAcceptVadSpeech(speechDuration, enforceMinSpeechDuration)) {
          speechDetected = true;
          if (enforceMinSpeechDuration) {
            setStatusOverride(STATUS_LABELS.listening);
          }
        }
      }
    }, 50);
  };

  const startRecording = async (mode: RecordingMode) => {
    if (
      isBusyRef.current ||
      isRecordingRef.current ||
      startRecordingPendingRef.current
    ) {
      return;
    }

    setStatusOverride(STATUS_LABELS.micInitializing);
    setIsMicPending(true);

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatusOverride(null);
      setIsMicPending(false);
      appendMessage("Bu tarayıcıda mikrofon kullanılamıyor.", false);
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setStatusOverride(null);
      setIsMicPending(false);
      appendMessage("Bu tarayıcıda MediaRecorder desteklenmiyor.", false);
      return;
    }

    startRecordingPendingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Use low bitrate for speech — opus handles voice well at 16-24 kbps
      // and produces ~4-5x smaller payloads, speeding up the upload to fal.
      const recorderOptions: MediaRecorderOptions = {
        audioBitsPerSecond: 16_000,
      };

      // Prefer opus-in-ogg (smaller container) → opus-in-webm → browser default
      const preferredMimeTypes = [
        "audio/ogg;codecs=opus",
        "audio/webm;codecs=opus",
        "audio/webm",
      ];
      for (const mime of preferredMimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          recorderOptions.mimeType = mime;
          break;
        }
      }

      const recorder = new MediaRecorder(stream, recorderOptions);
      recorderRef.current = recorder;
      audioChunksRef.current = [];
      clearLiveUserTranscriptionState();
      sttSendCuePlayedRef.current = false;

      const sttMimeType = (recorder.mimeType || recorderOptions.mimeType || "audio/webm")
        .split(";")[0]
        .trim() || "audio/webm";

      const sttWsController = startSttWebSocketStream(
        config.backendBaseUrl,
        {
          projectId: config.projectId,
          sessionId: sessionIdRef.current,
          language: "tr",
          mimeType: sttMimeType,
        },
        {
          onSessionId: (sid) => {
            if (!sid || sid === sessionIdRef.current) {
              return;
            }
            sessionIdRef.current = sid;
            if (typeof localStorage !== "undefined") {
              localStorage.setItem(SESSION_ID_KEY, sid);
            }
          },
          onPartial: ({ text }) => {
            if (!text.trim()) {
              return;
            }
            upsertLiveUserTranscription(text);
          },
        },
      );
      activeSttWsRef.current = sttWsController;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          if (activeSttWsRef.current) {
            void activeSttWsRef.current.pushChunk(event.data).catch((error) => {
              console.warn(
                `[Bulut] STT WS chunk send failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
        }
      };

      recorder.onerror = () => {
        appendMessage("Mikrofon kaydı sırasında bir hata oluştu.", false);
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        isRecordingRef.current = false;
        recordingModeRef.current = null;
        stopRecordingTimer();

        cleanupVAD();
        stopStreamTracks();

        const shouldDiscard = discardNextRecordingRef.current;
        discardNextRecordingRef.current = false;

        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        audioChunksRef.current = [];

        const currentSttWs = activeSttWsRef.current;
        activeSttWsRef.current = null;

        if (shouldDiscard) {
          currentSttWs?.cancel();
          clearLiveUserTranscriptionState();
          setStatusOverride(null);
          return;
        }

        if (blob.size === 0) {
          currentSttWs?.cancel();
          clearLiveUserTranscriptionState();
          setStatusOverride(null);
          appendMessage("Ses kaydı alınamadı. Lütfen tekrar deneyin.", false);
          return;
        }

        setIsTranscribing(true);
        setStatusOverride(STATUS_LABELS.transcribing);

        try {
          if (currentSttWs) {
            playSttSentCueOnce();
            const sttResult = await currentSttWs.stop();
            if (sttResult.session_id && sttResult.session_id !== sessionIdRef.current) {
              sessionIdRef.current = sttResult.session_id;
              if (typeof localStorage !== "undefined") {
                localStorage.setItem(SESSION_ID_KEY, sttResult.session_id);
              }
            }
            if (sttResult.text.trim()) {
              upsertLiveUserTranscription(sttResult.text);
              setStatusOverride(STATUS_LABELS.thinking);
              await runAgentForUserText(sttResult.text);
              return;
            }
          }
        } catch (error) {
          console.warn(
            `[Bulut] STT WS finalization failed, falling back to HTTP POST /chat/stt: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearLiveUserTranscriptionState();
        }

        console.info("[Bulut] Using HTTP POST fallback for STT (streaming WS did not succeed)");
        setStatusOverride(STATUS_LABELS.thinking);
        await handleAudioBlob(blob);
      };

      if (mode === "vad") {
        setupVAD(stream, recorder);
      }

      recorder.start(200);
      recordingModeRef.current = mode;
      setIsRecording(true);
      isRecordingRef.current = true;
      startRecordingTimer();

      setStatusOverride(
        accessibilityMode && mode === "vad"
          ? STATUS_LABELS.accessibilityActive
          : STATUS_LABELS.listening,
      );

      if (pendingStopAfterStartRef.current) {
        pendingStopAfterStartRef.current = false;
        stopRecording();
      }
    } catch (error) {
      const errMsg = normalizeError(error);
      if (errMsg.toLowerCase().includes("permission") || errMsg.toLowerCase().includes("denied")) {
        autoListenSuppressedRef.current = true;
      }
      cancelActiveSttWs();
      setStatusOverride(null);
      appendMessage(`Mikrofon hatası: ${errMsg}`, false);
      cleanupVAD();
      stopStreamTracks();
      pendingStopAfterStartRef.current = false;
      setIsRecording(false);
      isRecordingRef.current = false;
      stopRecordingTimer();
    } finally {
      if (!isRecordingRef.current && !isBusyRef.current) {
        setStatusOverride(null);
      }
      startRecordingPendingRef.current = false;
      setIsMicPending(false);
    }
  };

  const resetMicGesture = () => {
    micPressStartRef.current = null;
    micHoldTriggeredRef.current = false;
    clearMicHoldTimeout();
  };

  const handleMicPointerDown = (
    event: JSX.TargetedPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();

    if (isBusyRef.current) {
      return;
    }

    if (isRecordingRef.current) {
      // In VAD mode, tapping the button cancels; in press mode, it sends
      if (recordingModeRef.current === "vad") {
        stopRecording({ discard: true });
      } else {
        stopRecording();
      }
      return;
    }

    micPressStartRef.current = Date.now();
    micHoldTriggeredRef.current = false;
    clearMicHoldTimeout();

    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No-op.
      }
    }

    micHoldTimeoutRef.current = window.setTimeout(() => {
      if (
        micPressStartRef.current === null ||
        isBusyRef.current ||
        isRecordingRef.current
      ) {
        return;
      }

      micHoldTriggeredRef.current = true;
      void startRecording("press");
    }, HOLD_THRESHOLD_MS);
  };

  const handleMicPointerUp = (
    event: JSX.TargetedPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();

    if (event.currentTarget.releasePointerCapture) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // No-op.
      }
    }

    const startedAt = micPressStartRef.current;
    const wasHold = micHoldTriggeredRef.current;
    resetMicGesture();

    if (startedAt === null) {
      return;
    }

    if (wasHold) {
      if (isRecordingRef.current) {
        stopRecording();
      } else if (startRecordingPendingRef.current) {
        pendingStopAfterStartRef.current = true;
      }
      return;
    }

    const duration = Date.now() - startedAt;
    if (classifyMicGesture(duration) === "tap") {
      void startRecording("vad");
    }
  };

  const handleMicPointerCancel = (
    event: JSX.TargetedPointerEvent<HTMLButtonElement>,
  ) => {
    handleMicPointerUp(event);
  };

  const handleRestart = () => {
    invalidateRequestEpoch();
    sttSendCuePlayedRef.current = false;
    resetMicGesture();
    pendingStopAfterStartRef.current = false;

    stopActiveStream();
    stopActiveAudioPlayback();
    cancelActiveSttWs();

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      stopRecording({ discard: true });
    } else {
      discardNextRecordingRef.current = false;
      cleanupVAD();
      stopStreamTracks();
    }

    stopRecordingTimer();
    setRecordingDurationMs(0);

    clearPersistedChatState(
      typeof localStorage !== "undefined" ? localStorage : null,
    );

    sessionIdRef.current = null;
    const initialMessages = createInitialMessages(config.agentName);
    nextMessageIdRef.current = getNextMessageId(initialMessages);
    setMessages(initialMessages);

    setIsBusy(false);
    isBusyRef.current = false;
    setIsRecording(false);
    isRecordingRef.current = false;
    resetProcessingFlags();
  };

  // Auto-listen when accessibility mode is activated (initial trigger)
  useEffect(() => {
    if (!accessibilityMode || autoListenSuppressedRef.current) return;
    const timer = window.setTimeout(() => {
      if (!isRecordingRef.current && !isBusyRef.current && !startRecordingPendingRef.current && !autoListenSuppressedRef.current) {
        void startRecording("vad");
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [accessibilityMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopTask = () => {
    invalidateRequestEpoch();
    sttSendCuePlayedRef.current = false;
    stopActiveStream();
    stopActiveAudioPlayback();
    cancelActiveSttWs();
    stopRecording({ discard: true });
    cleanupVAD();
    stopStreamTracks();
    resetProcessingFlags();
    setIsBusy(false);
    isBusyRef.current = false;
  };

  // Expose recording actions to parent via actionsRef
  if (actionsRef) {
    actionsRef.current = {
      startRecording: () => {
        autoListenSuppressedRef.current = false;
        void startRecording("vad");
      },
      cancelRecording: () => {
        stopActiveAudioPlayback();
        cancelActiveSttWs();
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== "inactive") {
          stopRecording({ discard: true });
        } else {
          cleanupVAD();
          stopStreamTracks();
        }
      },
      stopTask,
    };
  }

  const windowStyle: { [key: string]: string } = {
    position: "fixed",
    bottom: `${POSITION_BOTTOM}px`,
    right: `${POSITION_RIGHT}px`,
    width: `${WINDOW_WIDTH}px`,
    maxHeight: `${WINDOW_HEIGHT}px`,
    backgroundColor: "hsla(0, 0%, 100%, 1)",
    borderRadius: BORDER_RADIUS.window,
    display: hidden ? "none" : "flex",
    flexDirection: "column",
    overflow: "hidden",
    zIndex: "10000",
    animation: hidden ? "none" : `slideIn ${TRANSITIONS.medium}`,
    boxShadow: accessibilityMode
      ? `inset 0 0 0 2px ${COLORS.primary}, ${SHADOW}`
      : SHADOW,
    fontFamily: "\"Geist\", sans-serif",
  };

  const headerStyle: { [key: string]: string } = {
    padding: "14px 16px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const headerActionsStyle: { [key: string]: string } = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  };

  const headerButtonStyle: { [key: string]: string } = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px",
    borderRadius: "6px",
    color: COLORS.text,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: `color ${TRANSITIONS.fast}, background-color ${TRANSITIONS.fast}`,
  };

  const messagesContainerStyle: { [key: string]: string } = {
    padding: "0px 16px",
    overflowY: "auto",
    flex: "1",
    minHeight: "0",
  };

  const messagesListStyle: { [key: string]: string } = {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  };

  const messageStyle = (isUser: boolean): JSX.CSSProperties => ({
    maxWidth: "84%",
    padding: isUser ? "9px 14px" : "0px 0px",
    borderRadius: BORDER_RADIUS.message,
    fontSize: "14px",
    lineHeight: "140%",
    wordWrap: "break-word",
    whiteSpace: "pre-wrap",
    alignSelf: isUser ? "flex-end" : "flex-start",
    backgroundColor: isUser ? COLORS.messageUser : "",
    color: isUser ? COLORS.messageUserText : "hsla(215, 100%, 5%, 1)",
  });

  const resolveToolIconSrc = (kind: Message["toolKind"]): string => {
    if (kind === "cursor") {
      return cursorArrowRaysIconContent;
    }
    if (kind === "scroll") {
      return handRaisedIconContent;
    }
    if (kind === "navigate") {
      return mapIconContent;
    }
    if (kind === "form") {
      return queueListIconContent;
    }
    if (kind === "interact") {
      return handRaisedIconContent;
    }
    if (kind === "unknown") {
      return commandLineIconContent;
    }
    return faceSmileIconContent;
  };

  const footerStyle: { [key: string]: string } = {
    padding: "10px 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
  };

  const statusPanelStyle: { [key: string]: string } = {
    flex: "1",
    minHeight: "34px",
    borderRadius: "10px",
    color: COLORS.text,
    fontSize: "14px",
    display: "flex",
    alignItems: "center",
    padding: "0 10px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    opacity: "0.7",
  };

  const footerActionsStyle: { [key: string]: string } = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: "0",
  };

  const recordingTimerStyle: { [key: string]: string } = {
    minWidth: "46px",
    fontSize: "12px",
    fontWeight: "700",
    color: COLORS.text,
    textAlign: "right",
  };

  const micFooterButtonStyle: { [key: string]: string } = {
    width: "37px",
    height: "37px",
    borderRadius: "999px",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "#ffffff",
    border: "1px solid hsla(215, 100%, 5%, 0.5)",
    transition: `transform ${TRANSITIONS.fast}`,
  };

  const isVadRecording = isRecording && recordingModeRef.current === "vad";
  const showStopButton = isBusy && !isRecording;
  const hideMicButton = isMicPending && !isRecording;
  const disableMicControl = isBusy;

  return (
    <div className="bulut-chat-window" style={windowStyle}>
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .bulut-header-btn:hover:not(:disabled) {
          color: ${COLORS.text};
        }

        .bulut-footer-btn:hover:not(:disabled) {
          transform: scale(1.04);
        }

        .bulut-header-btn:disabled,
        .bulut-footer-btn:disabled {
          cursor: not-allowed;
          opacity: 0.5;
          transform: none;
        }

        @keyframes bulut-dots {
          0%   { content: '.'; }
          33%  { content: '..'; }
          66%  { content: '...'; }
        }

        .bulut-status-dots::after {
          content: '.';
          animation: bulut-dots 1.2s steps(1) infinite;
          display: inline-block;
          min-width: 12px;
          text-align: left;
        }

        /* Mobile: full-screen chat window */
        @media (max-width: 600px) {
          .bulut-chat-window {
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100% !important;
            max-height: 100% !important;
            height: 100% !important;
            border-radius: 0 !important;
          }
          .bulut-close-btn {
            width: 40px !important;
            height: 40px !important;
            padding: 8px !important;
          }
          .bulut-close-btn svg {
            width: 26px !important;
            height: 26px !important;
          }
        }
      `}</style>

      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <SvgIcon
            src={logoContent}
            title="Bulut Logo"
            style={{ width: "80px", minWidth: "80px", height: "auto", flexShrink: 0 }}
            stripColors={false}
          />
          <span
            style={{
              marginTop: "7px",
              fontSize: "9px",
              color: COLORS.textSecondary,
              opacity: 0.45,
              fontWeight: 400,
              letterSpacing: "0.02em",
              userSelect: "none",
              whiteSpace: "nowrap",
              alignSelf: "flex-end",
            }}
          >
            v{typeof __BULUT_VERSION__ !== "undefined" ? __BULUT_VERSION__ : ""}
          </span>
        </div>
        <div style={headerActionsStyle}>
          <button
            type="button"
            className="bulut-header-btn"
            style={headerButtonStyle}
            onClick={handleRestart}
            aria-label="Sohbeti yeniden başlat"
            title="Sohbeti yeniden başlat"
          >
            <SvgIcon src={arrowPathIconContent} aria-hidden="true" width={22} height={22} />
          </button>

          <button
            type="button"
            className="bulut-header-btn bulut-close-btn"
            style={{
              ...headerButtonStyle,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={onClose}
            aria-label="Sohbeti kapat"
            title="Sohbeti kapat"
          >
            <SvgIcon src={xMarkIconContent} aria-hidden="true" width={22} height={22} />
          </button>
        </div>
      </div>

      <div style={messagesContainerStyle} ref={messagesContainerRef}>
        <div style={messagesListStyle} ref={messagesContentRef}>
          {messages.map((message) => {
            if (message.type === "tool") {
              const toolIconSrc = resolveToolIconSrc(message.toolKind);
              return (
                <div
                  key={message.id}
                  style={{
                    ...messageStyle(false),
                    opacity: "0.7",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <SvgIcon
                    src={toolIconSrc}
                    aria-hidden="true"
                    width={20}
                    height={20}
                    style={{ flexShrink: 0 }}
                  />
                  <span>{message.text}</span>
                </div>
              );
            }

            return (
              <div key={message.id} style={messageStyle(message.isUser)}>
                {message.text}
              </div>
            );
          })}
        </div>
      </div>

      <div style={footerStyle}>
        <div style={{ ...statusPanelStyle, transition: "opacity 0.2s ease-out" }}>
          {showStatus ? (
            <span className="bulut-status-dots" title={statusText}>
              {statusText}
            </span>
          ) : onAccessibilityToggle ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  opacity: "0.6",
                  whiteSpace: "nowrap",
                }}
              >
                Erişilebilirlik
              </span>
              <button
                type="button"
                onClick={onAccessibilityToggle}
                aria-label={
                  accessibilityMode
                    ? "Erişilebilirlik modunu kapat"
                    : "Erişilebilirlik modunu aç"
                }
                style={{
                  width: "36px",
                  height: "20px",
                  borderRadius: "10px",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px",
                  display: "flex",
                  alignItems: "center",
                  backgroundColor: accessibilityMode
                    ? COLORS.primary
                    : "hsla(215, 10%, 75%, 1)",
                  transition: `background-color ${TRANSITIONS.fast}`,
                  flexShrink: "0",
                }}
              >
                <span
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "50%",
                    backgroundColor: "#ffffff",
                    display: "block",
                    transition: `transform ${TRANSITIONS.fast}`,
                    transform: accessibilityMode
                      ? "translateX(16px)"
                      : "translateX(0)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }}
                />
              </button>
            </div>
          ) : null}
        </div>

        <div style={footerActionsStyle}>
          {isRecording ? (
            <span style={recordingTimerStyle}>
              {formatDurationMs(recordingDurationMs)}
            </span>
          ) : null}
          {showStopButton ? (
            <button
              type="button"
              className="bulut-footer-btn"
              style={micFooterButtonStyle}
              onClick={stopTask}
              aria-label="Görevi durdur"
              title="Görevi durdur"
            >
              <SvgIcon
                src={stopOutlineIconContent}
                aria-hidden="true"
                width={22}
                height={22}
                style={{ color: "hsla(215, 100%, 5%, 1)" }}
              />
            </button>
          ) : hideMicButton ? null : (
            <button
              type="button"
              className="bulut-footer-btn"
              style={micFooterButtonStyle}
              onPointerDown={handleMicPointerDown}
              onPointerUp={handleMicPointerUp}
              onPointerCancel={handleMicPointerCancel}
              disabled={disableMicControl}
              aria-label={isVadRecording ? "Kaydı iptal et" : isRecording ? "Kaydı durdur" : "Kaydı başlat"}
              title={
                isVadRecording
                  ? "Kaydı iptal et"
                  : isRecording
                    ? "Kaydı durdur"
                    : "Dokun: VAD, Basılı tut: bırakınca gönder"
              }
            >
              {isVadRecording ? (
                <SvgIcon
                  src={xMarkIconContent}
                  aria-hidden="true"
                  width={22}
                  height={22}
                  style={{ color: "hsla(215, 100%, 5%, 1)"}}
                />
              ) : (
                <SvgIcon
                  src={microphoneOutlineIconContent}
                  aria-hidden="true"
                  width={22}
                  height={22}
                  style={{ color: "hsla(215, 100%, 5%, 1)" }}
                />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
