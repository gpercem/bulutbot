export interface PageContext {
  links: string[];
  interactables: string[];
  summary: string;
  elementMap: Map<number, Element>;
}

export interface CachedPageContextEntry {
  url: string;
  summary: string;
  links: string[];
  interactables: string[];
  capturedAt: number;
  version: number;
}

interface InteractableCandidate {
  id: number;
  line: string;
  score: number;
  order: number;
  element: Element;
}

import {
  MAX_LINKS,
  MAX_INTERACTABLES,
  MAX_HEADINGS,
  MAX_TEXT_SNIPPETS,
  MAX_CACHED_PAGES,
  MAX_PAGE_SCAN_ELEMENTS,
} from "./contextConfig";

export const PAGE_CONTEXT_CACHE_VERSION = 4;
export const PAGE_CONTEXT_CACHE_KEY = "auticbot_page_context_cache_v4";

const NON_CONTENT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
]);

/** SVG drawing primitives — never useful as standalone interactables. */
const SVG_INTERNAL_TAGS = new Set([
  "path",
  "circle",
  "line",
  "rect",
  "polygon",
  "polyline",
  "ellipse",
  "g",
  "use",
  "defs",
  "clippath",
  "mask",
  "symbol",
  "lineargradient",
  "radialgradient",
  "stop",
  "text",
  "tspan",
]);

const NATIVE_INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "details",
  "option",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "option",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
]);

const pageContextCache = new Map<string, CachedPageContextEntry>();
let cacheHydrated = false;

/**
 * Live element map — maps numeric IDs to DOM elements.
 * Rebuilt on every page context scan; NOT serialised to cache.
 */
let liveElementMap = new Map<number, Element>();

/** Look up a DOM element by its semantic-map ID. */
export const getElementById = (id: number): Element | undefined =>
  liveElementMap.get(id);

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const canonicalUrl = (rawUrl: string): string => {
  try {
    return new URL(rawUrl, rawUrl).href;
  } catch {
    return rawUrl;
  }
};

const isCacheEntry = (value: unknown): value is CachedPageContextEntry => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.url === "string" &&
    typeof obj.summary === "string" &&
    Array.isArray(obj.links) &&
    Array.isArray(obj.interactables) &&
    typeof obj.capturedAt === "number" &&
    typeof obj.version === "number"
  );
};

const parseTabIndex = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const getPrimaryRole = (element: Element): string => {
  const rawRole = normalizeWhitespace(element.getAttribute("role") || "")
    .toLowerCase()
    .split(" ")[0];
  return rawRole || "";
};

const hydrateCacheFromStorage = (): void => {
  if (cacheHydrated || typeof sessionStorage === "undefined") {
    return;
  }

  cacheHydrated = true;

  try {
    const raw = sessionStorage.getItem(PAGE_CONTEXT_CACHE_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }

    for (const value of parsed) {
      if (!isCacheEntry(value)) {
        continue;
      }
      if (value.version !== PAGE_CONTEXT_CACHE_VERSION) {
        continue;
      }
      pageContextCache.set(value.url, value);
    }
    if (pageContextCache.size > 0) {
      console.info(
        `[Autic] context cache restored entries=${pageContextCache.size}`,
      );
    }
  } catch (error) {
    console.warn("[Autic] context cache restore failed", error);
  }
};

const persistCacheToStorage = (): void => {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    const serialized = JSON.stringify(
      Array.from(pageContextCache.values()).sort(
        (a, b) => a.capturedAt - b.capturedAt,
      ),
    );
    sessionStorage.setItem(PAGE_CONTEXT_CACHE_KEY, serialized);
  } catch (error) {
    console.warn("[Autic] context cache persist failed", error);
  }
};

const pruneOldestCacheEntries = (): void => {
  if (pageContextCache.size <= MAX_CACHED_PAGES) {
    return;
  }

  const sorted = Array.from(pageContextCache.values()).sort(
    (a, b) => a.capturedAt - b.capturedAt,
  );
  const overflow = sorted.length - MAX_CACHED_PAGES;
  for (let i = 0; i < overflow; i += 1) {
    pageContextCache.delete(sorted[i].url);
  }
};

const buildSummaryWithHistory = (
  current: CachedPageContextEntry,
): string => {
  const recentPages = Array.from(pageContextCache.values())
    .filter((entry) => entry.url !== current.url)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, 3);

  if (recentPages.length === 0) {
    return current.summary;
  }

  const historySection = [
    "Recent Page Memory:",
    ...recentPages.map((entry) => {
      const compactSummary = normalizeWhitespace(entry.summary);
      return `- ${entry.url} :: ${compactSummary}`;
    }),
  ].join("\n");

  return `${current.summary}\n\n${historySection}`;
};

