import {
  savePendingAgentResume,
  clearPendingAgentResume,
  hideAgentCursor,
  type PendingAgentResume,
} from "../agent/tools";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ApiErrorBody {
  detail?: string;
  error?: string;
  message?: string;
}

interface SseEventPayload {
  type?: string;
  session_id?: string;
  user_text?: string;
  assistant_text?: string;
  delta?: string;
  audio?: string;
  format?: string;
  mime_type?: string;
  sample_rate?: number;
  error?: string;
}

interface TtsWsEventPayload {
  type?: string;
  request_id?: string;
  seq?: number;
  audio?: string;
  format?: string;
  mime_type?: string;
  sample_rate?: number;
  error?: string;
  retryable?: boolean;
  last_seq?: number;
}

interface SttWsEventPayload {
  type?: string;
  session_id?: string;
  seq?: number;
  text?: string;
  error?: string;
  retryable?: boolean;
}

export type AudioStreamState = "rendering" | "playing" | "done" | "fallback";
export const TTS_WS_RETRY_DELAYS_MS = [250, 750, 1500];

const BULUT_AUDIO_STOP_EVENT = "bulut:audio-stop";
const activeAudioElements = new Set<HTMLAudioElement>();
let audioPlaybackGeneration = 0;

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Treat host-only values like "api.bulut.lu" as HTTPS absolute URLs.
  return `https://${trimmed}`;
};
const toWebSocketUrl = (baseUrl: string, path: string): string => {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(normalized);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const createRequestId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const parseTtsWsEventPayload = (
  value: unknown,
): TtsWsEventPayload | null => {
  try {
    if (typeof value !== "string") {
      return null;
    }
    return JSON.parse(value) as TtsWsEventPayload;
  } catch {
    return null;
  }
};

export const parseSttWsEventPayload = (
  value: unknown,
): SttWsEventPayload | null => {
  try {
    if (typeof value !== "string") {
      return null;
    }
    return JSON.parse(value) as SttWsEventPayload;
  } catch {
    return null;
  }
};

export const shouldAcceptAudioSeq = (
  incomingSeq: number,
  highestSeqSeen: number,
): boolean => incomingSeq > highestSeqSeen;

export const shouldFallbackToSse = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return Boolean((error as { retryable?: boolean }).retryable);
  }
  return true;
};

const parseErrorBody = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as ApiErrorBody;
    const detail = data.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return data.error || data.message || response.statusText;
  } catch {
    return response.statusText;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const registerActiveAudioElement = (audioElement: HTMLAudioElement): void => {
  activeAudioElements.add(audioElement);
};

const unregisterActiveAudioElement = (audioElement: HTMLAudioElement): void => {
  activeAudioElements.delete(audioElement);
};

const wasPlaybackStoppedAfter = (generationAtStart: number): boolean =>
  audioPlaybackGeneration !== generationAtStart;

export const getAudioPlaybackGeneration = (): number => audioPlaybackGeneration;

export const stopActiveAudioPlayback = (): void => {
  audioPlaybackGeneration += 1;
  const active = Array.from(activeAudioElements);
  for (const audioElement of active) {
    try {
      audioElement.dispatchEvent(new Event(BULUT_AUDIO_STOP_EVENT));
      audioElement.pause();
      audioElement.removeAttribute("src");
      audioElement.load();
    } catch {
      // Ignore playback stop errors.
    }
  }
};

export const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  // Strip potential data URI prefix if present
  const cleanBase64 = base64.replace(/^data:audio\/\w+;base64,/, "");
  const binaryString = atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const createWavHeader = (
  length: number,
  sampleRate: number = 16000,
): Uint8Array<ArrayBuffer> => {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const channels = 1;

  // RIFF chunk descriptor
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + length, true); // file length - 8
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt sub-chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, channels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * channels * 2, true); // ByteRate
  view.setUint16(32, channels * 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, length, true); // Subchunk2Size

  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
};
const waitForPlaybackEnd = async (
  audioElement: HTMLAudioElement,
): Promise<void> => {
  if (audioElement.ended) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const watchdog = window.setInterval(() => {
      if (!audioElement.ended) {
        console.info("[Bulut] playback watchdog: still playing...");
      }
    }, 30000);

    const onEnded = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Ses oynatma hatası oluştu."));
    };

    const onForcedStop = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      window.clearInterval(watchdog);
      audioElement.removeEventListener("ended", onEnded);
      audioElement.removeEventListener("error", onError);
      audioElement.removeEventListener(BULUT_AUDIO_STOP_EVENT, onForcedStop);
    };

    audioElement.addEventListener("ended", onEnded);
    audioElement.addEventListener("error", onError);
    audioElement.addEventListener(BULUT_AUDIO_STOP_EVENT, onForcedStop);
  });
};



