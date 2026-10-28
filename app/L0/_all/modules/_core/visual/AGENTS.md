# AGENTS

## Purpose

`_core/visual/` owns the shared Constellation Agent visual system.

It provides the reusable canvas, chrome, buttons, dialogs, cards, conversation rendering primitives, and shared authenticated-app visual assets that feature modules compose on top of. It should own shared presentation logic and reusable artwork, not feature-specific state or workflows.

Documentation is top priority for this module. After any change under `_core/visual/`, update this file and any affected parent docs in the same session.

## Ownership

Current sub-areas:

- `index.css`: shared visual aggregator that imports the reusable layers
- `canvas/`: authenticated shared backdrop CSS and JS runtimes
- `chrome/`: topbar, popover, toast, and light chrome behavior
- `icons/`: shared Material Symbols catalog helpers plus reusable icon-selection modal UI and runtime
- `actions/`: shared button and attachment-chip styling
- `forms/`: native dialog styling and helpers
- `conversation/`: shared agent-thread rendering helpers
- `surfaces/`: shared panel and card treatments
- `res/`: canonical shared image assets for authenticated app surfaces

## Local Contracts

### Current Contracts

Canvas:

- `canvas/space-canvas.css` owns the DOM-backed space backdrop visuals for authenticated surfaces
- `canvas/space-canvas.css` keeps both the base canvas gradient and the star or glow scene on fixed viewport layers so routed surface scrolling never drags the backdrop
- `canvas/spaceBackdropCore.js` owns the shared backdrop runtime, including resize-safe scale resync that forces `--space-backdrop-scale` back to `1`
- `canvas/spaceBackdropStatic.js` installs the static authenticated backdrop and registers `space.visual.installStaticBackdrop(...)`
- `canvas/spaceBackdropAnimated.js` installs the animated variant and registers `space.visual.installAnimatedBackdrop(...)`
- `canvas/spaceBackdrop.js` re-exports the animated variant as the generic backdrop installer

Chrome:

- `chrome/topbar.css` owns the shared glass topbar and menu-panel contract used by routed menus and admin tabs
- `chrome/popover.css` plus `chrome/popover.js` own the shared fixed-position dropdown or overflow-menu positioning contract; auto placement should flip upward once available bottom space drops below `2.2x` the measured panel height and top space is larger, so row menus avoid cramped bottom-edge inner scrolling
- `chrome/toast.css` plus `chrome/toast.js` own the shared fixed-position toast stack and register `space.visual.showToast(message, options)`

Icons:

- `icons/material-symbols.txt` plus `icons/material-symbols.js` own the shipped Material Symbols ligature catalog and normalized icon-name or hex-color helpers shared by feature modules
- `icons/icon-color-selector-modal.html`, `icons/icon-color-selector.css`, and `icons/icon-color-selector.js` own the reusable icon-selection modal and register `space.visual.openIconColorSelector(options)` once that module is imported
- `space.visual.openIconColorSelector(options)` should open through the framework modal shell, await close, and resolve with either `null` for cancel or an `{ icon, color }` selection payload
- the shared selector should support search, pagination, icon color, reset-to-default values supplied by the caller, and optional `allowNone` behavior without embedding feature-specific storage rules into the visual layer; its default page size is `100` icons unless a caller overrides `pageSize`
- selector option cells should keep wrapped two-line icon labels legible without clipping descenders, use a larger direct glyph instead of a nested inner chip, keep prev/next as compact icon-only controls beside the pagination label, leave a small visual gap above the footer action row, and keep hover, focus, and selected-state feedback hitbox-stable instead of translating the option cell

Actions and forms:

- `actions/buttons.css` owns shared `primary-button`, `secondary-button`, and `confirm-button` treatments plus composer-attachment chip styling
- `forms/dialog.css` plus `forms/dialog.js` own the shared native `<dialog>` presentation and open or close helpers
- `forms/dialog.css` also owns reusable prompt-budget field styling for dialog-based model settings, including the segmented preview bar plus the multi-slider control grid used by the first-party agent surfaces
- authenticated app feature dialogs are standardized on feature-owned native `<dialog class="chat-dialog">` markup that lives in the owning feature HTML, opens through `forms/dialog.js`, and composes `dialog-card` or `dialog-card-shell` content wrappers from `forms/dialog.css`
- `forms/dialog.css` also owns the reusable fixed-chrome dialog shell classes for long modals: `dialog-card-shell` keeps the header and footer static, `dialog-scroll-body` and `dialog-scroll-frame` own the interior scrolling region, and `dialog-actions-split` plus `dialog-actions-group` and `dialog-action-button-fixed` cover compact split footer rows without feature-local inline layout
- the framework modal shell in `_core/framework/js/modals.js` is reserved for generic separately loaded modal documents or shared utilities such as icon selectors that genuinely need that wrapper; it is not the default chrome path for first-party feature dialogs
- modal-scoped button chrome belongs in `forms/dialog.css`, not in feature-local styles: dialogs should use the tighter admin-style geometry with compact 10px radii, no oversized pill buttons, transparent secondary actions, and flatter primary or confirm actions without any painted shadow treatment

