# AGENTS

## Purpose

`server/lib/customware/` owns the layered app filesystem and module model.

This subtree is the canonical place for logical app-path normalization, customware-root resolution, group-derived permissions, layer limits, module inheritance, extension override resolution, app-file access, and module management. Do not re-implement those rules elsewhere.

Documentation is top priority for this subtree. After any change under `server/lib/customware/`, update this file and any affected parent or dependent docs in the same session.

## Ownership

Current files:

- `layout.js`: path normalization, entity-id normalization, logical-to-disk resolution for `L0`/`L1`/`L2`, and parser helpers for app, group, user, module, and extension paths
- `layer_limit.js`: `maxLayer` parsing, normalization, and request-level resolution
- `module_state.js`: shared-state-backed module/group index readers and shard-scoped module discovery helpers
- `git_history.js`: optional per-owner local Git history scheduling, repository discovery, commit listing, rollback, and `.git` metadata shielding for writable `L1` and `L2`
- `user_quota.js`: optional per-user `L2` folder size accounting, cached current-size reads, and quota projection checks for app-file mutations
- `group_files.js`: normalized `L1/<group>/group.yaml` read and write helpers used by CLI-managed group editing; membership adds ensure the target writable group directory exists first
- `group_index.js`: derived group membership and management graph from `group.yaml`
- `overrides.js`: inheritance ranking, accessible module collection, and override selection
- `module_inheritance.js`: `/modules/...` file resolution through layered overrides
- `extension_overrides.js`: extension request-path resolution and ordered grouped extension lookup results keyed by requested pattern groups rather than synthetic ids
- `file_access.js`: canonical app-file permission model, file operations, and readable-folder download resolution
- `module_manage.js`: module list, info, install, remove, and Git metadata helpers

## Local Contracts

### Path And Permission Contract

Path rules:

- app-rooted paths normalize to `/app/...`
- logical `/app/L0/...` always resolve under repo `app/L0/...`
- logical `/app/L1/...` and `/app/L2/...` resolve under `CUSTOMWARE_PATH/L1/...` and `CUSTOMWARE_PATH/L2/...` when `CUSTOMWARE_PATH` is configured, otherwise under repo `app/L1/...` and `app/L2/...`
- writable user-relative shorthand `~` and `~/...` are expanded by `file_access.js`
- a repeated own-user prefix collapses: `~` already means `L2/<username>/`, so `~/L2/<username>/...` and the plain doubled `L2/<username>/...` form canonicalize to the single own root for the authenticated session user, never rewriting a path whose inner name is a different user
- reads fall back to the bug-era doubled nested location when only that copy exists, mirroring the v1.1 legacy read fallback; writes, deletes, copies, moves, and lists always resolve the collapsed canonical path and never write back into the doubled tree
- module request paths normalize under `/modules/...`
- group and user ids are normalized through `normalizeEntityId(...)`

Permission rules:

- nobody writes `L0`
- users may write their own `L2/<username>/`
- users may write `L1/<group>/` only when they manage that group
- `_admin` members may write any `L1/` and `L2/` path
- readable group membership comes from the derived `group_index`
- when `SINGLE_USER_APP` is enabled, runtime permission helpers treat the implicit `user` principal as a virtual `_admin` member even if no user or group files exist on disk

`group.yaml` contract:

- `included_users`
- `included_groups`
- `managing_users`
- `managing_groups`

Those fields are the canonical inputs for the derived membership and management graph.

CLI group-editing rules:

- `group create` explicitly creates a writable `L1/<group>/` root
- `group add` and `user create --groups ...` may create the target writable `L1/<group>/` root automatically before writing membership, including `_admin`
- those writes must pass the resolved runtime params into `group_files.js` so configured `CUSTOMWARE_PATH` roots are honored

### Legacy Name Compatibility Contract

v1.1 renamed four directories one level inside a layer owner: `meta/` -> `metadata/`,
`conf/` -> `config/`, `hist/` -> `history/`, and `mod/` -> `modules/`. An install created
before v1.1 still carries only the old names, so reads must keep working without any
migration step, data movement, or rewrite.

Rules:

