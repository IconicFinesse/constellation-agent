<p align="center">
  <a href="https://github.com/IconicFinesse/constellation-agent"><img src="./.github/readme-banner-thin.svg" alt="Constellation Agent banner" /></a>
</p>

<p align="center">
<br>
  <a href="#run-it-yourself"><img alt="Run it yourself" height="50" src="https://img.shields.io/badge/Run%20it%20yourself-59F0A8?style=for-the-badge&labelColor=07111F&color=59F0A8" /></a>
  <a href="ROADMAP.md"><img alt="Roadmap" height="50" src="https://img.shields.io/badge/Roadmap-FFFFFF?style=for-the-badge&labelColor=07111F&color=FFFFFF" /></a>
</p>

<h3 align="center">A self-hosted agent that builds its own interface.<br />Forked from Space Agent, hardened for real deployments.</h3>

<p align="center">
  <em>Constellation Agent is an independent project built on the
  <a href="https://github.com/agent0ai/space-agent">Space Agent</a> codebase.</em>
</p>

## What this is

[Space Agent](https://github.com/agent0ai/space-agent) is a browser-resident agent
runtime. The agent loop runs inside the same JavaScript realm as the page, modules,
and widgets it reshapes, with a deliberately thin server behind it that holds no
agent state. That architecture is the interesting part, and this fork keeps it.

Constellation Agent takes that base and works on what it takes to run it for real:
read-only filesystems, absent system binaries, plain-HTTP LAN hosts, mislabeled
provider transports, and packaged desktop builds.

<p align="center">
  <img src="./.github/brand/readme-hero.webp" alt="Constellation Agent standing on a planet ledge beneath a star field" width="640" />
</p>

## Built on Space Agent

Most of what makes this project worth running is upstream work, and it is credited
as such. The GitHub fork badge is deliberate.

Inherited from [agent0ai/space-agent](https://github.com/agent0ai/space-agent):

- **The agent lives in the frontend runtime.** It works directly with the same
  framework, modules, spaces, and UI it reshapes, in a tab or in the desktop app.
- **Text-based capabilities.** New behaviour can live in `SKILL.md` files the agent
  writes and extends itself, in plain text.
- **Token-efficient execution.** No bulky tool-call JSON; the agent can stay in plain
  text and plain JavaScript inside the same message.
- **L0 / L1 / L2 layering.** Firmware, group, and personal layers, with the layer
  acting as the permission.
- **Layered extension with seams.** Modules can be added, removed, or overridden by
  ranked layer rather than welded into one app.
- **Hierarchical users and groups**, per-user work with group sharing, admin mode,
  and Git-backed Time Travel over file layers.
- **AI-driven development and documentation.** The DOX `AGENTS.md` hierarchy plus
  skills, so agents can understand ownership and architecture while maintaining it.

Upstream's own demo and community:

- Hosted demo: [space-agent.ai](https://space-agent.ai)
- The upstream project walkthrough:
  [![Space Agent walkthrough](https://img.youtube.com/vi/CNRHxEZ8yqs/0.jpg)](https://www.youtube.com/watch?v=CNRHxEZ8yqs)

Upstream was created by [Agent Zero](https://agent-zero.ai). The original MIT notice
is retained in [`LICENSE`](./LICENSE).

## What this fork adds

Only claims that are true today:

<p align="center">
  <img src="./.github/brand/readme-features.webp" alt="Constellation Agent arranging floating interface panels" width="720" />
</p>

### Hardening for hosts that actually exist

A focused campaign fixed ten upstream issue areas plus three self-found
infrastructure defects, shipped across `v0.66-fork.1` through `v0.66-fork.5`.
The recurring shape of the bugs is the point:

- **Read-only and packaged hosts.** Folder downloads and hosted-share extraction
  staged temp files in a bundled, read-only tree. Both now use the resolved runtime
  temp root.
- **Absent system binaries.** Space import shelled out to `unzip`; a missing binary
  or corrupt archive surfaced as a redacted `500`. Import now validates and extracts
  in-process and returns a clear `400` on a bad archive.
- **Plain-HTTP LAN hosts.** Browsers withhold `crypto.subtle` outside secure contexts,
  and the compatibility gate demanded it unconditionally — dead-ending self-hosters.
  The gate is now mode-aware, and the blocked copy names `SINGLE_USER_APP=true`.
- **Mislabeled provider transports.** Chat transport dispatched on
  `content-type.includes('text/event-stream')` and sent everything else to an
  unguarded `response.json()`. Responses are now framed by body.
- **Silent failures.** A CLI-sealed password verifier plus environment-injected
  keys produced a generic `401`. The server now logs a loud diagnostic naming the
  user and the active key source, while the client response stays generic.
- **Vanishing work.** Opening `/admin` mid-turn tore down the running agent and lost
  the in-flight prompt. Submitted turns are now persisted at prompt start with
  interrupted mid-stream checkpoints. (The interruption itself is architectural and
  still parked — see the roadmap.)
- **Unrecoverable truncation.** Prompt-budget trimming replaced the middle of
  over-budget contributors, and the read path could only re-read the head. Placeholders
  now name the real removed range and the read API can step through it.
- **Repeated absent-file probes.** Missing thumbnails and dashboard prefs were
  re-probed on every render. Both are now negatively cached.

### Its own product direction

The fork is not a pull-request staging area. [`PROJECT-THESIS.md`](./PROJECT-THESIS.md)
records the scope decision and [`FORK.md`](./FORK.md) records the divergence policy,
provenance, and baseline tag.

<p align="center">
  <img src="./.github/brand/readme-docs.webp" alt="Constellation Agent reading in a library" width="420" />
</p>

### An additive namespace rule

> New capabilities live in `app/L0/_all/modules/constellation/<repo>/` — additive, tracked,
> never inside inherited `_core`.

This keeps upstream pulls cheap, keeps provenance legible (`modules/constellation/...` is
ours, `modules/_core/...` is inherited), and means a module can be replaced wholesale
without touching the firmware beneath it. Extending the framework is preferred;
editing it is allowed when a seam genuinely cannot express the change.

`app/L1` and `app/L2` are gitignored runtime state, so fork code is never placed there.

### Its own release line

Releases are tagged `vX.Y.Z` from this repository. Release titles read `vX.Y.Z — First Light`:
the moniker applies to every `v1.x` release and changes only at a major
version bump. Earlier fork
builds used `v0.66-fork.N`; those tags stay valid, and because `1.0.0` sorts
above `0.66.7` an existing install updates forward cleanly. Downstream instances
(a container test instance, an UmbrelOS VM) update by git pull or release against
`origin`, and their `L1`/`L2` state is expected to survive every update untouched —
the same contract upstream gave its users, now given by this fork.

## What's new

<!-- WHATS-NEW:START -->

**`v1.1.3`**

- Fill the Windows icon slot and enlarge the overlay avatar

**`v1.1.4`**

- Fill the icon past the slot and give the avatar real presence

_Newest releases only. The full per-release record lives in [`ROADMAP.md`](./ROADMAP.md). Generated from `baseline-2026-06-08..HEAD` by `packaging/scripts/whats-new.js`._
<!-- WHATS-NEW:END -->

Generated from git history by `packaging/scripts/whats-new.js`. Run it before a
release; do not hand-edit the block.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for shipped work, what is in progress, and what is
being explored. The roadmap is deliberately tiered: shipped items are verifiable in
git history, and exploring items are labelled as ambition rather than commitment.

<a id="run-it-yourself"></a>

## Run it yourself

Constellation Agent is MIT-licensed and runs from source. There are no prebuilt
binaries published yet — release artifacts are a separate, unfinished step, and this
section will say so until it is done.

<p align="center">
  <img src="./.github/brand/readme-selfhost.webp" alt="Constellation Agent exploring a cave with a lantern" width="420" />
</p>

```bash
git clone https://github.com/IconicFinesse/constellation-agent.git
cd constellation-agent
npm install

# create yourself an admin (a fresh server has no accounts and no browser signup)
node space user create admin --password "change-me-now" --full-name "Admin" --groups _admin

# start the server
node space serve
```

For development, `npm run dev` starts the server with auto-reload. The checked-in VS
Code launch entry `Dev Server (npm run dev)` attaches breakpoints across restarts.

For production:

```bash
node space set CUSTOMWARE_PATH=/srv/space/customware
node space supervise HOST=0.0.0.0 PORT=3000 # zero downtime auto-update
```

Run `node space help` for the full command surface, documented per command in
[`commands/params.yaml`](./commands/params.yaml).

## License

MIT, per upstream. The original copyright notice stays in [`LICENSE`](./LICENSE)
alongside this fork's own.
