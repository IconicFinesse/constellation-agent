// COMPATIBILITY RE-EXPORT. This file contains NO implementation.
//
// The render projection was PROMOTED to the shared layer in P4a-3d: it now lives in
// `/modules/_core/framework/js/engine-swap/chat-projection.js` because TWO surfaces
// paint through it (onscreen and admin), and a projection is not a surface's property.
//
// THIS FILE EXISTS ONLY SO AN OLD IMPORT PATH KEEPS RESOLVING. Existing suites import
// this path; repointing them would be a test edit, and a promoted seam must not require
// one. Every symbol below is the framework module's own binding — the same function
// object, not a wrapper and not a second copy — so a caller through this path cannot
// drift from a caller through the new one. `engine_swap_render_projection_test.mjs`
// asserts that identity.
//
// New code imports the framework path directly. Do not add a definition here.

export {
  PROVISIONAL_CHIP_PREFIX,
  PREVIEW_SEGMENT_SUFFIX,
  buildChatRenderProjection,
  createProvisionalChipEntry,
  resolvePreviewTailContent
} from "/modules/_core/framework/js/engine-swap/chat-projection.js";
