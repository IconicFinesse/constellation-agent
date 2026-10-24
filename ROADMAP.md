# Roadmap

Four tiers, and the difference between them matters.

- **Shipped** is verifiable in git history. Nothing here is aspirational.
- **Selected** is owner-approved for this phase and not yet started. It is a
  commitment, not a schedule — no lane opens until the sequencing decision in
  `PROJECT-THESIS.md` §8.6 is called.
- **In progress** is work actively being built. It may slip.
- **Exploring** is ambition, not commitment. Items here may never ship, or may ship
  in a form nobody has described yet.

The **Selected** tier exists because collapsing it into either neighbour would lie:
"In progress" would overstate (nothing is being built), and "Exploring" would
understate (the owner has chosen these).

Last updated by hand: 2026-10-22, features phase open.

## The standing thesis these tiers serve

> **The agent is a citizen of the system, not a client of it.**

No external vantage point, no schema boundary between thinking and doing, and a
server that holds no agent state — which is what makes the agent **unhostable** and
the deployment genuinely private. The product shape that follows is a **workspace
with an agent resident in it**, not a chat that produces artifacts.

Every candidate feature is filtered by `PROJECT-THESIS.md` §8 before it lands on
this page: no new server authority, no capability the residency model cannot
honestly provide, contract decisions now and content decisions from use.

## Shipped since the fork

The fork began at upstream commit `10f4ffd` (tag `baseline-2026-06-08`, the v0.66
era). Everything below diverges from that point.

### `v1.1.3` — First Light

Two readability corrections on surfaces that were technically correct but read
too small in use.

- **The Windows icon fills its taskbar slot.** The head artwork is wider than it
  is tall, so fitting it to the icon square filled the width and left it looking
  small beside uniform neighbours. The small entries (16-64px) now fill by height
  and let a few pixels of the dark cloak fall outside the frame, which is
  invisible at that size and reads ~13% larger in the same slot. The 128 and
  256px plated entries are unchanged.
- **The draggable avatar is larger.** The overlay avatar moves from 72px to 88px
  on desktop and 64px to 78px on narrow viewports. The character inside the
  source image occupies only about 60% of its canvas width, so the previous size
  rendered a smaller figure than the box implied; the larger box restores the
  intended presence without dominating the panel. The panel-width reserves now
  derive from the avatar size plus gap plus margin instead of hardcoded pixel
  budgets, so the extra size cannot crowd the panel against the viewport edge,
  and the hidden-edge peek geometry follows the new size automatically.

### `v1.1.2` — First Light

Windows icon correction after the v1.1.1 artwork pass.

- **The Windows icon set uses the Star-Shaper head.** Small entries (16-64px)
  carry the head cut out on transparency, because a floating head reads at taskbar
  size where the plated tile did not; the 16 and 24px entries get a rim-light pass
  derived from the artwork's own edge so the dark hood stays legible on a dark
  taskbar. The 128 and 256px entries keep the rounded navy plate for the
  downloaded-file and shortcut views.
- **Installer now refreshes the shell icon cache.** A `SHChangeNotify` call after
  file copy stops Explorer from showing the previous release's icon on an in-place
  update.

Windows jump-list entries pinned before this release keep their cached artwork
until the item is re-pinned; that cache is shell state, not application state.

### `v1.1.1` — First Light

A patch release that lands the artwork rebrand without waiting for the larger
`v1.2` line.

- **The product has its own face.** Every upstream image was replaced: page
  favicons and PWA icons, the Linux/Windows/macOS packaging icons, the README
  banner and Open Graph card, and the character art on the login, enter, admin,
  onscreen, and browser-frame surfaces. No HTML, manifest, or packaging wiring
  changed — filenames and paths are load-bearing, so only the bytes moved.
- **Icons split by size tier.** The detailed painterly render is the master at
  128px and above; below that the flat tile carries the mark, because detail
  collapses at 32px and 16px. Both are the same character, so the silhouette
  holds across the crossover instead of changing with fidelity.
- **README gained real illustrations** — hero, features, self-host, and docs
  images drawn from the new set, plus a rebuilt banner that keeps its starfield
  and animation.
- **Release titles drop the product-name prefix.** They now read
  `v1.1.1 — First Light` and are set by the release tooling rather than edited
  by hand after publishing.

### `v1.1.0` — First Light

The framework's shorthand names are spelled out, and nothing that already
existed stops working.

- **User home directories use long-form names.** `~/conf/` became `~/config/`,
  `~/hist/` became `~/history/`, and `~/meta/` became `~/metadata/`, so the tree
  the agent sees in its own prompt context is readable at a glance instead of
  abbreviated.
