import { loadUiState } from "./persist";

// The saved UI state is in place before the app's modules load: several read
// theirs as they load (the settings apply themselves, the language is picked).
void loadUiState().then(() => import("./boot"));
