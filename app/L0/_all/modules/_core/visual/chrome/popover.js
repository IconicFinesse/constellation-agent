const DEFAULT_VIEWPORT_MARGIN = 12;
const DEFAULT_GAP = 8;
const AUTO_PLACEMENT_BOTTOM_SPACE_MULTIPLIER = 2.2;
const MIN_POPOVER_HEIGHT = 120;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function positionPopover(panel, anchor, options = {}) {
  if (!panel || !anchor) {
    return {
      left: DEFAULT_VIEWPORT_MARGIN,
      maxHeight: 240,
      top: DEFAULT_VIEWPORT_MARGIN
    };
  }

  const align = options.align === "start" ? "start" : "end";
  const gap = Number.isFinite(options.gap) ? options.gap : DEFAULT_GAP;
  const viewportMargin = Number.isFinite(options.viewportMargin) ? options.viewportMargin : DEFAULT_VIEWPORT_MARGIN;
  const placement =
    options.placement === "top" || options.placement === "bottom" ? options.placement : "auto";
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const measuredPanelHeight = Math.max(MIN_POPOVER_HEIGHT, panelRect.height);
  const bottomSpace = globalThis.innerHeight - anchorRect.bottom - gap - viewportMargin;
  const bottomSpaceThreshold = measuredPanelHeight * AUTO_PLACEMENT_BOTTOM_SPACE_MULTIPLIER;
  const topSpace = anchorRect.top - gap - viewportMargin;
  const shouldOpenUpward =
    placement === "top"
      ? true
      : placement === "bottom"
        ? false
        : bottomSpace < bottomSpaceThreshold && topSpace > bottomSpace;
  const maxHeight = Math.max(MIN_POPOVER_HEIGHT, shouldOpenUpward ? topSpace : bottomSpace);
  const panelHeight = Math.min(measuredPanelHeight, maxHeight);
  const maximumLeft = Math.max(viewportMargin, globalThis.innerWidth - panelRect.width - viewportMargin);
  const maximumTop = Math.max(viewportMargin, globalThis.innerHeight - panelHeight - viewportMargin);

  let left = align === "start" ? anchorRect.left : anchorRect.right - panelRect.width;
  left = clamp(left, viewportMargin, maximumLeft);

  let top = shouldOpenUpward ? anchorRect.top - gap - panelHeight : anchorRect.bottom + gap;
  top = clamp(top, viewportMargin, maximumTop);

  return {
    left: Math.round(left),
    maxHeight: Math.round(maxHeight),
    top: Math.round(top)
  };
}
