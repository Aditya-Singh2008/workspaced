import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app";
import { initPlatform } from "./platform";
import "./theme/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// Resolved before the first render so every synchronous `currentPlatform()`
// caller — keybind matching above all — sees the authoritative value rather
// than the user-agent fallback. Never rejects, so it cannot block startup.
await initPlatform();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