const playBufferedAudio = async (
  chunks: Uint8Array<ArrayBuffer>[],
  mimeType: string,
  sampleRate: number = 16000,
  onAudioStateChange?: (state: AudioStreamState) => void,
): Promise<void> => {
  const playbackGeneration = getAudioPlaybackGeneration();
  if (chunks.length === 0) {
    onAudioStateChange?.("done");
    return;
  }

  if (wasPlaybackStoppedAfter(playbackGeneration)) {
    onAudioStateChange?.("done");
    return;
  }

  // Debug info
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  console.log(`[Bulut] Playing buffered audio: ${chunks.length} chunks, ${totalBytes} bytes, type=${mimeType}`);

  onAudioStateChange?.("fallback");

  const blobParts: ArrayBuffer[] = chunks.map((chunk) => {
    const copied = new Uint8Array(chunk.byteLength) as Uint8Array<ArrayBuffer>;
    copied.set(chunk);
    return copied.buffer;
  });

  // Verify magic numbers and detect MIME type
  let detectedMime = mimeType;
  if (chunks.length > 0 && chunks[0].length >= 4) {
    const header = Array.from(chunks[0].slice(0, 4))
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    console.log(`[Bulut] Audio header (hex): ${header}`);

    // Magic number detection
    if (header.startsWith("49 44 33")) { // ID3
      detectedMime = "audio/mpeg";
    } else if (header.startsWith("FF F3") || header.startsWith("FF F2")) { // MP3 Sync
      detectedMime = "audio/mpeg";
    } else if (header.startsWith("52 49 46 46")) { // RIFF (WAV)
      detectedMime = "audio/wav";
    } else if (header.startsWith("1A 45 DF A3")) { // EBML (WebM)
      detectedMime = "audio/webm";
    }
  }

  // Ensure valid MIME type
  // Ensure valid MIME type or wrap raw PCM
  let safeMimeType = detectedMime && detectedMime.includes("/") ? detectedMime : "audio/mpeg";
  let finalBlobParts: BlobPart[] = blobParts;

  if (mimeType === "audio/pcm") {
    // Wrap raw PCM in WAV container
    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const header = createWavHeader(totalLength, sampleRate);
    finalBlobParts = [header.buffer, ...blobParts];
    safeMimeType = "audio/wav";
    console.log(`[Bulut] Wrapped raw PCM in WAV (rate=${sampleRate})`);
  }

  console.log(`[Bulut] Creating blob with type: ${safeMimeType} (original: ${mimeType})`);
  const blob = new Blob(finalBlobParts, { type: safeMimeType });

  const audioElement = new Audio();
  const objectUrl = URL.createObjectURL(blob);

  try {
    registerActiveAudioElement(audioElement);

    audioElement.preload = "auto";
    audioElement.autoplay = true;
    // Some browsers need this
    audioElement.setAttribute("playsinline", "true");
    audioElement.src = objectUrl;

    if (wasPlaybackStoppedAfter(playbackGeneration)) {
      onAudioStateChange?.("done");
      return;
    }

    await audioElement.play();
    onAudioStateChange?.("playing");
    await waitForPlaybackEnd(audioElement);
    onAudioStateChange?.("done");
  } catch (err) {
    console.error(`[Bulut] Playback failed: ${err}`, { mimeType: safeMimeType, size: blob.size });
    onAudioStateChange?.("done"); // Signal done to unblock UI even on error
    throw err;
  } finally {
    unregisterActiveAudioElement(audioElement);
    audioElement.pause();
    audioElement.removeAttribute("src");
    audioElement.load();
    URL.revokeObjectURL(objectUrl);
  }
};

export interface StreamController {
  stop: () => void;
  done: Promise<void>;
}

export const parseSseEventPayload = (eventBlock: string): SseEventPayload | null => {
  const dataLines = eventBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  const dataStr = dataLines.join("\n");
  if (dataStr === "[DONE]") {
    return { type: "done" };
  }

  try {
    return JSON.parse(dataStr) as SseEventPayload;
  } catch (error) {
    console.warn("Error parsing SSE chunk:", error);
    return null;
  }
};

export const isAudioSsePayload = (
  payload: SseEventPayload,
): payload is SseEventPayload & { audio: string } =>
  typeof payload.audio === "string" &&
  (payload.type === undefined || payload.type === "audio");

// ── Separated Endpoint Helpers ──────────────────────────────────────

