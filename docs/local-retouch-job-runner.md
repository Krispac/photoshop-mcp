# Local retouch job runner

`node scripts/run-retouch-job.mjs /absolute/job.json` runs a finite JSON job through one local MCP SDK connection. It uses existing Photoshop tools in fixed order; it accepts no arbitrary tool names, script text, shell commands, or paths except the explicit PSD destination in a reviewed finish job. The MCP apply timeout is 180 seconds; native script timeout is 120 seconds.

Actions are `prepare`, `patch`, `inspect`, and `finish`. Start from an already open RGB 16-bit RAW-developed document. `prepare` creates one full-canvas Smart Object and Gaussian Smart Filter from the named untouched raster base, then an editable external black mask; an optional named alpha channel can reveal that mask. Optional Exposure/Luminosity layers and full-canvas gray monochromatic-noise Soft Light layers are explicit named entries. Their masks also start black: preparation does not accidentally apply global light or grain. `patch` validates every numeric mask plan before making any call and reuses the existing fixed mask workflow. `inspect` exports only the requested composite, mask, or raster previews. `finish` requires `reviewed: true`, refreshes the grain mask from one explicitly named current effect mask (grain_masks: ["Effect name"]) after clearing the old grain mask, preserving soft values and removing stale geometry, checks Smart Filter and full-frame integrity metadata, and saves the same PSD.

Example: [retouch-job.example.json](retouch-job.example.json). Use a fresh operation ID per deliberate action. A private `.mcp-retouch-runs/` receipt is created before execution. A repeated identical job ID replays its receipt; a changed job with that ID is rejected. Submitted jobs are never automatically retried. `unknown` transport outcomes and partial failures need Photoshop inspection before a new operation ID. This is a local idempotency receipt, not a transaction or cross-process lock. Keep one Photoshop operator at a time. The source layer is explicitly named and remains the original; canvas bounds alone do not establish its provenance.

The runner never closes/reopens documents or declares visual acceptance. Review the requested previews yourself. No Lightroom/Camera Raw integration is included. Run the fixture script only against a disposable synthetic document; it is not part of this runner's automatic execution.


Use the same template for each photo, changing explicit IDs/names/parameters. Do not reuse a previous person's geometry. After prepare, patch the effect and light masks using existing numeric workflows. Reinspect only changed regions; source previews can be reused until the source changes. Finish only after visual QA, with the configured current Gaussian radius. A second effect can use a separate prepare job with a new ID/name; this is not an all-purpose agent or automatic segmentation system. Native tool failure stops the sequence and keeps completed-step evidence. Channel fallback is reported in warnings and checked with a bounded state read, never a repeated fill. No source-layer activation, save variants, document close/reopen or cross-thread status polling is added.

Tests: unit suite works without a prebuilt dist through injected source validators; build:server is required for normal CLI use. The live fixture creates only a synthetic RGB16 document, exercises effect/light/grain setup, patch, selected inspect and finish, reopens only its disposable PSD, and restores the original document. Decoded source before/after and current effect/grain masks must match; fixture exports in /tmp are QA-only. Backend success is not artistic acceptance or proof of end-to-end savings.


Canonical saves use the existing `photoshop_save_document` with `as_copy:false` (PSD only). Its general default remains `true` for compatibility. The runner verifies the same document ID, canonical path (including filesystem aliases) and saved state without reopening. An existing different destination is rejected. A timeout/unverified save is never repeated automatically.

Minimal finish job after reviewing the actual image:

```json
{"action":"finish","operation_id":"photo-finish-001","document_id":123456,"effect":{"layer_name":"Background blur","radius_px":3},"grain":{"name":"Film grain"},"grain_masks":["Background blur"],"reviewed":true,"save_path":"/absolute/photo.psd"}
```

`runner_ms` covers the entire local phase; `tool_ms` and `step_times` cover the logged native steps. These timings exclude model decisions between phases. Compare full retouch turns/tokens separately. The accepted photograph is not a fixture and must remain unchanged.
