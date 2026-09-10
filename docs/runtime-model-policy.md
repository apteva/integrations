# Runtime model selection

Integrations can declare `runtime.model_policy` to restrict their agent provider
view without restricting their tools. Gemini is the first integration to opt in.
Image generation, video, embeddings, and realtime remain separate uses; the
integration's `list_models` tool still exposes its general catalog.

The optional policy declares:

- `purpose`: currently `agent`, meaning text reasoning with tool calling. Models
  that accept images as input can qualify; specialized media-output models do not.
- `required_methods`: all must appear in normalized live discovery metadata.
- `allowed_id_patterns`: compatible model families, as Go/JavaScript-compatible
  regexes. Use anchors. These encode integration knowledge where discovery does
  not report enough capabilities; `generateContent` alone is insufficient.
- `tier_preferences`: ordered regex preferences for large, medium, and small,
  applied only to eligible IDs actually returned by the credential's catalog.
  Numeric versions sort descending within a preference; eligible unmatched IDs
  provide the fallback. No matching model means no invented default.

Gemini admits ordinary Pro, Flash, Flash Lite, preview/version variants and the
corresponding latest aliases. It excludes Antigravity, image generation, TTS,
native audio/live, embedding, and unknown model families. Large prefers stable
Pro, then Pro previews; medium prefers stable Flash; small prefers stable Flash
Lite. These are compatibility-family rules, not per-model inference certification.
New naming conventions require a catalog update before they become eligible.

Provider adapters normalize discovery into `ModelInfo`. Google discovery handles
pagination and malformed responses, preserving supported methods. The shared
policy resolver filters after the raw cache so policy changes apply immediately.
Cache keys hash the full credential, avoiding collisions between keys with the
same prefix. The picker honors `refresh=1`.

The server applies the contract to connection model pickers, tier hydration,
connection PATCH validation, per-agent overrides, raw provider config edits,
and final core export. Live availability is checked for new pins. During discovery
outages, compatible saved selections can continue. Empty or incompatible policy
selections never fall through to core factory defaults. No core changes are needed.

`runtime_config.model_selection_sources` records each tier as `automatic`,
`explicit`, or `legacy`. Clearing a tier to null resets it to automatic selection.
Existing unmarked selections have unknown provenance: compatible IDs are preserved
as legacy choices; incompatible/unavailable IDs are replaced from the eligible
live list and archived under `model_selection_previous`. We do not claim those
old values were certainly automatic. Explicit incompatible pins are retained,
reported in `model_selection_errors` and Providers settings, and excluded from
export until corrected. Hydration and settings writes serialize by connection,
and hydration reloads current state before saving to avoid overwriting a new pin.

Reconciliation runs when the server resolves a provider pool. Deploying the new
server enables it; running cores receive the repaired exported provider settings
on their next server-managed configuration update or restart. This code change
does not directly modify a live core or restart services. Unmigrated legacy provider
rows receive the final eligibility guard, but are not silently rewritten.

Validation: `go test -run 'TestGemini|TestRuntimeModelPolicy' .` in server and
`bun test test/llm-provider-catalog.test.ts` in integrations. The tests use provider
catalog fixtures, exercise real handler/store/export paths, and do not make paid
inference calls. Only Gemini opts into the new selection rules; other providers
retain their existing selection behavior.
