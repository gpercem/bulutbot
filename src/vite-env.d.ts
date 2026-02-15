/// <reference types="vite/client" />

declare module "*.svg?inline" {
  const src: string;
  export default src;
}

declare module "*.woff2?inline" {
  const src: string;
  export default src;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}

/** Injected by Vite at build time from package.json version. */
declare const __BULUT_VERSION__: string;
