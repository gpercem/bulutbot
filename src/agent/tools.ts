import { getPageContext } from "./context";
import { COLORS } from "../styles/constants";

const AGENT_CURSOR_ID = "auticbot-agent-cursor";
const CURSOR_STORAGE_KEY = "auticbot_agent_cursor_state";
export const CURSOR_MOVE_DURATION_MS = 900;
export const SCROLL_DURATION_MS = 900;
const CURSOR_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
const CURSOR_HOVER_RADIUS_PX = 14;

// ── Pending Agent Resume State (survives page reloads) ──────────────

const RESUME_STORAGE_KEY = "bulut_agent_resume";
const RESUME_TTL_MS = 60_000; // 1 minute

export interface PendingAgentResume {
  sessionId: string;
  projectId: string;
  model: string;
  voice: string;
  accessibilityMode: boolean;
  pendingToolCalls: Array<{
    call_id: string;
    tool: string;
    args: Record<string, unknown>;
  }>;
  completedResults: Array<{ call_id: string; result: string }>;
  savedAt: number;
}

export const savePendingAgentResume = (
  state: Omit<PendingAgentResume, "savedAt">,
): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      RESUME_STORAGE_KEY,
      JSON.stringify({ ...state, savedAt: Date.now() }),
    );
  } catch {
    // localStorage may be full or blocked
  }
};

export const getPendingAgentResume = (): PendingAgentResume | null => {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(RESUME_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingAgentResume;
    if (Date.now() - parsed.savedAt > RESUME_TTL_MS) {
      clearPendingAgentResume();
      return null;
    }
    return parsed;
  } catch {
    clearPendingAgentResume();
    return null;
  }
};

export const clearPendingAgentResume = (): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(RESUME_STORAGE_KEY);
};

interface PersistedCursorState {
  url: string;
  x: number;
  y: number;
  visible: boolean;
}

type InteractAction = "move" | "click" | "type" | "submit";

interface InteractToolCall {
  tool: "interact";
  action: InteractAction;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
}

interface NavigateToolCall {
  tool: "navigate";
  url: string;
}

interface GetPageContextToolCall {
  tool: "getPageContext";
}

interface ScrollToolCall {
  tool: "scroll";
  selector: string;
}

export type AgentToolCall =
  | InteractToolCall
  | NavigateToolCall
  | GetPageContextToolCall
  | ScrollToolCall;

export interface ParsedAgentResponse {
  reply: string;
  toolCalls: AgentToolCall[];
}

interface JsonObject {
  [key: string]: unknown;
}

interface ResolvedTarget {
  element?: HTMLElement;
  x: number;
  y: number;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const extractJsonCandidate = (raw: string): string => {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return trimmed;
};

const extractFirstJsonObject = (input: string): string | null => {
  const start = input.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = start; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }

  return null;
};

const parseJsonFromRaw = (raw: string): unknown => {
  const candidate = extractJsonCandidate(raw);
  try {
    return JSON.parse(candidate);
  } catch {
    const objectCandidate = extractFirstJsonObject(candidate);
    if (!objectCandidate) {
      return null;
    }
    try {
      return JSON.parse(objectCandidate);
    } catch {
      return null;
    }
  }
};

const sanitizeToolCalls = (value: unknown): AgentToolCall[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const toolCalls: AgentToolCall[] = [];

  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }

    if (item.tool === "interact") {
      const action = asString(item.action) as InteractAction | undefined;
      if (!action || !["move", "click", "type", "submit"].includes(action)) {
        continue;
      }

      toolCalls.push({
        tool: "interact",
        action,
        selector: asString(item.selector),
        text: typeof item.text === "string" ? item.text : undefined,
        x: asNumber(item.x),
        y: asNumber(item.y),
      });
      continue;
    }

    if (item.tool === "navigate") {
      const url = asString(item.url);
      if (!url) {
        continue;
      }

      toolCalls.push({
        tool: "navigate",
        url,
      });
      continue;
    }

    if (item.tool === "getPageContext") {
      toolCalls.push({
        tool: "getPageContext",
      });
      continue;
    }

    if (item.tool === "scroll") {
      const selector = asString(item.selector);
      if (!selector) {
        continue;
      }

      toolCalls.push({
        tool: "scroll",
        selector,
      });
    }
  }

  return toolCalls;
};

