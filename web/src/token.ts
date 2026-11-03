// The server's per-run token. The launch URL carries it once (?token=…); it is
// taken off the address bar and kept in this origin's localStorage so a
// reload still has it. It is the one thing kept there: the rest of the page's
// state lives on the server (persist.ts), and loading it needs this token.

export const TOKEN_KEY = "tablepeek.token";

function initialToken(): string {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(window.location.href).searchParams.get("token");
  } catch {
    fromUrl = null;
  }
  if (fromUrl) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
    } catch {}
    try {
      window.localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {}
    return fromUrl;
  }
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export const authToken = initialToken();