- aliasing applies only to the owner-child segment (`/app/<L0|L1|L2>/<owner>/<child>/`), never to deeper segments, so user content named `conf/` or `hist/` inside a module is untouched
- reads try the current name first and fall back to the legacy name when the current path does not exist; when both exist the current name wins
- writes, deletes, copies, and moves always resolve the current name and never create, modify, or remove a legacy directory
- `layout.js` owns the mapping: `toPreferredProjectPath(...)` maps an on-disk legacy path to the current name for reporting and parsing, and `listLegacyProjectPathCandidates(...)` returns the legacy read candidate for a logical path
- module discovery parses indexed paths through `toPreferredProjectPath` before matching `/app/<layer>/<owner>/modules/<author>/<repo>/`, so a legacy `mod/` tree lists as `/modules/<author>/<repo>`
- `parseProjectUserLoginsPath` and `parseProjectUserPasswordPath` accept both `metadata/` and `meta/` because auth state is read back from either name
- `module_list` returns a bare JSON array of entries; it is not wrapped in an envelope, and frontend consumers test `Array.isArray(result)`

Verification: `tests/legacy_upgrade_path_test.mjs` builds a v1.0.0-shaped tree and asserts
legacy auth discovery, legacy `~/conf/` and `~/hist/` reads, legacy `mod/` module
discovery, and that new-name writes leave the legacy directories untouched.

### Inheritance And Override Contract

Module and extension resolution is layered and rank-based.

High-level resolution order:

- `L0/_all`
- accessible `L0/<group>/` entries in group order
- `L1/_all`
- accessible `L1/<group>/` entries in group order
- `L2/<username>`

Important rules:

- `layer_limit.js` constrains module and extension resolution through `maxLayer`
- `layer_limit.js` also accepts `X-Space-Max-Layer` as an explicit request-level override source for module and extension fetches
- worker-side module lookup must read shared `file_index` and group shards from the shared `stateSystem`; only the primary watchdog owns filesystem scanning and shard publication, and `L2/<user>` file-index shards are loaded on demand
- auth-only request context does not imply the authenticated user's full L2 shard is loaded; file, module, extension, quota, and direct app-file callers must use the router-provided full-shard ensure hook before relying on user-owned file-index entries
- frontend HTML anchors resolve through module `ext/html/...` paths and JS hooks resolve through module `ext/js/...` paths
- modules may also resolve other extension-owned assets through the same ranked `ext/...` override model when the frontend calls `extensions_load` directly; the current first-party example is `ext/panels/*.yaml`, and grouped lookups preserve request order while returning each request's normalized `patterns` with its resolved `extensions`
- exact same override keys replace lower-ranked entries
- different extension filenames under the same extension point compose together
- `module_inheritance.js` and `extension_overrides.js` are the only supported paths for `/modules/...` and extension resolution

### File And Module Management Contract

`file_access.js` is the canonical entry point for:

- app-file list
- app-file read
- app-file write
- app-file delete
- app-file copy
- app-file move
- app-file info
- readable folder-download permission and path resolution for `folder_download`
- pattern-based `file_paths` lookup
- write-access-filtered `file_list` and `file_paths` discovery, including local-history repository root discovery that never exposes `.git` metadata

Rules:

