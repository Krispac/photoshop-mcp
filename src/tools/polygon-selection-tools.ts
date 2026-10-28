import type { ToolDefinition } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import {
  atomicFailureFromError,
  atomicSuccess,
  parseSnippetResult,
  runSnippet,
} from './atomic-shared.js';

/** Numeric-only input; never accepts JSX or filesystem paths. */
export function polygonScript(args: Record<string, unknown>): string {
  const { points, mode = 'replace', feather = 0, anti_alias = true } = args;
  if (
    !Array.isArray(points) ||
    points.length < 3 ||
    points.length > 2048 ||
    !points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
  ) {
    throw new Error('points must contain 3..2048 finite [x,y] document-pixel pairs');
  }
  if (!['replace', 'add', 'subtract', 'intersect'].includes(String(mode)))
    throw new Error('Invalid selection mode');
  if (typeof feather !== 'number' || !Number.isFinite(feather) || feather < 0 || feather > 1000)
    throw new Error('feather must be 0..1000 pixels');
  if (typeof anti_alias !== 'boolean') throw new Error('anti_alias must be boolean');
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0);
  if (Math.abs(area) < 0.001) throw new Error('Polygon must enclose a nonzero area');
  const constant = {
    replace: 'REPLACE',
    add: 'EXTEND',
    subtract: 'DIMINISH',
    intersect: 'INTERSECT',
  }[String(mode)];
  return `
    if (!app.documents.length) throw new Error('No active document');
    var doc = app.activeDocument;
    var points = ${JSON.stringify(points)};
    for (var i = 0; i < points.length; i++) {
      if (points[i][0] < 0 || points[i][1] < 0 || points[i][0] > doc.width.as('px') || points[i][1] > doc.height.as('px'))
        throw new Error('Polygon points must lie within the document canvas');
    }
    var mode = SelectionType.${constant};
    if (typeof mode === 'undefined') throw new Error('Selection mode unsupported by this Photoshop version');
    doc.selection.select(points, mode, ${feather}, ${anti_alias});
    var bounds = null;
    try { var b = doc.selection.bounds; bounds = [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')]; } catch (empty) {}
    return { ok: true, document_id: doc.id, mode: '${mode}', point_count: points.length, bounds: bounds };
  `;
}

export function createPolygonSelectionTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_select_polygon',
        description:
          'Select a closed polygon using original document pixel coordinates, independent of screen zoom. Add/subtract local silhouette corrections before creating a layer mask. Does not paint pixels or refine hair automatically. Points must be ordered along a simple, non-self-crossing contour within the canvas. Returns resulting selection bounds (null if empty).',
        inputSchema: {
          type: 'object',
          properties: {
            points: {
              type: 'array',
              minItems: 3,
              maxItems: 2048,
              items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
            },
            mode: {
              type: 'string',
              enum: ['replace', 'add', 'subtract', 'intersect'],
              default: 'replace',
            },
            feather: { type: 'number', minimum: 0, maximum: 1000, default: 0 },
            anti_alias: { type: 'boolean', default: true },
          },
          required: ['points'],
        },
      },
      handler: async (args) => {
        try {
          const script = polygonScript(args);
          const result = parseSnippetResult(await runSnippet(connection, script));
          if (!result || result.ok !== true)
            throw new Error('Polygon selection returned no successful result');
          return atomicSuccess('Polygon selection updated', result);
        } catch (error) {
          return atomicFailureFromError(error);
        }
      },
    },
  ];
}