Resources:

- `res/` is the canonical home for reusable authenticated-app artwork: the overlay chat character, the admin chat avatars, and the browser-frame placeholder character. Only wired artwork lives here; unpromoted variants were removed in the artwork rebrand
- repo-owned authenticated app modules should reference shared images from `/modules/_core/visual/res/...` instead of keeping image files in feature-local module folders
- public or pre-auth shells that live outside the authenticated app module tree, including `/login` and `/enter`, keep their own mirrored character asset under `server/pages/res/`

Conversation and surfaces:

- `conversation/thread-view.js` exports `createAgentThreadView(config)` and is the shared renderer used by the admin agent and onscreen agent
- `conversation/thread-view.js` must patch streaming assistant rows in place when possible, including streamed execution cards, so expanded execution details stay interactive instead of losing DOM state on every delta; ordinary shared-thread rerenders must also reconcile against existing keyed rows instead of clearing and rebuilding the full history; completed execution rows must stay isolated from later assistant turns so a new streamed reply only updates the live row; thread scroll should keep following while the user remains near the bottom and should decouple only after the user has scrolled up; once an execution card is mounted, settled narration and other stable subtrees should not be recreated on each streamed token; and single-paragraph execution narration should collapse to one message block instead of keeping an extra markdown wrapper around a lone `<p>`
- `conversation/thread-view.js` also owns the shared execution-card terminal-line parsing contract; execution transcript headers may arrive in legacy inline form such as `warn: ...` or in block-label form such as `log↓`, `warn↓`, `error↓`, and `result↓`, and the shared line-modifier logic must keep those headings styled consistently for both admin and overlay cards
- `conversation/thread-view.js` supports an opt-in chat-bubble markdown mode through `config.renderMarkdownWithMarked`; that mode routes settled non-streaming assistant bubbles through the shared framework markdown helper while keeping submitted user bubbles on plain pre-wrapped text so typed blank-line spacing stays literal, escapes raw HTML before parsing, strips unsafe markdown link or image URLs after render, wraps rendered tables in `.message-markdown-table-wrap`, removes empty generated table headers, and lets the owning feature attach a local assistant markdown class through `config.assistantMarkdownClassName`
- `conversation/agent-thread.css` keeps plain-text bubbles on `white-space: pre-wrap`, resets rendered markdown bubbles back to normal white-space so parser formatting newlines between tags do not render as visible blank lines, and collapses top and bottom margins on direct list-item child blocks inside markdown bubbles so loose markdown lists do not render blank-line-sized gaps between bullets in shared agent history
- `conversation/thread-view.js` also supports opt-in avatar run grouping through `config.groupConsecutiveAvatars`; when enabled, only the first consecutive rendered row for the same visible speaker should mount the real avatar and later rows in that run should keep the same bubble alignment with a non-visible spacer instead of re-rendering the icon or image
- `conversation/thread-view.js` owns ONE ROW PER CALL inside a collapsed tool run (chat-polish-2 item A): the card's body is built from `collectToolRunCalls` per-call records, so the expanded row count always equals the header's call count and each row shows its own outcome; a call and its own result are never two rows.
- `conversation/thread-view.js` owns the TYPED CHIP LABEL vocabulary (chat-polish-2 item D): a typed chip renders `<tool name> · <Success|Error|Running|Held|Deferred>` from the classified outcome (`formatTypedToolLabel`), never the Tier 3 code-line wording, and a typed result's empty projected name is resolved from the sibling call of the same id. Tier 3 `formatExecutionSummaryLabel` output stays byte-identical.
- `conversation/thread-view.js` owns ONE VOCABULARY PER TIER (chat-polish-3 item 1). A TYPED-tier (engine-swap) turn never executes separator code, so a separator-bearing reply from it renders `Shown, not executed` from the FIRST painted frame, and its typed calls render `<tool name> · <outcome>`. It must never show the Tier 3 code-line card (`Writing N lines of code` / the `edit_note` pencil) for such a reply: that put two mechanisms and two vocabularies on one turn, which is the owner-reported inconsistency. The signal is the message's `tier1Turn` mark, set by the store on its projection-only streaming preview; the committed row reaches the same reading through the derived `engineSwapDisplayOnlyMessageIds`. `resolveExecutionCardState({ displayOnlyTier })` gives the terminal reading and still lets the message's OWN facts win (a rerun that really executed reads Success/Error), `patchStreamingExecutionRow` resolves through the same resolver instead of forcing `generating`, and the mark is part of the execute section's render SIGNATURE so a mid-turn row cannot be reused with the legacy wording. A Tier 3 message carries no mark, so its streaming/busy/settled cards stay byte-identical.
- `conversation/thread-view.js` paints the typed OUTPUT pane BOUNDED and offers the expansion control (P4b-2a). The pane is filled by `formatTypedToolResult` in its default bounded mode, and the renderer decides whether to offer `Show all` by asking the PAINTED lines (via `hasExecutionHiddenMarker`) rather than recomputing any arithmetic — so the control appears exactly when a marker is on screen and never pretends content is hidden when it is not. Clicking it repaints the same pane through the same formatter with `unbounded: true` and clicking again returns to the bounded form; both forms are one derivation, so they cannot disagree about the content. It is LOCAL DOM STATE ONLY, in the `{ } Raw` shape P4b-1 established: `data-typed-output-toggle`, no `data-message-action` and no `data-terminal-action` so a store handler cannot claim it, not in `getGroupRenderSignature`, and a repaint always starts bounded. The typed OUTPUT pane adds no CSS class and no second vocabulary: bound markers are painted as ordinary `terminal-line.is-muted`.
- `conversation/thread-view.js` renders a SINGLE typed call as ONE chip (owner-reported live defect, 2026-10-27). One call stores TWO ENTRIES (its `call` and its `result`), so the old `callCount >= 2` gate fell through and drew the same call twice: the call entry with its real arguments above `OUTPUT: No output yet.`, then the result entry with `ARGUMENTS {}` above the real payload. The `callCount === 1` branch now folds the run into ONE `standalone-output` chip built from `collectToolRunCalls(run.entries)` — the SAME per-call fold the grouped card uses, so pairing has exactly one derivation — and consumes `run.endIndex`. The descriptor must carry the call's `argumentsText`, `name`, `outcome` AND the result's `outputText`, so the expanded chip shows both panes. It must stay a standalone CHIP: folding a single call into a collapsible tool-run card would make the user click to see one call. Held/deferred single calls keep their two individual rows (`collectToolRun` returns `null`), a mid-turn call is one chip reading `running` with no invented output, and grouping OFF keeps one row per ENTRY.
- `conversation/thread-view.js` renders SETTLED provisional chips (P3 chip settle). A chip descriptor prefers the entry's OWN terminal outcome (`success` / `error` / `held` / `deferred`) and falls back to the facts map built from result entries, then `running`. TERMINAL ONLY: a committed call entry carries `pending` from the history reader and must keep resolving from its own result entry, so the committed path stays byte-identical. The resolved outcome AND the descriptor's own text (name, arguments, output) are part of the standalone-output render signature, so a settled chip cannot reuse the running row and a folded chip cannot reuse the row built before its result landed with `No output yet.`; both terms are asserted independently with everything else held identical, because a chip whose outcome or prose changes alone would otherwise satisfy the signature test.
- `conversation/thread-view.js` renders a provisional chip's REAL PANES (P3 provisional panes). The descriptor's call branch prefers an entry's own `typedToolArgumentsText` / `typedToolOutputText` when the projection supplied them, and falls back to slicing the projected prose and to the result entry otherwise. A committed entry carries neither field, so the committed row's bytes are unchanged. The slice rule itself is no longer local: `getTypedEntryBodyText` delegates to `readProjectedChipBody` in the engine-swap history module, beside the writer that produces the format, because two copies of 'take everything after the first newline' drift exactly like two formatters. The pane text is copied verbatim into the ARGUMENTS and OUTPUT blocks, so a mid-turn chip and the committed row showing the same descriptor bytes means the user sees the same text before and after commit.
- `conversation/thread-view.js` must give a STREAMING assistant-sequence row its streaming identity (`data-streaming-message-id`). A separator-bearing live message groups as an assistant-sequence; without the mark `updateStreamingAssistantMessage` cannot find it and every delta falls back to a full thread rebuild.
- `conversation/thread-view.js` paints the TURN-LEVEL progress indicator (P4b-2b), the answer to 'is the agent working right now' that the per-call chip spinner never gave: before the first token of a turn the transcript otherwise showed the user's own row and nothing else. Its PRESENCE is derived from `options.isConversationBusy`, which both surfaces already pass to this renderer — there is no stored indicator state, no new store field and no cleanup call, so an indicator that outlives its turn is impossible by construction: the paint that ends a turn simply stops claiming it. It is synced on EVERY paint path including the empty-state early return (skipping that branch is how the first draft stranded it on a fresh chat) and before the scroll restore so its height is measured. The LABEL comes from `conversation/turn-progress.js`, fed the live assistant entry the render was handed, and the same label is re-synced by the per-delta patch (`updateStreamingAssistantMessage`) so a phase change does not wait for a full render. It is one element `[data-turn-progress]`, `role="status"` + `aria-live="polite"` + `aria-atomic="true"`, never focusable, with the spinner `aria-hidden` and the words carrying the meaning; it reuses the existing `agent-thread-spin` keyframes and has a `prefers-reduced-motion` variant. It is NOT a history row: the thread's row diff is positional, so it is filtered out of `existingRows` and re-appended last.
- `conversation/turn-progress.js` owns THE ONE turn-progress vocabulary (P4b-2b): `Thinking...`, `Preparing code...`, `Writing N lines of code...` and `Writing response...`, plus the line-counting they use. Both agent stores and the thread view import it, so a user-visible phase can never be spelled two ways; the fence-aware block extractor is INJECTED by each consumer because every surface owns its own execution module and a second copy of fence logic is the BUG-007 anti-pattern. A caller passing no extractor gets the no-blocks reading, which can never claim work a fence said was only displayed. `is-streaming` was the previous attempt at this signal: three sites added it and no stylesheet in the tree ever matched it, so it painted nothing and was removed rather than revived.
- Narration inside a STREAMING execution card is repainted through the preview painter on each tick (chat-polish-2 item C) and skipped when its text is unchanged; the committed narration path (`createExecutionNarrationBlock` from the sequence bubble) stays the formatted block, so settled output is byte-identical.
- Provisional live chips are placed CHRONOLOGICALLY against the streaming preview by the projection (`_core/framework/js/engine-swap/chat-projection.js`), not by this module: the rendered order is the order it receives. That projection is SHARED, not a surface's: both chat surfaces paint through the one module (P4a-3d). `_core/onscreen_agent/chat-projection.js` is now only a COMPATIBILITY SHIM — a definition-free re-export kept so an old import path keeps resolving. It defines nothing; new code imports the framework path, and a definition added there is a second copy of the projection.

