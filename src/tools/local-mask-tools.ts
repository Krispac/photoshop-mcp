import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import type { ToolDefinition } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import { jsStringLiteral } from '../utils/js-string.js';
import {
  atomicFailureFromError,
  atomicSuccess,
  parseSnippetResult,
  runSnippet,
} from './atomic-shared.js';

export const maskHelpers = `
  if (!app.documents.length) throw new Error('No active document');
  var doc = app.activeDocument;
  var c = charIDToTypeID, s = stringIDToTypeID;
  function findLayer(name) {
    var found = [];
    function walk(ls) { for(var i=0;i<ls.length;i++) { if(ls[i].name===name) found.push(ls[i]); if(ls[i].typename==='LayerSet') walk(ls[i].layers); } }
    walk(doc.layers);
    if(found.length!==1) throw new Error('Layer name must identify exactly one layer: '+name);
    return found[0];
  }
  function maskRef(layer) {
    var r = new ActionReference(); r.putEnumerated(c('Chnl'),c('Chnl'),c('Msk ')); r.putIdentifier(c('Lyr '),layer.id); return r;
  }
  function requireMask(layer) {
    var r=new ActionReference();r.putIdentifier(c('Lyr '),layer.id);
    var d=executeActionGet(r);
    if(!d.hasKey(s('hasUserMask')) || !d.getBoolean(s('hasUserMask'))) throw new Error('Layer has no pixel mask');
    return d;
  }
  function layerRef(layer) { var r=new ActionReference(); r.putIdentifier(c('Lyr '),layer.id); return r; }
`;

function name(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 1000)
    throw new Error(`${key} must be a nonempty name (max 1000 characters)`);
  return jsStringLiteral(value);
}
function number(value: unknown, key: string, min: number, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`Invalid ${key}`);
  return value;
}

export function loadSelectionScript(args: Record<string, unknown>): string {
  if (args.source !== 'layer_mask' && args.source !== 'alpha_channel')
    throw new Error('source must be layer_mask or alpha_channel');
  const target = name(
    args.source === 'layer_mask' ? args.layer_name : args.channel_name,
    'source name'
  );
  const invert = args.invert === undefined ? false : args.invert;
  if (typeof invert !== 'boolean') throw new Error('invert must be boolean');
  return `${maskHelpers}
    var targetName=${target};
    ${
      args.source === 'layer_mask'
        ? `
    var layer=findLayer(targetName); requireMask(layer);
    var d=new ActionDescriptor(), r=new ActionReference(); r.putProperty(c('Chnl'),c('fsel'));
    d.putReference(c('null'),r);d.putReference(c('T   '),maskRef(layer));executeAction(c('setd'),d,DialogModes.NO);
    `
        : `
    var matches=[];for(var i=0;i<doc.channels.length;i++) if(doc.channels[i].name===targetName && doc.channels[i].kind!==ChannelType.COMPONENT) matches.push(doc.channels[i]);
    if(matches.length!==1) throw new Error('Alpha channel name must identify exactly one saved selection');
    doc.selection.load(matches[0],SelectionType.REPLACE);
    `
    }
    if(${invert}) doc.selection.invert();
    var bounds=null;try {var b=doc.selection.bounds;bounds=[b[0].as('px'),b[1].as('px'),b[2].as('px'),b[3].as('px')];}catch(empty){}
    return {ok:true,document_id:doc.id,source:${jsStringLiteral(args.source)},name:targetName,bounds:bounds};
  `;
}

