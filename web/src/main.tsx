import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { migrateGroupNames } from "./connGroups";
import { applyServerEngines } from "./engines";
import { installScrollbars } from "./scrollbars";
import { store } from "./store";
import "./styles.css";

// Group names from older versions become groups once, before anything renders.
migrateGroupNames();
installScrollbars();

function render(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The server's engine descriptions replace the bundled copies before the first
// render; when it can't be reached the bundled ones stand in, and the screens
// report the unreachable server as they do for any request.
store
  .listEngines()
  .then(applyServerEngines)
  .catch(() => {})
  .finally(render);
