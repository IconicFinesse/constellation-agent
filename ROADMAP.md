# Roadmap

Three tiers, and the difference between them matters.

- **Shipped** is verifiable in git history. Nothing here is aspirational.
- **In progress** is work actively being built. It may slip.
- **Exploring** is ambition, not commitment. Items here may never ship, or may ship
  in a form nobody has described yet.

Last updated by hand: 2026-10-22.

## Shipped since the fork

The fork began at upstream commit `10f4ffd` (tag `baseline-2026-06-08`, the v0.66
era). Everything below diverges from that point.

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
  four dead frontend suites with a `/mod/` specifier loader.

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
- Binding project thesis and namespace rule (`PROJECT-THESIS.md`).
- Dual MIT notice; upstream attribution retained throughout.

## In progress

Nothing is listed here yet. The bug-fix phase closed 2026-10-22, and feature work
starts after it. Items appear here when they are actively being built, not when they
are merely planned.

## Exploring

Ambition only. These are trajectories the architecture makes possible, drawn from the
project's own analysis — not commitments, and not a promise list.

- **Agent-authored capabilities, not just agent-authored content.** Because skills
  are readable/writable text and the extension system has legal seams, "build me a
  widget" could become "build me a capability that builds these widgets."
- **Multi-agent collaboration inside one space.** If agent state is files in a layer,
  two agents acting for two users in a shared group layer is a permissions problem
  rather than an architecture problem. The server would not need to know they exist.
- **Local-first, provider-agnostic inference.** Browser-side model runtimes plus
  browser-owned API keys plus `CUSTOMWARE_PATH` could produce a genuinely private
  deployment.
- **The admin console as a true control plane.** `maxLayer=0` plus app-file APIs
  across all layers plus Time Travel equals a guaranteed-working surface that can
  inspect and repair any broken customization.
- **Making the residency handoff honest.** The system's strongest claim (the agent
  lives in the frontend runtime) is in tension with its most useful one (the agent can
  do persistent structural work), because the frontend is ephemeral. Rather than
  resolving that, the honest path is an explicit handoff: browser-resident agent for
  interactive, high-bandwidth, in-context work; something else for the long tail. The
  extension system could host that second thing without violating `L0`.

## Deliberately not planned

Stated so nobody waits for them:

- **Durable background agent work.** No server-side orchestration, no headless agent.
  A task that outlives the tab cannot exist in this design as specified.
- **Multi-client session continuity.** `space` does not cross browsing contexts. Two
  devices are two independent agents sharing a filesystem.
- **No new upstream pull requests.** The upstream PR phase closed 2026-10-22. Genuinely
  general bugs with an already-upstream-shaped fix remain the only exception.

## How this file is maintained

Tiers are updated by hand because roadmap status is a judgement call, not a
mechanical fact. The **What's new** block in [`README.md`](./README.md) is generated
from git history by `packaging/scripts/whats-new.js` and should not be hand-edited.
