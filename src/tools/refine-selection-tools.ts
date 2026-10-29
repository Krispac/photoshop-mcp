import type { ToolDefinition } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import {
  atomicFailureFromError,
  atomicSuccess,
  parseSnippetResult,
  runSnippet,
} from './atomic-shared.js';

// Bounded Photoshop operation, not an arbitrary script endpoint.
export function refineSelectionScript(args: Record<string, unknown>): string {
  const limits: Record<string, [number, number, number]> = {
    radius: [0, 250, 2],
    smooth: [0, 100, 0],
    feather: [0, 1000, 0],
    contrast: [0, 100, 0],
    shift_edge: [-100, 100, 0],
  };
  const values: Record<string, number> = {};
  for (const [key, [min, max, fallback]] of Object.entries(limits)) {
    const value = args[key] === undefined ? fallback : args[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (key === 'smooth' && !Number.isInteger(value))
    )
      throw new Error(
        `${key} must be ${key === 'smooth' ? 'an integer' : 'a finite number'} in ${min}..${max}`
      );
    values[key] = value;
  }
  const smart = args.smart_radius === undefined ? true : args.smart_radius;
  if (typeof smart !== 'boolean') throw new Error('smart_radius must be boolean');
  return `
    if (!app.documents.length) throw new Error('No active document');
    var doc = app.activeDocument;
    var before;
    try { before = doc.selection.bounds; } catch (e) { throw new Error('Active pixel selection required'); }
    var d = new ActionDescriptor();
    var s = stringIDToTypeID;
    d.putInteger(s('smartBrushRadius'), ${values.radius});
    d.putInteger(s('smartBrushSmooth'), ${values.smooth});
    d.putUnitDouble(s('smartBrushFeather'), charIDToTypeID('#Pxl'), ${values.feather});
    d.putUnitDouble(s('smartBrushContrast'), charIDToTypeID('#Prc'), ${values.contrast});
    d.putUnitDouble(s('smartBrushShiftEdge'), charIDToTypeID('#Prc'), ${values.shift_edge});
    d.putBoolean(s('smartBrushUseSmartRadius'), ${smart});
    d.putBoolean(s('smartBrushDecontaminate'), false);
    d.putBoolean(s('sampleAllLayers'), false);
    d.putEnumerated(s('refineEdgeOutput'), s('refineEdgeOutput'), s('selectionOutputToSelection'));
    executeAction(s('smartBrushWorkspace'), d, DialogModes.NO);
    var bounds = null;
    try { var b = doc.selection.bounds; bounds = [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')]; } catch (empty) {}
    if (!bounds) throw new Error('Refinement produced an empty selection; restore a saved selection or select again before creating a mask');
    return { ok: true, document_id: doc.id, method: 'smartBrushWorkspace', bounds: bounds, settings: ${JSON.stringify({ ...values, smart_radius: smart })}, output: 'selection', decontaminate: false };
  `;
}

export function createRefineSelectionTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_refine_selection_edges',
        description:
          'Run Photoshop Refine Edge on the current pixel selection using image-aware radius and Smart Radius. Returns a refined selection, not a new layer or pixel retouch. Requires correct active source layer and initial selection. Use before creating a mask; save a selection before refining when rollback is needed. Does not expose Refine Hair or promise Object Aware/Color Aware modes. No color decontamination, dialogs, arbitrary code or files.',
        inputSchema: {
          type: 'object',
          properties: {
            radius: {
              type: 'integer',
              minimum: 0,
              maximum: 250,
              default: 2,
              description: 'Edge analysis radius in original image pixels',
            },
            smooth: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
            feather: { type: 'number', minimum: 0, maximum: 1000, default: 0 },
            contrast: { type: 'number', minimum: 0, maximum: 100, default: 0 },
            shift_edge: { type: 'number', minimum: -100, maximum: 100, default: 0 },
            smart_radius: { type: 'boolean', default: true },
          },
          required: [],
        },
      },
      handler: async (args) => {
        try {
          const script = refineSelectionScript(args);
          const result = parseSnippetResult(await runSnippet(connection, script));
          if (!result || result.ok !== true)
            throw new Error('Refine Edge returned no successful result');
          return atomicSuccess('Selection edges refined by Photoshop', result);
        } catch (error) {
          return atomicFailureFromError(error);
        }
      },
    },
  ];
}
