// Renders the playground demo video from the Revideo composition in ./video.
// Expects the chapter clips (c1..c5.mp4) in ./public, produced by capture.mjs
// + the ffmpeg cutting step. Usage: node render.mjs

process.env.DISABLE_TELEMETRY = "true";

const { renderVideo } = await import("@revideo/renderer");

const file = await renderVideo({
  projectFile: "./video/project.ts",
  settings: {
    outFile: "catamorphic-playground-demo.mp4",
    outDir: "./out",
    logProgress: true,
  },
});

console.log(`Rendered: ${file}`);
