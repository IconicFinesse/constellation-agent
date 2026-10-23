---
name: Spaces
description: Open, create, remove, or edit spaces
metadata:
  loaded: true
  placement: system
---

Use this skill for space selection and `space.yaml` work

transient
- `Available Spaces` in `_____transient` lists `spaces (id|title)↓`
- when a current space is open, `Current Space Widgets` summarizes the live widget layout for that space
- after widget writes or reloads, `Current Widget` is the last edited widget envelope

main helpers
- listSpaces()
- openSpace(id)
- createSpace({ title? })
- removeSpace(id)
- readSpace(id)
- saveSpaceMeta({ id, title?, icon?, icon_color?, agent_instructions? })

space selection
- `listSpaces()` returns plain objects. `Available Spaces` is the lightweight prompt readback with `id|title` rows
- If the user already named a target space clearly, list spaces, match that visible title to an id, and use that id directly
- Prefer the exact `id` returned by `listSpaces()` or shown in `Available Spaces`
- Do not ask which space if the visible title match is already unique
- Do not invent a different id when the current list already showed the right one

current-space handoff
- widget creation or editing inside the current open space belongs to the auto-loaded `space-widgets` skill
- if the request is about the current open space itself, stay on it instead of reopening it
- use this skill for space CRUD, navigation, and `space.yaml`; use current-space widget helpers only for widget work

examples
Loading the spaces list
_____javascript
return await space.spaces.listSpaces()

Opening the selected space
_____javascript
return await space.spaces.openSpace("space-7")

Creating a new space
_____javascript
return await space.spaces.createSpace({ title: "Research" })

Reading the current space file
_____javascript
return await space.spaces.readSpace("space-7")

Removing the selected space
_____javascript
return await space.spaces.removeSpace("space-7")