const isVisible = (element: Element): boolean => {
  if (element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  if (element instanceof HTMLElement && element.hidden) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/**
 * Returns true if the element is nested inside an interactive parent
 * (e.g. a `<span>` or `<img>` inside a `<button>` or `<a>`).
 * This prevents listing child fragments of an already-listed interactable.
 */
const hasInteractiveAncestor = (element: Element): boolean => {
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const parentTag = parent.tagName.toLowerCase();
    if (NATIVE_INTERACTIVE_TAGS.has(parentTag)) return true;
    const parentRole = getPrimaryRole(parent);
    if (INTERACTIVE_ROLES.has(parentRole)) return true;
    parent = parent.parentElement;
  }
  return false;
};

const toAbsoluteUrl = (href: string): string => {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
};

const getElementLabel = (element: Element): string => {
  const text = normalizeWhitespace(
    (element instanceof HTMLElement ? element.innerText : element.textContent) ||
      "",
  ).substring(0, 80);
  const ariaLabel = normalizeWhitespace(element.getAttribute("aria-label") || "");
  const title = normalizeWhitespace(element.getAttribute("title") || "");
  const placeholder = normalizeWhitespace(
    element.getAttribute("placeholder") || "",
  );
  const name = normalizeWhitespace(element.getAttribute("name") || "");
  const value =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
      ? normalizeWhitespace(element.value || "")
      : "";

  const label =
    text || ariaLabel || title || placeholder || value || name || "";

  const tag = element.tagName.toLowerCase();

  // Images: prefer alt text, fall back to src filename
  if (tag === "img") {
    const alt = normalizeWhitespace(element.getAttribute("alt") || "");
    if (alt) return alt;
    const src = element.getAttribute("src") || "";
    const filename = src.split("/").pop()?.split("?")[0] || "";
    return filename ? `img: ${filename}` : compactOuterHtml(element);
  }

  if (tag === "svg") {
    return ariaLabel || title || "icon";
  }

  if (tag === "input") {
    const inputType = element.getAttribute("type") || "text";
    const currentValue = element instanceof HTMLInputElement ? element.value : "";
    const valueNote = currentValue ? ` val="${currentValue.substring(0, 40)}"` : "";
    return `${inputType} ${label || "input"}${valueNote}`;
  }

  if (tag === "textarea") {
    const currentValue = element instanceof HTMLTextAreaElement ? element.value : "";
    const valueNote = currentValue ? ` val="${currentValue.substring(0, 40)}"` : "";
    return `textarea ${label || "textarea"}${valueNote}`;
  }

  if (tag === "select") {
    const selectEl = element as HTMLSelectElement;
    const selectedText = selectEl.selectedOptions?.[0]?.textContent?.trim() || "";
    const valueNote = selectedText ? ` val="${selectedText}"` : "";
    return `select ${label || "select"}${valueNote}`;
  }

  if (label) return label;

  // Fallback: compact outerHTML snippet so the agent can still identify the element
  return compactOuterHtml(element);
};

/** Return a trimmed, single-line outerHTML (opening tag + short text), max 90 chars. */
const compactOuterHtml = (element: Element): string => {
  const html = element.outerHTML || "";
  // Take only the opening tag + a little content
  const closeIdx = html.indexOf(">");
  if (closeIdx === -1) return html.substring(0, 90);
  const snippet = html.substring(0, Math.min(closeIdx + 30, 90)).replace(/\s+/g, " ").trim();
  return snippet || "untitled";
};

// ── Semantic element description ────────────────────────────────────

const describeElementType = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const role = getPrimaryRole(element);

  // Role-based override
  if (role === "button" || tag === "button") return "Button";
  if (role === "link" || tag === "a") return "Link";
  if (role === "tab") return "Tab";
  if (role === "menuitem") return "MenuItem";
  if (role === "checkbox" || (tag === "input" && element.getAttribute("type") === "checkbox")) return "Checkbox";
  if (role === "radio" || (tag === "input" && element.getAttribute("type") === "radio")) return "Radio";
  if (role === "switch") return "Switch";
  if (role === "combobox" || tag === "select") return "Select";
  if (role === "textbox" || tag === "textarea") return "TextArea";
  if (role === "searchbox") return "SearchBox";
  if (role === "slider" || (tag === "input" && element.getAttribute("type") === "range")) return "Slider";
  if (role === "spinbutton") return "SpinButton";
  if (role === "option" || tag === "option") return "Option";
  if (role === "treeitem") return "TreeItem";
  if (tag === "input") {
    const t = element.getAttribute("type") || "text";
    return `Input[${t}]`;
  }
  if (tag === "summary") return "Summary";
  if (tag === "details") return "Details";
  if (element.getAttribute("contenteditable") === "true") return "Editable";

  // Generic interactive
  return role ? `${role[0].toUpperCase()}${role.slice(1)}` : `<${tag}>`;
};

