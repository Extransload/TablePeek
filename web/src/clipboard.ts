import { t } from "./i18n";

export async function writeClipboard(
  text: string,
  onError?: (message: string) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    onError?.(t("클립보드에 복사하지 못했습니다"));
  }
}
