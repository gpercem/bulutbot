/**
 * Tunable parameters for page context collection.
 *
 * Adjust these values to control how much information the agent receives
 * about the current page.  Lower values reduce token usage (and latency);
 * higher values give the LLM more detail to work with.
 */

/** Maximum number of links to include in the context. */
export const MAX_LINKS = 20;

/** Maximum number of interactable elements to include. */
export const MAX_INTERACTABLES = 24;

/** Maximum number of headings (h1-h3) to include. */
export const MAX_HEADINGS = 10;

/** Maximum number of main-content text snippets. */
export const MAX_TEXT_SNIPPETS = 4;

/** Maximum number of pages kept in the in-memory context cache. */
export const MAX_CACHED_PAGES = 20;

/** Maximum number of DOM elements scanned per page. */
export const MAX_PAGE_SCAN_ELEMENTS = 2000;

/** Maximum number of event-handler hints collected per element. */
export const MAX_EVENT_HINTS_PER_ELEMENT = 4;

/** Maximum top-level DOM branches sampled for the branch digest. */
export const MAX_BRANCH_SAMPLES = 4;

/** Maximum tree depth for each branch digest sample. */
export const MAX_BRANCH_DEPTH = 2;

/** Maximum stylesheet selectors to include in summary. */
export const MAX_STYLESHEET_SELECTORS = 80;

/** Maximum CSS rules to scan while collecting stylesheet selectors. */
export const MAX_STYLESHEET_RULES = 700;
