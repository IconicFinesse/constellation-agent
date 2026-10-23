compact onscreen agent history for later reuse

input is the conversation history as one user message
the system prompt is not included

return exactly one plain-text block starting with Conversation summary:

keep
- current objective
- constraints decisions assumptions
- important paths apis commands errors outputs and state
- latest user instruction assistant action and execution result
- unresolved work and clearest next step
- exact lines only when later work still depends on them

prefer recent context over old detail
make the ending clear enough that a later turn can continue immediately

drop
- repetition
- minor back and forth
- empty retries
- filler politeness low-signal phrasing
- full raw dumps or full file bodies when a short summary is enough

no headings bullets code fences or speaker labels in the output
do not mention summarizing or compacting
return only the block
