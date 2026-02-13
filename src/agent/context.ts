export interface PageContext {
  links: string[];
  interactables: string[];
  summary: string;
}

export interface CachedPageContextEntry {
  url: string;
  summary: string;
  links: string[];
  interactables: string[];
  capturedAt: number;
  version: number;
}

export interface PageContextSummaryInput {
  url: string;
  title: string;
  lang: string;
  headings: string[];
  landmarks: string[];
  links: string[];
  interactables: string[];
  interactionSignals: string[];
  styleSelectors: string[];
  pageBlueprint: string[];
  textSnippets: string[];
  outerHtmlDigest: string;
}

interface InteractableCandidate {
  line: string;
  score: number;
  order: number;
}

interface PageSignalSnapshot {
  links: string[];
  interactables: string[];
  interactionSignals: string[];
  styleSelectors: string[];
  pageBlueprint: string[];
}

import {
  MAX_LINKS,
  MAX_INTERACTABLES,
  MAX_HEADINGS,
  MAX_TEXT_SNIPPETS,
  MAX_CACHED_PAGES,
  MAX_PAGE_SCAN_ELEMENTS,
  MAX_EVENT_HINTS_PER_ELEMENT,
  MAX_BRANCH_SAMPLES,
  MAX_BRANCH_DEPTH,
  MAX_STYLESHEET_SELECTORS,
  MAX_STYLESHEET_RULES,
} from "./contextConfig";

export const PAGE_CONTEXT_CACHE_VERSION = 3;
export const PAGE_CONTEXT_CACHE_KEY = "auticbot_page_context_cache_v3";

const NON_CONTENT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
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

const TRACKED_DISPLAY_VALUES = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
]);

const TRACKED_POSITION_VALUES = new Set([
  "relative",
  "absolute",
  "fixed",
  "sticky",
]);

const EVENT_HINT_NAMES = [
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "keydown",
  "keyup",
  "keypress",
  "input",
  "change",
  "submit",
  "focus",
  "blur",
];

const ARIA_INTERACTION_ATTRS = [
  "aria-controls",
  "aria-expanded",
  "aria-haspopup",
  "aria-pressed",
  "aria-selected",
];

const DATA_INTERACTION_PATTERN =
  /(action|click|press|toggle|target|trigger|nav|open|close|menu|modal|command|submit)/i;

const STYLESHEET_SELECTOR_PATTERN =
  /(:hover|:focus|:active|button|a\b|input|textarea|select|\[role=|\[aria-|\[data-|\.btn|\.link)/i;

const pageContextCache = new Map<string, CachedPageContextEntry>();
let cacheHydrated = false;

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

const bumpCount = (map: Map<string, number>, key: string): void => {
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) ?? 0) + 1);
};

const formatTopCounts = (map: Map<string, number>, maxItems: number): string => {
  if (map.size === 0) {
    return "none";
  }

  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxItems)
    .map(([name, count]) => `${name}*${count}`)
    .join(", ");
};

const parseTabIndex = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const compactToken = (value: string): string => {
  const compact = value.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
  return compact || "";
};

const getElementDepth = (element: Element): number => {
  let depth = 0;
  let cursor: Element | null = element;
  while (cursor?.parentElement) {
    depth += 1;
    cursor = cursor.parentElement;
    if (cursor === document.body) {
      break;
    }
  }
  return depth;
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

const toAbsoluteUrl = (href: string): string => {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return href;
  }
};

