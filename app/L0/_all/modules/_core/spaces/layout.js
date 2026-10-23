import {
  DEFAULT_WIDGET_POSITION,
  DEFAULT_WIDGET_SIZE,
  GRID_COORD_MAX,
  GRID_COORD_MIN
} from "/modules/_core/spaces/constants.js";
import { normalizeWidgetSize } from "/modules/_core/spaces/widget-sdk-core.js";

function clampInteger(value, min, max, fallback) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

function coercePositionObject(position, fallbackPosition = DEFAULT_WIDGET_POSITION) {
  return {
    col: clampInteger(position?.col ?? position?.x, GRID_COORD_MIN, GRID_COORD_MAX, fallbackPosition.col),
    row: clampInteger(position?.row ?? position?.y, GRID_COORD_MIN, GRID_COORD_MAX, fallbackPosition.row)
  };
}

function resolveFallbackPosition(fallback) {
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    return coercePositionObject(fallback, DEFAULT_WIDGET_POSITION);
  }

  if (typeof fallback === "string") {
    const match = fallback
      .trim()
      .match(/^(-?\d+)\s*,\s*(-?\d+)$/u);

    if (match) {
      return coercePositionObject(
        {
          col: match[1],
          row: match[2]
        },
        DEFAULT_WIDGET_POSITION
      );
    }
  }

  if (Array.isArray(fallback) && fallback.length >= 2) {
    return coercePositionObject(
      {
        col: fallback[0],
        row: fallback[1]
      },
      DEFAULT_WIDGET_POSITION
    );
  }

  return {
    col: DEFAULT_WIDGET_POSITION.col,
    row: DEFAULT_WIDGET_POSITION.row
  };
}

export function normalizeWidgetPosition(position, fallback = DEFAULT_WIDGET_POSITION) {
  const fallbackPosition = resolveFallbackPosition(fallback);

  if (typeof position === "string") {
    const match = position
      .trim()
      .match(/^(-?\d+)\s*,\s*(-?\d+)$/u);

    if (match) {
      return coercePositionObject(
        {
          col: match[1],
          row: match[2]
        },
        fallbackPosition
      );
    }
  }

  if (Array.isArray(position) && position.length >= 2) {
    return coercePositionObject(
      {
        col: position[0],
        row: position[1]
      },
      fallbackPosition
    );
  }

  if (position && typeof position === "object") {
    return coercePositionObject(position, fallbackPosition);
  }

  return {
    col: fallbackPosition.col,
    row: fallbackPosition.row
  };
}

export function positionToToken(position, fallback = DEFAULT_WIDGET_POSITION) {
  const normalizedPosition = normalizeWidgetPosition(position, fallback);
  return `${normalizedPosition.col},${normalizedPosition.row}`;
}

export function getRenderedWidgetSize(size, minimized = false) {
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);

  if (!minimized) {
    return normalizedSize;
  }

  return {
    ...normalizedSize,
    rows: 1
  };
}

export function clampWidgetPosition(position, size) {
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);
  const normalizedPosition = normalizeWidgetPosition(position, DEFAULT_WIDGET_POSITION);

  return {
    col: Math.min(GRID_COORD_MAX - normalizedSize.cols + 1, Math.max(GRID_COORD_MIN, normalizedPosition.col)),
    row: Math.min(GRID_COORD_MAX - normalizedSize.rows + 1, Math.max(GRID_COORD_MIN, normalizedPosition.row))
  };
}

function createRect(widgetId, position, size) {
  const clampedPosition = clampWidgetPosition(position, size);

  return {
    bottom: clampedPosition.row + size.rows - 1,
    left: clampedPosition.col,
    right: clampedPosition.col + size.cols - 1,
    top: clampedPosition.row,
    widgetId
  };
}

function doRectsOverlap(leftRect, rightRect) {
  return !(
    leftRect.right < rightRect.left ||
    leftRect.left > rightRect.right ||
    leftRect.bottom < rightRect.top ||
    leftRect.top > rightRect.bottom
  );
}

function canPlaceRect(position, size, occupiedRects) {
  const nextRect = createRect("", position, size);

  return occupiedRects.every((occupiedRect) => !doRectsOverlap(nextRect, occupiedRect));
}

