export const USER_HOME_FILE_TREE_TRANSIENT_HEADING = "user home files";
export const USER_HOME_FILE_TREE_TRANSIENT_KEY = "user/home-file-tree";
export const USER_HOME_FILE_TREE_TRANSIENT_ORDER = 100;
export const USER_HOME_FILE_TREE_DEFAULTS = Object.freeze({
  maxDepth: 5,
  maxFilesPerFolder: 20,
  maxFoldersPerFolder: 20,
  maxLines: 250
});

const HOME_ROOT_DISPLAY_PATH = "~/";
const HOME_TREE_EMPTY_LINE = "# empty";
const INDENT_UNIT = "  ";
const LINE_LIMIT_REASON = "line limit";
const MAX_DEPTH_REASON = "max depth";
const OMITTED_DIRECTORY_BASENAMES = new Set([".git"]);

function createTreeNode(name = "") {
  return {
    directories: new Map(),
    files: new Set(),
    name: String(name || "").trim()
  };
}

function normalizePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function normalizeNonNegativeInteger(value, fallbackValue = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

function normalizeUserHomeTreeOptions(options = {}) {
  return {
    maxDepth: normalizePositiveInteger(options.maxDepth, USER_HOME_FILE_TREE_DEFAULTS.maxDepth),
    maxFilesPerFolder: normalizePositiveInteger(
      options.maxFilesPerFolder,
      USER_HOME_FILE_TREE_DEFAULTS.maxFilesPerFolder
    ),
    maxFoldersPerFolder: normalizePositiveInteger(
      options.maxFoldersPerFolder,
      USER_HOME_FILE_TREE_DEFAULTS.maxFoldersPerFolder
    ),
    maxLines: normalizePositiveInteger(options.maxLines, USER_HOME_FILE_TREE_DEFAULTS.maxLines)
  };
}

function normalizeListedPath(inputPath = "") {
  return String(inputPath ?? "")
    .replaceAll("\\", "/")
    .trim();
}

function toHomeRelativePath(inputPath = "") {
  const normalizedPath = normalizeListedPath(inputPath);

  if (!normalizedPath || normalizedPath === "~" || normalizedPath === "~/") {
    return "";
  }

  if (normalizedPath.startsWith("~/")) {
    return normalizedPath.slice(2);
  }

  return normalizedPath.replace(/^\/+/u, "");
}

function ensureDirectoryNode(node, directoryName) {
  const normalizedName = String(directoryName || "").trim();

  if (!normalizedName) {
    return node;
  }

  if (!node.directories.has(normalizedName)) {
    node.directories.set(normalizedName, createTreeNode(normalizedName));
  }

  return node.directories.get(normalizedName);
}

function shouldOmitListedPath(segments = [], isDirectory = false) {
  return segments.some((segment, index) => (
    OMITTED_DIRECTORY_BASENAMES.has(segment) &&
    (isDirectory || index < segments.length - 1)
  ));
}

function buildUserHomeTree(paths = []) {
  const rootNode = createTreeNode();

  for (const listedPath of Array.isArray(paths) ? paths : []) {
    const normalizedPath = normalizeListedPath(listedPath);
    const relativePath = toHomeRelativePath(normalizedPath);
    const isDirectory = normalizedPath.endsWith("/");
    const segments = relativePath.split("/").filter(Boolean);

    if (!segments.length || shouldOmitListedPath(segments, isDirectory)) {
      continue;
    }

    let currentNode = rootNode;
    const directorySegments = isDirectory ? segments : segments.slice(0, -1);

    for (const segment of directorySegments) {
      currentNode = ensureDirectoryNode(currentNode, segment);
    }

    if (!isDirectory) {
      currentNode.files.add(segments[segments.length - 1]);
    }
  }

  return rootNode;
}

function sortNames(values = []) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function buildIndent(indentLevel) {
  return INDENT_UNIT.repeat(Math.max(0, indentLevel));
}

function formatFolderLine(name, indentLevel) {
  return `${buildIndent(indentLevel)}${name}/`;
}

function formatFileLine(name, indentLevel) {
  return `${buildIndent(indentLevel)}${name}`;
}

function formatGenericMoreChildrenLine(totalCount, indentLevel, reason = "") {
  const suffix = reason ? ` (${reason})` : "";
  return `${buildIndent(indentLevel)}# ${totalCount} more children${suffix}`;
}

function formatMoreChildrenLine(count, kind, indentLevel, reason = "") {
  const suffix = reason ? ` (${reason})` : "";
  return `${buildIndent(indentLevel)}# ${count} more ${kind}${suffix}`;
}

function buildMoreChildrenLines(options = {}) {
  const folderCount = normalizeNonNegativeInteger(options.folderCount, 0);
  const fileCount = normalizeNonNegativeInteger(options.fileCount, 0);
  const indentLevel = normalizeNonNegativeInteger(options.indentLevel, 0);
  const maxLines = Math.max(0, Number.isFinite(options.maxLines) ? Number(options.maxLines) : Number.POSITIVE_INFINITY);
  const reason = String(options.reason || "").trim();
  const lines = [];

  if (folderCount > 0) {
    lines.push(formatMoreChildrenLine(folderCount, "folders", indentLevel, reason));
  }

  if (fileCount > 0) {
    lines.push(formatMoreChildrenLine(fileCount, "files", indentLevel, reason));
  }

  if (!lines.length || maxLines <= 0) {
    return [];
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  return [formatGenericMoreChildrenLine(folderCount + fileCount, indentLevel, reason)];
}

function countSummaryLines(folderCount, fileCount) {
  return Number(folderCount > 0) + Number(fileCount > 0);
}

function renderTreeNodeLines(node, options = {}) {
  const depth = normalizeNonNegativeInteger(options.depth, 0);
  const indentLevel = normalizeNonNegativeInteger(options.indentLevel, 0);
  const maxDepth = normalizePositiveInteger(options.maxDepth, USER_HOME_FILE_TREE_DEFAULTS.maxDepth);
  const maxFoldersPerFolder = normalizePositiveInteger(
    options.maxFoldersPerFolder,
    USER_HOME_FILE_TREE_DEFAULTS.maxFoldersPerFolder
  );
  const maxFilesPerFolder = normalizePositiveInteger(
    options.maxFilesPerFolder,
    USER_HOME_FILE_TREE_DEFAULTS.maxFilesPerFolder
  );
  const remainingLines = normalizeNonNegativeInteger(options.remainingLines, 0);
  const lines = [];
  const directories = sortNames(node?.directories?.keys?.() || []).map((name) => node.directories.get(name));
  const files = sortNames(node?.files || []);

  if (!remainingLines || (!directories.length && !files.length)) {
    return lines;
  }

  if (depth >= maxDepth) {
    return buildMoreChildrenLines({
      fileCount: files.length,
      folderCount: directories.length,
      indentLevel,
      maxLines: remainingLines,
      reason: MAX_DEPTH_REASON
    });
  }

  let shownDirectoryCount = 0;
  const visibleDirectoryCount = Math.min(directories.length, maxFoldersPerFolder);

  for (; shownDirectoryCount < visibleDirectoryCount; shownDirectoryCount += 1) {
    const remainingDirectoryCountAfterCurrent = directories.length - (shownDirectoryCount + 1);
    const remainingFileCountAfterCurrent = files.length;
    const reservedSummaryLines = countSummaryLines(
      remainingDirectoryCountAfterCurrent,
      remainingFileCountAfterCurrent
    );

    if (lines.length + 1 > remainingLines - reservedSummaryLines) {
      lines.push(...buildMoreChildrenLines({
        fileCount: files.length,
        folderCount: directories.length - shownDirectoryCount,
        indentLevel,
        maxLines: remainingLines - lines.length,
        reason: LINE_LIMIT_REASON
      }));
      return lines;
    }

    const directoryNode = directories[shownDirectoryCount];
    lines.push(formatFolderLine(directoryNode.name, indentLevel));

    const childLines = renderTreeNodeLines(directoryNode, {
      depth: depth + 1,
      indentLevel: indentLevel + 1,
      maxDepth,
      maxFilesPerFolder,
      maxFoldersPerFolder,
      remainingLines: remainingLines - lines.length - reservedSummaryLines
    });

    lines.push(...childLines);
  }

  const omittedDirectoryCount = directories.length - shownDirectoryCount;

  if (omittedDirectoryCount > 0) {
    const reservedFileSummaryLines = countSummaryLines(0, files.length);

    if (lines.length + 1 > remainingLines - reservedFileSummaryLines) {
      lines.push(...buildMoreChildrenLines({
        fileCount: files.length,
        folderCount: omittedDirectoryCount,
        indentLevel,
        maxLines: remainingLines - lines.length,
        reason: LINE_LIMIT_REASON
      }));
      return lines;
    }

    lines.push(formatMoreChildrenLine(omittedDirectoryCount, "folders", indentLevel));
  }

  let shownFileCount = 0;
  const visibleFileCount = Math.min(files.length, maxFilesPerFolder);

  for (; shownFileCount < visibleFileCount; shownFileCount += 1) {
    const remainingFileCountAfterCurrent = files.length - (shownFileCount + 1);
    const reservedSummaryLines = countSummaryLines(0, remainingFileCountAfterCurrent);

    if (lines.length + 1 > remainingLines - reservedSummaryLines) {
      lines.push(...buildMoreChildrenLines({
        fileCount: files.length - shownFileCount,
        indentLevel,
        maxLines: remainingLines - lines.length,
        reason: LINE_LIMIT_REASON
      }));
      return lines;
    }

    lines.push(formatFileLine(files[shownFileCount], indentLevel));
  }

  const omittedFileCount = files.length - shownFileCount;

  if (omittedFileCount > 0 && lines.length < remainingLines) {
    lines.push(formatMoreChildrenLine(omittedFileCount, "files", indentLevel));
  }

  return lines;
}

export function buildUserHomeFileTreeLines(paths = [], options = {}) {
  const normalizedOptions = normalizeUserHomeTreeOptions(options);
  const rootNode = buildUserHomeTree(paths);
  const lines = [HOME_ROOT_DISPLAY_PATH];
  const hasEntries = rootNode.directories.size > 0 || rootNode.files.size > 0;

  if (!hasEntries) {
    if (lines.length < normalizedOptions.maxLines) {
      lines.push(`${INDENT_UNIT}${HOME_TREE_EMPTY_LINE}`);
    }

    return lines.slice(0, normalizedOptions.maxLines);
  }

  lines.push(...renderTreeNodeLines(rootNode, {
    depth: 0,
    indentLevel: 1,
    maxDepth: normalizedOptions.maxDepth,
    maxFilesPerFolder: normalizedOptions.maxFilesPerFolder,
    maxFoldersPerFolder: normalizedOptions.maxFoldersPerFolder,
    remainingLines: normalizedOptions.maxLines - lines.length
  }));

  return lines.slice(0, normalizedOptions.maxLines);
}

export function buildUserHomeFileTreeTransientSection(options = {}) {
  const lines = buildUserHomeFileTreeLines(options.paths, options);

  return {
    content: lines.join("\n"),
    heading: USER_HOME_FILE_TREE_TRANSIENT_HEADING,
    key: USER_HOME_FILE_TREE_TRANSIENT_KEY,
    order: USER_HOME_FILE_TREE_TRANSIENT_ORDER
  };
}

export async function listUserHomeTreePaths(runtime = globalThis.space) {
  const apiClient = runtime?.api;

  if (!apiClient || typeof apiClient.fileList !== "function") {
    throw new Error("User home file tree transient requires space.api.fileList(...).");
  }

  const result = await apiClient.fileList(HOME_ROOT_DISPLAY_PATH, true);
  return Array.isArray(result?.paths) ? result.paths : [];
}

export async function buildUserHomeFileTreeTransientSectionFromRuntime(options = {}) {
  const paths = Array.isArray(options.paths) ? options.paths : await listUserHomeTreePaths(options.runtime);
  return buildUserHomeFileTreeTransientSection({
    ...options,
    paths
  });
}
