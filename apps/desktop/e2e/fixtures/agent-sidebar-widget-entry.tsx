import { createRoot } from "react-dom/client";
import AgentMonitor from "./agent-sidebar-widget.js";

const root = document.getElementById("root");
if (!root) throw new Error("Guest root is missing");
createRoot(root).render(<AgentMonitor />);
