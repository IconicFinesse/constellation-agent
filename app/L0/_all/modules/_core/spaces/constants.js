export const SPACES_ROUTE_PATH = "spaces";
export const SPACES_SCHEMA = "spaces/v2";
export const SPACE_WIDGET_SCHEMA = "space-widget/v1";
export const WIDGET_API_VERSION = 1;

export const SPACES_ROOT_PATH = "~/spaces/";
export const SPACE_MANIFEST_FILE = "space.yaml";
export const SPACE_WIDGETS_DIR = "widgets/";
export const SPACE_WIDGET_FILE_EXTENSION = ".yaml";
export const SPACE_DATA_DIR = "data/";
export const SPACE_ASSETS_DIR = "assets/";
export const SPACE_SCRIPTS_DIR = "scripts/";

export const GRID_COORD_MIN = -4096;
export const GRID_COORD_MAX = 4096;
export const MAX_WIDGET_COLS = 24;
export const MAX_WIDGET_ROWS = 24;
export const DEFAULT_WIDGET_POSITION = Object.freeze({
  col: 0,
  row: 0
});
export const DEFAULT_WIDGET_SIZE = Object.freeze({
  cols: 6,
  rows: 3
});

export const WIDGET_SIZE_PRESETS = Object.freeze({
  small: Object.freeze({ cols: 4, rows: 2 }),
  medium: Object.freeze({ cols: 6, rows: 3 }),
  large: Object.freeze({ cols: 8, rows: 4 }),
  tall: Object.freeze({ cols: 4, rows: 5 }),
  full: Object.freeze({ cols: 12, rows: 4 })
});
