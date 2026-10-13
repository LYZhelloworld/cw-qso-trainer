/** Minimal DOM helpers. Keeps page modules declarative without a framework. */

interface ElOpts {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOpts = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(c);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = el("button", { class: cls, text: label });
  b.addEventListener("click", onClick);
  return b;
}

export function textInput(
  type: "text" | "number",
  value: string,
  onInput: (value: string) => void,
  attrs: Record<string, string> = {},
): HTMLInputElement {
  const i = el("input", { attrs: { type, ...attrs } });
  i.value = value;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const box = el("input", { attrs: { type: "checkbox" } });
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  const wrap = el("label", { class: "row" });
  wrap.style.gap = "6px";
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

export function numberField(
  label: string,
  value: number,
  onInput: (value: number) => void,
  attrs: Record<string, string> = {},
): HTMLLabelElement {
  const inp = textInput("number", String(value), (v) => {
    const n = Number(v);
    if (Number.isFinite(n)) onInput(n);
  }, attrs);
  const wrap = el("label", { class: "field" });
  wrap.append(document.createTextNode(label), inp);
  return wrap;
}

export function textField(
  label: string,
  value: string,
  onInput: (value: string) => void,
): HTMLLabelElement {
  const inp = textInput("text", value, onInput);
  const wrap = el("label", { class: "field" });
  wrap.append(document.createTextNode(label), inp);
  return wrap;
}

export function panel(title: string, ...children: Array<Node | string>): HTMLDivElement {
  const p = el("div", { class: "panel" });
  p.append(el("h2", { text: title }));
  for (const c of children) p.append(c);
  return p;
}