const getElementState = (element: Element): string[] => {
  const states: string[] = [];

  const pressed = element.getAttribute("aria-pressed");
  if (pressed === "true") states.push("Pressed");
  else if (pressed === "false") states.push("Not pressed");

  const expanded = element.getAttribute("aria-expanded");
  if (expanded === "true") states.push("Expanded");
  else if (expanded === "false") states.push("Collapsed");

  const selected = element.getAttribute("aria-selected");
  if (selected === "true") states.push("Selected");

  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      states.push(element.checked ? "Checked" : "Unchecked");
    }
  }

  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    states.push("Disabled");
  }

  return states;
};

interface SemanticScanResult {
  links: string[];
  interactables: string[];
  elementMap: Map<number, Element>;
}

/**
 * Scan the DOM and build a semantic element map.
 *
 * Every interactive element gets a numeric ID. The LLM uses these IDs
 * with `interact(id=N)` instead of fragile CSS selectors.
 */
const collectSemanticElements = (): SemanticScanResult => {
  const allElements = Array.from(document.querySelectorAll("*"));
  const sampledElements = allElements.slice(0, MAX_PAGE_SCAN_ELEMENTS);

  const links: string[] = [];
  const linkSet = new Set<string>();
  const candidates: InteractableCandidate[] = [];
  const elementMap = new Map<number, Element>();
  let idCounter = 1;

  for (let order = 0; order < sampledElements.length; order += 1) {
    const element = sampledElements[order];
    const tag = element.tagName.toLowerCase();

    if (NON_CONTENT_TAGS.has(tag)) continue;
    if (SVG_INTERNAL_TAGS.has(tag)) continue;
    if (!isVisible(element)) continue;

    const role = getPrimaryRole(element);
    const style = window.getComputedStyle(element);
    const href = element.getAttribute("href");
    const isNativeInteractive = NATIVE_INTERACTIVE_TAGS.has(tag) && (tag !== "a" || Boolean(href));
    const isRoleInteractive = INTERACTIVE_ROLES.has(role);
    const tabIndex = parseTabIndex(element.getAttribute("tabindex"));
    const hasTabStop = tabIndex !== null && tabIndex >= 0;
    const hasPointerCursor = style.cursor === "pointer";
    const isContentEditable = element.getAttribute("contenteditable") === "true";
    const isDisabled =
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";

    // ── Links ───────────────────────────────────────────────────
    if (
      tag === "a" &&
      href &&
      !href.startsWith("#") &&
      !href.startsWith("javascript:")
    ) {
      const absoluteHref = toAbsoluteUrl(href);
      const label = getElementLabel(element) || absoluteHref;
      const id = idCounter++;
      const line = `- [${id}] ${label} -> ${absoluteHref}`;

      if (!linkSet.has(absoluteHref)) {
        linkSet.add(absoluteHref);
        links.push(line);
        elementMap.set(id, element);
      }
    }

    // ── Interactables ───────────────────────────────────────────
    const hasInteractionSignals =
      isNativeInteractive ||
      isRoleInteractive ||
      isContentEditable ||
      hasTabStop ||
      hasPointerCursor;

    if (!hasInteractionSignals || isDisabled) continue;

    // Skip children nested inside an already-interactive parent
    // (e.g. <span> or <img> inside a <button> or <a>)
    if (hasInteractiveAncestor(element)) continue;

    const id = idCounter++;
    elementMap.set(id, element);

    const elType = describeElementType(element);
    const label = getElementLabel(element);
    const stateTokens = getElementState(element);
    const statePart = stateTokens.length > 0 ? ` (${stateTokens.join(", ")})` : "";
    const line = `- [${id}] ${elType}: "${label}"${statePart}`;

    const score =
      (isNativeInteractive ? 5 : 0) +
      (isRoleInteractive ? 4 : 0) +
      (hasTabStop ? 2 : 0) +
      (hasPointerCursor ? 2 : 0) +
      (isContentEditable ? 2 : 0);

    candidates.push({ id, line, score, order, element });
  }

  const interactables = candidates
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_INTERACTABLES)
    .map((c) => c.line);

  return {
    links: links.slice(0, MAX_LINKS),
    interactables,
    elementMap,
  };
};

const TEXT_CONTENT_SELECTOR = [
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "figcaption", "dd", "dt", "td", "th",
  "pre", "label", "caption",
].join(", ");

/**
 * Check if an element has meaningful direct text content
 * (text nodes that aren't just whitespace).
 */
const hasDirectText = (element: Element): boolean => {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const trimmed = (child.textContent || "").trim();
      if (trimmed.length >= 10) return true;
    }
  }
  return false;
};