function buildColumnSearchOrder(startCol, radius) {
  const columns = [startCol];

  for (let offset = 1; offset <= radius; offset += 1) {
    columns.push(startCol + offset, startCol - offset);
  }

  return columns.filter((value, index, values) => values.indexOf(value) === index);
}

function findFirstAvailablePosition(size, occupiedRects, preferredPosition = DEFAULT_WIDGET_POSITION) {
  const normalizedSize = normalizeWidgetSize(size, DEFAULT_WIDGET_SIZE);
  const normalizedPosition = clampWidgetPosition(preferredPosition, normalizedSize);
  const minCol = GRID_COORD_MIN;
  const maxCol = GRID_COORD_MAX - normalizedSize.cols + 1;
  const columnSearchOrder = buildColumnSearchOrder(
    Math.min(maxCol, Math.max(minCol, normalizedPosition.col)),
    GRID_COORD_MAX - GRID_COORD_MIN
  );

  for (let row = normalizedPosition.row; row <= GRID_COORD_MAX - normalizedSize.rows + 1; row += 1) {
    for (const currentCol of columnSearchOrder) {
      if (currentCol < minCol || currentCol > maxCol) {
        continue;
      }

      const position = {
        col: currentCol,
        row
      };

      if (canPlaceRect(position, normalizedSize, occupiedRects)) {
        return position;
      }
    }
  }

  return {
    col: normalizedPosition.col,
    row: normalizedPosition.row
  };
}

export function resolveSpaceLayout({
  anchorMinimized = undefined,
  anchorPosition = undefined,
  anchorSize = undefined,
  anchorWidgetId = "",
  minimizedWidgetIds = [],
  widgetIds = [],
  widgetPositions = {},
  widgetSizes = {}
} = {}) {
  const minimizedSet = new Set(Array.isArray(minimizedWidgetIds) ? minimizedWidgetIds : []);
  const entries = widgetIds.map((widgetId, index) => {
    const preferredPosition =
      widgetId === anchorWidgetId && anchorPosition !== undefined
        ? normalizeWidgetPosition(anchorPosition, widgetPositions[widgetId] || DEFAULT_WIDGET_POSITION)
        : normalizeWidgetPosition(widgetPositions[widgetId], DEFAULT_WIDGET_POSITION);
    const minimized =
      widgetId === anchorWidgetId && anchorMinimized !== undefined
        ? Boolean(anchorMinimized)
        : minimizedSet.has(widgetId);
    const storedSize =
      widgetId === anchorWidgetId && anchorSize !== undefined
        ? normalizeWidgetSize(anchorSize, widgetSizes[widgetId] || DEFAULT_WIDGET_SIZE)
        : normalizeWidgetSize(widgetSizes[widgetId], DEFAULT_WIDGET_SIZE);

    return {
      index,
      minimized,
      preferredPosition,
      renderedSize: getRenderedWidgetSize(storedSize, minimized),
      storedSize,
      widgetId
    };
  });

  entries.sort((left, right) => {
    if (left.widgetId === anchorWidgetId && right.widgetId !== anchorWidgetId) {
      return -1;
    }

    if (right.widgetId === anchorWidgetId && left.widgetId !== anchorWidgetId) {
      return 1;
    }

    if (left.preferredPosition.row !== right.preferredPosition.row) {
      return left.preferredPosition.row - right.preferredPosition.row;
    }

    if (left.preferredPosition.col !== right.preferredPosition.col) {
      return left.preferredPosition.col - right.preferredPosition.col;
    }

    return left.index - right.index;
  });

  const occupiedRects = [];
  const positions = {};
  const renderedSizes = {};
  const minimizedMap = {};

  entries.forEach((entry) => {
    const resolvedPosition = findFirstAvailablePosition(entry.renderedSize, occupiedRects, entry.preferredPosition);
    positions[entry.widgetId] = resolvedPosition;
    renderedSizes[entry.widgetId] = entry.renderedSize;
    minimizedMap[entry.widgetId] = entry.minimized;
    occupiedRects.push(createRect(entry.widgetId, resolvedPosition, entry.renderedSize));
  });

  return {
    minimizedMap,
    positions,
    renderedSizes
  };
}