export function fillMaskScript(args: Record<string, unknown>): string {
  const layer = name(args.layer_name, 'layer_name');
  const value = number(args.value, 'value', 0, 255, true);
  const opacity = number(args.opacity === undefined ? 100 : args.opacity, 'opacity', 0.01, 100);
  return `${maskHelpers}
    var layer=findLayer(${layer}); requireMask(layer);
    var b;try {b=doc.selection.bounds;}catch(empty){throw new Error('Active pixel selection required; refusing whole-mask fill');}
    if(layer.allLocked) throw new Error('Target layer is locked');
    var oldLayer=doc.activeLayer, oldChannels=doc.activeChannels;
    var ancestors=[],current=layer;
    while(current && current.typename!=='Document') {if(current.visible===false) throw new Error('Target layer or parent is hidden; enable it intentionally before editing the mask');
      if(current.allLocked) throw new Error('Target layer or parent is locked');
      ancestors.push({layer:current,visible:current.visible});current=current.parent;}
    var applied=false,restored=true;
    try {
      var d=new ActionDescriptor();d.putReference(c('null'),layerRef(layer));d.putBoolean(s('makeVisible'),false);executeAction(c('slct'),d,DialogModes.NO);
      var m=new ActionDescriptor();m.putReference(c('null'),maskRef(layer));m.putBoolean(s('makeVisible'),false);executeAction(c('slct'),m,DialogModes.NO);
      var color=new SolidColor();color.rgb.red=${value};color.rgb.green=${value};color.rgb.blue=${value};
      doc.selection.fill(color,ColorBlendMode.NORMAL,${opacity},false);applied=true;
    } finally {
      for(var i=ancestors.length-1;i>=0;i--)try{if(ancestors[i].layer.visible!==ancestors[i].visible) ancestors[i].layer.visible=ancestors[i].visible;}catch(eVisible){restored=false;}
      try {doc.activeLayer=oldLayer;doc.activeChannels=oldChannels;}catch(eRestore){restored=false;}
    }
    return {ok:true,document_id:doc.id,layer_id:layer.id,layer_name:layer.name,value:${value},opacity:${opacity},mask_changed:applied,context_restored:restored};
  `;
}

export function detailPreviewScript(args: Record<string, unknown>, path: string): string {
  const source = args.source === undefined ? 'composite' : args.source;
  if (source !== 'composite' && source !== 'layer_mask')
    throw new Error('source must be composite or layer_mask');
  const layer = source === 'layer_mask' ? name(args.layer_name, 'layer_name') : 'null';
  const max = number(
    args.max_dimension_px === undefined ? (args.region ? 2048 : 1024) : args.max_dimension_px,
    'max_dimension_px',
    32,
    2048,
    true
  );
  const native = args.native_pixels === undefined ? Boolean(args.region) : args.native_pixels;
  if (typeof native !== 'boolean') throw new Error('native_pixels must be boolean');
  let region: number[] | null = null;
  if (args.region !== undefined) {
    if (!Array.isArray(args.region) || args.region.length !== 4)
      throw new Error('region must be [left,top,right,bottom]');
    region = args.region.map((n) => number(n, 'region', 0, 1000000, true));
    if (region[2] <= region[0] || region[3] <= region[1])
      throw new Error('region must have positive area');
  }
  return `${maskHelpers}
    var w=doc.width.as('px'),h=doc.height.as('px'),region=${JSON.stringify(region)};
    if(!region) region=[0,0,w,h];
    if(region[2]>w||region[3]>h) throw new Error('region outside document canvas');
    var rw=region[2]-region[0],rh=region[3]-region[1],scale=Math.min(1,${max}/Math.max(rw,rh));
    if(${native} && scale<1) throw new Error('Native-pixel preview exceeds max_dimension_px; request a smaller region');
    var layer=${source === 'layer_mask' ? `findLayer(${layer})` : 'null'},info=null;
    if(layer) info=requireMask(layer);
    var preview=null;
    try {
      ${
        source === 'layer_mask'
          ? `
      var d=new ActionDescriptor(),spec=new ActionDescriptor();spec.putString(s('name'),'MCP mask preview');
      d.putObject(s('new'),s('document'),spec);d.putReference(s('using'),maskRef(layer));d.putString(s('channelName'),'MCP mask');
      executeAction(s('make'),d,DialogModes.NO);preview=app.activeDocument;
      if(preview.id===doc.id) throw new Error('Mask channel did not duplicate into a new document');
      preview.changeMode(ChangeMode.GRAYSCALE);
      `
          : `preview=doc.duplicate('MCP detail preview',true);`
      }
      preview.crop([UnitValue(region[0],'px'),UnitValue(region[1],'px'),UnitValue(region[2],'px'),UnitValue(region[3],'px')]);
      if(scale<1) preview.resizeImage(UnitValue(Math.round(rw*scale),'px'),UnitValue(Math.round(rh*scale),'px'),null,ResampleMethod.BICUBIC);
      preview.flatten();var file=new File(${jsStringLiteral(path)}),opts=new JPEGSaveOptions();opts.quality=12;opts.embedColorProfile=true;
      preview.saveAs(file,opts,true);
      return {ok:true,path:file.fsName,document_id:doc.id,source:${jsStringLiteral(source)},layer_id:layer?layer.id:null,layer_name:layer?layer.name:null,region:region,scale:scale,width:Math.round(rw*scale),height:Math.round(rh*scale),native_pixels:scale===1};
    }finally{if(preview && preview.id!==doc.id)try{preview.close(SaveOptions.DONOTSAVECHANGES);}catch(closeError){} app.activeDocument=doc;}
  `;
}

