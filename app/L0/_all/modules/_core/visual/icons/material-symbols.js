export const MATERIAL_SYMBOLS_CATALOG_PATH = "/modules/_core/visual/icons/material-symbols.txt";

let materialSymbolNamesPromise = null;

export function normalizeMaterialSymbolName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
    .replace(/[^a-z0-9_]/gu, "")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function normalizeIconHexColor(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();

  if (!normalizedValue) {
    return "";
  }

  const shortMatch = normalizedValue.match(/^#([0-9a-f]{3})$/u);

  if (shortMatch) {
    const [red, green, blue] = shortMatch[1].split("");
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }

  const longMatch = normalizedValue.match(/^#([0-9a-f]{6})$/u);
  return longMatch ? `#${longMatch[1]}` : "";
}

export async function loadMaterialSymbolNames() {
  if (materialSymbolNamesPromise) {
    return materialSymbolNamesPromise;
  }

  materialSymbolNamesPromise = (async () => {
    const response = await fetch(MATERIAL_SYMBOLS_CATALOG_PATH, {
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Unable to load Material icons (${response.status}).`);
    }

    const content = await response.text();
    const names = [...new Set(
      content
        .split(/\r?\n/gu)
        .map((value) => normalizeMaterialSymbolName(value))
        .filter(Boolean)
    )];

    if (!names.length) {
      throw new Error("The Material icons catalog is empty.");
    }

    return names;
  })();

  try {
    return await materialSymbolNamesPromise;
  } catch (error) {
    materialSymbolNamesPromise = null;
    throw error;
  }
}