function buildPackingEntries(widgetIds = [], widgetSizes = {}) {
  return widgetIds.map((widgetId, index) => {
    const size = normalizeWidgetSize(widgetSizes?.[widgetId], DEFAULT_WIDGET_SIZE);

    return {
      area: size.cols * size.rows,
      index,
      size,
      widgetId
    };
  });
}

const PACKING_VIEWPORT_HEADROOM_COLS = 2;

function sortPackingEntries(entries) {
  return [...entries].sort((left, right) => {
    if (right.area !== left.area) {
      return right.area - left.area;
    }

    if (right.size.cols !== left.size.cols) {
      return right.size.cols - left.size.cols;
    }

    if (right.size.rows !== left.size.rows) {
      return right.size.rows - left.size.rows;
    }

    return left.index - right.index;
  });
}

function resolvePackingWidthThreshold(entries, viewportCols = 0) {
  return resolvePackingWidthThresholdWithMode(entries, viewportCols, true);
}

function resolvePackingWidthThresholdWithMode(entries, viewportCols = 0, capToTotalWidth = true) {
  if (!entries.length) {
    return 1;
  }

  const maxWidgetWidth = entries.reduce((maxWidth, entry) => Math.max(maxWidth, entry.size.cols), 1);
  const totalWidth = entries.reduce((sum, entry) => sum + entry.size.cols, 0);
  const normalizedViewportCols = Number.isFinite(viewportCols) && viewportCols > 0
    ? Math.max(1, Math.floor(viewportCols) - PACKING_VIEWPORT_HEADROOM_COLS)
    : totalWidth;

  if (!capToTotalWidth) {
    return Math.max(maxWidgetWidth, normalizedViewportCols);
  }

  return Math.max(maxWidgetWidth, Math.min(totalWidth, Math.max(maxWidgetWidth, normalizedViewportCols)));
}

function isScanCellOccupied(position, occupiedRects) {
  return !canPlaceRect(position, { cols: 1, rows: 1 }, occupiedRects);
}

function findPhysicallyFittingEntry(entries, position, widthThreshold, occupiedRects) {
  for (const entry of entries) {
    if ((position.col + entry.size.cols) > widthThreshold) {
      continue;
    }

    if (!canPlaceRect(position, entry.size, occupiedRects)) {
      continue;
    }

    return entry;
  }

  return null;
}

function buildFirstFitPackedPositions(entries, widthThreshold, options = {}) {
  const occupiedRects = Array.isArray(options.occupiedRects) ? [...options.occupiedRects] : [];
  const positions = {};
  const remainingEntries = sortPackingEntries(entries);
  let row = Number.isFinite(options.startRow) ? Math.max(0, Math.floor(options.startRow)) : 0;

  while (remainingEntries.length) {
    for (let col = 0; col < widthThreshold; col += 1) {
      const candidatePosition = {
        col,
        row
      };

      if (isScanCellOccupied(candidatePosition, occupiedRects)) {
        continue;
      }

      const matchingEntry = findPhysicallyFittingEntry(remainingEntries, candidatePosition, widthThreshold, occupiedRects);

      if (!matchingEntry) {
        continue;
      }

      positions[matchingEntry.widgetId] = candidatePosition;
      occupiedRects.push(createRect(matchingEntry.widgetId, candidatePosition, matchingEntry.size));
      remainingEntries.splice(remainingEntries.indexOf(matchingEntry), 1);
    }

    row += 1;
  }

  return positions;
}

function buildOccupiedRects(widgetPositions = {}, widgetSizes = {}, offset = { col: 0, row: 0 }) {
  return Object.entries(widgetPositions || {}).map(([widgetId, position]) =>
    createRect(
      widgetId,
      {
        col: position.col - offset.col,
        row: position.row - offset.row
      },
      normalizeWidgetSize(widgetSizes?.[widgetId], DEFAULT_WIDGET_SIZE)
    )
  );
}