- `conversation/agent-thread.css` owns the baseline bubble sizing, avatar spacer, and wrapping rules for shared threads; user bubbles must keep natural compact width for short drafts but still wrap long lines inside the bubble so chat scrollers do not widen or grow horizontal scrollbars, and execution narration should sit visually tight to its execution card instead of reading like a separate later reply; execute sections may use tighter local spacing than follow-up sections to preserve that coupling
- message bubbles mount their children in a single shrinkable `minmax(0, 1fr)` grid track so one wide child cannot inflate the bubble past its max-width and stretch sibling blocks into a clipped, horizontally scrolling thread; markdown code blocks keep their block formatting but wrap long lines and unbreakable tokens (`white-space: pre-wrap`, `overflow-wrap: anywhere`) instead of widening the bubble
- `surfaces/cards.css` owns shared panel or card wrappers such as `space-panel`

### Visual System Rules

- solve shared presentation problems here before cloning styles into feature modules
- keep the overall direction calm, dark, and readable rather than loud or novelty-driven
- keep shared interactive hover and focus emphasis hitbox-stable: prefer border, background, outline, or opacity changes over translate or position shifts that move the clickable box
- first-party glass surfaces in this module stay shadowless: do not use box-shadow, text-shadow, or drop-shadow for depth; rely on blur, borders, gradients, and contrast instead
- avoid putting feature logic, API calls, or store state into this module
- when a feature needs a dialog, default to the shared native `<dialog class="chat-dialog">` pattern documented here; only update the visual system itself when that pattern must change for everyone
- when a modal needs persistent action rows, scroll the inner body or framed content area through the shared dialog shell helpers instead of putting overflow on the full dialog card
- when a primitive is only used by one feature, keep it local until reuse is real
- keep reusable selection modals generic: the visual layer may own search, pagination, preview, and return-value flow, but feature-specific metadata semantics stay in the calling module
- when changing the shared backdrop system, also review the mirrored public-shell copies in `server/pages/res/space-backdrop.css` and `server/pages/res/space-backdrop.js`

## Work Guidance

### Local Work Rules

- prefer semantic tokens from `_core/framework/css/colors.css`
- prefer composing existing visual primitives over inventing near-duplicates
- keep the baseline bubble markdown layout in `_core/visual/conversation/agent-thread.css`; add only feature-specific markdown tuning in the owning surface stylesheet
- if a feature needs new shared chrome or surface behavior, add the smallest reusable primitive here and keep feature orchestration in the owning module
- if a visual change affects app-wide direction, update `/app/AGENTS.md`; if it affects pre-auth mirrored shells, update `server/pages/AGENTS.md` too

## Verification



## Child DOX Index

- No child DOX docs.
