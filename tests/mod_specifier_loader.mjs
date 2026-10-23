const MOD_SPECIFIER_PREFIX = "/modules/";
const APP_L0_ALL_DIR = new URL("../app/L0/_all/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(MOD_SPECIFIER_PREFIX)) {
    const mappedUrl = new URL(
      "modules/" + specifier.slice(MOD_SPECIFIER_PREFIX.length),
      APP_L0_ALL_DIR
    ).href;

    return nextResolve(mappedUrl, context);
  }

  return nextResolve(specifier, context);
}