function computePackedBounds(positions, sizes) {
  const bounds = {
    maxCol: 0,
    maxRow: 0,
    minCol: 0,
    minRow: 0
  };
  let hasPositions = false;

  Object.entries(positions || {}).forEach(([widgetId, position]) => {
    const size = normalizeWidgetSize(sizes?.[widgetId], DEFAULT_WIDGET_SIZE);
    const right = position.col + size.cols;
    const bottom = position.row + size.rows;

    if (!hasPositions) {
      bounds.minCol = position.col;
      bounds.maxCol = right;
      bounds.minRow = position.row;
      bounds.maxRow = bottom;
      hasPositions = true;
      return;
    }

    bounds.minCol = Math.min(bounds.minCol, position.col);
    bounds.maxCol = Math.max(bounds.maxCol, right);
    bounds.minRow = Math.min(bounds.minRow, position.row);
    bounds.maxRow = Math.max(bounds.maxRow, bottom);
  });

  if (!hasPositions) {
    return {
      height: 0,
      maxCol: 0,
      maxRow: 0,
      minCol: 0,
      minRow: 0,
      width: 0
    };
  }

  return {
    ...bounds,
    height: bounds.maxRow - bounds.minRow,
    width: bounds.maxCol - bounds.minCol
  };
}

function centerPackedPositions(positions, sizes) {
  const bounds = computePackedBounds(positions, sizes);
  const desiredMinCol = -Math.floor(bounds.width / 2);
  const desiredMinRow = -Math.floor(bounds.height / 2);
  const shiftCol = desiredMinCol - bounds.minCol;
  const shiftRow = desiredMinRow - bounds.minRow;

  if (shiftCol === 0 && shiftRow === 0) {
    return {
      bounds,
      positions
    };
  }

  const centeredPositions = Object.fromEntries(
    Object.entries(positions || {}).map(([widgetId, position]) => [
      widgetId,
      {
        col: position.col + shiftCol,
        row: position.row + shiftRow
      }
    ])
  );

  return {
    bounds: computePackedBounds(centeredPositions, sizes),
    positions: centeredPositions
  };
}

export function buildCenteredFirstFitLayout({
  viewportCols = 0,
  widgetIds = [],
  widgetSizes = {}
} = {}) {
  const entries = buildPackingEntries(widgetIds, widgetSizes);

  if (!entries.length) {
    return {
      positions: {}
    };
  }

  const widthThreshold = resolvePackingWidthThreshold(entries, viewportCols);
  const positions = buildFirstFitPackedPositions(entries, widthThreshold);
  const centeredLayout = centerPackedPositions(positions, widgetSizes);

  return {
    positions: centeredLayout.positions || {}
  };
}

export function findFirstFitWidgetPlacement({
  existingWidgetPositions = {},
  existingWidgetSizes = {},
  viewportCols = 0,
  widgetSize = DEFAULT_WIDGET_SIZE
} = {}) {
  const normalizedWidgetSize = normalizeWidgetSize(widgetSize, DEFAULT_WIDGET_SIZE);
  const normalizedExistingPositions = existingWidgetPositions && typeof existingWidgetPositions === "object" ? existingWidgetPositions : {};
  const normalizedExistingSizes = existingWidgetSizes && typeof existingWidgetSizes === "object" ? existingWidgetSizes : {};
  const existingBounds = computePackedBounds(normalizedExistingPositions, normalizedExistingSizes);
  const hasExistingWidgets = Object.keys(normalizedExistingPositions).length > 0;
  const originOffset = hasExistingWidgets
    ? {
        col: existingBounds.minCol,
        row: existingBounds.minRow
      }
    : {
        col: 0,
        row: 0
      };
  const widthThreshold = resolvePackingWidthThresholdWithMode(
    [
      {
        area: normalizedWidgetSize.cols * normalizedWidgetSize.rows,
        index: 0,
        size: normalizedWidgetSize,
        widgetId: "__candidate__"
      }
    ],
    viewportCols,
    false
  );
  const localPositions = buildFirstFitPackedPositions(
    [
      {
        area: normalizedWidgetSize.cols * normalizedWidgetSize.rows,
        index: 0,
        size: normalizedWidgetSize,
        widgetId: "__candidate__"
      }
    ],
    widthThreshold,
    {
      occupiedRects: buildOccupiedRects(normalizedExistingPositions, normalizedExistingSizes, originOffset)
    }
  );
  const localPosition = localPositions.__candidate__ || DEFAULT_WIDGET_POSITION;

  return {
    col: localPosition.col + originOffset.col,
    row: localPosition.row + originOffset.row
  };
}