export const parseAgentResponse = (raw: string): ParsedAgentResponse => {
  const parsed = parseJsonFromRaw(raw);
  if (!isObject(parsed)) {
    return {
      reply: raw.trim(),
      toolCalls: [],
    };
  }

  const reply = asString(parsed.reply) || "";
  const toolCalls = sanitizeToolCalls(parsed.tool_calls ?? parsed.toolCalls);

  return {
    reply,
    toolCalls,
  };
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const easeInOutCubic = (progress: number): number => {
  if (progress < 0.5) {
    return 4 * progress * progress * progress;
  }
  return 1 - Math.pow(-2 * progress + 2, 3) / 2;
};

export const easeInOutSine = (progress: number): number =>
  -(Math.cos(Math.PI * progress) - 1) / 2;

export const isRectOutsideViewport = (
  rect: Pick<DOMRect, "top" | "bottom">,
  viewportHeight: number,
): boolean => rect.top < 0 || rect.bottom > viewportHeight;

export const computeCenteredScrollTop = (
  currentScrollY: number,
  rectTop: number,
  rectHeight: number,
  viewportHeight: number,
  maxScrollTop: number,
): number => {
  const desired =
    currentScrollY + rectTop - (viewportHeight / 2 - rectHeight / 2);
  return clamp(desired, 0, Math.max(0, maxScrollTop));
};

export const animateWindowScrollTo = async (
  targetY: number,
  durationMs: number = SCROLL_DURATION_MS,
): Promise<void> => {
  if (typeof window === "undefined") {
    return;
  }

  const startY = window.scrollY;
  const delta = targetY - startY;
  if (Math.abs(delta) < 1) {
    return;
  }

  await new Promise<void>((resolve) => {
    const raf =
      window.requestAnimationFrame ||
      ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));

    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = clamp(elapsed / durationMs, 0, 1);
      const eased = easeInOutSine(progress);
      window.scrollTo(0, startY + delta * eased);

      if (progress < 1) {
        raf(step);
      } else {
        resolve();
      }
    };

    raf(step);
  });
};

const getPersistedCursorState = (): PersistedCursorState | null => {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedCursorState>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.x !== "number" ||
      !Number.isFinite(parsed.x) ||
      typeof parsed.y !== "number" ||
      !Number.isFinite(parsed.y)
    ) {
      return null;
    }

    return {
      url: parsed.url,
      x: parsed.x,
      y: parsed.y,
      visible: parsed.visible !== false,
    };
  } catch {
    return null;
  }
};

const persistCursorState = (x: number, y: number, visible: boolean) => {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    const payload: PersistedCursorState = {
      url: window.location.href,
      x,
      y,
      visible,
    };
    localStorage.setItem(CURSOR_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // No-op: localStorage may be unavailable or blocked.
  }
};

const setCursorPosition = (cursor: HTMLElement, x: number, y: number) => {
  cursor.style.left = `${x}px`;
  cursor.style.top = `${y}px`;
};

const getCursorPosition = (cursor: HTMLElement): { x: number; y: number } => ({
  x: Number.parseFloat(cursor.style.left) || 0,
  y: Number.parseFloat(cursor.style.top) || 0,
});

const setCursorVisibility = (cursor: HTMLElement, visible: boolean) => {
  cursor.style.opacity = visible ? "1" : "0";
};

export const hideAgentCursor = (): void => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const cursor = document.getElementById(AGENT_CURSOR_ID);
  if (!(cursor instanceof HTMLElement)) {
    return;
  }

  const { x, y } = getCursorPosition(cursor);
  setCursorVisibility(cursor, false);
  persistCursorState(x, y, false);
};

