import type { EngineIcon } from "../types";

// A rounded S in a ring, drawn for TablePeek after ScyllaDB's colours (not
// the trademarked logo itself): it only labels the database type.
export const icon: EngineIcon = {
  color: "#6cd5e7",
  viewBox: "0 0 24 24",
  paths: [
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z",
    "M15.5 8.6c-.8-.9-2-1.4-3.4-1.4-2.2 0-3.6 1.2-3.6 2.8 0 1.8 1.6 2.4 3.3 2.8 1.3.3 2 .6 2 1.3 0 .7-.7 1.2-1.8 1.2-1 0-1.9-.4-2.6-1.2l-1.2 1.3c.9 1 2.2 1.6 3.8 1.6 2.3 0 3.8-1.2 3.8-3 0-1.8-1.5-2.4-3.3-2.8-1.3-.3-2-.6-2-1.2 0-.6.6-1 1.5-1 .9 0 1.6.3 2.2.9l1.3-1.3z",
  ],
};
