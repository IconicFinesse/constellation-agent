import {
  SPACE_BACKDROP_RUNTIME_KEY,
  createSpaceBackdropRuntime,
  destroySpaceBackdrop
} from "./spaceBackdropCore.js";

export function installSpaceBackdrop(
  root = document.querySelector("[data-space-backdrop]"),
  { canvas = document.body } = {}
) {
  if (root?.[SPACE_BACKDROP_RUNTIME_KEY] && !root.classList.contains("is-static")) {
    root[SPACE_BACKDROP_RUNTIME_KEY].destroy();
  }

  return createSpaceBackdropRuntime(root, {
    canvas,
    variantClassName: "is-static"
  });
}

const space = globalThis.space || (globalThis.space = {});
space.visual = space.visual || {};
space.visual.installStaticBackdrop = installSpaceBackdrop;
space.visual.destroyStaticBackdrop = destroySpaceBackdrop;

export { destroySpaceBackdrop };
