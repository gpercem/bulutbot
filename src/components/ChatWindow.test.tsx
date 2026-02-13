import { describe, expect, it, vi } from "vitest";
import {
  formatDurationMs,
  HOLD_THRESHOLD_MS,
  classifyMicGesture,
  clearPersistedChatState,
  createInitialMessages,
  hasActiveStatus,
  resolveStatusText,
  resolveAssistantPayload,
  shouldAutoListenAfterAudio,
  scrollElementToBottom,
} from "./ChatWindow";

describe("resolveAssistantPayload", () => {
  it("prefers parsed reply text and returns parsed tool calls", () => {
    const payload = resolveAssistantPayload(
      '{"reply":"Yönlendiriyorum","tool_calls":[{"tool":"navigate","url":"?tab=navigate"}]}'
    );

    expect(payload.displayText).toBe("Yönlendiriyorum");
    expect(payload.toolCalls).toEqual([{ tool: "navigate", url: "?tab=navigate" }]);
  });

  it("falls back to raw assistant text when parsing fails", () => {
    const raw = "bu sade bir metin";
    const payload = resolveAssistantPayload(raw);

    expect(payload.displayText).toBe(raw);
    expect(payload.toolCalls).toEqual([]);
  });

  it("keeps UI-safe fallback text when reply field is empty", () => {
    const raw = '{"reply":"","tool_calls":[{"tool":"navigate","url":"/dashboard"}]}';
    const payload = resolveAssistantPayload(raw);

    const finalDisplayText = payload.displayText || raw;
    expect(finalDisplayText).toBe(raw);
    expect(payload.toolCalls).toEqual([{ tool: "navigate", url: "/dashboard" }]);
  });
});

describe("mic gesture classification", () => {
  it("classifies short presses as tap and long presses as hold", () => {
    expect(classifyMicGesture(HOLD_THRESHOLD_MS - 1)).toBe("tap");
    expect(classifyMicGesture(HOLD_THRESHOLD_MS)).toBe("hold");
    expect(classifyMicGesture(HOLD_THRESHOLD_MS + 500)).toBe("hold");
  });
});

describe("restart helpers", () => {
  it("clears persisted chat/session keys", () => {
    const removeItem = vi.fn();
    clearPersistedChatState({ removeItem });
    expect(removeItem).toHaveBeenCalledTimes(3);
    expect(removeItem).toHaveBeenCalledWith("bulut_chat_history");
    expect(removeItem).toHaveBeenCalledWith("bulut_chat_timestamp");
    expect(removeItem).toHaveBeenCalledWith("bulut_session_id");
  });

  it("creates the initial welcome message", () => {
    const messages = createInitialMessages("Bulut");
    expect(messages).toHaveLength(1);
    expect(messages[0].isUser).toBe(false);
    expect(messages[0].text).toContain("Bulut");
  });
});

describe("scroll helper", () => {
  it("keeps message container pinned to bottom", () => {
    const mockEl = { scrollTop: 0, scrollHeight: 540 };
    scrollElementToBottom(mockEl);
    expect(mockEl.scrollTop).toBe(540);
  });
});

describe("status and timer helpers", () => {
  it("formats recording duration as mm:ss", () => {
    expect(formatDurationMs(0)).toBe("00:00");
    expect(formatDurationMs(65_000)).toBe("01:05");
  });

  it("prioritizes status panel text deterministically", () => {
    expect(
      resolveStatusText({
        isBusy: true,
        isRecording: false,
        isTranscribing: true,
        isThinking: false,
        isRenderingAudio: false,
        isPlayingAudio: false,
        isRunningTools: false,
      }),
    ).toBe("Metne dönüştürülüyor");

    expect(
      resolveStatusText({
        isBusy: true,
        isRecording: false,
        isTranscribing: false,
        isThinking: true,
        isRenderingAudio: false,
        isPlayingAudio: false,
        isRunningTools: false,
      }),
    ).toBe("Düşünüyor");

    expect(
      resolveStatusText({
        isBusy: true,
        isRecording: false,
        isTranscribing: false,
        isThinking: false,
        isRenderingAudio: false,
        isPlayingAudio: false,
        isRunningTools: true,
      }),
    ).toBe("Araç çalıştırılıyor");
  });

  it("auto-listens only in accessibility mode after audio", () => {
    expect(shouldAutoListenAfterAudio(true, false, false)).toBe(true);
    expect(shouldAutoListenAfterAudio(false, false, false)).toBe(false);
    expect(shouldAutoListenAfterAudio(true, true, false)).toBe(false);
    expect(shouldAutoListenAfterAudio(true, false, true)).toBe(false);
  });

  it("shows accessibility toggle only when no active status remains", () => {
    const idleFlags = {
      isBusy: false,
      isRecording: false,
      isTranscribing: false,
      isThinking: false,
      isRenderingAudio: false,
      isPlayingAudio: false,
      isRunningTools: false,
    };

    expect(hasActiveStatus(idleFlags, null)).toBe(false);
    expect(hasActiveStatus(idleFlags, "Araç çalıştırılıyor")).toBe(true);
  });
});
