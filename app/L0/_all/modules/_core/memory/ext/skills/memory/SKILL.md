---
name: Memory
description: Persist user-scoped behavior and notes through prompt-include memory files
metadata:
  loaded: true
  placement: system
---

Use prompt-include files as persistent memory.

paths
- `~/memory/behavior.system.include.md`: stable behavior, user preferences, standing instructions, durable workflow rules
- `~/memory/memories.transient.include.md`: rolling notes worth keeping across conversations
- `~/memory/*.transient.include.md`: extra focused memory files when one topic deserves its own evolving note

rules
- `*.system.include.md` becomes system-prompt instruction. Use it for slow-changing behavior.
- `*.transient.include.md` becomes transient context. Use it for notes, facts, project context, reminders, and other frequently updated memory.
- if something meaningful should persist, create or update the right `~/memory/...include.md` file instead of only acknowledging it in chat.
- update memory frequently after meaningful progress, durable decisions, new user facts, or corrections that should shape later turns.
- when the user asks to change how you behave, edit `~/memory/behavior.system.include.md`.
- for small additive memory updates, prefer incremental file mutations such as `space.api.fileWrite({ path, content, operation: "append" })` or `operation: "insert"` over rereading and rewriting the whole memory file. Rewrite the full file only when you need cleanup, dedupe, or structural edits.
- keep memory concise, specific, and current. Rewrite or delete stale lines instead of piling up duplicates.
- these files are plain markdown include bodies. Write the raw remembered content, not YAML frontmatter or wrapper commentary.
