# Editable Smart Filters and full-frame effect sources

Local extension, 2026-10-29. No new service, UXP bridge or arbitrary-script endpoint. Tools use exact recursive unique layer names and the standard document_id guard.

- `photoshop_prepare_full_frame_smart_layer`: source_layer_name, new_layer_name. Duplicate a known untouched full-frame raster base to a new root Smart Object. Reject cropped bounds, existing pixel/vector source masks and name collisions. Copy all pixels, regardless of selection; do not copy a selected person. Source visibility/locking are not changed. Canvas coverage is not proof of provenance: the caller must choose the actual untouched RAW-derived base. The new root layer is visible; the original active layer is restored. On conversion failure inspect state: a new copy may remain.
- `photoshop_add_gaussian_smart_filter`: layer_name, radius_px (0.1..250). Existing visible/unlocked SO and no selection required. Explicitly targets composite channels, never rasterizes; verifies SO type and increased stack count.
- `photoshop_get_smart_filters`: layer_name. Read stack order, 1-based indices, Gaussian radii, and enabled state. No activation or visibility changes. Unknown descriptor shapes fail instead of pretending success.
- `photoshop_set_gaussian_smart_filter`: layer_name, filter_index, expected_radius_px, radius_px. Reuses the existing full filter descriptor and changes only its radius. Verifies count/radius. Reject stale radius and non-Gaussian targets; no second blur is added.
- `photoshop_get_layer_integrity`: layer_name. Read kind, pixel bounds without mask, mask presence and canvas. Bounds alone cannot detect holes, Content-Aware replacements or altered source pixels.

The legacy `photoshop_apply_gaussian_blur` now rejects SO/text instead of silently rasterizing them. It remains a destructive filter for ordinary raster layers; do not use it for editable book effects. Smart Filter mutations preserve the layer/channel context and reject hidden/locked targets/ancestors. If Photoshop cannot expose the active channels, select composite RGB before editing filters; no pixels are changed by this guard. On any error inspect state before retrying, because native Photoshop may already have completed an operation.

## Executor loop

Use the untouched full source → prepare full-frame SO → add Smart Filter → create an external editable mask from a verified selection. Keep source intact. Later change the existing radius, not the underlying pixels. Adjust mask locally using existing mask tools; do not apply/bake it. Light/color stay adjustment layers; spot retouch stays on separate layers. A technical background plate used to prevent blur bleed must remain separately identifiable and recoverable, with the true original retained. Do not call a Content-Aware replacement an unchanged original. Do not silently widen a mask over synthesized content.

Mask preview/edits now handle Photoshop's unavailable activeChannels getter (notably just-created masks). A component-channel fallback is explicit as `channel_restore: composite_fallback`. A fill with approximate context restoration returns `context_restored:false`: inspect state before continuing; do not repeat the fill. Source pixels are unchanged by the preview. This recovery does not claim to restore an unreadable channel selection exactly.

## Evidence and activation

`node scripts/test-smart-filter-live.mjs`: disposable synthetic RGB16 full-frame TIFF; full-source SO preparation, two Gaussian filters, explicit radius update without count growth, stale-radius/selection guards, external mask expansion, full pixel bounds, PSD save/reopen with identical stack, image and mask previews, group-mask preview. Only the test PSD is closed/reopened; book documents remain open. Small JPEG exports in /tmp are for independent decoded-pixel comparisons and can be removed after verification.

Run unit tests, lint, build:server, verify:photoshop-prompts and verify:pack. Update the installed source, rebuild, then refresh the MCP tool list or use a fresh local SDK session. No Photoshop restart required. Rollback: revert the package merge and rebuild; PSD filters remain native Photoshop data.

References: [Adobe native Smart Filter action](https://developer.adobe.com/firefly-services/docs/photoshop/guides/workflows/smart_filters/), [AM radius update example](https://community.adobe.com/questions-628/how-to-pass-a-variable-from-js-to-jsx-685265). Live testing, not these examples alone, establishes compatibility with the installed desktop Photoshop. No claim of artistic acceptance or faster retouch follows from a passed fixture.
