import { loadUiState } from "./persist";

// The saved UI state is in place before the app's modules load: several read
// theirs as they load (the settings apply themselves, the language is picked).
// A saved Tern theme is loaded first too, so the app is never drawn in the
// default theme's colours for a moment.
void loadUiState()
  .then(() => import("./ternThemes"))
  .then(({ loadSavedTheme }) => loadSavedTheme())
  .catch(() => {})
  .then(() => import("./boot"));
