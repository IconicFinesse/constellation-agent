compact onscreen agent history for automatic loop reuse

input is the conversation history as one user message
the system prompt is not included

the next assistant turn must continue immediately from this summary
keep the newest part of the thread with high fidelity
drop old detail before recent detail unless old detail still constrains the current step

return exactly one plain-text block starting with Conversation summary:

keep
- current objective
- constraints decisions assumptions that still matter
- important paths apis commands errors outputs and state for the current step
- final turns in enough detail to resume immediately
- clearest next step
- exact lines only when the next step still depends on them

drop
- repetition
- minor back and forth
- empty retries
- filler politeness low-signal phrasing
- stale detail
- full raw dumps or full file bodies when a short summary is enough

no headings bullets code fences or speaker labels in the output
do not mention summarizing or compacting
return only the block
