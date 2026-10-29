# Selection edge refinement (local extension)

`photoshop_refine_selection_edges` invokes Photoshop's `smartBrushWorkspace` (Select and Mask) without UI. Requires an initial pixel selection and the correct source image layer. Supports `document_id` through the standard target guard.

Parameters: `radius` integer 0..250 pixels (default 2), `smart_radius` boolean (default true), `smooth` integer 0..100, `feather` 0..1000 pixels, `contrast` 0..100 percent, `shift_edge` -100..100 percent. Defaults for the latter four are zero. No arbitrary JSX, file arguments, dialogs or color decontamination. Output is a selection; existing mask pixels are not edited. Preserve a selection in an alpha channel before iterative refinement. An empty result is an error: select again before creating a mask.

This exposes image-aware radius and Smart Radius, not the entire workspace. It does not expose Refine Hair or explicitly choose Color Aware/Object Aware. Do not describe it as a complete AI matting pipeline or as proof of artistic acceptance. Wrong initial contours can retain background or expand into it; inspect the result at 100%. It cannot correct an incorrect blur-compositing pipeline.

Live validation on Photoshop 2026: `node scripts/test-refine-live.mjs`. Creates a disposable 200×200 fixture, verifies selection-required failure, moves an inset rough selection to the true 50..150 image boundary, exercises an outset selection, verifies no added layers/background conversion, and restores the previously active document. The outset selection may expand; no promise of perfect segmentation is made. Preview JPEG metadata can vary: compare decoded pixels rather than encoded bytes when checking image preservation.

`scripts/test-refine-hand.mjs` is an opt-in local experiment requiring `/tmp/tomek-hand-source.bmp` (a source crop). It operates only on two temporary image copies, exports small JPEG previews to `/tmp`, closes those copies without saving, and restores the active document. A manual decoded-pixel comparison confirmed that the operation changed selections without changing source image pixels. The resulting contour still needs visual review; no book PSD is changed by this script.

Unit/regression checks: `npm run test:unit`, `npm run lint`, `npm run build:server`, `npm run verify:photoshop-prompts`, `npm run verify:pack`.

Activation: rebuild the existing server and refresh its MCP connection/tool list. Existing chats may retain the old tool inventory; a local MCP SDK client can call this specific tool against `dist/index.js` without enabling the disabled arbitrary-script endpoint. Rollback: revert this extension commit and rebuild. PSD files do not depend on this tool. No Photoshop restart is needed.

References: Adobe Select and Mask tutorial https://www.adobe.com/learn/photoshop/web/make-precise-selections-in-select-mask ; older Action Manager example (runtime behavior must be verified) https://community.adobe.com/questions-712/need-to-get-user-input-from-select-and-mask-using-am-code-1179787 . The legacy `refineSelectionEdge` event was rejected in our live test because it created a layer mask instead of retaining a selection; it is not used as a silent fallback.
