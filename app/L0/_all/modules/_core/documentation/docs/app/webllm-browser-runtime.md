# WebLLM Browser Runtime

This doc covers the first-party browser inference test surface under `_core/webllm`.

## Primary Sources

- `app/AGENTS.md`
- `app/L0/_all/modules/_core/webllm/AGENTS.md`
- `app/L0/_all/modules/_core/webllm/store.js`
- `app/L0/_all/modules/_core/webllm/webllm-worker.js`
- `app/L0/_all/modules/_core/webllm/helpers.js`

## Route And Scope

The routed test page lives at:

```txt
#/webllm
```

This route is not advertised to the dashboard panels index. The Hugging Face-backed `#/huggingface` route is the only dashboard-listed Local LLM page.

This module is intentionally a manual browser-only test harness:

- load a prebuilt WebLLM `model_id` or a custom model URL plus model library URL
- set a plain system prompt
- send plain user chat turns and stream assistant text back
- stop inference when the runtime supports interruption
- show simple response throughput metrics after the turn finishes
- present the chat area as a `Testing chat` surface with an inline clear-chat action in the section heading
- keep the route visually compact and low-chrome so more of the viewport is available for model controls and chat
- show the current model and load state first in the sidebar, inside a slightly more prominent rounded panel with a compact status badge, an unload control beside the current model name that switches to `Stop` while a load is in flight, and auto-restore the last successful load on refresh in the same browser profile
- on desktop, keep the route slightly shorter than the full viewport, cap the routed surface itself to that height, and let the model list absorb the remaining sidebar height above the advanced section so the list and chat thread own the primary scroll areas instead of the whole page
- keep that desktop height clamp local to the WebLLM page layout, matching the Hugging Face route pattern rather than relying on a router-level `data-route-path` height override
- keep both the advanced custom-model form and the system-prompt editor collapsed by default so the main model list and chat stay dense

It is not a second agent runtime. There is no tool execution, attachment handling, queued turn scheduler, or persisted chat history in this module.

## Main-Thread And Worker Split

`_core/webllm` keeps the heavy inference runtime out of the routed page thread.

Ownership split:

- `config-sidebar.html` owns the standalone model-loading sidebar component mounted by `view.html` through `<x-component>`
- `store.js` owns the routed page, Alpine store state, and worker lifecycle
- `webllm-worker.js` owns `MLCEngine`, model reloads, streaming chat calls, and stop/reset actions
- `protocol.js` owns the postMessage event names shared between the page and worker
- `web-llm.js` is the vendored browser build of `@mlc-ai/web-llm`, kept local to the module instead of promoted into `_core/framework`

That split keeps the route self-contained and avoids a repo-wide frontend dependency seam for an experimental test surface.

## Model Loading Contract

Two load modes are supported:

1. Prebuilt WebLLM models by `model_id`, using the package's `prebuiltAppConfig`.
2. Custom models by browser-visible model URL plus `model_lib` URL.

Custom-load rules:

- the custom model URL and model library URL are both required
- the custom model id is optional; when blank, `_core/webllm/helpers.js` derives one from the model URL
- the route does not add backend storage or server proxy behavior for model configuration
- the routed page includes a compact searchable prebuilt catalog so users can select every model in the vendored WebLLM build without guessing model ids manually
- the prebuilt catalog uses browser cache status to label uncached entries as `Download <size estimate>`, cached entries as `Enable`, and the active prebuilt entry as `Unload`, and it exposes a `Downloaded` filter for cached-only browsing
- cached prebuilt rows render slightly brighter than uncached rows, and the active prebuilt row is outlined in green so the enabled model is immediately visible in the compact list
- cached prebuilt rows also expose a red trash control that discards cached model files from browser storage; if the discarded model is currently enabled, the route unloads it first and clears the persisted auto-restore selection
- cached action buttons stay label-sized, while uncached download buttons keep a slightly wider fixed width so the compact list remains visually aligned without wasting as much space
- sparse filtered result sets stay top-aligned and keep compact row heights instead of stretching rows to fill the full model-list column
- the routed page persists the last successfully loaded model config in browser storage and automatically reloads it on refresh
- the advanced custom-model form is collapsed by default and its load action is isolated from the prebuilt model picker
- arbitrary Hugging Face repo discovery is intentionally not exposed as a normal load path because official WebLLM custom loading still needs MLC/WebLLM-compiled artifacts plus a compatible `model_lib` wasm

WebLLM itself owns browser-side downloads and caching. `_core/webllm` only forwards progress reports and load results into the route UI.

## Chat And Metrics Contract

The route sends OpenAI-style WebLLM chat-completion requests with:

- one optional system prompt message first
- the in-memory user and assistant history from the page
- `stream: true`
- `stream_options.include_usage: true`

Stop behavior:

- the stop button calls `engine.interruptGenerate()` inside the worker
- a stopped turn should finish with WebLLM's `abort` finish reason when the runtime reports it

Metrics behavior:

- final assistant metrics use WebLLM usage extras such as `decode_tokens_per_s`, `prefill_tokens_per_s`, `time_to_first_token_s`, and `e2e_latency_s` when available
- if WebLLM omits decode throughput, the route falls back to simple elapsed-time math at response end
- the chat view renders model id plus key response metrics in a single compact inline row below each assistant reply instead of separate metric cards
- the compact metric labels use hover tooltips so the abbreviated stats remain readable without consuming more space
- sparse chat threads stay top-aligned and keep compact message heights instead of stretching message rows to fill the full thread column
- the model list uses simple separated rows instead of boxed cards, and chat messages use compact padding to keep more turns visible

## Related Docs

- `app/modules-and-extensions.md`
- `app/runtime-and-layers.md`
