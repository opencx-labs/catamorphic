import { makeProject } from "@revideo/core";
import scene from "./scene.tsx";

export default makeProject({
  name: "catamorphic-playground-demo",
  scenes: [scene],
  settings: {
    shared: {
      size: { x: 1920, y: 1080 },
      background: "#0a0a0a",
    },
    rendering: {
      fps: 30,
    },
  },
});