- **The module namespace is `modules`, not `mod`.** The `/mod/` URL prefix became
  `/modules/`, and the on-disk `app/L0/_all/mod` and `app/L0/_admin/mod` trees
  became `.../modules`. This was one atomic change: the URL prefix, the directory
  name, and the path parsers that map requests onto disk all had to agree, or
  module resolution would silently stop matching. It is cheaper now, before the
  builder phase produces modules against absolute import paths.
- **Existing installs keep their data.** A legacy read fallback means a server
  provisioned before this release still finds its credentials under `meta/`,
  its config under `conf/`, its history under `hist/`, and its installed modules
  under `mod/`. Reads prefer the new names and fall back to the old ones; writes
  always use the new names. No data is moved, renamed, or migrated.

Deliberately unchanged: `ext/`, `res/`, `lib/`, and `end/`, which are
recognizable conventions rather than cryptic abbreviations.

### `v1.0.0` — First Light

The first standalone release: the product is Constellation Agent throughout,
not a fork of something else still carrying its old name on screen.

- **Upstream identity is gone from the product surface.** The dashboard resource
  row, the `/login` and `/enter` footer social rows, and their local icons were
  removed outright. Repository, release, and publish metadata now point here,
  which also fixes a publish configuration that combined upstream's owner with
  this repository's name — a repository that does not exist.
- **Hosted space sharing no longer reaches upstream.** `CLOUD_SHARE_URL`
  defaulted to upstream's receiver, so a default install would have uploaded
  shares to a service this project does not run. It now defaults to empty, which
  the existing guards already treat as unavailable: local ZIP export and import
  are unaffected, and the hosted path stays hidden until a receiver is
  configured deliberately.
- **Packaged desktop stops adopting upstream's profile directory.** Dropping the
  upstream names from the legacy `userData` candidates prevents a fresh install
  from silently preferring that folder. The project's original `Agent One` names
  are still honoured, and the current-product names were always supported.
- **Linux packaging metadata names this repository's maintainer**, while the
  global `author` field keeps the original author's credit.
- **OpenRouter requests now identify this repository.** They previously sent
  upstream's domain as the referer on every call.
- **The Agent Zero video demos are gone.** Both bundled demo spaces streamed
  upstream's YouTube channel, and the onboarding launcher entry went with them.

Upstream attribution deliberately remains in `README.md`, `FORK.md`,
`PROJECT-THESIS.md`, `DESIGN-PHILOSOPHY.md`, and `LICENSE`. The lineage is the
point, not a detail to erase.

### `v0.66-fork.7`

- Desktop **connected mode**: the packaged app can run against a saved remote
  HTTPS server instead of always spawning a local one. First launch shows a
  connection chooser with Standalone (default) and saved servers; connections
  are HTTPS-only outside localhost development, the origin is pinned on first
  connect with a visible warning if it changes, and auto-update checks are
  disabled while connected. The embedded browser keeps full `space.browser`
  capability against the remote server with **zero** `web_browsing/` changes.
- **Fork-tag release fix**: `release-version.js` accepted only plain `vX.Y.Z`,
  so every `v*-fork.*` tag failed the desktop release `prepare` job before any
  build ran. Fork tags now map the fork ordinal to the semver patch
  (`v0.66-fork.7` → `0.66.7`), which also keeps the desktop updater monotonic.
- **Privacy**: tracked files carry no personal hostnames, private-network
  addresses, tunnel identifiers, or credentials; connection-mode tests use
  RFC 2606 example domains and RFC 5737 TEST-NET addresses.

### `v0.66-fork.6`

