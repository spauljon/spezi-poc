/**
 * A small, dependency-free accessibility audit of a rendered DOM. It checks what a test runner can know (names, structure,
 * hiding); it cannot see contrast, focus order on a real screen or a screen reader's output, which need a real browser.
 */
export interface Problem {
  readonly rule: string;
  readonly where: string;
}

/** The text a screen reader would read: content under aria-hidden is left out. */
const text = (el: Element | null | undefined) => {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
};

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `<${el.tagName.toLowerCase()}${id}${cls}> "${text(el).slice(0, 40)}"`;
}

/** The accessible name, by the rules that matter here (aria-labelledby, aria-label, label, content, alt). */
export function nameOf(el: Element, root: Document | Element = document): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const named = labelledby.split(/\s+/).map((id) => text(root.ownerDocument?.getElementById(id) ?? (root as Document).getElementById?.(id))).join(" ").trim();
    if (named) return named;
  }
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  if (el.id) {
    const forLabel = (el.ownerDocument ?? document).querySelector(`label[for="${el.id}"]`);
    if (forLabel && text(forLabel)) return text(forLabel);
  }
  const wrapping = el.closest("label");
  if (wrapping && text(wrapping)) return text(wrapping);
  if (el.tagName === "IMG") return el.getAttribute("alt")?.trim() ?? "";
  const content = text(el);
  if (content) return content;
  // an icon-only control may be named by an image inside it
  return el.querySelector("img[alt]")?.getAttribute("alt")?.trim() ?? "";
}

export function audit(container: Element): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: string, el: Element) => problems.push({ rule, where: describe(el) });

  // 1. every control has an accessible name
  for (const el of container.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], summary")) {
    if (nameOf(el) === "") add("a control has no accessible name", el);
  }
  // 2. anything focusable by tab (a chart, a scroller) has a name too
  for (const el of container.querySelectorAll('[tabindex="0"]:not(button):not(a):not(input):not(select):not(textarea):not(summary)')) {
    if (nameOf(el) === "") add("a tab-focusable element has no accessible name", el);
  }
  // 3. tables: a caption or a name, and header cells with a scope
  for (const table of container.querySelectorAll("table")) {
    if (!table.querySelector("caption") && !table.getAttribute("aria-label") && !table.getAttribute("aria-labelledby")) add("a table has no caption or name", table);
    for (const th of table.querySelectorAll("th")) {
      if (!th.getAttribute("scope")) add("a header cell has no scope", th);
    }
  }
  // 4. headings do not skip a level
  let previous = 0;
  for (const h of container.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const level = Number(h.tagName[1]);
    if (previous !== 0 && level > previous + 1) add(`a heading jumps from h${previous} to h${level}`, h);
    if (text(h) === "") add("a heading is empty", h);
    previous = level;
  }
  // 5. ids are unique
  const seen = new Map<string, number>();
  for (const el of container.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) problems.push({ rule: "an id is used more than once", where: `#${id} x${n}` });
  // 6. nothing focusable is hidden from assistive technology
  for (const hidden of container.querySelectorAll('[aria-hidden="true"]')) {
    for (const f of hidden.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
      add("a focusable element sits inside aria-hidden", f);
    }
  }
  // 7. images have alt text (an empty alt is a deliberate decoration)
  for (const img of container.querySelectorAll("img")) {
    if (!img.hasAttribute("alt")) add("an image has no alt attribute", img);
  }
  // 8. a role=group or region that is announced has a name
  for (const el of container.querySelectorAll('[role="group"], [role="region"], section[aria-labelledby]')) {
    if (nameOf(el) === "") add("a group or region has no name", el);
  }
  // 9. live regions that carry a status use a polite or assertive setting, never an empty one
  for (const el of container.querySelectorAll("[aria-live]")) {
    if (!["polite", "assertive", "off"].includes(el.getAttribute("aria-live") ?? "")) add("aria-live has an invalid value", el);
  }
  return problems;
}