export function createLocalMaskTools(connection: PhotoshopConnection): ToolDefinition[] {
  const named = { type: 'string', minLength: 1, maxLength: 1000 };
  const atomic =
    (build: (a: Record<string, unknown>) => string, summary: string) =>
    async (args: Record<string, unknown>) => {
      try {
        const result = parseSnippetResult(await runSnippet(connection, build(args)));
        if (!result || result.ok !== true) throw new Error('No successful mask result');
        return atomicSuccess(summary, result, 'photoshop_get_state');
      } catch (e) {
        return atomicFailureFromError(e);
      }
    };
  return [
    {
      tool: {
        name: 'photoshop_load_selection',
        description:
          'Replace the current selection with an existing pixel layer mask or saved alpha selection; optional invert. Recursively resolves an exact unique layer name; no layer visibility or pixel changes. Empty masks legitimately yield no selection. Does not create a mask.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['layer_mask', 'alpha_channel'] },
            layer_name: named,
            channel_name: named,
            invert: { type: 'boolean', default: false },
          },
          required: ['source'],
        },
      },
      handler: atomic(loadSelectionScript, 'Selection loaded'),
    },
    {
      tool: {
        name: 'photoshop_fill_layer_mask',
        description:
          'Fill ONLY an existing named pixel layer mask inside the active selection with gray value 0..255 and opacity. 0 hides, 255 reveals. Use polygon/ellipse/refinement first. No selection is an error, never a whole-mask fill. Preserves image pixels, layer visibility and active layer/channels; inspect context_restored before another operation. Supports group masks; rejects missing/ambiguous names, hidden layers/parents and locks before editing.',
        inputSchema: {
          type: 'object',
          properties: {
            layer_name: named,
            value: { type: 'integer', minimum: 0, maximum: 255 },
            opacity: { type: 'number', exclusiveMinimum: 0, maximum: 100, default: 100 },
          },
          required: ['layer_name', 'value'],
        },
      },
      handler: atomic(fillMaskScript, 'Existing layer mask updated'),
    },
    {
      tool: {
        name: 'photoshop_get_detail_preview',
        description:
          'Read-only JPEG preview of a composite or raw pixel layer mask, optionally cropped to original document coordinates [left,top,right,bottom]. Region defaults to native pixels (1:1); rejects oversize native crops instead of silently resizing. Returns offset region, scale and dimensions. Full previews default to max 1024px, native crops max 2048px. Mask preview shows raw values without applying mask density/feather. Creates and closes only a temporary preview document, never crops or saves the source.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['composite', 'layer_mask'], default: 'composite' },
            layer_name: named,
            region: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'integer', minimum: 0 },
            },
            native_pixels: { type: 'boolean' },
            max_dimension_px: { type: 'integer', minimum: 32, maximum: 2048 },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const path = join(tmpdir(), `ps-detail-${randomUUID()}.jpg`);
        try {
          const result = parseSnippetResult(
            await runSnippet(connection, detailPreviewScript(args, path))
          );
          if (!result || result.ok !== true) throw new Error('Unexpected preview result');
          const data = await readFile(path);
          if (data.byteLength > 4 * 1024 * 1024)
            throw new Error('Preview exceeds 4MB; use a smaller region');
          const { path: unused, ...metadata } = result;
          void unused;
          return {
            content: [
              { type: 'image' as const, mimeType: 'image/jpeg', data: data.toString('base64') },
              { type: 'text' as const, text: JSON.stringify(metadata) },
            ],
          };
        } catch (e) {
          return atomicFailureFromError(e);
        } finally {
          await unlink(path).catch(() => undefined);
        }
      },
    },
  ];
}