let cursorHoverTrackingInitialized = false;
const initializeCursorHoverTracking = () => {
  if (cursorHoverTrackingInitialized) {
    return;
  }
  cursorHoverTrackingInitialized = true;

  document.addEventListener("mousemove", (event) => {
    const cursor = document.getElementById(AGENT_CURSOR_ID);
    if (!(cursor instanceof HTMLElement)) {
      return;
    }

    if (cursor.style.opacity !== "1") {
      return;
    }

    const { x, y } = getCursorPosition(cursor);
    const pointerX = event.pageX;
    const pointerY = event.pageY;
    const distance = Math.hypot(pointerX - x, pointerY - y);

    if (distance <= CURSOR_HOVER_RADIUS_PX) {
      setCursorVisibility(cursor, false);
      persistCursorState(x, y, false);
    }
  });
};

const applyStoredCursorStateForCurrentUrl = (cursor: HTMLElement) => {
  const stored = getPersistedCursorState();
  if (!stored || stored.url !== window.location.href) {
    return;
  }

  setCursorPosition(cursor, stored.x, stored.y);
  setCursorVisibility(cursor, stored.visible);
};

const ensureCursor = (): HTMLElement => {
  const existing = document.getElementById(AGENT_CURSOR_ID);
  if (existing) {
    // Keep cursor color in sync with the current theme
    existing.style.background = COLORS.primary;
    initializeCursorHoverTracking();
    return existing as HTMLElement;
  }

  const cursor = document.createElement("div");
  cursor.id = AGENT_CURSOR_ID;
  cursor.style.position = "absolute";
  cursor.style.left = "0px";
  cursor.style.top = "0px";
  cursor.style.opacity = "0";
  const width = 25;
  cursor.style.width = `${width}px`;
  cursor.style.height = `${width}px`;
  cursor.style.borderRadius = "50%";
  const baseColor = COLORS.primary;
  cursor.style.background = baseColor;
  const border = 25 * 16 / 100;
  cursor.style.border = `${border}px solid #ffffff`;
  cursor.style.boxShadow = "0px 0px 10px rgba(0, 11, 26, 0.5)";
  cursor.style.boxSizing = "border-box";
  cursor.style.zIndex = "2147483647";
  cursor.style.pointerEvents = "none";
  cursor.style.transform = "translate(-50%, -50%)";
  cursor.style.transition = `left ${CURSOR_MOVE_DURATION_MS}ms ${CURSOR_EASING}, top ${CURSOR_MOVE_DURATION_MS}ms ${CURSOR_EASING}, opacity 150ms ease-out`;
  document.body.appendChild(cursor);
  initializeCursorHoverTracking();
  applyStoredCursorStateForCurrentUrl(cursor);
  console.info(`[Autic] cursor created color=${baseColor} duration=${CURSOR_MOVE_DURATION_MS}ms`);
  return cursor;
};

const moveCursor = async (x: number, y: number) => {
  const cursor = ensureCursor();
  setCursorPosition(cursor, x, y);
  setCursorVisibility(cursor, true);
  persistCursorState(x, y, true);
  await new Promise((resolve) => setTimeout(resolve, CURSOR_MOVE_DURATION_MS));
};

const getElementCenter = (element: HTMLElement): { x: number; y: number } => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + window.scrollX + rect.width / 2,
    y: rect.top + window.scrollY + rect.height / 2,
  };
};

