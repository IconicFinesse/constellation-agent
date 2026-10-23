import {
  destroySpaceBackdrop,
  installSpaceBackdrop
} from "./spaceBackdropAnimated.js";

export { destroySpaceBackdrop, installSpaceBackdrop };

const space = globalThis.space || (globalThis.space = {});
space.visual = space.visual || {};
space.visual.installBackdrop = installSpaceBackdrop;
space.visual.destroyBackdrop = destroySpaceBackdrop;
