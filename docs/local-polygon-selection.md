# Local polygon selection extension

`photoshop_select_polygon` adds a narrow, numeric-only selection operation for editorial masking. It does not enable the disabled arbitrary-script tool or add an IPC service. Source pixels, not screen coordinates: map a preview point by originalWidth/previewWidth and originalHeight/previewHeight (add crop offsets when using a detail crop).

Arguments: `document_id` (normal server target guard), `points: [[x,y],...]` (3..2048 ordered simple contour vertices inside the canvas), `mode: replace|add|subtract|intersect`, `feather: 0..1000` (default zero), `anti_alias` (default true). Invalid inputs are rejected before selection mutation; Photoshop bounds are checked before select. Self-crossing contours are not supported. Boolean operations may legitimately yield an empty selection. Returns document ID and resulting bounds.

Start with automatic selection only if useful, correct local contours with add/subtract, inspect small JPEG details, then use existing mask tools. Save the selection before replacing an existing mask. Do not use broad feather to conceal a wrong outline; hair/reflections still require separate visual validation.

Validation: `npm run test:unit`, `npm run lint`, `npm run build:server`. Live smoke: disposable document, triangle replace/add/subtract/intersect, empty intersection, feather and targeted-document isolation; close fixture without saving. Do not run smoke against book photographs.

Rollback: revert the extension commit and rebuild the server. Existing PSDs do not depend on the tool. Restart the Photoshop MCP connection to refresh advertised tools; until then an MCP SDK client may invoke this concrete tool against the rebuilt server. No Photoshop/application restart is needed.
