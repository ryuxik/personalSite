/**
 * Vite `?url` imports of font binaries.
 *
 * astro/client declares the image/media asset modules but not `*?url`, and
 * BaseLayout preloads the two latin-subset variable woff2 files by importing
 * their built URLs (never a hardcoded /_astro/ hash — those change per build).
 */
declare module '*.woff2?url' {
  const src: string;
  export default src;
}
