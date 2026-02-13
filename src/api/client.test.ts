import { describe, expect, it } from "vitest";
import {
  TTS_WS_RETRY_DELAYS_MS,
  base64ToUint8Array,
  isAudioSsePayload,
  parseSttWsEventPayload,
  parseTtsWsEventPayload,
  parseSseEventPayload,
  getAudioPlaybackGeneration,
  shouldAcceptAudioSeq,
  shouldFallbackToSse,
  stopActiveAudioPlayback,
} from "./client";

describe("parseSseEventPayload", () => {
  it("parses typed SSE JSON payload", () => {
    const payload = parseSseEventPayload(
      'data: {"type":"stt","session_id":"abc","user_text":"merhaba"}',
    );

    expect(payload).toEqual({
      type: "stt",
      session_id: "abc",
      user_text: "merhaba",
    });
  });

  it("supports [DONE] sentinel", () => {
    const payload = parseSseEventPayload("data: [DONE]");
    expect(payload).toEqual({ type: "done" });
  });

  it("returns null for invalid SSE payload", () => {
    const payload = parseSseEventPayload("event: ping");
    expect(payload).toBeNull();
  });
});

describe("base64ToUint8Array", () => {
  it("decodes base64 chunks", () => {
    const bytes = base64ToUint8Array("YWJj");
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
  });
});

describe("isAudioSsePayload", () => {
  it("accepts typed audio events", () => {
    const payload = parseSseEventPayload(
      'data: {"type":"audio","audio":"YWJj","format":"mp3","mime_type":"audio/mpeg"}',
    );

    expect(payload).not.toBeNull();
    expect(isAudioSsePayload(payload!)).toBe(true);
  });

  it("accepts untyped audio events for backward compatibility", () => {
    const payload = parseSseEventPayload(
      'data: {"audio":"YWJj","format":"mp3","mime_type":"audio/mpeg"}',
    );

    expect(payload).not.toBeNull();
    expect(isAudioSsePayload(payload!)).toBe(true);
  });

  it("rejects non-audio events", () => {
    const payload = parseSseEventPayload('data: {"type":"audio_done"}');

    expect(payload).not.toBeNull();
    expect(isAudioSsePayload(payload!)).toBe(false);
  });
});

describe("tts websocket helpers", () => {
  it("parses websocket event payloads", () => {
    const payload = parseTtsWsEventPayload(
      JSON.stringify({ type: "audio", request_id: "r1", seq: 3 }),
    );

    expect(payload).toEqual({
      type: "audio",
      request_id: "r1",
      seq: 3,
    });
  });

  it("ignores duplicate or older sequence ids", () => {
    expect(shouldAcceptAudioSeq(5, 4)).toBe(true);
    expect(shouldAcceptAudioSeq(4, 4)).toBe(false);
    expect(shouldAcceptAudioSeq(3, 4)).toBe(false);
  });

  it("marks retryable websocket errors for SSE fallback", () => {
    const retryableError = Object.assign(new Error("ws failed"), { retryable: true });
    const finalError = Object.assign(new Error("bad payload"), { retryable: false });

    expect(shouldFallbackToSse(retryableError)).toBe(true);
    expect(shouldFallbackToSse(finalError)).toBe(false);
  });

  it("uses configured reconnect delays", () => {
    expect(TTS_WS_RETRY_DELAYS_MS).toEqual([250, 750, 1500]);
  });
});

describe("stt websocket helpers", () => {
  it("parses websocket event payloads", () => {
    const payload = parseSttWsEventPayload(
      JSON.stringify({ type: "partial", seq: 7, text: "merhaba" }),
    );

    expect(payload).toEqual({
      type: "partial",
      seq: 7,
      text: "merhaba",
    });
  });

  it("returns null for invalid payloads", () => {
    expect(parseSttWsEventPayload("{invalid")).toBeNull();
    expect(parseSttWsEventPayload(123)).toBeNull();
  });
});

describe("audio playback stop helpers", () => {
  it("bumps playback generation when stop is requested", () => {
    const before = getAudioPlaybackGeneration();
    stopActiveAudioPlayback();
    const after = getAudioPlaybackGeneration();

    expect(after).toBe(before + 1);
  });
});
