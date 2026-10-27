import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { migrateGroupNames } from "./connGroups";
import { installScrollbars } from "./scrollbars";
import "./styles.css";

// Group names from older versions become groups once, before anything renders.
migrateGroupNames();
installScrollbars();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