const escapeCssValue = (value: string): string => {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/([ #;&,.+*~':"!^$\[\]()=>|\/@])/g, "\\$1");
};

const buildSelectorSegment = (element: Element): string => {
  const tag = element.tagName.toLowerCase();

  if (element.id) {
    return `#${escapeCssValue(element.id)}`;
  }

  const attrCandidates: Array<[name: string, value: string | null]> = [
    ["name", element.getAttribute("name")],
    ["data-testid", element.getAttribute("data-testid")],
    ["data-test-id", element.getAttribute("data-test-id")],
    ["aria-label", element.getAttribute("aria-label")],
    ["role", element.getAttribute("role")],
    ["type", element.getAttribute("type")],
  ];

  for (const [attrName, attrValue] of attrCandidates) {
    if (attrValue) {
      return `${tag}[${attrName}="${escapeCssValue(attrValue)}"]`;
    }
  }

  const classes = Array.from(element.classList)
    .filter(Boolean)
    .slice(0, 3)
    .map((className) => `.${escapeCssValue(className)}`)
    .join("");
  if (classes) {
    return `${tag}${classes}`;
  }

  const parent = element.parentElement;
  if (!parent) {
    return tag;
  }

  const siblingsOfTag = Array.from(parent.children).filter(
    (sibling) => sibling.tagName === element.tagName,
  );
  const index = siblingsOfTag.indexOf(element) + 1;
  return `${tag}:nth-of-type(${index})`;
};

const buildSelector = (element: Element): string => {
  const segments: string[] = [];
  let cursor: Element | null = element;
  let depth = 0;

  while (cursor && depth < 4) {
    const segment = buildSelectorSegment(cursor);
    segments.unshift(segment);
    if (segment.startsWith("#")) {
      break;
    }
    cursor = cursor.parentElement;
    depth += 1;
  }

  return segments.join(" > ");
};

const getElementLabel = (element: Element): string => {
  const text = normalizeWhitespace(
    (element instanceof HTMLElement ? element.innerText : element.textContent) ||
      "",
  );
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

  const classHint = Array.from(element.classList)
    .map((item) => compactToken(item))
    .find(Boolean);
  const fallback =
    (element.id && `#${element.id}`) ||
    (classHint && `.${classHint}`) ||
    buildSelector(element);

  const label =
    text || ariaLabel || title || placeholder || value || name || fallback;

  if (element.tagName.toLowerCase() === "input") {
    const inputType = element.getAttribute("type") || "text";
    return `${inputType} ${label || "input"}`;
  }

  return label || "untitled";
};

const getEventHints = (element: Element): string[] => {
  const record = element as unknown as Record<string, unknown>;
  const eventHints: string[] = [];

  for (const eventName of EVENT_HINT_NAMES) {
    const handlerKey = `on${eventName}`;
    const hasInlineHandler = Boolean(element.getAttribute(handlerKey));
    const hasPropertyHandler = typeof record[handlerKey] === "function";

    if (!hasInlineHandler && !hasPropertyHandler) {
      continue;
    }

    eventHints.push(eventName);
    if (eventHints.length >= MAX_EVENT_HINTS_PER_ELEMENT) {
      break;
    }
  }

  return eventHints;
};

const getAriaInteractionHints = (element: Element): string[] =>
  ARIA_INTERACTION_ATTRS.filter((attrName) => element.hasAttribute(attrName)).map(
    (attrName) => attrName.replace("aria-", ""),
  );

const getDataInteractionHints = (element: Element): string[] =>
  element
    .getAttributeNames()
    .filter(
      (attrName) =>
        attrName.startsWith("data-") && DATA_INTERACTION_PATTERN.test(attrName),
    )
    .slice(0, 2)
    .map((attrName) => attrName.replace("data-", ""));

const getComputedStyleSignals = (style: CSSStyleDeclaration): string[] => {
  const signals: string[] = [];

  if (style.cursor && style.cursor !== "auto") {
    signals.push(`cursor:${style.cursor}`);
  }
  if (style.display) {
    signals.push(`display:${style.display}`);
  }
  if (style.position) {
    signals.push(`position:${style.position}`);
  }
  if (style.zIndex && style.zIndex !== "auto") {
    signals.push(`z-index:${style.zIndex}`);
  }
  if (style.pointerEvents && style.pointerEvents !== "auto") {
    signals.push(`pointer-events:${style.pointerEvents}`);
  }
  if (style.visibility && style.visibility !== "visible") {
    signals.push(`visibility:${style.visibility}`);
  }
  if (style.opacity && style.opacity !== "1") {
    signals.push(`opacity:${style.opacity}`);
  }

  return Array.from(new Set(signals));
};

const buildBlueprintToken = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const idToken = element.id ? `#${compactToken(element.id)}` : "";
  const classToken = Array.from(element.classList)
    .map((item) => compactToken(item))
    .find(Boolean);

  return `${tag}${idToken}${classToken ? `.${classToken}` : ""}`;
};

const buildBranchDigest = (element: Element, depth: number): string => {
  const token = buildBlueprintToken(element);
  if (depth <= 0) {
    return token;
  }

  const children = Array.from(element.children)
    .filter((child) => !NON_CONTENT_TAGS.has(child.tagName.toLowerCase()))
    .filter((child) => isVisible(child));
  if (children.length === 0) {
    return token;
  }

  const sampled = children
    .slice(0, 3)
    .map((child) => buildBranchDigest(child, depth - 1));
  const overflow =
    children.length > sampled.length ? `+${children.length - sampled.length}` : "";

  return `${token}>${sampled.join("+")}${overflow}`;
};

const collectDomBranchDigest = (): string[] => {
  const root = document.body ?? document.documentElement;
  const topLevelNodes = Array.from(root.children)
    .filter((child) => !NON_CONTENT_TAGS.has(child.tagName.toLowerCase()))
    .filter((child) => isVisible(child))
    .slice(0, MAX_BRANCH_SAMPLES);

  return topLevelNodes.map((child) =>
    buildBranchDigest(child, MAX_BRANCH_DEPTH),
  );
};

const formatSection = (title: string, lines: string[]): string => {
  if (lines.length === 0) {
    return `${title}:\n- none`;
  }

  return `${title}:\n${lines.join("\n")}`;
};

const buildOuterHtmlDigest = (): string => {
  const raw = document.body?.outerHTML || document.documentElement.outerHTML;

  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const structural = withoutScripts
    .replace(/>[^<]*</g, "><")
    .replace(/\s+/g, " ")
    .trim();

  return structural;
};

const collectTextSnippets = (): string[] => {
  const root =
    document.querySelector("main, article, [role='main']") ?? document.body;
  const snippets: string[] = [];
  const seen = new Set<string>();

  const candidates = Array.from(root.querySelectorAll("p, li, h1, h2, h3"));
  for (const node of candidates) {
    if (!isVisible(node)) {
      continue;
    }

    const text = normalizeWhitespace(node.textContent || "");
    if (!text || text.length < 20) {
      continue;
    }

    if (seen.has(text)) {
      continue;
    }

    seen.add(text);
    snippets.push(`- ${text}`);
    if (snippets.length >= MAX_TEXT_SNIPPETS) {
      break;
    }
  }

  return snippets;
};

const collectLandmarkSnapshot = (): string[] => {
  const probes: Array<{ label: string; selector: string }> = [
    { label: "main", selector: "main, [role='main']" },
    { label: "nav", selector: "nav, [role='navigation']" },
    { label: "section", selector: "section" },
    { label: "article", selector: "article" },
    { label: "form", selector: "form" },
    { label: "a", selector: "a" },
    { label: "button", selector: "button" },
    { label: "input", selector: "input" },
    { label: "role=button/link", selector: "[role='button'], [role='link']" },
    { label: "onclick attrs", selector: "[onclick]" },
    {
      label: "other event attrs",
      selector:
        "[onpointerdown], [onpointerup], [onkeydown], [onkeyup], [onchange], [onsubmit]",
    },
    { label: "tabindex", selector: "[tabindex]" },
    { label: "contenteditable", selector: "[contenteditable='true']" },
    { label: "inline cursor styles", selector: "[style*='cursor']" },
  ];

  return probes.map(
    ({ label, selector }) => `- ${label}: ${document.querySelectorAll(selector).length}`,
  );
};

const collectSelectorsFromRuleList = (
  rules: CSSRuleList,
  selectors: Set<string>,
  scanned: { count: number },
): void => {
  for (const rule of Array.from(rules)) {
    if (
      scanned.count >= MAX_STYLESHEET_RULES ||
      selectors.size >= MAX_STYLESHEET_SELECTORS
    ) {
      return;
    }

    scanned.count += 1;

    if (rule instanceof CSSStyleRule) {
      const parts = rule.selectorText
        .split(",")
        .map((selector) => normalizeWhitespace(selector))
        .filter(Boolean);

      for (const selector of parts) {
        if (!STYLESHEET_SELECTOR_PATTERN.test(selector)) {
          continue;
        }
        selectors.add(selector);
        if (selectors.size >= MAX_STYLESHEET_SELECTORS) {
          return;
        }
      }
      continue;
    }

    if ("cssRules" in rule) {
      try {
        const nestedRules = (rule as CSSMediaRule).cssRules;
        collectSelectorsFromRuleList(nestedRules, selectors, scanned);
      } catch {
        // Ignore inaccessible nested rules.
      }
    }
  }
};

const collectStylesheetSelectors = (): string[] => {
  const selectors = new Set<string>();
  const scanned = { count: 0 };

  for (const stylesheet of Array.from(document.styleSheets)) {
    if (
      scanned.count >= MAX_STYLESHEET_RULES ||
      selectors.size >= MAX_STYLESHEET_SELECTORS
    ) {
      break;
    }

    try {
      if (!stylesheet.cssRules) {
        continue;
      }
      collectSelectorsFromRuleList(stylesheet.cssRules, selectors, scanned);
    } catch {
      // Ignore cross-origin stylesheets.
    }
  }

  return Array.from(selectors).map((selector) => `- ${selector}`);
};

const collectPageSignalSnapshot = (): PageSignalSnapshot => {
  const allElements = Array.from(document.querySelectorAll("*"));
  const sampledElements = allElements.slice(0, MAX_PAGE_SCAN_ELEMENTS);

  const links: string[] = [];
  const linkSet = new Set<string>();
  const interactableCandidates = new Map<string, InteractableCandidate>();
  const tagCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const displayCounts = new Map<string, number>();
  const positionCounts = new Map<string, number>();
  const styleSignalCounts = new Map<string, number>();

  let visibleElements = 0;
  let maxDepth = 0;
  let semanticInteractables = 0;
  let nonSemanticInteractables = 0;
  let eventHintElements = 0;
  let tabStopElements = 0;
  let pointerCursorElements = 0;
  let dataHintElements = 0;
  let ariaHintElements = 0;
  let contentEditableElements = 0;

  for (let order = 0; order < sampledElements.length; order += 1) {
    const element = sampledElements[order];
    const tag = element.tagName.toLowerCase();

    if (NON_CONTENT_TAGS.has(tag)) {
      continue;
    }

    if (!isVisible(element)) {
      continue;
    }

    visibleElements += 1;
    bumpCount(tagCounts, tag);

    const role = getPrimaryRole(element);
    if (role) {
      bumpCount(roleCounts, role);
    }

    const depth = getElementDepth(element);
    if (depth > maxDepth) {
      maxDepth = depth;
    }

    const style = window.getComputedStyle(element);
    if (TRACKED_DISPLAY_VALUES.has(style.display)) {
      bumpCount(displayCounts, style.display);
    }
    if (TRACKED_POSITION_VALUES.has(style.position)) {
      bumpCount(positionCounts, style.position);
    }

    const computedStyleSignals = getComputedStyleSignals(style);
    for (const styleSignal of computedStyleSignals) {
      bumpCount(styleSignalCounts, styleSignal);
    }

    const eventHints = getEventHints(element);
    if (eventHints.length > 0) {
      eventHintElements += 1;
      for (const eventName of eventHints) {
        bumpCount(eventCounts, eventName);
      }
    }

    const tabIndex = parseTabIndex(element.getAttribute("tabindex"));
    const hasTabStop = tabIndex !== null && tabIndex >= 0;
    if (hasTabStop) {
      tabStopElements += 1;
    }

    const hasPointerCursor = style.cursor === "pointer";
    if (hasPointerCursor) {
      pointerCursorElements += 1;
    }

    const dataHints = getDataInteractionHints(element);
    if (dataHints.length > 0) {
      dataHintElements += 1;
    }

    const ariaHints = getAriaInteractionHints(element);
    if (ariaHints.length > 0) {
      ariaHintElements += 1;
    }

    const isContentEditable = element.getAttribute("contenteditable") === "true";
    if (isContentEditable) {
      contentEditableElements += 1;
    }

    const href = element.getAttribute("href");
    const isNativeInteractive = NATIVE_INTERACTIVE_TAGS.has(tag) && (tag !== "a" || Boolean(href));
    const isRoleInteractive = INTERACTIVE_ROLES.has(role);
    const isDisabled =
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";

    if (
      tag === "a" &&
      href &&
      !href.startsWith("#") &&
      !href.startsWith("javascript:")
    ) {
      const absoluteHref = toAbsoluteUrl(href);
      const label = getElementLabel(element) || absoluteHref;
      const line = `- ${label} -> ${absoluteHref}`;

      if (!linkSet.has(line)) {
        linkSet.add(line);
        links.push(line);
        if (links.length >= MAX_LINKS) {
          // Keep scanning other elements for page blueprint and interactables.
        }
      }
    }

    const hasInteractionSignals =
      isNativeInteractive ||
      isRoleInteractive ||
      isContentEditable ||
      eventHints.length > 0 ||
      hasTabStop ||
      hasPointerCursor ||
      dataHints.length > 0 ||
      ariaHints.length > 0;

    if (!hasInteractionSignals || isDisabled) {
      continue;
    }

    if (isNativeInteractive) {
      semanticInteractables += 1;
    } else {
      nonSemanticInteractables += 1;
    }

    const selector = buildSelector(element);
    const label = getElementLabel(element);
    const styleSignals = computedStyleSignals;
    const signalTokens: string[] = [];

    if (eventHints.length > 0) {
      signalTokens.push(`evt:${eventHints.join("|")}`);
    }
    if (isRoleInteractive) {
      signalTokens.push(`role:${role}`);
    }
    if (hasTabStop) {
      signalTokens.push(`tab:${tabIndex}`);
    }
    if (dataHints.length > 0) {
      signalTokens.push(`data:${dataHints.join("|")}`);
    }
    if (ariaHints.length > 0) {
      signalTokens.push(`aria:${ariaHints.join("|")}`);
    }
    if (styleSignals.length > 0) {
      signalTokens.push(`css:${styleSignals.join("|")}`);
    } else if (hasPointerCursor) {
      signalTokens.push("css:cursor:pointer");
    }

    const signalBlock =
      signalTokens.length > 0 ? ` [${signalTokens.join("; ")}]` : "";
    const line = `- ${tag} ${selector}${signalBlock} (${label})`;

    const score =
      eventHints.length * 5 +
      (isNativeInteractive ? 5 : 0) +
      (isRoleInteractive ? 4 : 0) +
      (hasTabStop ? 2 : 0) +
      (hasPointerCursor ? 2 : 0) +
      (dataHints.length > 0 ? 2 : 0) +
      (ariaHints.length > 0 ? 1 : 0) +
      (isContentEditable ? 2 : 0);

    const existing = interactableCandidates.get(line);
    if (!existing || score > existing.score) {
      interactableCandidates.set(line, { line, score, order });
    }
  }

  const interactables = Array.from(interactableCandidates.values())
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_INTERACTABLES)
    .map((candidate) => candidate.line);

  const interactiveRoleCounts = new Map(
    Array.from(roleCounts.entries()).filter(([role]) =>
      INTERACTIVE_ROLES.has(role),
    ),
  );

  const interactionSignals = [
    `- coverage: semantic=${semanticInteractables}, non-semantic=${nonSemanticInteractables}, contenteditable=${contentEditableElements}`,
    `- listener hints: ${formatTopCounts(eventCounts, 8)}`,
    `- interaction cues: tabindex>=0=${tabStopElements}, pointer-cursor=${pointerCursorElements}, data-hints=${dataHintElements}, aria-hints=${ariaHintElements}`,
    `- role hints: ${formatTopCounts(interactiveRoleCounts, 8)}`,
    `- css footprint: ${formatTopCounts(styleSignalCounts, 10)}`,
    "- listener scope: inline/on* handlers are detected directly; addEventListener handlers are inferred via cues.",
  ];

  const branchDigest = collectDomBranchDigest();
  const pageBlueprint = [
    `- nodes: total=${allElements.length}, scanned=${sampledElements.length}, visible=${visibleElements}, max-depth=${maxDepth}${allElements.length > sampledElements.length ? ", sampling=on" : ""}`,
    `- tag density: ${formatTopCounts(tagCounts, 10)}`,
    `- role density: ${formatTopCounts(roleCounts, 8)}`,
    `- layout density: display(${formatTopCounts(displayCounts, 6)}), position(${formatTopCounts(positionCounts, 4)})`,
    `- branch digest: ${branchDigest.length > 0 ? branchDigest.join(" || ") : "none"}`,
  ];

  return {
    links: links.slice(0, MAX_LINKS),
    interactables,
    interactionSignals,
    styleSelectors: collectStylesheetSelectors(),
    pageBlueprint,
  };
};

