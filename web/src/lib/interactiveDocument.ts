import { installClickFlash } from './clickFlashRuntime';
import { installInteractiveCapture } from './interactiveCaptureRuntime';
import { installInteractiveAudioMute } from './interactiveAudioMute';
import { normalizeScreenshotControls, rasterizeScreenshotSvg } from './screenshotRasterize';

/** Default starting surface; individual programs may choose another shape.
 * The viewer scales the measured surface uniformly to available space. */
export const INTERACTIVE_VIEWPORT_WIDTH = 960 as const;
export const INTERACTIVE_VIEWPORT_HEIGHT = 720 as const;
/** Default canvas size, also defining the preview scale for other shapes. */
export const INTERACTIVE_PREVIEW_WIDTH = 764 as const;
export const INTERACTIVE_PREVIEW_HEIGHT = 573 as const;
export const LEGACY_INTERACTIVE_VIEWPORT_SIZE = 580 as const;
export const INTERACTIVE_DOCUMENT_MAX_CHARS = 200_000;
/** JSON can encode one UTF-16 character as six characters (a Unicode escape).
 * Edits carry both a search string and a replacement. Keep transport bounds
 * separate from the unchanged limit on the decoded program itself. */
export const INTERACTIVE_TOOL_ARGUMENT_LIMITS: Readonly<Record<string, number>> = {
  write_document: INTERACTIVE_DOCUMENT_MAX_CHARS * 6 + 1024,
  edit_document: INTERACTIVE_DOCUMENT_MAX_CHARS * 12 + 1024,
};

export interface InteractiveViewport {
  width: number;
  height: number;
}

export const INTERACTIVE_MAX_DIMENSION = 1600;

