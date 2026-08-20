import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/message.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("entangle: #root container missing from index.html");
}

// `?fixture=NAME` hands the root to the dev harness (ui/src/dev.tsx), which
// resolves ui/src/fixtures/NAME.tsx by convention. Lazily imported so the
// harness and every fixture stay out of the entry chunk.
// Do not drop the `import.meta.env.DEV` guard: it is statically false in a
// production build, which is what lets Rollup prove the branch dead and omit
// dev.tsx and every fixture chunk from the published package.
const fixture = new URLSearchParams(window.location.search).get("fixture");

if (fixture && import.meta.env.DEV) {
  void import("./dev").then((harness) => harness.mountFixture(container, fixture));
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
