# AI Workspace Pro

Autonomous, **on-device** workspace agent. A zero-API-key, privacy-first assistant that records expenses, manages tasks, schedules calendar events, runs semantic search, coordinates specialist personas, and talks to small AI models that are downloaded and executed **entirely in your browser tab** via [Transformers.js](https://huggingface.co/docs/transformers.js).

```
                            ┌────────────────────────────────────────────┐
   user message ──────────▶ │   runPipeline  (app/pipeline.js)           │
                            │                                            │
                            │  0. quick-chat fast-path (0 ms, no model)  │  greetings / thanks / identity / help
                            │  1. classifyIntent   → zero-shot classifier │
                            │  2. extractEntities  → NER token tagger    │
                            │  3. rankTools        → embedding scorer    │
                            │  4. routeToAgent     → specialist persona  │
                            │  5. executeTool      → tool / data layer   │
                            │  6. generateResponse → small T5 (dialog)   │
                            └────────────────────────────────────────────┘
```

---

## Highlights

- **No API keys, no servers, no accounts.** All inference runs in the browser via WebAssembly (ONNX Runtime). Works offline after the first model download.
- **One tiny model at a time.** A `ModelScheduler` loads a single ~77–260 MB specialist model per stage and disposes it (frees the ONNX session) before the next stage loads, keeping memory low and roughly constant.
- **Instant replies for common chat.** Greetings/thanks/identity/help short-circuit before any model work (~0 ms).
- **Deterministic fallbacks everywhere.** Every model stage can fail (offline, CDN blocked, Node runtime) without breaking the app — rule-based intent, entity extraction, and template replies take over.
- **Multi-persona multi-agent.** Characters (Aria, Marcus) have specializations; tasks can be delegated (`delegate to marcus …`) or auto-routed to the best specialist.
- **Persistent, memory-fast storage.** Writes mirror to IndexedDB (survives reload), reads are served from in-memory maps — no per-read transaction latency.
- **Built-in tool registry** with permission levels, parameter validation, a sandboxed `create_tool` dynamic-tool system, and a chaining executor.

---

## Quick start

No build step. Serve the folder over HTTP (modules + CDN need a real origin) and open `index.html`:

```bash
# any static server, e.g.
python3 -m http.server 8080
# then open http://localhost:8080
```

### Tests

```bash
node test.js        # 55 unit/integration tests — must stay green
open test.html      # run the same suite in the browser
```

---

## On-device AI (`modelSettings.pipeline`)

```jsonc
{
  "policy": "swap",          // one model resident at a time
  "threshold": 0.35,         // min classifier confidence for a "model" intent
  "memory": { "maxSimultaneous": 1, "wasmInitialMb": 64 },
  "stages": [
    { "key": "encoder", "task": "feature-extraction",        "role": "embedder",   "model": "Xenova/all-MiniLM-L6-v2" },
    { "key": "intent",  "task": "zero-shot-classification",  "role": "classifier", "model": "Xenova/mobilebert-uncased-mnli" },
    { "key": "tagger",  "task": "token-classification",      "role": "ner",        "model": "Xenova/bert-base-NER" },
    { "key": "dialog",  "task": "text2text-generation",      "role": "generator",  "model": "Xenova/LaMini-Flan-T5-248M" }
  ]
}
```

| Stage | Task | Used for |
| --- | --- | --- |
| `encoder` | feature-extraction | semantic search, tool ranking, record embeddings |
| `intent` | zero-shot-classification | which tool / intent the message maps to |
| `tagger` | token-classification | entity/parameter extraction (amount, date, target) |
| `dialog` | text2text-generation | natural-language replies |

Behavior notes:

- **Fast-path chat** (hi/hello/thanks/bye/"who are you"/"what can you do") is served by a pure rule (`app/pipeline.js` `QUICK_CHAT_PATTERNS`) with **zero model load**.
- `small_talk` skips NER and tool-ranking entirely.
- Tool ranking vectors are cached and invalidated automatically when the config's tools/stages change.
- `updateModelStatus` and the model badges (`#modelStatus`, `#pipelineStage`, `#modelProgress`) reflect every stage transition.

Change any `model.model` to one of the entries in `modelSettings.availableModels`, or add your own Transformers.js-compatible model.

---

## Architecture

```
core/                     framework-agnostic domain layer
  env.js                  runtime detection (isBrowser)
  state.js                shared application state + active character/business helpers
  config.js               ConfigAPI (getters, add schema/char/business, history, rollback, export/import/reset)
  utils.js                filterRecords, escapeHtml
  db.js                   WorkspaceDB – IndexedDB persistence + in-memory mirrors (reads), hydrate()
  tools.js                ToolRegistry, createSandboxedTool, ToolChain, permission levels

app/                      application / orchestration layer
  pipeline.js             multi-model orchestrator (runPipeline, per-stage functions, quick-chat path)
  models.js               ModelScheduler (load one stage, dispose previous, graceful null fallbacks)
  intent.js               rule-based intent detection + JSON/XML tool-call parser (deterministic fallback)
  execute.js              core tool registrations + natural-language parameter extraction
  agents.js               AgentCommunication (delegation, routing, capping message queue)
  google.js               Google sign-in + Calendar/Drive/Sheets reads (optional)
  ui.js                   DOM renderers (chat, explorer, config editor, toasts)
  init.js                 bootstrap: hydrate DB → load config → register tools → wire UI

app.js                    entry module — re-exports the public API for tests & browser
index.html                single-page shell (Bootstrap 5.3, marked, Chart.js)
test.js / test.html       node + browser test suites (55 tests)
config.json               app, characters, businesses, tools, categories, model settings
```

Dependency rules that keep the app modular and tests deterministic:
- `core/*` never imports from `app/*`.
- `intent.js` imports the pipeline **only dynamically** (avoids cycles).
- `pipeline.js` imports `detectIntentRules` statically for the rule fallback.
- The tool runner is **injected** into `runPipeline` (via the UI send handler), which avoids a circular import between `pipeline.js` and `execute.js`.

### Storage (`core/db.js`)

- All reads (`getKV`, `getRecords`, `getRecordById`, `getChat`) are served from in-memory maps → **O(1), zero IndexedDB transaction latency**.
- All writes mirror to memory first, then persist to IndexedDB.
- `hydrate()` replays persisted data into memory on boot (called from `init()` before config resolution), so saved configs/records survive reloads.
- In Node (tests) there is no IndexedDB — the memory store is the only store, identical behavior.

---

## Configuration (`config.json`)

| Section | Purpose |
| --- | --- |
| `app` | name, subtitle, version, default character/workspace, theme, voice, Google client ID |
| `quickPrompts` | suggestion chips shown above the chat input |
| `categories` | keyword→category mapping used by `add_transaction` |
| `characters` | personas with `systemPrompt`, `specialization`, emotion icons, voice pitch/rate |
| `businesses` | workspaces, each with typed `schemas` (`fields` + `vectorize` fields for embeddings) |
| `tools` | registry seed (name, type, description, icon) |
| `modelSettings` | on-device model configuration (see above) |

The Config tab supports **export / import / reset** of this file from the browser, and the agent can read/update/rollback configuration itself via `get_config`, `update_config`, `rollback_config`.

---

## Tools

25 core tools registered from `config.json` (finance, tasks, calendar, search, schema creation, config management, dynamic tool creation, chaining, multi-agent, web search, Google integration). Tools carry a permission level — `CONFIG`/`SYSTEM` levels ask for confirmation via the permission modal in the browser.

The AI also writes it owns tools: `create_tool` compiles a sandboxed `new Function('API', ...)` tool (only `Math`, `JSON`, `Date`, `console`, and a restricted `db` handle are exposed) and persists it to `custom_tools`.

---

## Performance notes

- **Zero-model fast path** for common chat — the dominant startup latency in a browser is the CDN import + model download/swap, and it's skipped entirely for these phrases.
- **Memory-first DB reads** remove a transaction round-trip per read (search/explorer/chat all benefit).
- **Single-resident model** keeps JS heap flat across multi-stage runs.
- **Preconnect/dns-prefetch/modulepreload** hints in `index.html` warm the jsdelivr + Hugging Face connections before the first model request.
- `model_status` no longer persists to storage on every status flip (unused), and the agent delegation queue is capped (unbounded KV array removed).