export async function transcribeAudio(
  baseUrl: string,
  file: File,
  projectId: string,
  sessionId: string | null,
  language: string,
  onRequestSent?: () => void,
): Promise<{ text: string; session_id: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/stt`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("project_id", projectId);
  if (sessionId) formData.append("session_id", sessionId);
  formData.append("language", language);

  const responsePromise = fetch(url, { method: "POST", body: formData });
  onRequestSent?.();
  const response = await responsePromise;
  if (!response.ok) {
    throw new Error(await parseErrorBody(response));
  }
  return response.json();
}

export interface SttWsResult {
  text: string;
  session_id: string;
}

export interface SttWsEvents {
  onRequestSent?: () => void;
  onSessionId?: (sessionId: string) => void;
  onPartial?: (payload: { seq: number; text: string }) => void;
}

export interface SttWsController {
  pushChunk: (chunk: Blob) => Promise<void>;
  stop: () => Promise<SttWsResult>;
  cancel: () => void;
}

export const startSttWebSocketStream = (
  baseUrl: string,
  config: {
    projectId: string;
    sessionId: string | null;
    language?: string;
    mimeType?: string;
  },
  events: SttWsEvents = {},
): SttWsController => {
  const wsUrl = toWebSocketUrl(baseUrl, "/chat/stt/ws");
  console.info("[Bulut] STT WS connecting to", wsUrl);
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  let finalText = "";
  let finalSessionId = config.sessionId || "";
  let stopped = false;
  let settled = false;
  // All chunk sends and the final stop are chained through sendQueue
  // so the "stop" message always follows all enqueued chunks.
  let sendQueue: Promise<void> = Promise.resolve();

  let resolveStart: (() => void) | null = null;
  let rejectStart: ((error: Error & { retryable?: boolean }) => void) | null = null;
  const startPromise = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });

  let resolveDone: ((result: SttWsResult) => void) | null = null;
  let rejectDone: ((error: Error & { retryable?: boolean }) => void) | null = null;
  const donePromise = new Promise<SttWsResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const rejectAll = (error: Error & { retryable?: boolean }) => {
    if (settled) return;
    settled = true;
    console.warn("[Bulut] STT WS rejected:", error.message);
    rejectStart?.(error);
    rejectDone?.(error);
  };

  const resolveDoneIfPossible = () => {
    if (settled) return;
    if (!finalText.trim() || !finalSessionId) return;
    settled = true;
    resolveStart?.();
    resolveDone?.({
      text: finalText.trim(),
      session_id: finalSessionId,
    });
  };

  socket.onopen = () => {
    console.info("[Bulut] STT WS connected, sending start");
    events.onRequestSent?.();
    socket.send(
      JSON.stringify({
        type: "start",
        project_id: config.projectId,
        session_id: config.sessionId || undefined,
        language: config.language || "tr",
        mime_type: config.mimeType || "audio/webm",
      }),
    );
  };

  socket.onmessage = (event) => {
    const payload = parseSttWsEventPayload(String(event.data));
    if (!payload) return;

    if (payload.type === "start_ack" && typeof payload.session_id === "string") {
      console.info("[Bulut] STT WS start_ack received, session:", payload.session_id);
      finalSessionId = payload.session_id;
      events.onSessionId?.(payload.session_id);
      resolveStart?.();
      return;
    }

    if (payload.type === "partial" && typeof payload.text === "string") {
      events.onPartial?.({
        seq: typeof payload.seq === "number" ? payload.seq : 0,
        text: payload.text,
      });
      return;
    }

    if (payload.type === "final" && typeof payload.text === "string") {
      console.info("[Bulut] STT WS final text received:", payload.text.slice(0, 80));
      finalText = payload.text;
      if (typeof payload.session_id === "string") {
        finalSessionId = payload.session_id;
        events.onSessionId?.(payload.session_id);
      }
      return;
    }

    if (payload.type === "done") {
      console.info("[Bulut] STT WS done");
      resolveDoneIfPossible();
      socket.close();
      return;
    }

    if (payload.type === "error") {
      console.error("[Bulut] STT WS server error:", payload.error);
      const err = buildError(payload.error || "stt_ws_error", payload.retryable !== false);
      rejectAll(err);
      socket.close();
    }
  };

  socket.onerror = (ev) => {
    console.error("[Bulut] STT WS transport error", ev);
    rejectAll(buildError("stt_ws_transport_error", true));
  };

  socket.onclose = (ev) => {
    console.info("[Bulut] STT WS closed code=%d reason=%s", ev.code, ev.reason);
    if (settled) return;
    if (finalText && finalSessionId) {
      resolveDoneIfPossible();
      return;
    }
    rejectAll(buildError("stt_ws_closed_before_done", true));
  };

  return {
    pushChunk: (chunk: Blob): Promise<void> => {
      if (stopped || chunk.size === 0) return Promise.resolve();
      // Chain the entire operation (wait for connection, base64-encode,
      // send) into sendQueue so that a later stop() is guaranteed to
      // follow all previously-enqueued chunks.
      sendQueue = sendQueue.then(async () => {
        if (stopped) return;
        await startPromise;
        if (stopped) return;
        const audio = await blobToBase64(chunk);
        seq += 1;
        if (stopped || socket.readyState !== WebSocket.OPEN) return;
        console.debug("[Bulut] STT WS sending chunk seq=%d size=%d", seq, chunk.size);
        socket.send(JSON.stringify({ type: "chunk", seq, audio }));
      });
      return sendQueue;
    },
    stop: (): Promise<SttWsResult> => {
      console.info("[Bulut] STT WS stop requested, draining %d pending chunks", seq);
      // Chain after all pending pushChunk operations so the server
      // always receives every chunk before the stop message.
      sendQueue = sendQueue.then(async () => {
        await startPromise;
        if (stopped) return;
        if (socket.readyState === WebSocket.OPEN) {
          console.info("[Bulut] STT WS sending stop after seq=%d", seq);
          socket.send(JSON.stringify({ type: "stop" }));
        }
      });
      return donePromise;
    },
    cancel: () => {
      stopped = true;
      try {
        socket.close();
      } catch {
        // no-op
      }
    },
  };
};

interface TtsCollectResult {
  chunks: Uint8Array<ArrayBuffer>[];
  mimeType: string;
  sampleRate: number;
}

const buildError = (message: string, retryable: boolean = true): Error & { retryable: boolean } => {
  const error = new Error(message) as Error & { retryable: boolean };
  error.retryable = retryable;
  return error;
};

const collectTtsViaSse = async (
  baseUrl: string,
  assistantText: string,
  voice: string,
  accessibilityMode: boolean,
  isStopped: () => boolean,
  setReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<TtsCollectResult> => {
  const ttsFormData = new FormData();
  ttsFormData.append("text", assistantText);
  ttsFormData.append("voice", voice);
  ttsFormData.append("accessibility_mode", String(accessibilityMode));

  const ttsResponse = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/tts`, {
    method: "POST",
    body: ttsFormData,
  });

  if (!ttsResponse.ok) {
    throw buildError(await parseErrorBody(ttsResponse), false);
  }

  const reader = ttsResponse.body?.getReader();
  if (!reader) {
    throw buildError("TTS response body is not readable", false);
  }

  setReader(reader);

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let mimeType = "audio/mpeg";
  let sampleRate = 16000;
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (isStopped()) {
      break;
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const payload = parseSseEventPayload(block);
      if (!payload) {
        continue;
      }

      if (isAudioSsePayload(payload)) {
        const format = payload.format || "mp3";
        mimeType = payload.mime_type || (format === "webm" ? "audio/webm" : "audio/mpeg");
        chunks.push(base64ToUint8Array(payload.audio));
        if (payload.sample_rate) {
          sampleRate = payload.sample_rate;
        }
      }
    }
  }

  reader.releaseLock();
  setReader(undefined);

  return { chunks, mimeType, sampleRate };
};