const collectTextSnippets = (): string[] => {
  const root =
    document.querySelector("main, article, [role='main']") ?? document.body;
  const snippets: string[] = [];
  const seen = new Set<string>();

  const addSnippet = (raw: string): boolean => {
    if (!raw || raw.length < 15) return false;
    const text = raw.length > 300 ? raw.substring(0, 300) + "…" : raw;
    if (seen.has(text)) return false;
    seen.add(text);
    snippets.push(`- ${text}`);
    return snippets.length >= MAX_TEXT_SNIPPETS;
  };

  // Pass 1: semantic text elements (p, li, headings, etc.)
  const candidates = Array.from(root.querySelectorAll(TEXT_CONTENT_SELECTOR));
  for (const node of candidates) {
    if (!isVisible(node)) continue;
    const raw = normalizeWhitespace(node.textContent || "");
    if (addSnippet(raw)) return snippets;
  }

  // Pass 2: generic containers (div, span, section, etc.) that hold
  // direct text not already captured by semantic tags above.
  const genericContainers = Array.from(
    root.querySelectorAll("div, span, section, article, aside, header, footer"),
  );
  for (const node of genericContainers) {
    if (!isVisible(node)) continue;
    // Only include elements whose own direct child text nodes are meaningful,
    // to avoid duplicating text already captured from nested semantic tags.
    if (!hasDirectText(node)) continue;
    const raw = normalizeWhitespace(node.textContent || "");
    if (addSnippet(raw)) return snippets;
  }

  return snippets;
};

const formatSection = (title: string, lines: string[]): string => {
  if (lines.length === 0) return `${title}:\n- none`;
  return `${title}:\n${lines.join("\n")}`;
};

export const buildPageContextSummary = (
  url: string,
  title: string,
  lang: string,
  headings: string[],
  links: string[],
  interactables: string[],
  textSnippets: string[],
): string => {
  const sections = [
    formatSection("Page", [
      `- URL: ${url || "unknown"}`,
      `- Title: ${title || "unknown"}`,
      `- Lang: ${lang || "unknown"}`,
    ]),
    formatSection("Headings", headings),
    formatSection("Content Snippets", textSnippets),
    formatSection("Links", links),
    formatSection("Interactive Elements", interactables),
  ];

  return sections.join("\n\n");
};

export const clearPageContextCache = (): void => {
  pageContextCache.clear();
  cacheHydrated = false;
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(PAGE_CONTEXT_CACHE_KEY);
  }
};

export const getCachedPageContexts = (): CachedPageContextEntry[] => {
  hydrateCacheFromStorage();
  return Array.from(pageContextCache.values()).sort(
    (a, b) => b.capturedAt - a.capturedAt,
  );
};

export const invalidateCurrentPageContext = (): void => {
  if (typeof window === "undefined") return;
  const url = canonicalUrl(window.location.href);
  pageContextCache.delete(url);
  persistCacheToStorage();
};

export const getPageContext = (forceRefresh: boolean = false): PageContext => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      links: [],
      interactables: [],
      summary: "",
      elementMap: new Map(),
    };
  }

  hydrateCacheFromStorage();
  const url = canonicalUrl(window.location.href);

  // Always rebuild the live element map (it holds DOM references)
  const scan = collectSemanticElements();
  liveElementMap = scan.elementMap;

  if (!forceRefresh) {
    const cached = pageContextCache.get(url);
    if (cached) {
      console.info(`[Autic] context cache hit url=${url}`);
      return {
        links: cached.links,
        interactables: cached.interactables,
        summary: buildSummaryWithHistory(cached),
        elementMap: liveElementMap,
      };
    }
  }

  console.info(`[Autic] context cache miss url=${url}`);

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter((element) => isVisible(element))
    .map((element) =>
      `- ${normalizeWhitespace(element.textContent || "")}`,
    )
    .filter((line) => line !== "- ")
    .slice(0, MAX_HEADINGS);

  const summary = buildPageContextSummary(
    url,
    document.title,
    document.documentElement.lang,
    headings,
    scan.links,
    scan.interactables,
    collectTextSnippets(),
  );

  const entry: CachedPageContextEntry = {
    url,
    summary,
    links: scan.links,
    interactables: scan.interactables,
    capturedAt: Date.now(),
    version: PAGE_CONTEXT_CACHE_VERSION,
  };

  pageContextCache.set(url, entry);
  pruneOldestCacheEntries();
  persistCacheToStorage();
  console.info(
    `[Autic] context cache stored url=${url} size=${pageContextCache.size}`,
  );

  return {
    links: entry.links,
    interactables: entry.interactables,
    summary: buildSummaryWithHistory(entry),
    elementMap: liveElementMap,
  };
};