export const buildPageContextSummary = (
  input: PageContextSummaryInput,
): string => {
  const sections = [
    formatSection("Meta", [
      `- URL: ${input.url || "unknown"}`,
      `- Title: ${input.title || "unknown"}`,
      `- Lang: ${input.lang || "unknown"}`,
    ]),
    formatSection("Headings", input.headings),
    formatSection("Landmark Snapshot", input.landmarks),
    formatSection("Interaction Signals", input.interactionSignals),
    formatSection("Stylesheet Selector Snapshot", input.styleSelectors),
    formatSection("Compressed Page Blueprint", input.pageBlueprint),
    formatSection("Top Links", input.links),
    formatSection("Top Interactables", input.interactables),
    formatSection("Main Content Snippets", input.textSnippets),
    formatSection("OuterHTML Skeleton", [
      `- ${input.outerHtmlDigest || "unavailable"}`,
    ]),
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

export const getPageContext = (): PageContext => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      links: [],
      interactables: [],
      summary: "",
    };
  }

  hydrateCacheFromStorage();
  const url = canonicalUrl(window.location.href);
  const cached = pageContextCache.get(url);
  if (cached) {
    console.info(`[Autic] context cache hit url=${url}`);
    return {
      links: cached.links,
      interactables: cached.interactables,
      summary: buildSummaryWithHistory(cached),
    };
  }

  console.info(`[Autic] context cache miss url=${url}`);

  const snapshot = collectPageSignalSnapshot();
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter((element) => isVisible(element))
    .map((element) =>
      `- ${normalizeWhitespace(element.textContent || "")}`,
    )
    .filter((line) => line !== "- ")
    .slice(0, MAX_HEADINGS);

  const summary = buildPageContextSummary({
    url,
    title: document.title,
    lang: document.documentElement.lang,
    headings,
    landmarks: collectLandmarkSnapshot(),
    links: snapshot.links,
    interactables: snapshot.interactables,
    interactionSignals: snapshot.interactionSignals,
    styleSelectors: snapshot.styleSelectors,
    pageBlueprint: snapshot.pageBlueprint,
    textSnippets: collectTextSnippets(),
    outerHtmlDigest: buildOuterHtmlDigest(),
  });

  const entry: CachedPageContextEntry = {
    url,
    summary,
    links: snapshot.links,
    interactables: snapshot.interactables,
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
  };
};