const collectTtsViaWebSocket = async (
  baseUrl: string,
  assistantText: string,
  voice: string,
  accessibilityMode: boolean,
  isStopped: () => boolean,
  setSocket: (socket: WebSocket | null) => void,
): Promise<TtsCollectResult> => {
  const wsUrl = toWebSocketUrl(baseUrl, "/chat/tts/ws");
  const requestId = createRequestId();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let mimeType = "audio/mpeg";
  let sampleRate = 16000;
  let highestSeqSeen = 0;

  const connectOnce = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (isStopped()) {
        reject(buildError("stream_stopped", false));
        return;
      }

      let done = false;
      let finalError: (Error & { retryable?: boolean }) | null = null;
      const socket = new WebSocket(wsUrl);
      setSocket(socket);

      const finalize = (
        mode: "resolve" | "reject",
        error?: Error & { retryable?: boolean },
      ) => {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        setSocket(null);
        if (mode === "resolve") {
          resolve();
          return;
        }
        reject(error || buildError("tts_ws_closed", true));
      };

      socket.onopen = () => {
        console.info(
          `[Bulut] TTS WS connected request_id=${requestId} resume_seq=${highestSeqSeen}`,
        );
        socket.send(
          JSON.stringify({
            type: "start",
            request_id: requestId,
            text: assistantText,
            voice,
            accessibility_mode: accessibilityMode,
            last_seq: highestSeqSeen,
          }),
        );
      };

      socket.onmessage = (event) => {
        const payload = parseTtsWsEventPayload(String(event.data));
        if (!payload) {
          console.warn("[Bulut] TTS WS invalid JSON payload");
          return;
        }

        if (payload.type === "audio" && typeof payload.audio === "string") {
          const seq = typeof payload.seq === "number" ? payload.seq : 0;
          if (shouldAcceptAudioSeq(seq, highestSeqSeen)) {
            chunks.push(base64ToUint8Array(payload.audio));
            highestSeqSeen = seq;
            if (payload.mime_type) {
              mimeType = payload.mime_type;
            }
            if (typeof payload.sample_rate === "number") {
              sampleRate = payload.sample_rate;
            }
          } else {
            console.info(
              `[Bulut] TTS WS duplicate chunk ignored request_id=${requestId} seq=${seq} seen=${highestSeqSeen}`,
            );
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "ack",
                request_id: requestId,
                last_seq: highestSeqSeen,
              }),
            );
          }
          return;
        }

        if (payload.type === "done") {
          const streamLastSeq =
            typeof payload.last_seq === "number" ? payload.last_seq : highestSeqSeen;
          if (streamLastSeq > highestSeqSeen) {
            finalError = buildError("tts_ws_sequence_gap", true);
            done = false;
            socket.close();
            return;
          }
          done = true;
          socket.close();
          return;
        }

        if (payload.type === "error") {
          finalError = buildError(payload.error || "tts_ws_error", payload.retryable !== false);
          done = false;
          socket.close();
        }
      };

      socket.onerror = () => {
        if (!finalError) {
          finalError = buildError("tts_ws_transport_error", true);
        }
      };

      socket.onclose = () => {
        if (isStopped()) {
          finalize("reject", buildError("stream_stopped", false));
          return;
        }
        if (done) {
          finalize("resolve");
          return;
        }
        finalize("reject", finalError || buildError("tts_ws_closed_before_done", true));
      };
    });

  for (let attempt = 0; attempt <= TTS_WS_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = TTS_WS_RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[Bulut] TTS WS retry attempt=${attempt} delay_ms=${delay} last_seq=${highestSeqSeen}`,
      );
      await sleep(delay);
    }

    try {
      await connectOnce();
      return { chunks, mimeType, sampleRate };
    } catch (error) {
      const retryable =
        shouldFallbackToSse(error);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Bulut] TTS WS attempt failed attempt=${attempt} retryable=${retryable} error=${message}`,
      );
      if (!retryable || attempt === TTS_WS_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }
  }

  throw buildError("tts_ws_exhausted", true);
};

// ── Agent-mode Types ────────────────────────────────────────────────

