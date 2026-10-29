import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import {
  maskHelpers,
  fillMaskScript,
  detailPreviewScript,
  createLocalMaskTools,
} from './local-mask-tools.js';
import { polygonScript } from './polygon-selection-tools.js';
import { refineSelectionScript } from './refine-selection-tools.js';
import { jsStringLiteral } from '../utils/js-string.js';
import { parseSnippetResult, runSnippet } from './atomic-shared.js';

interface Patch {
  points: number[][];
  value: number;
  opacity: number;
  feather: number;
  refine: boolean;
  settings: Record<string, unknown>;
}
interface Plan {
  document_id: number;
  operation_id: string;
  layer_name: string;
  source_layer_name?: string;
  patches: Patch[];
  regions: number[][];
}
function named(v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > 1000)
    throw Error('Exact nonempty layer name required');
  return v;
}
export function normalizeMaskPlan(a: Record<string, unknown>): Plan {
  if (
    Object.keys(a).some(
      (k) =>
        ![
          'document_id',
          'operation_id',
          'layer_name',
          'source_layer_name',
          'patches',
          'preview_regions',
        ].includes(k)
    )
  )
    throw Error('Unsupported workflow option');
  if (typeof a.document_id !== 'number' || !Number.isInteger(a.document_id) || a.document_id <= 0)
    throw Error('Positive document_id required');
  if (typeof a.operation_id !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(a.operation_id))
    throw Error('operation_id must contain 1..80 letters, digits, dot, dash or underscore');
  if (!Array.isArray(a.patches) || a.patches.length > 12)
    throw Error('patches must contain 0..12 patches');
  const layer = named(a.layer_name);
  const patches = a.patches.map((raw): Patch => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid patch');
    const p = raw as Record<string, unknown>;
    if (
      Object.keys(p).some(
        (k) => !['points', 'value', 'opacity', 'feather', 'refine', 'refine_settings'].includes(k)
      )
    )
      throw Error('Unsupported patch option');
    polygonScript({ points: p.points, feather: p.feather ?? 0, mode: 'replace', anti_alias: true });
    fillMaskScript({ layer_name: layer, value: p.value, opacity: p.opacity ?? 100 });
    if (p.refine !== undefined && typeof p.refine !== 'boolean')
      throw Error('refine must be boolean');
    if (
      p.refine_settings !== undefined &&
      (!p.refine_settings ||
        typeof p.refine_settings !== 'object' ||
        Array.isArray(p.refine_settings))
    )
      throw Error('Invalid refine_settings');
    const settings = (p.refine_settings ?? {}) as Record<string, unknown>;
    if (
      Object.keys(settings).some(
        (k) =>
          !['radius', 'smooth', 'feather', 'contrast', 'shift_edge', 'smart_radius'].includes(k)
      )
    )
      throw Error('Unsupported refine option');
    if (settings.radius !== undefined && !Number.isInteger(settings.radius))
      throw Error('Refine radius must be integer');
    refineSelectionScript(settings);
    return {
      points: p.points as number[][],
      value: p.value as number,
      opacity: (p.opacity ?? 100) as number,
      feather: (p.feather ?? 0) as number,
      refine: p.refine !== false,
      settings,
    };
  });
  const source =
    patches.some((p) => p.refine) || a.source_layer_name !== undefined
      ? named(a.source_layer_name)
      : undefined;
  if (
    !Array.isArray(a.preview_regions) ||
    a.preview_regions.length < 1 ||
    a.preview_regions.length > 2
  )
    throw Error('preview_regions must contain 1..2 regions');
  const regions = a.preview_regions.map((r) => {
    detailPreviewScript({ region: r, native_pixels: true }, '/unused-preview-validation.jpg');
    return r as number[];
  });
  for (const patch of patches) {
    const xs = patch.points.map((p) => p[0]),
      ys = patch.points.map((p) => p[1]);
    if (
      !regions.some(
        (r) =>
          Math.max(...xs) >= r[0] &&
          Math.min(...xs) <= r[2] &&
          Math.max(...ys) >= r[1] &&
          Math.min(...ys) <= r[3]
      )
    )
      throw Error(
        'Patch misses every preview region; use original document coordinates, not crop coordinates'
      );
  }
  return {
    document_id: a.document_id,
    operation_id: a.operation_id,
    layer_name: layer,
    source_layer_name: source,
    patches,
    regions,
  };
}
export function maskWorkflowScript(p: Plan): string {
  const blocks = p.patches
    .map(
      (
        x,
        i
      ) => `stage='polygon';patch_index=${i};(function(){${polygonScript({ points: x.points, feather: x.feather })}})();
 ${x.refine ? `stage='refine';activate(source);doc.activeChannels=components;(function(){${refineSelectionScript(x.settings)}})();` : ''}
 stage='fill';var filled=(function(){${fillMaskScript({ layer_name: p.layer_name, value: x.value, opacity: x.opacity })}})();if(!filled.mask_changed)throw Error('Mask fill did not verify');completed++;`
    )
    .join('\n');
  return `${maskHelpers}
 if(doc.id!==${p.document_id})throw Error('Document changed');if(doc.mode!==DocumentMode.RGB)throw Error('Mask workflow requires an RGB working document');
 var target=findLayer(${jsStringLiteral(p.layer_name)});requireMask(target);
 var source=${p.source_layer_name ? `findLayer(${jsStringLiteral(p.source_layer_name)})` : 'null'};
 function visible(l){while(l&&l.typename!=='Document'){if(l.visible===false)throw Error('Layer or parent hidden');l=l.parent}}
 if(${p.patches.length}){visible(target);if(source){visible(source);if(source.kind!==LayerKind.NORMAL)throw Error('Refinement source must be the untouched unblurred raster base');var sm=executeActionGet(layerRef(source));if((sm.hasKey(s('hasUserMask'))&&sm.getBoolean(s('hasUserMask')))||(sm.hasKey(s('hasVectorMask'))&&sm.getBoolean(s('hasVectorMask'))))throw Error('Refinement source must be unmasked');}}
 var ancestor=target;if(${p.patches.length})while(ancestor&&ancestor.typename!=='Document'){if(ancestor.allLocked)throw Error('Mask target or parent locked');ancestor=ancestor.parent}
 var regions=${JSON.stringify(p.regions)},patches=${JSON.stringify(p.patches)};var w=doc.width.as('px'),h=doc.height.as('px');
 for(var r=0;r<regions.length;r++)if(regions[r][2]>w||regions[r][3]>h||regions[r][2]-regions[r][0]>2048||regions[r][3]-regions[r][1]>2048)throw Error('Preview region outside canvas or 1:1 limit');
 for(var i=0;i<patches.length;i++)for(var j=0;j<patches[i].points.length;j++){var xy=patches[i].points[j];if(xy[0]<0||xy[1]<0||xy[0]>w||xy[1]>h)throw Error('Patch point outside canvas')}
 if(!patches.length)return {ok:true,completed:0,mask_changed:false,context_restored:true,source_layer_id:source?source.id:null,target_layer_id:target.id};
 var selected=false;try{selected=!!doc.selection.bounds}catch(noSelection){}if(selected)throw Error('Deselect before applying workflow');
 var oldLayer=doc.activeLayer,channels=captureChannels(),components=[];for(var ci=0;ci<doc.channels.length;ci++)if(doc.channels[ci].kind===ChannelType.COMPONENT)components.push(doc.channels[ci]);if(!components.length)throw Error('No component channels');
 function activate(l){var d=new ActionDescriptor();d.putReference(c('null'),layerRef(l));d.putBoolean(s('makeVisible'),false);executeAction(c('slct'),d,DialogModes.NO)}
 var history=doc.activeHistoryState,completed=0,patch_index=null,stage='start',out=null;
 var applyBatch=function(){${blocks}doc.selection.deselect();return {ok:true,completed:completed,mask_changed:true}};
 try{
  activate(source||target);doc.activeChannels=components;
  doc.suspendHistory('MCP mask workflow',"try{out=applyBatch()}catch(batchError){out={ok:false,message:batchError.message||String(batchError),completed:completed,patch_index:patch_index,stage:stage}} ");
  if(!out)throw Error('No workflow result');
  if(!out.ok){try{doc.activeHistoryState=history;out.rolled_back=true;out.mask_changed=false}catch(rollbackError){out.rolled_back=false;out.mask_changed='unknown'}}
 }finally{activate(oldLayer);doc.activeChannels=channels.channels;}
 out.context_restored=channels.exact;out.source_layer_id=source?source.id:null;out.target_layer_id=target.id;return out;
 `;
}
export function createMaskWorkflowTools(connection: PhotoshopConnection): ToolDefinition[] {
  const receipts = new Map<string, { hash: string; receipt: Record<string, unknown> }>();
  let busy = false;
  const text = (r: Record<string, unknown>, error = false): ToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(r) }],
    ...(error ? { isError: true } : {}),
  });
  return [
    {
      tool: {
        name: 'photoshop_run_mask_workflow',
        description:
          'Run 0..12 validated local mask patches as one fixed workflow, then return paired composite/mask previews at 1:1. Empty patches inspect only. Refinement uses an explicitly named untouched visible raster base. One history step; rollback on known apply failure. operation_id prevents duplicate application within this server process; replay returns receipt only. No automatic retries, arbitrary tools, JSX, paths, save or layer creation. Transport failures are unknown: inspect, never blindly retry after server restart.',
        inputSchema: {
          type: 'object',
          properties: {
            operation_id: { type: 'string', pattern: '^[a-zA-Z0-9_.-]{1,80}$' },
            layer_name: { type: 'string' },
            source_layer_name: { type: 'string' },
            patches: {
              type: 'array',
              maxItems: 12,
              items: {
                type: 'object',
                properties: {
                  points: { type: 'array' },
                  value: { type: 'integer', minimum: 0, maximum: 255 },
                  opacity: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
                  feather: { type: 'number', minimum: 0, maximum: 1000 },
                  refine: { type: 'boolean', default: true },
                  refine_settings: { type: 'object' },
                },
                required: ['points', 'value'],
              },
            },
            preview_regions: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: { type: 'integer', minimum: 0 },
              },
            },
          },
          required: ['operation_id', 'layer_name', 'patches', 'preview_regions'],
        },
      },
      handler: async (args) => {
        let plan: Plan;
        try {
          plan = normalizeMaskPlan(args);
        } catch (e) {
          return text({ ok: false, phase: 'validation', message: String(e) }, true);
        }
        const key = `${plan.document_id}:${plan.operation_id}`,
          hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
          prior = receipts.get(key);
        if (prior) {
          if (prior.hash !== hash)
            return text({ ok: false, message: 'operation_id reused with different plan' }, true);
          return text({ ...prior.receipt, replayed: true }, prior.receipt.ok !== true);
        }
        if (busy) return text({ ok: false, message: 'Mask workflow already running' }, true);
        if (receipts.size >= 256)
          return text(
            {
              ok: false,
              message: 'Receipt capacity reached; inspect state before starting a new session',
            },
            true
          );
        busy = true;
        const start = Date.now();
        let phase = 'apply';
        let receipt: Record<string, unknown> = {
          ok: false,
          status: 'running',
          operation_id: plan.operation_id,
          document_id: plan.document_id,
          do_not_retry: true,
        };
        receipts.set(key, { hash, receipt });
        try {
          const applied = parseSnippetResult(
            await runSnippet(connection, maskWorkflowScript(plan), 120000)
          );
          if (!applied) throw Error('Unparseable apply result');
          receipt = {
            ...receipt,
            ...applied,
            status: applied.ok === true ? 'applied' : 'apply_failed',
            apply_ms: Date.now() - start,
          };
          receipts.set(key, { hash, receipt });
          if (applied.ok !== true) return text({ ...receipt, total_ms: Date.now() - start }, true);
          phase = 'preview';
          const content: ToolResult['content'] = [];
          const previewTool = createLocalMaskTools(connection).find(
            (t) => t.tool.name === 'photoshop_get_detail_preview'
          )!;
          for (const region of plan.regions)
            for (const source of plan.source_layer_name
              ? ['raster_layer', 'composite', 'layer_mask']
              : ['composite', 'layer_mask']) {
              const r = await previewTool.handler({
                source,
                layer_name: source === 'raster_layer' ? plan.source_layer_name : plan.layer_name,
                region,
                native_pixels: true,
              });
              if (r.isError)
                throw Error(
                  'Preview failed after apply; inspect-only workflow can recover previews'
                );
              content.push(...r.content.filter((x) => x.type === 'image'));
            }
          receipt = {
            ...receipt,
            ok: true,
            status: 'complete',
            total_ms: Date.now() - start,
            preview_ms: Date.now() - start - Number(receipt.apply_ms),
            preview_order: plan.regions.flatMap((region) =>
              (plan.source_layer_name
                ? ['raster_layer', 'composite', 'layer_mask']
                : ['composite', 'layer_mask']
              ).map((source) => ({ source, region, scale: 1 }))
            ),
          };
          receipts.set(key, { hash, receipt });
          return { content: [...content, { type: 'text', text: JSON.stringify(receipt) }] };
        } catch (e) {
          receipt = {
            ...receipt,
            ok: false,
            status: phase === 'apply' ? 'apply_unknown' : 'applied_preview_failed',
            message: String(e),
            total_ms: Date.now() - start,
            do_not_retry: true,
          };
          receipts.set(key, { hash, receipt });
          return text(receipt, true);
        } finally {
          busy = false;
        }
      },
    },
  ];
}
