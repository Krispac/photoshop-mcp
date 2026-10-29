import type { ToolDefinition } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import {
  atomicFailureFromError,
  atomicSuccess,
  parseSnippetResult,
  runSnippet,
} from './atomic-shared.js';
import { jsStringLiteral } from '../utils/js-string.js';

const helpers = `
if(!app.documents.length) throw Error('No active document');
var doc=app.activeDocument,c=charIDToTypeID,s=stringIDToTypeID;
function find(n){var a=[];function walk(ls){for(var i=0;i<ls.length;i++){if(ls[i].name===n)a.push(ls[i]);if(ls[i].typename==='LayerSet')walk(ls[i].layers)}}walk(doc.layers);if(a.length!==1)throw Error('layer_name must identify exactly one layer');return a[0]}
function layerRef(l){var r=new ActionReference();r.putIdentifier(c('Lyr '),l.id);return r}
function composite(){var a=[];for(var i=0;i<doc.channels.length;i++)if(doc.channels[i].kind===ChannelType.COMPONENT)a.push(doc.channels[i]);if(!a.length)throw Error('No component channels');return a}
function activate(l){var d=new ActionDescriptor();d.putReference(c('null'),layerRef(l));d.putBoolean(s('makeVisible'),false);executeAction(c('slct'),d,DialogModes.NO)}
function guard(l){if(l.kind!==LayerKind.SMARTOBJECT)throw Error('Target must be an existing Smart Object');var p=l;while(p&&p.typename!=='Document'){if(p.visible===false)throw Error('Target or ancestor is hidden');if(p.allLocked)throw Error('Target or ancestor is locked');p=p.parent}try{if(doc.selection.bounds)throw Error('Deselect before editing Smart Filters')}catch(e){if(String(e).indexOf('Deselect')>=0)throw e}}
function read(l){
 if(l.kind!==LayerKind.SMARTOBJECT)throw Error('Target must be an existing Smart Object');
 var d=executeActionGet(layerRef(l)),list=null,seen=false;
 function inspect(x){if(!x)return;var k=s('filterFX');if(x.hasKey(k)){seen=true;var t=x.getType(k);if(t===DescValueType.LISTTYPE)list=x.getList(k);else if(t===DescValueType.OBJECTTYPE){var o=x.getObjectValue(k);if(o.hasKey(s('filterFXList')))list=o.getList(s('filterFXList'))}}if(x.hasKey(s('filterFXList'))){seen=true;list=x.getList(s('filterFXList'))}}
 inspect(d);if(d.hasKey(s('smartObjectMore')))inspect(d.getObjectValue(s('smartObjectMore')));if(d.hasKey(s('smartObject')))inspect(d.getObjectValue(s('smartObject')));
 if(seen&&!list)throw Error('Unsupported Smart Filter descriptor');
 var out=[];if(list)for(var i=0;i<list.count;i++){var item=list.getObjectValue(i),type='unknown',radius=null,enabled=null;var key=s('filter');
 if(item.hasKey(key)){var tid=item.getObjectType(key);type=typeIDToStringID(tid);if(tid===c('GsnB')||type==='gaussianBlur'){type='gaussianBlur';radius=item.getObjectValue(key).getUnitDoubleValue(s('radius'))}}
 if(item.hasKey(s('enabled')))enabled=item.getBoolean(s('enabled'));
 out.push({filter_index:i+1,filter_type:type,radius_px:radius,enabled:enabled});}
 return {list:list,filters:out};
}
function result(l,q){return {ok:true,layer_name:l.name,layer_id:l.id,is_smart_object:true,filter_count:q.filters.length,filters:q.filters}}
`;
function name(args: Record<string, unknown>): string {
  if (
    typeof args.layer_name !== 'string' ||
    !args.layer_name.length ||
    args.layer_name.length > 1000
  )
    throw Error('layer_name must be nonempty (max 1000)');
  return jsStringLiteral(args.layer_name);
}
function radius(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0.1 || x > 250)
    throw Error('radius must be 0.1..250');
  return x;
}
export function smartFilterScript(
  args: Record<string, unknown>,
  op: 'get' | 'add' | 'set'
): string {
  const n = name(args);
  if (op === 'get') return `${helpers}var layer=find(${n});return result(layer,read(layer));`;
  const r = radius(args.radius_px);
  let action: string;
  if (op === 'add')
    action = `var before=read(layer);var f=new ActionDescriptor();f.putUnitDouble(c('Rds '),c('#Pxl'),${r});executeAction(c('GsnB'),f,DialogModes.NO);var after=read(layer);if(after.filters.length!==before.filters.length+1)throw Error('Add did not verify; inspect state before retry');return result(layer,after);`;
  else {
    const ix = args.filter_index;
    if (typeof ix !== 'number' || !Number.isInteger(ix) || ix < 1 || ix > 1000)
      throw Error('filter_index must be 1..1000');
    const ex = radius(args.expected_radius_px);
    action = `var before=read(layer),i=${ix}-1;if(i>=before.filters.length)throw Error('filter_index out of range');var entry=before.filters[i];if(entry.filter_type!=='gaussianBlur')throw Error('Selected filter is not Gaussian Blur');if(Math.abs(entry.radius_px-${ex})>0.0001)throw Error('Radius changed; reread filters');
 var item=before.list.getObjectValue(i),f=item.getObjectValue(s('filter'));f.putUnitDouble(c('Rds '),c('#Pxl'),${r});item.putObject(s('filter'),c('GsnB'),f);
 var d=new ActionDescriptor(),ref=new ActionReference();ref.putIndex(s('filterFX'),${ix});ref.putIdentifier(c('Lyr '),layer.id);d.putReference(c('null'),ref);d.putObject(s('filterFX'),s('filterFX'),item);executeAction(c('setd'),d,DialogModes.NO);
 var after=read(layer);if(after.filters.length!==before.filters.length||Math.abs(after.filters[i].radius_px-${r})>0.0001)throw Error('Set did not verify; inspect state before retry');return result(layer,after);`;
  }
  return `${helpers}var layer=find(${n});guard(layer);var old=doc.activeLayer,chs;try{chs=doc.activeChannels}catch(e){throw Error('Select the composite RGB channels before editing Smart Filters')}try{activate(layer);doc.activeChannels=composite();${action}}finally{activate(old);doc.activeChannels=chs;}`;
}
export function integrityScript(args: Record<string, unknown>): string {
  return `${helpers}
var l=find(${name(args)}),d=executeActionGet(layerRef(l));function bounds(k){if(!d.hasKey(s(k)))return null;var b=d.getObjectValue(s(k));return [b.getUnitDoubleValue(s('left')),b.getUnitDoubleValue(s('top')),b.getUnitDoubleValue(s('right')),b.getUnitDoubleValue(s('bottom'))]}
return {ok:true,name:l.name,id:l.id,kind:String(l.kind),bounds:bounds('bounds'),bounds_no_mask:bounds('boundsNoMask'),has_user_mask:d.hasKey(s('hasUserMask'))&&d.getBoolean(s('hasUserMask')),canvas:{width:doc.width.as('px'),height:doc.height.as('px')},limitation:'Bounds cannot prove original or complete image content; inspect unmasked pixels and source provenance'};`;
}
export function prepareFullFrameScript(args: Record<string, unknown>): string {
  const source = name({ layer_name: args.source_layer_name }),
    target = name({ layer_name: args.new_layer_name });
  return `${helpers}var source=find(${source});if(source.kind!==LayerKind.NORMAL)throw Error('Source must be the untouched full-frame raster base');
 function countName(ls,n){var k=0;for(var j=0;j<ls.length;j++){if(ls[j].name===n)k++;if(ls[j].typename==='LayerSet')k+=countName(ls[j].layers,n)}return k}
 if(countName(doc.layers,${target}))throw Error('New layer name already exists');
 var sd=executeActionGet(layerRef(source));if((sd.hasKey(s('hasUserMask'))&&sd.getBoolean(s('hasUserMask')))||(sd.hasKey(s('hasVectorMask'))&&sd.getBoolean(s('hasVectorMask'))))throw Error('Source must not have a pixel or vector mask');
 var key=sd.hasKey(s('boundsNoMask'))?'boundsNoMask':'bounds',bb=sd.getObjectValue(s(key));var bounds=[bb.getUnitDoubleValue(s('left')),bb.getUnitDoubleValue(s('top')),bb.getUnitDoubleValue(s('right')),bb.getUnitDoubleValue(s('bottom'))];
 if(bounds[0]>0||bounds[1]>0||bounds[2]<doc.width.as('px')||bounds[3]<doc.height.as('px'))throw Error('Source does not cover the full canvas');
 var old=doc.activeLayer,copy=null;try{copy=source.duplicate(doc,ElementPlacement.PLACEATBEGINNING);copy.name=${target};copy.visible=true;activate(copy);executeAction(s('newPlacedLayer'),undefined,DialogModes.NO);var made=doc.activeLayer;if(made.kind!==LayerKind.SMARTOBJECT)throw Error('Smart Object conversion did not verify');return {ok:true,source_layer_id:source.id,layer_id:made.id,layer_name:made.name,is_smart_object:true,full_frame_source:true,limitation:'Caller must identify the untouched original base; canvas coverage does not prove provenance'};}finally{activate(old);}
 `;
}
export function createSmartFilterTools(connection: PhotoshopConnection): ToolDefinition[] {
  const props = {
    source_layer_name: { type: 'string', minLength: 1, maxLength: 1000 },
    new_layer_name: { type: 'string', minLength: 1, maxLength: 1000 },
    layer_name: { type: 'string', minLength: 1, maxLength: 1000 },
    radius_px: { type: 'number', minimum: 0.1, maximum: 250 },
    filter_index: { type: 'integer', minimum: 1, maximum: 1000 },
    expected_radius_px: { type: 'number', minimum: 0.1, maximum: 250 },
  };
  const specs = [
    {
      name: 'photoshop_prepare_full_frame_smart_layer',
      description:
        'Duplicate a known untouched unmasked full-frame raster base to a new root Smart Object without selection-copy or cropping. Does not change source pixels; rejects incomplete bounds and name collisions. Caller must establish source provenance. No mask/filter is added yet.',
      required: ['source_layer_name', 'new_layer_name'],
      build: prepareFullFrameScript,
    },
    {
      name: 'photoshop_get_smart_filters',
      description:
        'Read the Smart Filter stack of an exact unique Smart Object layer; returns 1-based indices and Gaussian radii. Does not activate or edit the layer.',
      required: ['layer_name'],
      build: (a: Record<string, unknown>) => smartFilterScript(a, 'get'),
    },
    {
      name: 'photoshop_add_gaussian_smart_filter',
      description:
        'Add one editable Gaussian Smart Filter to an existing visible unlocked Smart Object, with no active selection. Never rasterizes. Preserves layer/channel context; reread state on failure.',
      required: ['layer_name', 'radius_px'],
      build: (a: Record<string, unknown>) => smartFilterScript(a, 'add'),
    },
    {
      name: 'photoshop_set_gaussian_smart_filter',
      description:
        'Change an existing Gaussian Smart Filter by 1-based index and expected current radius. Preserves its descriptor and stack count; requires no selection and a visible unlocked Smart Object. Reread state on failure.',
      required: ['layer_name', 'filter_index', 'expected_radius_px', 'radius_px'],
      build: (a: Record<string, unknown>) => smartFilterScript(a, 'set'),
    },
    {
      name: 'photoshop_get_layer_integrity',
      description:
        'Read layer kind, mask presence, pixel bounds without mask, and canvas dimensions. Bounds alone do not prove complete original pixels; compare unmasked image and provenance.',
      required: ['layer_name'],
      build: integrityScript,
    },
  ];
  return specs.map(({ name, description, required, build }) => ({
    tool: { name, description, inputSchema: { type: 'object', properties: props, required } },
    handler: async (args) => {
      try {
        const r = parseSnippetResult(await runSnippet(connection, build(args)));
        if (!r || r.ok !== true) throw Error('Unverified Photoshop result');
        return atomicSuccess(description, r, 'photoshop_get_state');
      } catch (e) {
        return atomicFailureFromError(e);
      }
    },
  }));
}
