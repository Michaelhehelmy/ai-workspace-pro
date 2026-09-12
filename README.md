# AI Workspace Pro

Autonomous, **on-device** workspace agent. A zero-API-key, privacy-first assistant that records expenses, manages tasks, schedules calendar events, runs semantic search, coordinates specialist personas, and talks to small AI models that are downloaded and executed **entirely in your browser tab** via [Transformers.js](https://huggingface.co/docs/transformers.js).

```
                            ┌────────────────────────────────────────────┐
   user message ──────────▶ │   runPipeline  (app/pipeline.js)           │
                            │                                            │
                            │  0. quick-chat fast-path (0 ms, no model)  │  greetings / thanks / identity / help
                            │  0b. agent loop (tool-capable backend)     │  multi-turn tool calling via runner
                            │  1. classifyIntent   → zero-shot classifier │
                            │  2. extractEntities  → NER token tagger    │
                            │  3. rankTools        → embedding scorer    │
                            │  4. routeToAgent     → specialist persona  │
                            │  5. executeTool      → tool / data layer   │
                            │  6. generateResponse → routed backend | T5 │  llama.cpp / Ollama / on-device
                            └────────────────────────────────────────────┘
```

---

## Highlights

- **No API keys, no servers, no accounts.** All inference runs locally via WebAssembly (ONNX Runtime). Works offline after the first model download.
- **One tiny model at a time.** A `ModelScheduler` loads a single quantized specialist model per stage and disposes it (frees the ONNX session) before the next stage loads, keeping memory low and roughly constant. Heaviest stage (LaMini-Flan-T5-248M, q8) is ~150 MB disk / ~250 MB WAsm-allocated.
- **Instant replies for common chat.** Greetings/thanks/identity/help short-circuit before any model work (~0 ms).
- **No canned-text fallbacks — real models only.** A down/unconfigured model does **not** silently degrade to templates: it raises a typed, user-readable `ModelError` (`{code, stage, message, fix}`) rendered in the UI, so the user always knows exactly which piece failed and how to fix it.
- **Optional remote backends with routing.** In addition to on-device Transformers.js, the dialog and embedder stages can route (auto or fixed per stage) to a local **llama.cpp** (`http://localhost:8080/v1`) or **Ollama** (`http://localhost:11434`) server — live health probes, automatic fallback to the on-device model, and per-stage pickers in the Models tab.
- **Tool-calling agent loop.** When the active dialog backend supports function calling (`canTools`), `runPipeline` first tries a multi-turn agent loop that can invoke any registered tool (authenticated, permission-checked) and iterate; non-tool backends keep the single-shot path.
- **Evolving characters via skills.** Skills (see `skills/`) define triggers + specializations; when a user message matches, the skill's directive is folded into the system prompt so any character can grow new capabilities without touching persistence.
- **Session compaction.** Long chats collapse older turns into a synthetic summary message (deterministic digest offline, or a real summarizer when a dialog backend is available) so context stays bounded.
- **Multi-persona multi-agent.** Characters (Aria, Marcus) have specializations; tasks can be delegated (`delegate to marcus …`) or auto-routed to the best specialist.
- **Persistent, memory-fast storage.** Writes mirror to IndexedDB (survives reload), reads are served from in-memory maps — no per-read transaction latency.
- **Built-in tool registry** with permission levels, parameter validation, a sandboxed `create_tool` dynamic-tool system, and a chaining executor.
- **Strict config/secrets validation.** Missing or placeholder secrets (e.g. `YOUR_…`, `CHANGE_ME_…`, `<…>`) are detected on boot with actionable error codes; the Google client ID is only enabled for real non-missing, non-placeholder values.
- **Optional local RPC sidecar.** A JSON-RPC 2.0 endpoint (`app/pi/pi-rpc.js`) can expose the assistant's API to a local Pi/controller — strictly env-gated (`AIWS_PI_RPC_PORT`), never auto-started.
- **Device-aware model selection.** The app profiles the client at runtime (`core/device.js`): form factor, GPU (WebGPU/WebGL/SwiftShader), CPU cores, memory, WASM SIMD, and network. Every device gets a tier (`low`/`mid`/`high`), a recommended per-stage model set + dtype, and catalog rows are annotated with an **ideal/ok/heavy/too-heavy** fit badge. One click applies the recommended setup for the device you're actually on.
- **Deploys as a Cloudflare Worker.** Ships a ready-to-deploy static-asset Worker (`worker/index.js` + `wrangler.jsonc`) — the entire AI stack still runs on the user's device (Transformers.js in their browser, or their own Ollama/llama.cpp), so the edge is only a cheap CDN host + a `/api/health` endpoint. No D1/KV/bindings required.

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
node test.js                          # 121 tests — must stay green (real models cache into .cache/transformers)
AIWS_SKIP_MODEL_TESTS=1 node test.js  # 114 hermetic tests — no model downloads, no network
open test.html                        # run the same suite in the browser
```

Two test modes:

- **Hermetic suite (114 tests):** `AIWS_SKIP_MODEL_TESTS=1` (or the `MODELS_DISABLED=1` env) runs the full suite with model stages forced into the `E_DISABLED` path — no downloads, no network. CI-friendly.
- **Real-model suite (7 extra tests):** the default `node test.js` run additionally loads the four configured models (first run seeds `.cache/transformers`, later runs are offline) and asserts real embeddings, real zero-shot classification, real NER, real dialog generation, and the full `runPipeline` flow end-to-end.

### Node setup & the model cache

Transformers.js reads and writes weights under `.cache/transformers/<org>/<model>/` (`env.cacheDir`). Everything the library needs is **already bundled on-disk in this repo's cache** — no runtime download required.

> **npm:** `onnxruntime-node` ships its prebuilt binary inside the npm tarball, so install with scripts disabled: `npm install --ignore-scripts`.

> **Re-seeding the cache (only needed if you wipe `.cache/`):** the weights are fetched with `curl` (the Node fetch/undici stack can stall against the Hugging Face CDN for multi-hundred-MB bodies). `./preseed.sh` downloads exactly the files the configured models need (q8 ONNX weights + tokenizer/config fixtures) straight into `.cache/transformers/`.

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

### Models tab (browser)

The **Models** tab gives each stage its own `<select>` fed from `availableModels` (with size hints), a data-type picker (`q8` / `int8` / `uint8` / `fp32` / `fp16`), a **Preload all** button (`forcePreload`, background warms every configured stage), and a **Reset to defaults** button (`defaultModelSettings` — keeps the downloaded weight cache and the catalog). Catalog rows show a **Use** button that selects the model for its stage; picking a different model enables **Apply & Load**, which persists the whole `modelSettings` subtree via the config API, reloads that stage resident, and updates the status badges. Changing the data type persists immediately and applies to the next model load.

**Models load lazily, not on page open.** Opening the app never triggers model reads/compiles, so you won't see a "downloading models" phase on every visit. Models are fetched on first use (cached per origin via the Cache API) and all four stages are warmed only when you actually need them. Set `modelSettings.preloadOnOpen: true` (or tick **Preload models on page open** in the tab) to go back to eager warm-up at boot.

## Device-aware model selection (`core/device.js`)

A **Your Device** card on the Models tab profiles the visiting client and recommends the smallest good-enough model set for it:

- **Detection** (`detectDevice(probes)`): form factor (phone/tablet/laptop/desktop), GPU kind (WebGPU/WebGL2/WebGL1/**SwiftShader-as-none**), CPU cores (`hardwareConcurrency`), memory (`navigator.deviceMemory`), WASM + SIMD support, and network `effectiveType`. All probes are injectable functions so tests run headless.
- **Tiering** (`scoreDevice` rotation inside `detectDevice`): a 0–100 score from form factor + cores + memory + GPU → `low` (<45) / `mid` (<70) / `high` (≥70). A phone or software-GPU machine lands `low`; a desktop with a WebGPU adapter and 8 GB+ RAM lands `high`.
- **Recommendations** (`recommendModelSet(profile)`, used by `getDeviceRecommendations` / `buildRecommendedModelSettings`): picks a per-stage catalog model + `dtype` per tier — e.g. `low` → MiniLM-L6 + q8, `high` → bge-base. `buildRecommendedModelSettings` returns a full `modelSettings` object ready for `ConfigAPI.updateConfig`; the **Apply recommended for this device** button persists it in one click.
- **Fit badges** (`getModelFit(profile, meta)`): catalog rows show an **ideal / ok / heavy / too-heavy** badge computed against that device's memory budget, with the details in the tooltip.
- **First-visit hint**: if you've never applied a device plan and your current picks differ from the recommendation, a toast nudges you to the card. The `deviceRecApplied` KV flag silences it afterward.

## Remote backends & routing (`app.ai`)

```jsonc
{
  "backends": {
    "llamacpp": { "url": "http://localhost:8080/v1", "enabled": false },
    "ollama":   { "url": "http://localhost:11434",   "enabled": false }
  },
  "routing": { "dialog": "auto", "embedder": "auto" }
}
```

- `app.ai.backends` configures each provider; `enabled: true` makes it eligible. When all remote providers are disabled, every stage transparently uses the on-device Transformers.js pipeline.
- `app.ai.routing` pins a stage (`"dialog": "ollama"`) or keeps it `"auto"` (probe order: Ollama first, then llama.cpp — first healthy backend wins). The `intent`/`tagger` pipeline stages are never routed and always use the on-device models.
- Health is probed with a 30 s cache; the Models tab exposes per-stage backend pickers plus a **Probe backends** button with live status.
- `generateResponse` / `generateChatResponse` / `embedText` try the routed remote backend first, then fall back to `inferStage` / on-device inference.

**Provider contracts** (`app/ai/backend.js`): every backend implements `health()`, `embed(input)`, and `generate(req)`; `generate` returns an async generator yielding `{ text }` and/or `{ toolCall: { id, type: 'function', function: { name, arguments } } }`. `canTools` flags tool-calling support (Ollama: yes; llama.cpp: no). Register providers via `createBackend` / `registerBackend`.

## Agent loop (tool calling)

`agentLoop({ message, persona, maxTokens, maxIterations, runner, query, stateInstance })` runs a multi-turn loop against a `canTools` dialog backend:

1. Build OpenAI-style tool schemas from the tool registry.
2. Stream `generate()`; a `toolCall` chunk is executed through the injected `runner` (same permission-gated executor as the normal pipeline).
3. Tool results are fed back as tool messages for the next iteration (max 5), errors are reported *to the model* honestly (never thrown).
4. No tool calls in a reply → return the answer. Backends/runners that don't support tools → `agentLoop` returns `null` and `runPipeline` falls through to the single-shot path.

## Skills (`skills/`, `core/skills.js`)

Each `skills/<id>/SKILL.md` carries front-matter with `specializations`, `triggers`, `steps`, and a prompt fragment; `core/skills.js` mirrors them at runtime (`Skill`, `SkillLibrary`, `skillLibrary`).

- `findSkillsForMessage(msg)` — substring match on triggers.
- `augmentPersona(msg, character)` — folds matched, specialization-overlapping skill directives into the system prompt (used by `generateResponse`, `generateChatResponse`, and the agent loop).
- `evolveCharacter(id)` — capability summary for any character.

Built-in skills: expense-intake, task-capture, calendar-upkeep, semantic-retrieval, financial-analysis, character-delegation.

## Session compaction (`core/compaction.js`)

`compactChat(db, businessId, { keepRecent, summarizer })` collapses older messages into one synthetic `role:'system'` summary message (flagged `summary: true`) prepended to the newest `keepRecent` (default 10) turns, then persists via the new `WorkspaceDB.replaceChat(businessId, messages)`. With no summarizer it uses `buildDigestSummary` (deterministic, no network); pass `summarizer: generateResponse.bind(null, …)` (any async `(messages) => string`) for a real model summary.

## Pi RPC sidecar (`app/pi/pi-rpc.js`)

JSON-RPC 2.0 over HTTP `POST {baseUrl}/rpc`. `createPiClient` works in Node and browser; `createPiServer` is Node-only (uses `node:http`). `startPiRpc` never starts itself — it returns `null` unless `AIWS_PI_RPC_PORT` is set to a port in the environment **or** `config.app.ai.pi.enabled === true`. Built-in methods: `ping`, `echo`, `time`; pass a `methods` map to expose your own callbacks. Example:

```bash
AIWS_PI_RPC_PORT=9300 node server.js   # your entry imports startPiRpc
curl -s http://127.0.0.1:9300/rpc -d '{"jsonrpc":"2.0","method":"ping","id":1}'
# {"jsonrpc":"2.0","result":{"pong":true,"id":"ping"},"id":1}
```

## Deploy to Cloudflare Workers (`worker/`, `wrangler.jsonc`)

The app is fully client-hosted, so the Cloudflare Worker is a **thin static-asset host** — no D1, no KV, no bindings. Every pipeline stage still runs on the user's device. This keeps the existing Node/browser workflow untouched: `npm test` runs the same way locally.

```bash
npm run worker:dev      # wrangler dev — local preview with the ASSETS binding
npm run worker:deploy   # wrangler deploy — push to your Cloudflare account
```

How it works:

- `wrangler.jsonc` serves the repo root as static assets with `run_worker_first: true` and SPA not-found handling. The Worker (`worker/index.js`) answers `GET /api/health` (a JSON envelope with service/version) and delegates **everything else** to `env.ASSETS.fetch(request)`. `/api/*` that the Worker doesn't implement returns a typed 404.
- `.assetsignore` keeps `node_modules/`, `.cache/`, `test.js`, `skills/`, `worker/`, and other development files out of the uploaded asset bundle (only `index.html`, `app.js`, `styles.css`, `config.json`, plus the `app/` and `core/` module trees ship).
- `worker/index.js` is intentionally dependency-free (it never imports from `app/` or `core/`), so the Worker bundle stays tiny and total-isolate friendly.
- Because weights cache per origin in the browser, the deployed site gets the same "download once, then offline" behavior as the local folder served over HTTP.

---

## Failure model & configuration validation

### Typed `ModelError`s instead of silent fallbacks

A model stage that cannot run raises `ModelError` with a stable `code`, the failing `stage`, a human `message`, and an actionable `fix`. `code` is one of:

| Code | When |
| --- | --- |
| `E_DISABLED` | Model stages globally disabled (`MODELS_DISABLED`) |
| `E_LOAD_PACKAGE` | `@huggingface/transformers` unavailable on the runtime |
| `E_LOAD_MODEL` | Weights/tokenizer failed to load or are missing from cache |
| `E_INFER` | Inference ran but produced unusable output (e.g. degenerate dialog scaffold) |
| `E_UNKNOWN_STAGE` | `runPipeline` got a stage key it does not know |
| `E_NO_CONFIG` | No resolved `modelSettings` in config |
| `E_INTERNAL` | Anything unexpected |

`formatModelError()` renders these into readable UI text, and the chat bubbles surface the error with its `fix`. Intent/entity extraction remain *best-effort* (rule fallback when the resident classifier/NER is unavailable), but the **dialog stage never substitutes canned copy** — if it cannot generate real text it raises `E_INFER`.

### Config & secrets validation (`core/config.js`, boot order in `app/init.js`)

1. Apply runtime overrides: `window.__APP_CONFIG__` → `AIWS_CONFIG_JSON` → `AIWS_CONFIG_FILE` → `GOOGLE_CLIENT_ID` (last wins for the Google client ID).
2. Validate the resolved config: empty `app.google.clientId` → `E_SECRET_MISSING`; a placeholder value (`YOUR_…`, `CHANGE_ME_…`, `INSERT_…`, `REPLACE_…`, `TODO`, `TOKEN_…`, `API_KEY`, `<…>`) → `E_SECRET_PLACEHOLDER`; missing model config → `E_MODEL_MISSING`; other structural problems → `E_CONFIG`.
3. Render issues into the `#configIssuesBanner`; Google calendar/drive/sheets tools stay disabled until the client ID is genuinely configured.

Run any stage in **disabled mode**-style testing via `MODELS_DISABLED=1` (Node) or `window.__MODELS_DISABLED__ = true` (browser).

---

## Architecture

```
core/                     framework-agnostic domain layer
  env.js                  runtime detection (isBrowser)
  state.js                shared application state + active character/business helpers
  config.js               ConfigAPI (getters, add schema/char/business, history, rollback, export/import/reset)
  utils.js                filterRecords, escapeHtml
  db.js                   WorkspaceDB – IndexedDB persistence + in-memory mirrors (reads), hydrate(), replaceChat
  tools.js                ToolRegistry, createSandboxedTool, ToolChain, permission levels
  skills.js               Skill / SkillLibrary — runtime mirror of skills/*/SKILL.md, persona augmentation
  compaction.js           compactChat + buildDigestSummary (session bounding)
  device.js               device profiling + tiering + per-tier model recommendations + fit verdicts

app/                      application / orchestration layer
  pipeline.js             multi-model orchestrator (runPipeline, per-stage functions, quick-chat path, agent-loop step)
  models.js               model coordinator (load one stage, dispose previous, typed ModelError propagation, device recommendations)
  intent.js               rule-based intent detection + JSON/XML tool-call parser (deterministic fallback)
  execute.js              core tool registrations + natural-language parameter extraction
  agents.js               AgentCommunication (delegation, routing, capping message queue)
  google.js               Google sign-in + Calendar/Drive/Sheets reads (optional)
  ui.js                   DOM renderers (chat, explorer, config editor, toasts, backend pickers)
  init.js                 bootstrap: hydrate DB → load config → register tools → wire UI

app/ai/                   backend abstraction (Phase 0–2)
  backend.js              LLMBackend interface, registry, ModelError, createBackend/registerBackend
  transformers-backend.js on-device provider (scheduler, hooks, canTools:false)
  llamacpp-backend.js     llama.cpp client (canTools:false, tools-aware generate)
  ollama-backend.js       Ollama client (canTools:true, tools + tool_calls)
  routing.js              resolveBackendForStage, probeAllBackends, setStageBackend, health cache
  agent-loop.js           multi-turn tool-calling loop (runner-injected)

app/pi/                   optional sidecar (Phase 4)
  pi-rpc.js               JSON-RPC 2.0 client (browser+Node) + server (Node-only), env-gated startPiRpc

skills/                   human-readable skill definitions
app.js                    entry module — re-exports the public API for tests & browser
index.html                single-page shell (Bootstrap 5.3, marked, Chart.js)
test.js / test.html       node + browser test suites (121 tests, hermetic + real-model modes)
config.json               app, characters, businesses, tools, categories, model settings

worker/                   Cloudflare Workers deploy target
  index.js                thin ESM Worker: /api/health + env.ASSETS passthrough (dependency-free)
wrangler.jsonc            Workers config: static assets (run_worker_first, SPA fallback)
.assetsignore             excludes dev files from the uploaded asset bundle
```

Dependency rules that keep the app modular and tests deterministic:
- `core/*` never imports from `app/*`.
- `intent.js` imports the pipeline **only dynamically** (avoids cycles).
- `pipeline.js` imports `detectIntentRules` statically for the rule fallback.
- The tool runner is **injected** into `runPipeline` (via the UI send handler) and into `agentLoop`, which avoids a circular import between `pipeline.js` and `execute.js`.
- Backend modules register themselves at import (`app.js` imports both `llamacpp-backend.js` and `ollama-backend.js` for auto-registration); `routing.js`/`agent-loop.js`/`pipeline.js` only talk to them through the registry.
- `ui.js` never imports `app/*` statically — the backend pickers use a dynamic `import('./ai/routing.js')` (same green rule as `intent.js`).
- `core/device.js` is pure and probe-injectable; `ui.js` + `models.js` import it statically (core-only), keeping the device panel testable without a browser.
- `worker/index.js` imports nothing from `app/` or `core/` — it stays bundleable as a standalone Workerd entry.

### Storage (`core/db.js`)

- All reads (`getKV`, `getRecords`, `getRecordById`, `getChat`) are served from in-memory maps → **O(1), zero IndexedDB transaction latency**.
- All writes mirror to memory first, then persist to IndexedDB.
- `hydrate()` replays persisted data into memory on boot (called from `init()` before config resolution), so saved configs/records survive reloads.
- In Node (tests) there is no IndexedDB — the memory store is the only store, identical behavior.

---

## Configuration (`config.json`)

| Section | Purpose |
| --- | --- |
| `app` | name, subtitle, version, default character/workspace, theme, voice, Google client ID, optional `ai.backends` + `ai.routing` + `ai.pi` |
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