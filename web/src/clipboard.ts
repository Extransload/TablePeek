import { t } from "./i18n";

// Resolves to whether the text reached the clipboard.
export async function writeClipboard(
  text: string,
  onError?: (message: string) => void,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    onError?.(t("클립보드에 복사하지 못했습니다"));
    return false;
  }
}