- Clear five high production dependency advisories with a plain `npm audit fix`
  (no `--force`); post-fix audit reports zero vulnerabilities (#83).
- Fix the container browser harness: install the missing `electron` the browser
  suites silently depended on, and pass `--disable-dev-shm-usage` so a 64 MB
  `/dev/shm` stops hanging Chromium (`browser_address_bar` 0/1 → 1/1,
  `browser_content_format` 0/5 → 5/5).

### `v0.66-fork.5`

- Stop re-probing absent space thumbnails and dashboard preferences with
  module-local negative caches (#15).

### `v0.66-fork.4`

- Rebrand as Constellation Agent; add `PROJECT-THESIS.md` and a rebranded `FORK.md`.
  Own the project rather than staging upstream pull requests.

### `v0.66-fork.3`

- Persist overlay conversation history across a torn-down turn with mid-stream
  checkpoints (#23, contained part).
- Name the real removed range in prompt-budget placeholders and support sliding reads
  so trimmed source can be reconstructed (#61, truncation half).
- Self-found: forward the resolved runtime temp root through the share service
  (read-only host `EACCES`), repair two suites broken on a clean checkout, and wake
  four dead frontend suites with a `/modules/` specifier loader.

### `v0.66-fork.2`

- Mode-aware Web Crypto gate so plain-HTTP `SINGLE_USER_APP` deployments can start (#49).
- Clamp the message-bubble grid track and wrap code blocks so long content cannot
  inflate the bubble (#62).

### `v0.66-fork.1`

- Surface auth-key mismatches instead of a silent login failure (#39, #52).
- Frame provider completions by body rather than the content-type header (#47).
- Validate space archives in-process and return `400` on corrupt ZIPs (#57).
- Use `??` so an explicitly cleared Params value survives save and reload (#58).
- Stage folder-download ZIPs in the resolved runtime temp root (#64).

### Repository and governance

- Fork charter with provenance, baseline tag, and divergence policy (`FORK.md`).
- Binding project thesis, namespace rule, and modularity rule (`PROJECT-THESIS.md`).
- Dual MIT notice; upstream attribution retained throughout.

## Selected

Owner-approved for the features phase. The two thesis features are additive
modules under `app/L0/_all/modules/constellation/`, self-contained under the
modularity rule; the connected-mode lane is desktop-packaging work under
`packaging/desktop/`. None of the three requires new server authority. Full
descriptions in `PROJECT-THESIS.md` §1.3, §8.4 and §8.5.

### Connected mode — the desktop app pointed at a remote server

**Status:** Phase 3 Lane 1 (active 2026-10-22).

**What it is:** the packaged desktop app gains a second connection mode next to
the default `standalone` spawn: `connected` skips the local server and opens a
saved HTTPS remote URL — same renderer, same agent runtime, same embedded
browser at full capability, canonical data on the owner's server. The browser
wall in a plain webUI tab resolves without touching `web_browsing/`: the
runtime gate reads the desktop bridge, and the wall copy stays as accurate
signposting for browser tabs.

**Why it earns the slot:** first owner-ratified feature since the fork, and the
only shape that keeps both halves of the vision — a light, always-reachable
server for workspace data, and the fully capable embedded browser living in the
desktop client — with zero new server authority and zero agent state moved
server-side. It strengthens the residency thesis instead of arguing with it.

**Contracts frozen now:** standalone remains the default and stays zero-config;
a launcher chooser offers both modes every launch; saved connections (label +
pinned origin) live in desktop `userData`; HTTPS-only outside localhost dev
targets; origin pinned on first connect with a visible change warning;
auto-update checks disabled in connected mode; connection-mode resolution
extracted into a unit-testable module rather than inline in `main.js`; zero
`web_browsing/` changes.

**Content discovered later:** chooser polish, reconnect-on-launch behavior,
multi-server management UX.

**Serving infrastructure (approved):** an owner-hosted HTTPS endpoint published
through a Cloudflare Tunnel, with the connector running inside the self-hosted
server guest as a systemd service (upstream `127.0.0.1:3000`) rather than the
host's tunnel app; a private-network fallback route stays available and
sidesteps the ~100 MB free-tier request cap for large uploads. No concrete
hostnames, addresses, or credentials belong in this repository.

### Capability authoring as the compounding loop

**What it is:** the agent goes from building the thing you asked for to building the
*capability* that builds those things. Write a `SKILL.md`, validate the frontmatter,
reload the catalog, prove the new capability fires — browser side, through the file
APIs the server already has.

**Why it earns a slot:** content is disposable, capability compounds. A widget helps
once; a skill that produces widgets of a class helps every time after. That is the
difference between an agent that is the tool and one that is the colleague.

**Why it is not purely a build task:** *when should a repeated solution be promoted
into a skill?* is a judgement about a real workflow. That half is discovered by use,
not designed from architecture knowledge.

**Honest constraints:** extension lookups are cached in memory so a new extension
file is not live until refresh (skill files are re-read on prompt build); auto-loaded
discovery is limited to top-level `ext/skills/*/SKILL.md`, and nested skills are
explicit-load only. The feature inherits those rules rather than working around them.

### A memory surface, not a memory policy

**What it is:** a way to see, understand, and correct what the agent remembers and why
— what it knows, when it learned it, which space or conversation produced it, and what
is currently in the prompt versus merely resident.

**Why it earns a slot:** memory here is already the right substance —
`~/memory/*.include.md`, plain text, in the user's own layer, auto-loaded by a skill
that teaches a convention rather than by prompt-builder special-casing. It is currently
invisible. Making an existing architectural advantage legible is the cheapest kind of
value to add and the most durable. A user who can read the agent's memory can correct
it, and a corrected memory beats a longer context window.

**Why it is not the dashboard everyone else ships:** competing products expose an
opaque store through categories and confidence scores you cannot inspect. This is a
view over files the user already owns.

**Contract versus content:** where memory lives, its format, how it is discovered and
ordered, and the runtime surface the module reads through are all already fixed by the
inherited architecture — so this feature *defends* an existing contract instead of
inventing one. When the agent should write memory on its own, and what belongs in
memory versus a space's own files, is content: discovered by use.

That split is why the read-only half can ship before a use phase and the write-behaviour
half cannot.

### Sequencing — partially called

Connected mode was called by the owner on 2026-10-22 and runs as Phase 3 Lane 1
(tunnel infra → desktop feature → docs). Whether the two module features come
before, after, or interleaved with a real use phase remains the open decision
recorded in `PROJECT-THESIS.md` §8.6 and `PLAN.md`. No lane for them starts until
the owner calls it.

## In progress

Nothing is listed here yet. The bug-fix phase closed 2026-10-22; feature work starts
after the sequencing decision above.

## Exploring

Ambition only. These are trajectories the architecture makes possible, drawn from the
project's own analysis — not commitments, and not a promise list. Each is stated with
the reason it is not yet Selected.

- **Agent-authored capabilities, not just agent-authored content.** *Selected above;
  retained here only as a pointer to the original framing.* Because skills are
  readable/writable text and the extension system has legal seams, "build me a widget"
  could become "build me a capability that builds these widgets."
- **Standing intent per space.** A space that knows what it is for, so the agent picks
  up the thread when you open it — persisted intent attached to the workspace instead
  of buried in a chat log. *Not selected yet:* durable-intent semantics interact with
  the residency limits and should be designed against a workflow someone actually runs.
- **Spaces as the thing you point at.** The transient tail already carries live page
  state, so the room is already context; the missing primitive is "this" — work on this
  room. *Not selected yet:* this is interaction grammar rather than a module, and the
  right grammar is a use-phase finding.
- **Team capability in L1.** A skill pack in the group layer is a team capability,
  versioned by time travel, shared by permission rather than by publish step. The server
  never needs to know two agents exist. *Not selected yet:* requires the isolation audit
  first — per-user/group/global enforcement is the canon's most under-audited surface.
- **Template-with-context sharing.** A shared space that ships its standing instructions
  too, so a research room arrives with the agent already briefed. *Not selected yet:*
  depends on where standing intent lands.
- **Multi-agent collaboration inside one space.** If agent state is files in a layer,
  two agents acting for two users in a shared group layer is a permissions problem
  rather than an architecture problem. The server would not need to know they exist.
  *Not selected yet:* same isolation-audit dependency as L1 team capability.
- **Agent avatar states.** The artwork set carries idle, working, error, and
  loading poses; only idle is wired today (the admin empty state). Making the
  avatar reflect live agent state needs a transition design first: cross-fades
  or motion that reads as one continuous character rather than four stills
  swapping. *Not selected yet:* parked by owner decision until that design
  direction exists, because a snapping swap would be worse than one stable
  avatar.
- **Local-first, provider-agnostic inference.** Browser-side model runtimes plus
  browser-owned API keys plus `CUSTOMWARE_PATH` could produce a genuinely private
  deployment. *Not selected yet:* largely already possible; the gap is packaging and
  guidance, not architecture.
- **The admin console as a true control plane.** `maxLayer=0` plus app-file APIs
  across all layers plus Time Travel equals a guaranteed-working surface that can
  inspect and repair any broken customization. *Not selected yet:* the untested claim
  (that the hatch survives a fully broken main UI) is a cheap test and a candidate to
  pull forward as a trust artifact.
- **Making the residency handoff honest.** The system's strongest claim (the agent
  lives in the frontend runtime) is in tension with its most useful one (the agent can
  do persistent structural work), because the frontend is ephemeral. Rather than
  resolving that, the honest path is an explicit handoff: browser-resident agent for
  interactive, high-bandwidth, in-context work; something else for the long tail. The
  extension system could host that second thing without violating `L0`. *Not selected
  yet:* the largest idea on this page and the one most likely to change shape after a
  use phase.

## Deliberately not planned

Stated so nobody waits for them:

- **Durable background agent work.** No server-side orchestration, no headless agent.
  A task that outlives the tab cannot exist in this design as specified, and adding it
  would dissolve the constitution that keeps the agent unhostable.
- **Multi-client session continuity.** `space` does not cross browsing contexts. Two
  devices are two independent agents sharing a filesystem.
- **No new upstream pull requests.** The upstream PR phase closed 2026-10-22. Genuinely
  general bugs with an already-upstream-shaped fix remain the only exception.

## How this file is maintained

Tiers are updated by hand because roadmap status is a judgement call, not a
mechanical fact. Selecting an item moves it from **Exploring** to **Selected** with the
reason it was chosen; starting a lane moves it to **In progress**; shipping it moves it
to **Shipped** with the tag. The **What's new** block in [`README.md`](./README.md) is
generated from git history by `packaging/scripts/whats-new.js` and should not be
hand-edited.