const CONTAINS_SELECTOR_PATTERN = /^(.*?):contains\((['"])(.*?)\2\)\s*$/;

const findElementBySelector = (selector: string): Element | null => {
  try {
    return document.querySelector(selector);
  } catch (error) {
    const containsMatch = selector.match(CONTAINS_SELECTOR_PATTERN);
    if (!containsMatch) {
      console.warn(`AuticBot selector invalid: ${selector}`, error);
      return null;
    }

    const baseSelector = containsMatch[1]?.trim() || "*";
    const expectedText = containsMatch[3]?.trim() || "";
    if (!expectedText) {
      console.warn(`AuticBot selector contains empty text: ${selector}`);
      return null;
    }

    try {
      const candidates = document.querySelectorAll(baseSelector);
      for (const candidate of candidates) {
        if (candidate.textContent?.includes(expectedText)) {
          return candidate;
        }
      }
      return null;
    } catch (fallbackError) {
      console.warn(`AuticBot selector fallback invalid: ${selector}`, fallbackError);
      return null;
    }
  }
};

const resolveTarget = (call: InteractToolCall): ResolvedTarget | null => {
  if (call.selector) {
    const selected = findElementBySelector(call.selector);

    if (selected instanceof HTMLElement) {
      const center = getElementCenter(selected);
      return {
        element: selected,
        x: center.x,
        y: center.y,
      };
    }
    console.warn(`AuticBot interact: selector not found: ${call.selector}`);
  }

  if (typeof call.x === "number" && typeof call.y === "number") {
    return {
      x: call.x,
      y: call.y,
    };
  }

  console.warn("AuticBot interact: missing target selector or coordinates.", call);
  return null;
};

const dispatchMouseEvent = (
  element: HTMLElement,
  type: string,
  x: number,
  y: number,
) => {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x - window.scrollX,
      clientY: y - window.scrollY,
    }),
  );
};

const typeIntoElement = (element: HTMLElement, text: string) => {
  const tagName = element.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA") {
    (element as HTMLInputElement).focus();
    (element as HTMLInputElement).value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element.isContentEditable) {
    element.focus();
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  console.warn(
    "AuticBot interact: type action requires input, textarea, or contenteditable target.",
  );
};

const submitElement = (element: HTMLElement) => {
  if (element.tagName === "FORM") {
    (element as HTMLFormElement).requestSubmit();
    return;
  }

  if (element.tagName === "BUTTON" && (element as HTMLButtonElement).form) {
    (element as HTMLButtonElement).form?.requestSubmit();
    return;
  }

  const parentForm = element.closest("form");
  if (parentForm) {
    parentForm.requestSubmit();
    return;
  }

  console.warn("AuticBot interact: submit action requires a form target.");
};

const slowScrollElementIntoView = async (element: HTMLElement): Promise<void> => {
  await slowScrollElementIntoViewWithMode(element, false);
};

const slowScrollElementIntoViewWithMode = async (
  element: HTMLElement,
  forceCenter: boolean,
): Promise<void> => {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;

  if (!forceCenter && !isRectOutsideViewport(rect, viewportHeight)) {
    return;
  }

  const maxScrollTop = Math.max(
    0,
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - viewportHeight,
  );
  const targetY = computeCenteredScrollTop(
    window.scrollY,
    rect.top,
    rect.height,
    viewportHeight,
    maxScrollTop,
  );

  await animateWindowScrollTo(targetY, SCROLL_DURATION_MS);
};

const executeScroll = async (call: ScrollToolCall) => {
  const selected = findElementBySelector(call.selector);
  if (!(selected instanceof HTMLElement)) {
    console.warn(`AuticBot scroll: selector not found: ${call.selector}`);
    return;
  }

  await slowScrollElementIntoViewWithMode(selected, true);
  const center = getElementCenter(selected);
  await moveCursor(center.x, center.y);
};

const executeInteract = async (call: InteractToolCall) => {
  const target = resolveTarget(call);
  if (!target) {
    return;
  }

  if (call.action === "click" && target.element) {
    await slowScrollElementIntoView(target.element);
    const center = getElementCenter(target.element);
    target.x = center.x;
    target.y = center.y;
  }

  await moveCursor(target.x, target.y);

  if (call.action === "move") {
    return;
  }

  if (!target.element) {
    console.warn("AuticBot interact: target element not available for action.", call.action);
    return;
  }

  if (call.action === "click") {
    dispatchMouseEvent(target.element, "pointerdown", target.x, target.y);
    dispatchMouseEvent(target.element, "mousedown", target.x, target.y);
    dispatchMouseEvent(target.element, "pointerup", target.x, target.y);
    dispatchMouseEvent(target.element, "mouseup", target.x, target.y);
    target.element.click();
    return;
  }

  if (call.action === "type") {
    typeIntoElement(target.element, call.text ?? "");
    return;
  }

  submitElement(target.element);
};

