import { beforeEach, describe, expect, it } from "vitest";
import {
  PAGE_CONTEXT_CACHE_KEY,
  PAGE_CONTEXT_CACHE_VERSION,
  buildPageContextSummary,
  clearPageContextCache,
  getCachedPageContexts,
  type PageContextSummaryInput,
} from "./context";

const buildInput = (): PageContextSummaryInput => ({
  url: "https://example.com/products?page=2",
  title: "Example Products",
  lang: "tr",
  headings: ["- Urunler", "- One Cikanlar"],
  landmarks: ["- main: 1", "- nav: 2", "- button: 14"],
  interactionSignals: [
    "- coverage: semantic=8, non-semantic=6, contenteditable=1",
    "- listener hints: click*4, keydown*2",
  ],
  styleSelectors: [".hero button:hover", "[role='button']:focus"],
  pageBlueprint: [
    "- nodes: total=120, scanned=120, visible=84, max-depth=9",
    "- branch digest: main#app>section.hero+section.features || nav.topbar>a+a+a",
  ],
  links: ["- Sepet -> https://example.com/cart"],
  interactables: [
    "- button #checkout (Odeme Yap)",
    "- input input[name=\"q\"] (text ara)",
  ],
  textSnippets: ["- Haftanin en cok satilan urunlerini burada bulabilirsiniz."],
  outerHtmlDigest: "<body><main><section><h1>Urunler</h1></section></main></body>",
});

describe("buildPageContextSummary", () => {
  beforeEach(() => {
    let store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      key: (_index: number) => null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage;

    Object.defineProperty(globalThis, "sessionStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
    clearPageContextCache();
  });

  it("includes all expected sections", () => {
    const summary = buildPageContextSummary(buildInput());

    expect(summary).toContain("Meta:");
    expect(summary).toContain("Headings:");
    expect(summary).toContain("Landmark Snapshot:");
    expect(summary).toContain("Interaction Signals:");
    expect(summary).toContain("Stylesheet Selector Snapshot:");
    expect(summary).toContain("Compressed Page Blueprint:");
    expect(summary).toContain("Top Links:");
    expect(summary).toContain("Top Interactables:");
    expect(summary).toContain("Main Content Snippets:");
    expect(summary).toContain("OuterHTML Skeleton:");
  });

  it("does not truncate oversized summaries", () => {
    const oversized = buildInput();
    oversized.outerHtmlDigest = "x".repeat(12_000);

    const summary = buildPageContextSummary(oversized);
    expect(summary.length).toBeGreaterThan(12_000);
    expect(summary).not.toContain("...[truncated]");
  });

  it("restores page context entries from session storage cache", () => {
    const entries = [
      {
        url: "https://example.com/a",
        summary: "A summary",
        links: ["- A"],
        interactables: ["- button #a"],
        capturedAt: 123,
        version: PAGE_CONTEXT_CACHE_VERSION,
      },
    ];
    sessionStorage.setItem(PAGE_CONTEXT_CACHE_KEY, JSON.stringify(entries));

    const restored = getCachedPageContexts();
    expect(restored).toHaveLength(1);
    expect(restored[0].url).toBe("https://example.com/a");
  });

  it("ignores cache entries with incompatible version", () => {
    const entries = [
      {
        url: "https://example.com/a",
        summary: "A summary",
        links: [],
        interactables: [],
        capturedAt: 123,
        version: PAGE_CONTEXT_CACHE_VERSION + 1,
      },
    ];
    sessionStorage.setItem(PAGE_CONTEXT_CACHE_KEY, JSON.stringify(entries));

    expect(getCachedPageContexts()).toHaveLength(0);
  });
});
