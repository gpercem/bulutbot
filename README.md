<p align="center">
  <img src="./public/bulut_banner_github.png" alt="Bulut Banner" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@auticlabs/bulut">
    <img src="https://img.shields.io/npm/v/@auticlabs/bulut" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/@auticlabs/bulut">
    <img src="https://img.shields.io/npm/dw/@auticlabs/bulut" alt="npm downloads" />
  </a>
  <a href="https://github.com/gpercem/bulutbot">
    <img src="https://img.shields.io/github/stars/gpercem/bulutbot" alt="github stars" />
  </a>
  <a href="https://github.com/gpercem/bulutbot/issues">
    <img src="https://img.shields.io/github/issues/gpercem/bulutbot" alt="issues" />
  </a>
  <a href="https://github.com/gpercem/bulutbot/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/gpercem/bulutbot" alt="license" />
  </a>
</p>

# Bulut

Bulut is an embeddable AI accessibility assistant for modern web applications.  
It provides real-time voice interaction, contextual understanding of your pages, and structured tool-based navigation — all isolated inside a Shadow DOM.

Designed for production use. Built for accessibility from the ground up.

---

## Core Capabilities

- Real-time voice pipeline (STT → LLM → TTS with streaming)
- Structured tool calling (navigate, click, scroll, context retrieval)
- Floating chat interface with compact and full chat modes
- Accessibility-first continuous conversation mode
- Shadow DOM isolation (no CSS leakage)
- Single bundle distribution
- Minimal integration surface

---

## Installation

```bash
npm install bulutbot
```

---

## Quick Integration

### React / Vite

```tsx
import { Bulut } from "bulutbot";

export default function App() {
  return (
    <>
      <h1>My App</h1>
      <Bulut projectId="your-project-id" />
    </>
  );
}
```

---

### Next.js (App Router)

The component internally uses `'use client'`, so it can be placed directly in layouts:

```tsx
// app/layout.tsx
import { Bulut } from "bulutbot";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Bulut projectId="your-project-id" />
      </body>
    </html>
  );
}
```

If conditional rendering is required:

```tsx
"use client";

import { Bulut } from "bulutbot";

export function ChatWidget() {
  return (
    <Bulut
      projectId="your-project-id"
      baseColor="#0ea5e9"
      voice="alloy"
    />
  );
}
```

---

### Next.js (Pages Router)

```tsx
// pages/_app.tsx
import type { AppProps } from "next/app";
import { Bulut } from "bulutbot";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <Bulut projectId="your-project-id" />
    </>
  );
}
```

---

### Vanilla HTML (Embed Mode)

For non-React environments:

```html
<script type="module">
  import Bulut from "https://unpkg.com/bulutbot/dist/embed.js";

  Bulut.init({
    projectId: "your-project-id"
  });
</script>
```

---

## Configuration

### Component Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `projectId` | `string` | — | Required project identifier. |
| `backendBaseUrl` | `string` | `"http://localhost:8000"` | Backend API base URL. |
| `model` | `string` | `"google/gemini-3-flash-preview:nitro"` | LLM identifier. |
| `voice` | `"alloy" \| "zeynep" \| "ali"` | `"alloy"` | TTS voice selection. |
| `baseColor` | `string` | `"#6C03C1"` | Primary accent color (hex). |

---

## Embed API

When using the embed entry:

### `Bulut.init(options)`

Initializes the widget.

Additional option:

- `containerId` — Mount into an existing element instead of auto-creating one.

```js
Bulut.init({
  projectId: "your-project-id",
  baseColor: "#0ea5e9"
});
```

### `Bulut.destroy()`

Unmounts the widget and cleans listeners.

### `Bulut.isReady()`

Returns boolean initialization state.

---

## Accessibility Mode

When accessibility mode is active:

- Voice becomes the primary interface
- Responses become more descriptive
- Listening auto-restarts after speech output
- Conversation flows continuously

This mode is optimized for visually impaired users and hands-free environments.

---

## Architecture Notes

Bulut dynamically loads a lightweight Preact-based runtime and mounts it inside a Shadow DOM container.

Implications:

1. No global style collisions.
2. SSR-safe via runtime import.
3. Small bundle size.
4. Framework-agnostic backend communication.

The assistant retrieves structured page context and executes explicit tool calls instead of relying purely on text generation.

---

## Browser Support

ES2020+ environments:

- Chrome 80+
- Firefox 80+
- Safari 14+
- Edge 80+

---

## Links

- Website: https://bulut.lu  
- About: https://bulut.lu/about  
- npm: https://www.npmjs.com/package/@auticlabs/bulut  
- Backend Repository: https://github.com/gpercem/bulutbot  

---

## License

This project is licensed under the [MIT License](./LICENSE).