export interface AgentToolCallInfo {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentVoiceChatEvents {
  onSttRequestSent?: () => void;
  onTranscription?: (data: {
    session_id: string;
    user_text: string;
  }) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: (assistantText: string) => void;
  onAudioStateChange?: (state: AudioStreamState) => void;
  onError?: (error: string) => void;
  /** Called when the agent requests tool execution on the frontend. */
  onToolCalls?: (calls: AgentToolCallInfo[]) => void;
  /** Called after each tool has been executed with the result. */
  onToolResult?: (callId: string, toolName: string, result: string) => void;
  /** Called at the start of each agent iteration. */
  onIteration?: (iteration: number, maxIterations: number) => void;
  /** Called when the backend confirms / creates a session ID. */
  onSessionId?: (sessionId: string) => void;
  /**
   * Called when the agent emits a reply text followed by tool calls.
   * This text is spoken aloud before the tools run so the user hears
   * every piece of the conversation, not just the final reply.
   */
  onIntermediateReply?: (text: string) => void;
}

/**
 * Standalone TTS helper: synthesize + play a text snippet.
 * Uses WebSocket TTS with SSE fallback, same as the main stream functions.
 */
export const speakText = async (
  baseUrl: string,
  text: string,
  voice: string,
  accessibilityMode: boolean,
  onAudioStateChange?: (state: AudioStreamState) => void,
): Promise<void> => {
  const trimmed = text.trim();
  if (!trimmed) return;
  const playbackGeneration = getAudioPlaybackGeneration();

  console.info(`[Bulut] speakText start (${trimmed.length} chars)`);
  onAudioStateChange?.("rendering");
  let ttsResult: TtsCollectResult;

  const neverStopped = () => false;

  try {
    ttsResult = await collectTtsViaWebSocket(
      baseUrl, trimmed, voice, accessibilityMode,
      neverStopped,
      () => {},
    );
  } catch {
    ttsResult = await collectTtsViaSse(
      baseUrl, trimmed, voice, accessibilityMode,
      neverStopped,
      () => {},
    );
  }

  if (wasPlaybackStoppedAfter(playbackGeneration)) {
    onAudioStateChange?.("done");
    return;
  }

  if (ttsResult.chunks.length > 0) {
    await playBufferedAudio(
      ttsResult.chunks, ttsResult.mimeType, ttsResult.sampleRate,
      onAudioStateChange,
    );
  } else {
    onAudioStateChange?.("done");
  }
};

// ── Agent Voice Chat Stream (STT → Agent WS → TTS) ─────────────────

export const agentVoiceChatStream = (
  baseUrl: string,
  audioFile: File,
  projectId: string,
  sessionId: string | null,
  config: {
    model: string;
    voice: string;
    pageContext?: string;
    accessibilityMode?: boolean;
  },
  events: AgentVoiceChatEvents,
  executeTool: (call: AgentToolCallInfo) => Promise<{ call_id: string; result: string }>,
): StreamController => {
  let isStopped = false;
  let activeSocket: WebSocket | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let errorEmitted = false;

  const donePromise = new Promise<void>(async (resolve, reject) => {
    try {
      // ── 1. STT ────────────────────────────────────────────────
      if (isStopped) return resolve();
      const sttResult = await transcribeAudio(
        baseUrl,
        audioFile,
        projectId,
        sessionId,
        "tr",
        events.onSttRequestSent,
      );

      const currentSessionId = sttResult.session_id;
      let effectiveSessionId = currentSessionId;
      const userText = sttResult.text;

      events.onTranscription?.({
        session_id: currentSessionId,
        user_text: userText,
      });

      if (isStopped) return resolve();

      // ── 2. Agent loop via WebSocket ───────────────────────────
      const assistantText = await new Promise<string>((agentResolve, agentReject) => {
        if (isStopped) { agentResolve(""); return; }

        const wsUrl = toWebSocketUrl(baseUrl, "/chat/agent/ws");
        const socket = new WebSocket(wsUrl);
        activeSocket = socket;

        let finalReply = "";
        let resolved = false;
        let accumulatedDelta = "";

        const finish = (reply: string) => {
          if (resolved) return;
          resolved = true;
          agentResolve(reply);
        };

        const fail = (error: Error) => {
          if (resolved) return;
          resolved = true;
          agentReject(error);
        };

        socket.onopen = () => {
          console.info("[Bulut] Agent WS connected");
          socket.send(JSON.stringify({
            type: "start",
            project_id: projectId,
            session_id: currentSessionId,
            user_text: userText,
            model: config.model,
            page_context: config.pageContext,
            accessibility_mode: config.accessibilityMode,
          }));
        };

        socket.onmessage = async (event) => {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(String(event.data));
          } catch {
            console.warn("[Bulut] Agent WS invalid JSON");
            return;
          }

          const msgType = data.type as string;

          if (msgType === "session" && typeof data.session_id === "string") {
            effectiveSessionId = data.session_id as string;
            events.onSessionId?.(effectiveSessionId);
            return;
          }

          if (msgType === "iteration") {
            events.onIteration?.(
              data.iteration as number,
              data.max_iterations as number,
            );
            return;
          }

          if (msgType === "reply_delta" && typeof data.delta === "string") {
            accumulatedDelta += data.delta;
            events.onAssistantDelta?.(data.delta);
            return;
          }

          if (msgType === "tool_calls" && Array.isArray(data.calls)) {
            const calls = data.calls as AgentToolCallInfo[];

            // Speak accumulated text before running tools
            if (accumulatedDelta.trim()) {
              events.onIntermediateReply?.(accumulatedDelta.trim());
            }
            accumulatedDelta = "";

            events.onToolCalls?.(calls);

            const results: { call_id: string; result: string }[] = [];
            for (const call of calls) {
              // Save resume state before navigate in case of full-page reload
              const isNavigate = call.tool === "navigate";
              if (isNavigate) {
                savePendingAgentResume({
                  sessionId: effectiveSessionId,
                  projectId,
                  model: config.model,
                  voice: config.voice,
                  accessibilityMode: Boolean(config.accessibilityMode),
                  pendingToolCalls: calls.map((c) => ({
                    call_id: c.call_id,
                    tool: c.tool,
                    args: c.args,
                  })),
                  completedResults: [...results],
                });
              }

              const result = await executeTool(call);

              // If we reach here, no full-page reload happened
              if (isNavigate) {
                clearPendingAgentResume();
              }

              events.onToolResult?.(call.call_id, call.tool, result.result);
              results.push(result);
            }

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: "tool_results",
                results,
              }));
            }
            return;
          }

          if (msgType === "agent_done") {
            finalReply = (data.final_reply as string) || "";
            events.onAssistantDone?.(finalReply);
            if (typeof data.session_id === "string") {
              events.onSessionId?.(data.session_id as string);
            }
            finish(finalReply);
            return;
          }

          if (msgType === "error") {
            const errMsg = (data.error as string) || "Agent error";
            errorEmitted = true;
            events.onError?.(errMsg);
            fail(new Error(errMsg));
            return;
          }
        };

        socket.onerror = () => {
          console.error("[Bulut] Agent WS error");
          errorEmitted = true;
          events.onError?.("Agent WebSocket connection error");
          fail(new Error("Agent WebSocket connection error"));
        };

        socket.onclose = () => {
          console.info("[Bulut] Agent WS closed");
          finish(finalReply);
        };
      });

      activeSocket = null;

      // ── 3. TTS ────────────────────────────────────────────────
      if (isStopped || !assistantText) {
        if (!isStopped) {
          hideAgentCursor();
        }
        return resolve();
      }

      console.info(
        `[Bulut] TTS start mode=agent voice=${config.voice}`,
      );

      events.onAudioStateChange?.("rendering");
      let ttsResult: TtsCollectResult;

      try {
        ttsResult = await collectTtsViaWebSocket(
          baseUrl,
          assistantText,
          config.voice,
          Boolean(config.accessibilityMode),
          () => isStopped,
          (socket) => { activeSocket = socket; },
        );
      } catch (wsError) {
        if (isStopped) return resolve();
        console.warn(
          `[Bulut] TTS WS failed, falling back to SSE: ${wsError instanceof Error ? wsError.message : String(wsError)}`,
        );
        ttsResult = await collectTtsViaSse(
          baseUrl,
          assistantText,
          config.voice,
          Boolean(config.accessibilityMode),
          () => isStopped,
          (reader) => { activeReader = reader; },
        );
      }

      if (!isStopped && ttsResult.chunks.length > 0) {
        await playBufferedAudio(
          ttsResult.chunks,
          ttsResult.mimeType,
          ttsResult.sampleRate,
          events.onAudioStateChange,
        );
      } else {
        events.onAudioStateChange?.("done");
      }

      if (!isStopped) {
        hideAgentCursor();
      }
      resolve();
    } catch (err) {
      // Only emit onError if it hasn't been emitted already by the WS handler
      if (!errorEmitted) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onError?.(msg);
      }
      reject(err);
    } finally {
      activeReader?.cancel().catch(() => { });
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
      activeSocket = null;
    }
  });

  return {
    stop: () => {
      isStopped = true;
      stopActiveAudioPlayback();
      if (activeReader) {
        activeReader.cancel().catch(() => { });
      }
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
    },
    done: donePromise,
  };
};