- batch file operations must validate all targets before mutation begins
- `file_write` defaults to replacement but also supports `append`, `prepend`, and `insert`; insert accepts exactly one anchor through `line`, `before`, or `after`, uses the first literal pattern match for `before` or `after`, treats `line` as a 1-based insertion point, and requires `utf8` encoding, while directory writes remain replace-only path creation
- single-path app-file deletes must continue to work when request plumbing passes `paths: undefined`; only an explicit non-array `paths` value should be rejected as malformed batch input
- keep permission, duplication, overlap, path-normalization, and logical-to-disk resolution logic centralized here
- copy destinations are decided from disk state, not only from the watchdog path index: an absent destination copies, an existing empty directory is removed and copied fresh, and an existing non-empty directory or a file is a `409` that names the destination and leaves it untouched; a failed copy removes only the destination it created, so no empty artifact is left to fail the next attempt
- `copyAppPaths` reports `409` from both conflict layers (index guard and disk layer) so callers never branch on index freshness; the index guard still refuses content conflicts but defers for a directory copy onto an existing empty directory, and `moveAbsolutePath`'s `EXDEV` fallback inherits the same destination protection
- single-file copies keep the strict guard and still refuse to overwrite; `force: false`, permission, layer-limit, quota, and reserved-path checks are unaffected by the copy destination rules
- frontend callers should derive writable roots from the canonical permission rules and the `user_self_info` identity fields instead of depending on a serialized scope payload
- callers that need server-confirmed writable discovery may pass `access: "write"` or `writableOnly: true` to `file_list` or `file_paths`; repository pickers may add `gitRepositories: true` with a pattern such as `**/.git/` to receive writable owner roots like `L1/<group>/` and `L2/<user>/`
- normal request-time `file_paths` discovery must read the caller's relevant `file_index` shards, matching module discovery: readable lookups scan `L0`, readable `L1` group shards, and the authenticated user's demand-loaded `L2` shard, while writable lookups scan only writable owner shards except admin-wide discovery
- do not route ordinary `file_paths` calls through a full `watchdog.getPaths()` or whole-index sort when the shared `stateSystem` is available; fallback whole-index filtering is only for direct helper callers that do not provide replicated state
- when `CUSTOMWARE_GIT_HISTORY` is enabled, writable `L1` and `L2` file mutations schedule debounced per-owner Git history commits; in clustered runtime, worker writes defer that scheduling to the primary after it rebuilds the authoritative watchdog state for the changed logical paths
- debounced owner-root history work must stay off the request path; local-history backends serialize operations per owner repository so primary-owned scheduling does not block the event loop or race the same repo, native keeps Git subprocess work asynchronous, and the isomorphic fallback reuses immutable history-entry and tree caches for repeated Time Travel reads
- when `USER_FOLDER_SIZE_LIMIT_BYTES` is positive, `file_access.js` must check all app-file writes, copies, moves, and deletes through `user_quota.js` before mutation; projected growth over the cap is rejected, while a user folder already over cap may only perform mutations whose net `L2/<user>/` size delta is negative
- user-folder quota accounting is cached per resolved `L2/<user>/` root; cache fills and subtree size reads should come from indexed `sizeBytes` metadata in the loaded `file_index` shard instead of crawling the full user tree, while normal app-file mutations update that cache by byte deltas
- other backend app-path mutation callers invalidate the affected cache through `recordAppPathMutations`, and Git history commits, rollback, and revert also invalidate affected L2 quota cache entries because backend `.git` metadata can change outside the app-file mutation delta
- filesystem failures caused by the caller's own path map to client statuses at the `file_access.js` boundary through one shared `mapFilesystemErrorToHttpError` helper, applied at the write, delete, copy, and move mutation boundaries rather than re-implemented per operation: `ENAMETOOLONG` -> `400` naming the requested path and the 255-byte per-name limit, `EACCES` and `EPERM` -> `403`, and `ENOSPC` -> `507` (the router forwards any `400`-`599` status, so `507` reaches the client as-is). `EMFILE`, `ENFILE`, and unlisted codes stay unmapped so they keep their raw `500`, because transient resource exhaustion is genuinely server-side. The mapped error preserves the raw OS message and keeps the original error as `cause`. A permission failure on the project root itself, or on a root the caller never named, stays a `500`: that is operator configuration and must not be reported as a client mistake. Already-statused errors such as validation, access, quota, and copy-conflict failures pass through untouched
- write-encoding and write-operation validation rejections name the accepted forms in their messages (encodings `"utf8"` and `"base64"`, write options on a single entry object, operations `replace`, `append`, `prepend`, and `insert`, and `file_delete` for removals) so the onscreen agent can self-correct from the error text

`module_manage.js` is the canonical entry point for:

- visible module discovery
- module metadata lookup
- Git-backed installs and updates
- module removal

Module Git rules:

- `module_manage.js` must pass resolved runtime params into shared Git client creation so `GIT_BACKEND` affects module info, install, and update flows consistently

Module discovery rules:

- request-time module reads and listings must consume replicated shared-state shards instead of calling watchdog path-walk helpers directly
- normal override resolution should limit shard reads to readable `L0`, readable `L1`, and the authenticated user's `L2`
- admin-only cross-user module listings may expand to selected `L2/<user>` shards or all replicated `L2/*` shards as needed, but should still stay shard-scoped instead of scanning the whole app index

