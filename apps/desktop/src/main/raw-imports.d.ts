/** Vite's `?raw` suffix imports a file's text (electron-vite and vitest). */
declare module "*?raw" {
  const source: string;
  export default source;
}
