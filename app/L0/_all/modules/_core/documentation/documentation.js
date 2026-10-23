const DOCS_ROOT = "docs/";

function normalizeDocSegment(segment) {
  const value = String(segment || "").trim();

  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`Invalid documentation path segment: ${segment}`);
  }

  return value;
}

function normalizeDocPath(docPath) {
  const rawPath = String(docPath || "").trim().replace(/^\/+|\/+$/gu, "");

  if (!rawPath) {
    throw new Error("Documentation path must not be empty.");
  }

  const normalizedPath = rawPath
    .split("/")
    .filter(Boolean)
    .map((segment) => normalizeDocSegment(segment))
    .join("/");

  if (!normalizedPath.endsWith(".md")) {
    throw new Error(`Documentation path must end with .md: ${docPath}`);
  }

  return normalizedPath;
}

export function url(docPath) {
  return new URL(`${DOCS_ROOT}${normalizeDocPath(docPath)}`, import.meta.url).toString();
}

export async function read(docPath) {
  const normalizedPath = normalizeDocPath(docPath);
  const response = await fetch(url(normalizedPath), {
    cache: "no-store",
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error(
      `Unable to read documentation "${normalizedPath}": ${response.status} ${response.statusText}`
    );
  }

  return response.text();
}

export default {
  read,
  url
};
