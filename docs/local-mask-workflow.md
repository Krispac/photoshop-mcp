# Local mask correction (local extension)

This package completes the existing polygon/refinement workflow with three narrow operations. It does not install a new service or enable arbitrary script execution. All tools support the standard `document_id` guard. Coordinates are original document pixels, independent of screen zoom.

| Need                                           | Tool                           | Important inputs                                                                                  |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Load an existing mask or saved alpha selection | `photoshop_load_selection`     | `source: layer_mask`, `layer_name`, or `source: alpha_channel`, `channel_name`; optional `invert` |
| Reveal/hide a local part of an existing mask   | `photoshop_fill_layer_mask`    | `layer_name`, `value: 0..255`, `opacity: 0.01..100`; requires a nonempty selection                |
| Inspect the exact image/mask boundary          | `photoshop_get_detail_preview` | `source: composite` or `layer_mask`, optional `layer_name`, `region: [left,top,right,bottom]`     |

Layer names resolve recursively and must match exactly one layer. Alpha names must identify exactly one non-component channel. Load replaces the current selection; preserve it first with `photoshop_save_selection` when needed. Empty masks can load as no selection.

Mask fill changes only the pixel mask, including group masks. Zero hides, 255 reveals, intermediate values and opacity allow graded corrections. Use a locally feathered polygon/ellipse for a soft correction; preserve crisp boundaries where the source is crisp. Missing selections/masks, ambiguous names, hidden layers/ancestors and locks fail before editing. The result reports `mask_changed` and `context_restored`; if restoration is false, inspect state before continuing rather than blindly retrying. Existing owner-disabled layers are never enabled for editing.

Preview returns a JPEG plus the source `region`, `scale`, dimensions and `native_pixels`. Crops default to 1:1 and reject regions above the requested limit (up to 2048 pixels per dimension), rather than silently downsampling. Full views default to a 1024-pixel limit. For crop coordinates `(x,y)`, original coordinates are `(left+x/scale,top+y/scale)`. Mask previews show raw grayscale values, without the layer's density/feather. JPEG is for visual inspection, not a lossless mask interchange format. Preview creates and closes only its temporary document/file; it does not save, crop or change the mode of the source.

## Short executor loop

1. Read state and identify the canonical document, source layer and existing effect mask. Inspect a small composite crop and its mask at 1:1 using the same region.
2. Load the existing mask or saved selection when useful. Form a local polygon/ellipse correction in original coordinates; refine against the correct source pixels when the boundary requires image analysis. Do not refine against an already blurred layer.
3. Fill the existing effect/protection mask locally. Inspect the same two crops again; undo a bad edit. Keep one editable PSD and organized groups. Do not recreate the whole mask for one finger or turn off another author's changes.
4. After geometry is accepted, adjust independent light/blur/grain layers. Reflections need their own weaker effect and nonbinary transitions. Grain cannot repair an inaccurate mask or color spill from the blur source.

Existing `photoshop_delete_layer_mask` and `photoshop_apply_layer_mask` were repaired: they check the actual Action Manager pixel-mask property, target the mask explicitly even when RGB/alpha is active, and verify removal. A missing mask is an error. Apply is destructive and is not part of the normal editable-retouch loop.

## Validation and activation

`node scripts/test-local-mask-live.mjs` operates only on a disposable 200×200 document and restores the original active tab. It exercises black/gray mask edits, 50% opacity, alpha/mask reload, 1:1 preview, context/selection preservation, hidden-layer preservation, delete/apply and failure guards. It leaves small `/tmp/mask-workflow-*.jpg` test exports for independent decoded-pixel checks. Those checks confirmed unchanged RGB after mask deletion, unchanged composite after applying a mask, and expected grayscale values (0, 64, 255). No book PSD is changed.

Run `npm run test:unit`, `npm run lint`, `npm run build:server`, `npm run verify:photoshop-prompts`, `npm run verify:pack`. Build the installed checkout and refresh the MCP connection/tool list. A fresh local MCP SDK client against `dist/index.js` can use the tools immediately if a host caches its inventory. No Photoshop restart is needed. Rollback is a revert of this extension commit followed by rebuilding; PSDs remain independent.

This is a tested toolkit for the current correction loop, not a guarantee of segmentation quality or a complete AI matting system. Refine Hair, explicit Color/Object Aware switching and automatic texture matching remain outside the exposed tools. Accept the real pilot at 100% before applying it across a series.

Reference for duplicating an explicit mask channel into a temporary preview document: [Adobe community scripting example](https://community.adobe.com/questions-712/use-extend-script-to-convert-layer-masks-into-images-and-export-1178610).
