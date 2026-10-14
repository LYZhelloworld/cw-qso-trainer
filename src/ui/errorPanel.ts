import { button, clear, el } from "./dom.js";

/**
 * Render a self-contained error panel into `root` when a page renderer throws.
 * Keeps the rest of the app (nav, other pages, background QSO) alive instead of
 * blanking the whole screen, and offers a retry that re-renders the page.
 */
export function renderErrorPanel(
  root: HTMLElement,
  pageId: string,
  err: unknown,
  onRetry: () => void,
): void {
  clear(root);
  const panel = el("div", { class: "panel error-panel" });
  panel.append(el("h2", { text: "页面渲染出错" }));
  panel.append(
    el("p", {
      class: "hint",
      text: `「${pageId}」页面发生意外错误，已就地隔离。其他页面与后台通联不受影响。`,
    }),
  );
  const detail =
    err instanceof Error
      ? `${err.message}${err.stack ? `\n\n${err.stack}` : ""}`.trim()
      : String(err);
  panel.append(el("pre", { class: "error-detail", text: detail }));
  panel.append(button("重试", onRetry, "btn"));
  root.append(panel);
}