// ── Agent Text Chat Stream (no STT, Agent WS → TTS) ────────────────

export const agentTextChatStream = (
  baseUrl: string,
  userText: string,
  projectId: string,
  sessionId: string | null,
  config: {
    model: string;
    voice: string;
    pageContext?: string;
    accessibilityMode?: boolean;
  },
  events: AgentVoiceChatEvents,
  executeTool: (call: AgentToolCallInfo) => Promise<{ call_id: string; result: string }>,
): StreamController => {
  let isStopped = false;
  let activeSocket: WebSocket | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let errorEmitted = false;

  const donePromise = new Promise<void>(async (resolve, reject) => {
    try {
      if (isStopped) return resolve();

      // ── 1. Agent loop via WebSocket ───────────────────────────
      const assistantText = await new Promise<string>((agentResolve, agentReject) => {
        if (isStopped) { agentResolve(""); return; }

        const wsUrl = toWebSocketUrl(baseUrl, "/chat/agent/ws");
        const socket = new WebSocket(wsUrl);
        activeSocket = socket;

        let finalReply = "";
        let resolved = false;
        let effectiveSessionId = sessionId || "";
        let accumulatedDelta = "";

        const finish = (reply: string) => {
          if (resolved) return;
          resolved = true;
          agentResolve(reply);
        };

        const fail = (error: Error) => {
          if (resolved) return;
          resolved = true;
          agentReject(error);
        };

        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: "start",
            project_id: projectId,
            session_id: sessionId,
            user_text: userText,
            model: config.model,
            page_context: config.pageContext,
            accessibility_mode: config.accessibilityMode,
          }));
        };

        socket.onmessage = async (event) => {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(String(event.data));
          } catch { return; }

          const msgType = data.type as string;

          if (msgType === "session" && typeof data.session_id === "string") {
            effectiveSessionId = data.session_id as string;
            events.onSessionId?.(effectiveSessionId);
            return;
          }

          if (msgType === "iteration") {
            events.onIteration?.(
              data.iteration as number,
              data.max_iterations as number,
            );
            return;
          }

          if (msgType === "reply_delta" && typeof data.delta === "string") {
            accumulatedDelta += data.delta;
            events.onAssistantDelta?.(data.delta);
            return;
          }

          if (msgType === "tool_calls" && Array.isArray(data.calls)) {
            const calls = data.calls as AgentToolCallInfo[];

            // Speak accumulated text before running tools
            if (accumulatedDelta.trim()) {
              events.onIntermediateReply?.(accumulatedDelta.trim());
            }
            accumulatedDelta = "";

            events.onToolCalls?.(calls);

            const results: { call_id: string; result: string }[] = [];
            for (const call of calls) {
              const isNavigate = call.tool === "navigate";
              if (isNavigate) {
                savePendingAgentResume({
                  sessionId: effectiveSessionId,
                  projectId,
                  model: config.model,
                  voice: config.voice,
                  accessibilityMode: Boolean(config.accessibilityMode),
                  pendingToolCalls: calls.map((c) => ({
                    call_id: c.call_id,
                    tool: c.tool,
                    args: c.args,
                  })),
                  completedResults: [...results],
                });
              }

              const result = await executeTool(call);

              if (isNavigate) {
                clearPendingAgentResume();
              }

              events.onToolResult?.(call.call_id, call.tool, result.result);
              results.push(result);
            }

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: "tool_results",
                results,
              }));
            }
            return;
          }

          if (msgType === "agent_done") {
            finalReply = (data.final_reply as string) || "";
            events.onAssistantDone?.(finalReply);
            if (typeof data.session_id === "string") {
              events.onSessionId?.(data.session_id as string);
            }
            finish(finalReply);
            return;
          }

          if (msgType === "error") {
            const errMsg = (data.error as string) || "Agent error";
            errorEmitted = true;
            events.onError?.(errMsg);
            fail(new Error(errMsg));
            return;
          }
        };

        socket.onerror = () => {
          errorEmitted = true;
          events.onError?.("Agent WebSocket error");
          fail(new Error("Agent WebSocket error"));
        };
        socket.onclose = () => finish(finalReply);
      });

      activeSocket = null;

      // ── 2. TTS ────────────────────────────────────────────────
      if (isStopped || !assistantText) {
        if (!isStopped) {
          hideAgentCursor();
        }
        return resolve();
      }

      events.onAudioStateChange?.("rendering");
      let ttsResult: TtsCollectResult;

      try {
        ttsResult = await collectTtsViaWebSocket(
          baseUrl, assistantText, config.voice, Boolean(config.accessibilityMode),
          () => isStopped,
          (socket) => { activeSocket = socket; },
        );
      } catch (wsError) {
        if (isStopped) return resolve();
        ttsResult = await collectTtsViaSse(
          baseUrl, assistantText, config.voice, Boolean(config.accessibilityMode),
          () => isStopped,
          (reader) => { activeReader = reader; },
        );
      }

      if (!isStopped && ttsResult.chunks.length > 0) {
        await playBufferedAudio(
          ttsResult.chunks, ttsResult.mimeType, ttsResult.sampleRate,
          events.onAudioStateChange,
        );
      } else {
        events.onAudioStateChange?.("done");
      }

      if (!isStopped) {
        hideAgentCursor();
      }
      resolve();
    } catch (err) {
      if (!errorEmitted) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onError?.(msg);
      }
      reject(err);
    } finally {
      activeReader?.cancel().catch(() => { });
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
      activeSocket = null;
    }
  });

  return {
    stop: () => {
      isStopped = true;
      stopActiveAudioPlayback();
      if (activeReader) activeReader.cancel().catch(() => { });
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
    },
    done: donePromise,
  };
};

