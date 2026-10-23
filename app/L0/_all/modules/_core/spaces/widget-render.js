function createElement(tagName, className = "", text = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (text) {
    element.textContent = text;
  }

  return element;
}

function renderChildren(children, parent) {
  children.forEach((child) => {
    const nextNode = renderWidgetNode(child);

    if (nextNode) {
      parent.appendChild(nextNode);
    }
  });
}

function renderObjectFallback(value) {
  const pre = createElement("pre", "spaces-widget-output-json");
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

export function renderWidgetNode(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }

  if (value instanceof Node) {
    return value;
  }

  if (Array.isArray(value)) {
    const fragment = document.createDocumentFragment();
    renderChildren(value, fragment);
    return fragment;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return createElement("p", "spaces-widget-output-copy", String(value));
  }

  if (value && typeof value === "object") {
    return renderObjectFallback(value);
  }

  return createElement("p", "spaces-widget-output-copy", String(value));
}

export function renderWidgetOutput(output, targetElement) {
  if (!targetElement) {
    return;
  }

  targetElement.replaceChildren();
  const renderedNode = renderWidgetNode(output);

  if (renderedNode) {
    targetElement.appendChild(renderedNode);
  }
}