const isSamePageNavigation = (targetUrl: string): boolean => {
  try {
    const current = new URL(window.location.href);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch {
    return false;
  }
};

/**
 * Find the best matching link element for a target URL.
 * Supports exact href match, partial path/query/hash match,
 * and text-content match for framework <Link> components.
 */
const findMatchingLinkForTarget = (targetUrl: string): HTMLElement | null => {
  let parsedTarget: URL | null = null;
  try {
    parsedTarget = new URL(targetUrl, window.location.href);
  } catch {
    // will fall through to text-based matching
  }

  const allLinks = Array.from(
    document.querySelectorAll('a[href], [role="link"][href], [data-href]'),
  ) as HTMLElement[];

  // 1. Exact href match
  for (const el of allLinks) {
    if (el instanceof HTMLAnchorElement && el.href === parsedTarget?.href) {
      return el;
    }
  }

  if (parsedTarget) {
    // 2. Match by pathname + search + hash (ignoring origin)
    for (const el of allLinks) {
      if (!(el instanceof HTMLAnchorElement)) continue;
      try {
        const elUrl = new URL(el.href, window.location.href);
        if (
          elUrl.pathname === parsedTarget.pathname &&
          elUrl.search === parsedTarget.search &&
          elUrl.hash === parsedTarget.hash
        ) {
          return el;
        }
      } catch {
        continue;
      }
    }

    // 3. Match by pathname only (query/hash may differ)
    for (const el of allLinks) {
      if (!(el instanceof HTMLAnchorElement)) continue;
      try {
        const elUrl = new URL(el.href, window.location.href);
        if (elUrl.pathname === parsedTarget.pathname) {
          return el;
        }
      } catch {
        continue;
      }
    }

    // 4. Partial href attribute match (covers relative paths, query strings)
    const rawUrl = targetUrl.replace(/^\//, "");
    for (const el of allLinks) {
      const href = el.getAttribute("href") || el.getAttribute("data-href") || "";
      if (href && (href === targetUrl || href === rawUrl || href === `/${rawUrl}`)) {
        return el;
      }
    }
  }

  // 5. Text-content match (for framework <Link> or <button> navigations)
  const urlSegments = targetUrl
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean);
  const lastSegment = urlSegments[urlSegments.length - 1] || "";

  if (lastSegment) {
    // Also search query param values (e.g., ?tab=interact → "interact")
    let searchTerms = [lastSegment];
    if (parsedTarget) {
      for (const [, value] of parsedTarget.searchParams.entries()) {
        if (value) searchTerms.push(value);
      }
      if (parsedTarget.hash) {
        searchTerms.push(parsedTarget.hash.replace(/^#/, ""));
      }
    }
    searchTerms = searchTerms.map((t) => t.toLowerCase());

    // Look across all clickable elements
    const clickables = Array.from(
      document.querySelectorAll(
        'a, button, [role="link"], [role="tab"], [role="button"], [data-tab], [onclick]',
      ),
    ) as HTMLElement[];

    for (const el of clickables) {
      const text = (el.textContent || "").trim().toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const dataTab = (el.getAttribute("data-tab") || "").toLowerCase();
      for (const term of searchTerms) {
        if (
          text === term ||
          ariaLabel === term ||
          dataTab === term ||
          text.includes(term)
        ) {
          return el;
        }
      }
    }
  }

  return null;
};

const executeNavigate = async (call: NavigateToolCall): Promise<boolean> => {
  try {
    const targetUrl = call.url;
    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(targetUrl, window.location.href).href;
    } catch {
      resolvedUrl = targetUrl;
    }

    const matchingElement = findMatchingLinkForTarget(targetUrl);

    if (matchingElement) {
      console.log("AuticBot navigate: clicking element", resolvedUrl, matchingElement.tagName);
      await slowScrollElementIntoView(matchingElement);

      const center = getElementCenter(matchingElement);
      await moveCursor(center.x, center.y);

      matchingElement.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, view: window }));
      matchingElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, view: window }));
      matchingElement.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, view: window }));
      matchingElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, view: window }));
      matchingElement.click();

      return !isSamePageNavigation(resolvedUrl);
    }

    // 6. Fallback: direct browser navigation (query param, hash, or full URL)
    console.log("AuticBot navigate: no matching element found, using direct navigation", resolvedUrl);

    // Hash-only navigation
    try {
      const parsed = new URL(resolvedUrl);
      if (
        parsed.origin === window.location.origin &&
        parsed.pathname === window.location.pathname &&
        parsed.hash
      ) {
        window.location.hash = parsed.hash;
        return false;
      }
    } catch { /* continue */ }

    // Query-param or same-origin navigation via History API
    try {
      const parsed = new URL(resolvedUrl);
      if (parsed.origin === window.location.origin) {
        // Use pushState + popstate to trigger SPA routers
        const newPath = parsed.pathname + parsed.search + parsed.hash;
        window.history.pushState({}, "", newPath);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        return false;
      }
    } catch { /* continue */ }

    // Cross-origin: full page navigation
    window.location.href = resolvedUrl;
    return true;
  } catch (error) {
    console.warn("AuticBot navigate: error", call.url, error);
    return false;
  }
};