// ── Agent Resume Stream (after page navigation reload) ──────────────
//
// When a navigate tool causes a full-page reload, the agent WS is lost.
// This function opens a new WS with {type: "resume"}, sends the
// completed tool results (including the navigate result with the new
// page context), and continues the agent loop from where it left off.

export const agentResumeStream = (
  baseUrl: string,
  resumeState: PendingAgentResume,
  pageContext: string,
  events: AgentVoiceChatEvents,
  executeTool: (call: AgentToolCallInfo) => Promise<{ call_id: string; result: string }>,
): StreamController => {
  let isStopped = false;
  let activeSocket: WebSocket | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let errorEmitted = false;

  // Build tool results for the calls that were pending when the page reloaded.
  // Navigate results include the new page context; other tools that couldn't
  // execute get a descriptive skip message.
  const allResults = [...resumeState.completedResults];
  for (const tc of resumeState.pendingToolCalls) {
    if (allResults.some((r) => r.call_id === tc.call_id)) continue;
    if (tc.tool === "navigate") {
      allResults.push({
        call_id: tc.call_id,
        result: `Navigasyon tamamlandı. Şu anki sayfa: ${typeof window !== "undefined" ? window.location.href : ""}\nSayfa bağlamı: ${pageContext}`,
      });
    } else {
      allResults.push({
        call_id: tc.call_id,
        result: "Sayfa yeniden yüklendi, bu araç çalıştırılamadı.",
      });
    }
  }

  const donePromise = new Promise<void>(async (resolve, reject) => {
    try {
      if (isStopped) return resolve();

      let effectiveSessionId = resumeState.sessionId;

      const assistantText = await new Promise<string>((agentResolve, agentReject) => {
        if (isStopped) { agentResolve(""); return; }

        const wsUrl = toWebSocketUrl(baseUrl, "/chat/agent/ws");
        const socket = new WebSocket(wsUrl);
        activeSocket = socket;

        let finalReply = "";
        let resolved = false;
        let accumulatedDelta = "";

        const finish = (reply: string) => {
          if (resolved) return;
          resolved = true;
          agentResolve(reply);
        };

        const fail = (error: Error) => {
          if (resolved) return;
          resolved = true;
          agentReject(error);
        };

        socket.onopen = () => {
          console.info("[Bulut] Agent WS resume connected");
          socket.send(JSON.stringify({
            type: "resume",
            project_id: resumeState.projectId,
            session_id: resumeState.sessionId,
            model: resumeState.model,
            page_context: pageContext,
            accessibility_mode: resumeState.accessibilityMode,
            pending_tool_calls: resumeState.pendingToolCalls,
            tool_results: allResults,
          }));
        };

        socket.onmessage = async (event) => {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(String(event.data));
          } catch { return; }

          const msgType = data.type as string;

          if (msgType === "session" && typeof data.session_id === "string") {
            effectiveSessionId = data.session_id as string;
            events.onSessionId?.(effectiveSessionId);
            return;
          }

          if (msgType === "iteration") {
            events.onIteration?.(
              data.iteration as number,
              data.max_iterations as number,
            );
            return;
          }

          if (msgType === "reply_delta" && typeof data.delta === "string") {
            accumulatedDelta += data.delta;
            events.onAssistantDelta?.(data.delta);
            return;
          }

          if (msgType === "tool_calls" && Array.isArray(data.calls)) {
            const calls = data.calls as AgentToolCallInfo[];

            // Speak accumulated text before running tools
            if (accumulatedDelta.trim()) {
              events.onIntermediateReply?.(accumulatedDelta.trim());
            }
            accumulatedDelta = "";

            events.onToolCalls?.(calls);

            const results: { call_id: string; result: string }[] = [];
            for (const call of calls) {
              const isNavigate = call.tool === "navigate";
              if (isNavigate) {
                savePendingAgentResume({
                  sessionId: effectiveSessionId,
                  projectId: resumeState.projectId,
                  model: resumeState.model,
                  voice: resumeState.voice,
                  accessibilityMode: resumeState.accessibilityMode,
                  pendingToolCalls: calls.map((c) => ({
                    call_id: c.call_id,
                    tool: c.tool,
                    args: c.args,
                  })),
                  completedResults: [...results],
                });
              }

              const result = await executeTool(call);

              if (isNavigate) {
                clearPendingAgentResume();
              }

              events.onToolResult?.(call.call_id, call.tool, result.result);
              results.push(result);
            }

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "tool_results", results }));
            }
            return;
          }

          if (msgType === "agent_done") {
            finalReply = (data.final_reply as string) || "";
            events.onAssistantDone?.(finalReply);
            if (typeof data.session_id === "string") {
              events.onSessionId?.(data.session_id as string);
            }
            finish(finalReply);
            return;
          }

          if (msgType === "error") {
            const errMsg = (data.error as string) || "Agent error";
            errorEmitted = true;
            events.onError?.(errMsg);
            fail(new Error(errMsg));
            return;
          }
        };

        socket.onerror = () => {
          errorEmitted = true;
          events.onError?.("Agent WebSocket error");
          fail(new Error("Agent WebSocket error"));
        };

        socket.onclose = () => finish(finalReply);
      });

      activeSocket = null;

      // ── TTS ────────────────────────────────────────────────
      if (isStopped || !assistantText) {
        if (!isStopped) {
          hideAgentCursor();
        }
        return resolve();
      }

      console.info(`[Bulut] TTS start mode=resume voice=${resumeState.voice}`);
      events.onAudioStateChange?.("rendering");
      let ttsResult: TtsCollectResult;

      try {
        ttsResult = await collectTtsViaWebSocket(
          baseUrl, assistantText, resumeState.voice, Boolean(resumeState.accessibilityMode),
          () => isStopped,
          (socket) => { activeSocket = socket; },
        );
      } catch (wsError) {
        if (isStopped) return resolve();
        console.warn(
          `[Bulut] TTS WS failed, falling back to SSE: ${wsError instanceof Error ? wsError.message : String(wsError)}`,
        );
        ttsResult = await collectTtsViaSse(
          baseUrl, assistantText, resumeState.voice, Boolean(resumeState.accessibilityMode),
          () => isStopped,
          (reader) => { activeReader = reader; },
        );
      }

      if (!isStopped && ttsResult.chunks.length > 0) {
        await playBufferedAudio(
          ttsResult.chunks, ttsResult.mimeType, ttsResult.sampleRate,
          events.onAudioStateChange,
        );
      } else {
        events.onAudioStateChange?.("done");
      }

      if (!isStopped) {
        hideAgentCursor();
      }
      resolve();
    } catch (err) {
      if (!errorEmitted) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onError?.(msg);
      }
      reject(err);
    } finally {
      activeReader?.cancel().catch(() => { });
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
      activeSocket = null;
    }
  });

  return {
    stop: () => {
      isStopped = true;
      stopActiveAudioPlayback();
      if (activeReader) activeReader.cancel().catch(() => { });
      if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
        activeSocket.close();
      }
    },
    done: donePromise,
  };
};