/** A model may request a portrait, square, or landscape starting surface. */
export function preferredInteractiveViewport(html: string): InteractiveViewport {
  const tag = html.match(/<meta\b[^>]*\bname\s*=\s*["']scatter-viewport["'][^>]*>/i)?.[0];
  const content = tag?.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  const dimension = (name: string, fallback: number) => {
    const value = Number(content.match(new RegExp(`${name}\\s*=\\s*(\\d+)`, 'i'))?.[1]);
    return value > 0 ? Math.max(480, Math.min(INTERACTIVE_MAX_DIMENSION, value)) : fallback;
  };
  return { width: dimension('width', 960), height: dimension('height', 720) };
}

export function interactiveDisplaySize(value?: { viewportWidth?: number; viewportHeight?: number }, viewer = false, canvasWidth?: number): InteractiveViewport {
  const validViewport = value?.viewportWidth && Number.isFinite(value.viewportWidth) && value.viewportWidth > 0
    && value.viewportHeight && Number.isFinite(value.viewportHeight) && value.viewportHeight > 0;
  const source = validViewport ? { width: value.viewportWidth!, height: value.viewportHeight! }
    : { width: INTERACTIVE_VIEWPORT_WIDTH, height: INTERACTIVE_VIEWPORT_HEIGHT };
  // Resizing scales the canvas presentation only. Keep the program's own
  // viewport (and enlarged viewer) unchanged, so its layout and state survive.
  if (!viewer && canvasWidth != null && Number.isFinite(canvasWidth) && canvasWidth > 0) {
    const width = Math.max(280, Math.round(canvasWidth));
    return { width, height: Math.round(width * source.height / source.width) };
  }
  const scale = viewer ? 1 : INTERACTIVE_PREVIEW_WIDTH / INTERACTIVE_VIEWPORT_WIDTH;
  return { width: Math.round(source.width * scale), height: Math.round(source.height * scale) };
}

/** Resolve persisted viewport metadata without migrating old 580px-square
 * documents. New documents store explicit dimensions in their chosen shape. */
export function resolveInteractiveViewport(value?: {
  viewportSize?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): InteractiveViewport {
  const width = value?.viewportWidth;
  const height = value?.viewportHeight;
  if (
    typeof width === 'number' && Number.isFinite(width) && width > 0
    && typeof height === 'number' && Number.isFinite(height) && height > 0
  ) {
    return { width, height };
  }
  const legacySize = typeof value?.viewportSize === 'number'
    && Number.isFinite(value.viewportSize) && value.viewportSize > 0
    ? value.viewportSize
    : LEGACY_INTERACTIVE_VIEWPORT_SIZE;
  return { width: legacySize, height: legacySize };
}

export interface InteractiveRuntimeError {
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface InteractiveHostTheme {
  cursors?: Record<string, string>;
  mode: 'light' | 'dark';
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  primarySoft: string;
  primaryText?: string;
  onPrimary?: string;
  success: string;
  warning: string;
  danger: string;
  fontFamily: string;
  fontSize: string;
  fontSizeSmall: string;
  fontSizeTitle: string;
  lineHeight: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  shadow: string;
}

export interface InteractiveHostState {
  active: boolean;
  theme: InteractiveHostTheme;
}

export const DEFAULT_INTERACTIVE_HOST_STATE: InteractiveHostState = {
  active: true,
  theme: {
    mode: 'light',
    background: '#ffffff',
    surface: '#f5f5f5',
    surfaceRaised: '#ffffff',
    text: '#1a1a1a',
    muted: '#5c5c5c',
    border: 'rgba(163,163,163,0.6)',
    primary: '#377eb8',
    primarySoft: 'rgba(55,126,184,0.18)',
    primaryText: '#3273a7',
    onPrimary: '#000000',
    success: '#40a02b',
    warning: '#df8e1d',
    danger: '#d20f39',
    fontFamily: 'Arial, sans-serif',
    fontSize: '14px',
    fontSizeSmall: '12px',
    fontSizeTitle: '18px',
    lineHeight: '1.45',
    radiusSm: '4px',
    radiusMd: '6px',
    radiusLg: '8px',
    shadow: '0 8px 24px rgba(0,0,0,0.12)',
  },
};

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i, 'External resources are not allowed'],
  [/url\s*\(\s*["']?\s*(?:https?:)?\/\//i, 'External resources are not allowed'],
  [/@import\b/i, 'CSS imports are not allowed'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i, 'Network APIs are not allowed'],
  [/navigator\.(?:sendBeacon|clipboard|serviceWorker)\b/i, 'Privileged browser APIs are not allowed'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/i, 'Browser storage is not allowed'],
  [/\b(?:SharedWorker|Worker)\s*\(/i, 'Workers are not allowed'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/i, 'Dynamic code evaluation is not allowed'],
  [/\bwindow\.open\s*\(|\blocation\.(?:assign|replace)\s*\(|\blocation\.href\s*=/i, 'Navigation is not allowed'],
  [/<\s*form\b|\bdownload\s*=/i, 'Forms and downloads are not allowed'],
  [/\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i, 'Blocking unbounded loops are not allowed'],
];

/** Normalize and statically validate one provider-neutral interactive document. */
export function validateInteractiveDocument(
  raw: string,
  options: { requireDesignTokens?: boolean } = {},
): string {
  const html = stripFence(raw);
  if (!html) throw new Error('The model returned no interactive document.');
  if (html.length > INTERACTIVE_DOCUMENT_MAX_CHARS) {
    throw new Error('The interactive document is too large.');
  }
  if (!/^<!doctype\s+html>/i.test(html)) {
    throw new Error('The interactive document must begin with <!doctype html>.');
  }
  if (!/<html(?:\s|>)/i.test(html) || !/<\/html>\s*$/i.test(html)) {
    throw new Error('The interactive document must contain one complete <html> document.');
  }
  for (const [pattern, message] of FORBIDDEN) {
    if (pattern.test(html)) throw new Error(message);
  }
  if (options.requireDesignTokens) {
    for (const token of ['--sc-bg', '--sc-text', '--sc-primary']) {
      const reference = new RegExp(`var\\(\\s*${token}\\b`, 'i');
      if (!reference.test(html)) {
        throw new Error(`The interactive document must use Scatter's ${token} design token.`);
      }
    }
  }
  return html;
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Inject isolation, design tokens, error reporting, and a host-controlled
 * scheduler before model code. Pausing keeps the last frame painted while
 * stopping recurring work and sound. */
export function buildInteractiveSrcDoc(
  html: string,
  channel: string,
  initialState: InteractiveHostState = DEFAULT_INTERACTIVE_HOST_STATE,
  viewport: InteractiveViewport = {
    width: INTERACTIVE_VIEWPORT_WIDTH,
    height: INTERACTIVE_VIEWPORT_HEIGHT,
  },
  options: { muteAudio?: boolean } = {},
): string {
  const safeChannel = JSON.stringify(channel);
  const safeState = JSON.stringify(initialState).replace(/</g, '\\u003c');
  const injected = `<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{box-sizing:border-box;width:100%;height:100%;margin:0;overflow:hidden;background:var(--sc-bg);color:var(--sc-text);font-family:var(--sc-font-family,Arial,sans-serif);font-size:var(--sc-font-size,14px);line-height:var(--sc-line-height,1.45);color-scheme:light}*,*::before,*::after{box-sizing:border-box}html[data-sc-paused] *,html[data-sc-paused] *::before,html[data-sc-paused] *::after{animation-play-state:paused!important}</style>
<script>(function(){
  ${options.muteAudio ? `(${installInteractiveAudioMute.toString()})();` : ''}
  var channel=${safeChannel};
  (${installInteractiveCapture.toString()})(channel, (${rasterizeScreenshotSvg.toString()}), (${normalizeScreenshotControls.toString()}));
  var hostState=${safeState};
  var desiredActive=!!hostState.active;
  var bootPreview=!desiredActive;
  var paused=false;
  var nextHandle=1;
  var rafs=new Map(),timers=new Map(),audioContexts=new Set(),resumeAudioContexts=new Set(),resumeMedia=new Set(),resumeAnimations=new Set();
  var nativeRAF=window.requestAnimationFrame.bind(window),nativeCancelRAF=window.cancelAnimationFrame.bind(window);
  var nativeSetTimeout=window.setTimeout.bind(window),nativeClearTimeout=window.clearTimeout.bind(window);
  (${installClickFlash.toString()})(document,{setTimeout:nativeSetTimeout,clearTimeout:nativeClearTimeout});
  var nativeMediaPlay=window.HTMLMediaElement&&HTMLMediaElement.prototype.play;
  var nativeMediaPause=window.HTMLMediaElement&&HTMLMediaElement.prototype.pause;
  function send(type,payload){parent.postMessage({__scatterInteractive:channel,type:type,payload:payload||null},'*')}
  // Wheel events do not bubble out of an iframe. Cancel browser pinch zoom
  // here, before generated handlers, and route it through the host camera.
  window.addEventListener('wheel',function(event){
    if(!event.ctrlKey&&!event.metaKey)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send('canvas-zoom',{clientX:event.clientX,clientY:event.clientY,deltaY:event.deltaY,deltaMode:event.deltaMode,ctrlKey:event.ctrlKey,metaKey:event.metaKey});
  },{capture:true,passive:false});
  function applyTheme(theme){
    if(!theme)return;
    hostState.theme=theme;
    var root=document.documentElement;
    var values={'--sc-bg':theme.background,'--sc-surface':theme.surface,'--sc-surface-raised':theme.surfaceRaised,'--sc-text':theme.text,'--sc-muted':theme.muted,'--sc-border':theme.border,'--sc-primary':theme.primary,'--sc-primary-soft':theme.primarySoft,'--sc-success':theme.success,'--sc-warning':theme.warning,'--sc-danger':theme.danger,'--sc-font-family':theme.fontFamily,'--sc-font-size':theme.fontSize,'--sc-font-size-small':theme.fontSizeSmall,'--sc-font-size-title':theme.fontSizeTitle,'--sc-line-height':theme.lineHeight,'--sc-radius-sm':theme.radiusSm,'--sc-radius-md':theme.radiusMd,'--sc-radius-lg':theme.radiusLg,'--sc-shadow':theme.shadow};
    values['--sc-primary-text']=theme.primaryText||theme.text;
    values['--sc-on-primary']=theme.onPrimary||theme.text;
    Object.keys(values).forEach(function(key){root.style.setProperty(key,values[key])});
    Object.keys(theme.cursors||{}).forEach(function(key){root.style.setProperty('--sc-cursor-'+key,theme.cursors[key])});
    root.dataset.scTheme=theme.mode;
    root.style.colorScheme=theme.mode;
    window.scatterTheme=theme;
    window.dispatchEvent(new CustomEvent('scatter:themechange',{detail:theme}));
  }
  function scheduleRAF(id,record){
    if(paused||record.nativeId!=null)return;
    record.nativeId=nativeRAF(function(time){record.nativeId=null;if(!rafs.has(id)||paused)return;rafs.delete(id);record.callback(time)});
  }
  window.requestAnimationFrame=function(callback){var id=nextHandle++,record={callback:callback,nativeId:null};rafs.set(id,record);scheduleRAF(id,record);return id};
  window.cancelAnimationFrame=function(id){var record=rafs.get(id);if(record&&record.nativeId!=null)nativeCancelRAF(record.nativeId);rafs.delete(id)};
  function scheduleTimer(id,record,delay){
    if(paused)return;
    record.remaining=Math.max(0,delay);record.due=Date.now()+record.remaining;
    record.nativeId=nativeSetTimeout(function(){record.nativeId=null;if(!timers.has(id)||paused)return;if(record.repeat){record.callback.apply(window,record.args);scheduleTimer(id,record,record.delay)}else{timers.delete(id);record.callback.apply(window,record.args)}},record.remaining);
  }
  function makeTimer(callback,delay,args,repeat){if(typeof callback!=='function')throw new TypeError('Interactive timers require a function');var id=nextHandle++,record={callback:callback,delay:Math.max(0,Number(delay)||0),remaining:Math.max(0,Number(delay)||0),args:args,repeat:repeat,nativeId:null,due:0};timers.set(id,record);scheduleTimer(id,record,record.remaining);return id}
  window.setTimeout=function(callback,delay){return makeTimer(callback,delay,Array.prototype.slice.call(arguments,2),false)};
  window.setInterval=function(callback,delay){return makeTimer(callback,delay,Array.prototype.slice.call(arguments,2),true)};
  window.clearTimeout=window.clearInterval=function(id){var record=timers.get(id);if(record&&record.nativeId!=null)nativeClearTimeout(record.nativeId);timers.delete(id)};
  function wrapAudio(name){var Native=window[name];if(!Native)return;function Wrapped(){var context=Reflect.construct(Native,arguments,new.target||Wrapped);audioContexts.add(context);if(paused)context.suspend().catch(function(){});else if(navigator.userActivation&&navigator.userActivation.isActive)queueAudioUnlock();return context}Object.setPrototypeOf(Wrapped,Native);Wrapped.prototype=Native.prototype;window[name]=Wrapped}
  wrapAudio('AudioContext');wrapAudio('webkitAudioContext');
  var audioUnlockQueued=false;
  function unlockAudioContexts(){
    audioUnlockQueued=false;
    if(paused)return;
    audioContexts.forEach(function(context){if(context.state==='suspended')context.resume().catch(function(){})});
  }
  function queueAudioUnlock(){
    if(audioUnlockQueued||paused)return;
    audioUnlockQueued=true;
    Promise.resolve().then(unlockAudioContexts);
  }
  ['click','pointerdown','pointerup','touchend','keydown'].forEach(function(name){
    document.addEventListener(name,queueAudioUnlock,true);
  });
  window.addEventListener('keydown',function(event){
    if(event.key!=='Escape')return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send('escape');
  },true);
  if(nativeMediaPlay){HTMLMediaElement.prototype.play=function(){if(paused){resumeMedia.add(this);return Promise.resolve()}return nativeMediaPlay.call(this)}}
  function pauseRuntime(){
    if(paused)return;paused=true;document.documentElement.dataset.scPaused='';
    rafs.forEach(function(record){if(record.nativeId!=null){nativeCancelRAF(record.nativeId);record.nativeId=null}});
    timers.forEach(function(record){if(record.nativeId!=null){record.remaining=Math.max(0,record.due-Date.now());nativeClearTimeout(record.nativeId);record.nativeId=null}});
    audioContexts.forEach(function(context){if(context.state==='running'){resumeAudioContexts.add(context);context.suspend().catch(function(){})}});
    if(nativeMediaPause)document.querySelectorAll('audio,video').forEach(function(media){if(!media.paused){resumeMedia.add(media);nativeMediaPause.call(media)}});
    if(document.getAnimations)document.getAnimations().forEach(function(animation){if(animation.playState==='running'){resumeAnimations.add(animation);animation.pause()}});
  }
  function resumeRuntime(){
    if(!paused)return;paused=false;delete document.documentElement.dataset.scPaused;
    rafs.forEach(function(record,id){scheduleRAF(id,record)});
    timers.forEach(function(record,id){scheduleTimer(id,record,record.remaining)});
    resumeAudioContexts.forEach(function(context){if(context.state==='suspended')context.resume().catch(function(){})});resumeAudioContexts.clear();
    resumeMedia.forEach(function(media){if(nativeMediaPlay)nativeMediaPlay.call(media).catch(function(){})});resumeMedia.clear();
    resumeAnimations.forEach(function(animation){animation.play()});resumeAnimations.clear();
  }
  function setActive(active){desiredActive=!!active;if(desiredActive)resumeRuntime();else pauseRuntime()}
  function errorPayload(value,source,line,column){
    var err=value instanceof Error?value:null;
    return {message:String(err?err.message:(value&&value.message)||value||'Unknown runtime error').slice(0,2000),source:source||'',line:line||0,column:column||0,stack:String(err&&err.stack||value&&value.stack||'').slice(0,8000)}
  }
  function reportLayoutOverflow(){
    if(!document.body)return;
    var width=window.innerWidth,height=window.innerHeight;
    var tolerance=2,minLeft=0,minTop=0,maxRight=width,maxBottom=height,clipped=0;
    var elements=document.body.querySelectorAll('*');
    elements.forEach(function(element){
      if(element.hidden)return;
      var style=window.getComputedStyle(element);
      if(style.display==='none'||style.visibility==='hidden')return;
      var rect=element.getBoundingClientRect();
      var left=rect.left,right=rect.right,top=rect.top,bottom=rect.bottom,ancestor=element.parentElement;
      while(ancestor&&ancestor!==document.body){
        var parentStyle=window.getComputedStyle(ancestor),parentRect=ancestor.getBoundingClientRect();
        if(parentStyle.overflowX!=='visible'){left=Math.max(left,parentRect.left);right=Math.min(right,parentRect.right)}
        if(parentStyle.overflowY!=='visible'){top=Math.max(top,parentRect.top);bottom=Math.min(bottom,parentRect.bottom)}
        ancestor=ancestor.parentElement;
      }
      if(right>left&&bottom>top){minLeft=Math.min(minLeft,left);minTop=Math.min(minTop,top);maxRight=Math.max(maxRight,right);maxBottom=Math.max(maxBottom,bottom)}
      var clipsX=(style.overflowX==='hidden'||style.overflowX==='clip')&&element.clientWidth>0&&element.scrollWidth>element.clientWidth+tolerance;
      var clipsY=(style.overflowY==='hidden'||style.overflowY==='clip')&&element.clientHeight>0&&element.scrollHeight>element.clientHeight+tolerance;
      if(clipsX||clipsY)clipped++;
    });
    var root=document.documentElement,body=document.body;
    var requiredWidth=Math.ceil(Math.max(maxRight,root.scrollWidth,body.scrollWidth)-Math.min(0,minLeft));
    var requiredHeight=Math.ceil(Math.max(maxBottom,root.scrollHeight,body.scrollHeight)-Math.min(0,minTop));
    send('layout',{width:requiredWidth,height:requiredHeight,clipped:clipped,negativeOverflow:minLeft < -tolerance||minTop < -tolerance});
  }
  window.addEventListener('error',function(event){send('error',errorPayload(event.error||event.message,event.filename,event.lineno,event.colno))});
  window.addEventListener('unhandledrejection',function(event){send('error',errorPayload(event.reason))});
  window.addEventListener('scatter:check-layout',reportLayoutOverflow);
  window.addEventListener('resize',function(){nativeSetTimeout(reportLayoutOverflow,60)});
  window.addEventListener('message',function(event){var message=event.data;if(event.source!==parent||!message||message.__scatterInteractive!==channel||message.type!=='host-state')return;hostState=message.payload||hostState;applyTheme(hostState.theme);setActive(hostState.active)});
  applyTheme(hostState.theme);
  window.addEventListener('DOMContentLoaded',function(){
    nativeRAF(function(){nativeRAF(function(){
      if(bootPreview&&!desiredActive)pauseRuntime();
      send('ready');
      nativeSetTimeout(reportLayoutOverflow,600);
    })})
  });
})();</script>
<style>
body{cursor:var(--sc-cursor-pointer,default)}
button,a,[role=button],[role=slider],select,input[type=range],input[type=checkbox],input[type=radio]{cursor:var(--sc-cursor-click,pointer)}
input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]{cursor:var(--sc-cursor-text,text)}
[draggable=true],[data-sc-draggable]{cursor:var(--sc-cursor-move,move)}
:disabled,[aria-disabled=true]{cursor:var(--sc-cursor-click,pointer)!important}
html.sc-pressing,html.sc-pressing *{cursor:var(--sc-cursor-press,pointer)!important}
html.sc-disabled-pressing,html.sc-disabled-pressing *{cursor:var(--sc-cursor-ban,not-allowed)!important}
</style>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${injected}`);
  }
  return html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}\n<head>${injected}</head>`);
}

export function formatInteractiveError(error: InteractiveRuntimeError): string {
  const location = error.source
    ? `\nSource: ${error.source}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : ''}`
    : '';
  const stack = error.stack ? `\nStack:\n${error.stack}` : '';
  return `${error.message}${location}${stack}`.slice(0, 12_000);
}