const executeGetPageContext = async () => {
  const context = getPageContext();
  console.info(
    `[Autic] getPageContext tool executed links=${context.links.length} interactables=${context.interactables.length} summary_len=${context.summary.length}`,
  );
};

export const executeToolCalls = async (toolCalls: AgentToolCall[]) => {
  for (const toolCall of toolCalls) {
    if (toolCall.tool === "interact") {
      await executeInteract(toolCall);
      continue;
    }

    if (toolCall.tool === "scroll") {
      await executeScroll(toolCall);
      continue;
    }

    if (toolCall.tool === "getPageContext") {
      await executeGetPageContext();
      continue;
    }

    if (toolCall.tool === "navigate") {
      const terminalNavigation = await executeNavigate(toolCall);
      if (terminalNavigation) {
        break;
      }
    }
  }
};

// ── Agent-mode tool execution (returns results) ─────────────────────

export type ToolCallWithId = AgentToolCall & {
  call_id: string;
};

export interface ToolCallResult {
  call_id: string;
  result: string;
}

/**
 * Execute a single tool call and return a result string.
 * Used by the agent loop to feed results back into the LLM.
 */
export const executeSingleToolCall = async (
  call: ToolCallWithId,
): Promise<ToolCallResult> => {
  const callId = call.call_id;
  try {
    if (call.tool === "interact") {
      await executeInteract(call);
      return {
        call_id: callId,
        result: `Etkileşim başarılı: ${call.action}`,
      };
    }

    if (call.tool === "scroll") {
      await executeScroll(call);
      return {
        call_id: callId,
        result: "Öğeye kaydırma başarılı.",
      };
    }

    if (call.tool === "getPageContext") {
      const context = getPageContext();
      return {
        call_id: callId,
        result: context.summary,
      };
    }

    if (call.tool === "navigate") {
      await executeNavigate(call);
      // Wait for navigation / SPA routing to settle
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const context = getPageContext();
      return {
        call_id: callId,
        result: `Navigasyon tamamlandı. Şu anki sayfa: ${window.location.href}\nSayfa bağlamı: ${context.summary}`,
      };
    }

    return { call_id: callId, result: "Bilinmeyen araç." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Autic] Tool execution error: ${call.tool}`, error);
    return { call_id: callId, result: `Hata: ${msg}` };
  }
};

const restoreCursorFromStorageForCurrentUrl = () => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const stored = getPersistedCursorState();
  if (!stored || stored.url !== window.location.href) {
    return;
  }

  ensureCursor();
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restoreCursorFromStorageForCurrentUrl, {
      once: true,
    });
  } else {
    restoreCursorFromStorageForCurrentUrl();
  }
}