When `USER_FOLDER_SIZE_LIMIT_BYTES` is positive, first-time module installs into `L2/<user>/` must clone into a system temp directory first, measure that tree, and pass the quota projection before moving it into the user folder. Existing module updates still invalidate affected user quota cache entries after mutation because their final Git object growth is not known until the update completes, and the current cached user-root total should still come from indexed `file_index` metadata rather than a fresh disk crawl.

Current module-list areas are:

- `l1`
- `l2_self`
- `l2_user`
- `l2_users`

Admin-only access is required for aggregated or cross-user user-layer listings.

`git_history.js` is the canonical entry point for optional per-owner writable-layer history:

- `CUSTOMWARE_GIT_HISTORY=false` disables automatic history scheduling, but the runtime parameter defaults to `true`
- local-history client creation must pass resolved runtime params into `server/lib/git/local_history.js` so `GIT_BACKEND` can force `native` or `isomorphic`; `auto` keeps the shared fallback order
- each writable `L1/<group>/` and `L2/<user>/` owner root may become its own local Git repository when history is enabled
- file writes, deletes, copies, moves, auth/user writes, group writes, and module installs schedule a debounced commit for the affected owner root
- in clustered runtime, workers must not keep their own owner-root Git commit debounces; they publish changed logical app paths once, and the primary schedules the debounced commit after `applyProjectPathChanges(...)` finishes rebuilding the authoritative indexes
- local-history backends serialize work per owner repository, so commit, preview, diff, rollback, and revert operations for one root never overlap; native keeps subprocess work asynchronous, and the isomorphic fallback reuses immutable history-entry and tree caches for repeated Time Travel reads
- the debounce window starts at 10 seconds of quiet, drops to 5 seconds after a pending owner root has waited more than 1 minute, drops to 1 second after 5 minutes, and commits immediately after 10 minutes
- server shutdown flushes pending commits
- commit listing supports page `limit`, page `offset`, and open-ended `fileFilter` matching across changed paths and nested filenames; filtered list responses include full per-commit file action entries for listed commits, not only the matching files, still do not include patch bodies, and may return `total: null` when the backend can prove `hasMore` without finishing a full filtered count
- file diff reads, operation previews, and commit revert operations are separate helper calls so list pages stay fast
- repository discovery reuses the history target and permission model, returns owner roots rather than `.git` paths, and supports write-access filtering for Time Travel repository selection
- operation previews require write access, return the files affected by travel or revert, and can return an operation-specific patch for one file
- rollback suppresses scheduling so resetting a worktree does not create a commit loop
- rollback preserves the previous head in backend-owned history refs when possible so commits after the travelled-to point remain listable for forward travel
- revert creates a new history commit that undoes the selected commit instead of resetting the worktree to that commit
- each owner repository has a `.gitignore`; `L2` repositories must ignore `metadata/password.json`, `metadata/logins.json`, and `metadata/user_crypto.json`, while `L1` group repositories currently use an empty ignore file
- rollback snapshots and restores the ignored L2 auth and wrapped-user-key files so old commits cannot log the user out, resurrect an old password verifier, or silently replace the current `userCrypto` record
- `.git` metadata paths are reserved and must not be exposed through app-file APIs, direct app fetches, or path indexes

## Work Guidance

### Local Work Rules

- do not add ad hoc filesystem walks or permission checks to endpoints when this subtree already owns the rule
- keep changes to path semantics, inheritance, or permissions centralized here
- publish logical app-path mutations through the shared mutation-capture path after mutations that affect indexed module, group, user, or file state
- if path, layer, module-resolution, or permission rules change, also update `app/L0/_all/modules/_core/skillset/ext/skills/development/` because the shared development skill mirrors this contract
- if path, layer, module-resolution, or permission rules change, also update the matching docs under `app/L0/_all/modules/_core/documentation/docs/server/`
- if you change path normalization, group semantics, `maxLayer`, file access, or module-management rules, update this file and the relevant server or API docs in the same session

## Verification

- `tests/user_path_canonicalization_test.mjs` covers the own-user prefix collapse, the doubled-path read fallback, the corrective write rejections, and that another user's name inside a doubled shorthand never collapses to a sibling of their root


## Child DOX Index

- No child DOX docs.
