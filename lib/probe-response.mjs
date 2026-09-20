import {createGunzip, createInflate, createBrotliDecompress} from 'node:zlib';
import {ResponseMetadata} from './response-meta.mjs';

// Probe-only response reader. Ordinary forwarding still preserves all bytes.
// Missing Content-Type is not an error by itself: inspect a bounded prefix for
// SSE/JSON, then require a successful terminal response before adopting state.
export function inspectProbeResponse(res, targetLengths, finish, options = {}) {
  const limit = options.maxBytes ?? 65536;
  const rawType = String(res.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const type = rawType === 'text/event-stream' ? 'sse' : /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(rawType) ? 'json' :
    !rawType ? 'missing' : rawType === 'text/plain' ? 'text' : rawType === 'application/octet-stream' ? 'binary' : 'other';
  const rawEncoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const encoding = ['identity','gzip','deflate','br'].includes(rawEncoding) ? rawEncoding : 'other';
  const result = {status:res.statusCode, length:0, responseModel:null, state:'', accepted:false, completed:false,
    responseContentType:type, responseEncoding:encoding, responseDetection:null};
  let done = false, decoder = null, meta = null, prefix = Buffer.alloc(0), rawBytes = 0, decodedBytes = 0;
  const signal = options.signal;
  const cleanup = () => {
    done = true;
    signal?.removeEventListener('abort', aborted);
    if (decoder) {res.unpipe(decoder); decoder.destroy();}
    prefix = Buffer.alloc(0);
    if (meta) meta.buffer = '';
  };
  const end = extra => {
    if (done) return;
    done = true;
    const out = {...result, rawBytes, decodedBytes, ...extra};
    cleanup(); finish(out);
  };
  const aborted = () => end({error:'cancelled'});
  signal?.addEventListener('abort', aborted, {once:true});
  if (signal?.aborted) {aborted(); return cleanup;}
  const retry = String(res.headers['retry-after'] || '');
  const retryMs = /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
  if (Number.isFinite(retryMs) && retryMs>0) result.retryAfterMs=retryMs;
  // Authentication/rate-limit/server status is never hidden by a header miss.
  if (res.statusCode<200 || res.statusCode>=300) {end({error:'http_'+res.statusCode}); return cleanup;}
  const values = res.headersDistinct?.['x-codex-turn-state'] || [];
  const state = values.length===1 ? values[0] : '';
  result.length = typeof res.headers['x-codex-turn-state']==='string' ? Buffer.byteLength(res.headers['x-codex-turn-state']) : 0;
  const wanted = targetLengths.includes(result.length) && state.length===result.length && /^[\x21-\x7e]+$/.test(state);
  // A known non-target/duplicate/unsafe state cannot be adopted. Do not stop the
  // whole node pool just because its response omitted a media-type header.
  if (!wanted) {end({error:'length_miss'}); return cleanup;}
  if (type==='other') {end({error:'unsupported_response_type'}); return cleanup;}
  if (encoding==='other') {end({error:'unsupported_content_encoding'}); return cleanup;}
  const initialize = detected => {
    result.responseDetection = (type==='sse'||type==='json') ? 'header_'+detected : 'body_'+detected;
    meta = new ResponseMetadata({'content-type':detected==='sse'?'text/event-stream':'application/json'}, limit);
  };
  if (type==='sse'||type==='json') initialize(type);
  const assess = atEnd => {
    if (!meta || done) return;
    result.responseModel = meta.model;
    result.completed = meta.completed;
    if (meta.failed) {end({error:'response_failed'}); return;}
    if (meta.truncated) {end({error:'response_too_large'}); return;}
    // Compressed streams must finish and pass decoder integrity checks.
    if ((meta.completed||meta.outputLimitReached) && (!decoder||atEnd)) {
      end({state, accepted:true, completed:meta.completed, modelConflict:!!meta.modelConflict}); return;
    }
    if (atEnd) end({error:meta.parseFailed?'invalid_response_json':'incomplete_response'});
  };
  const detect = atEnd => {
    const text = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (text.startsWith('{')) initialize('json');
    else if (/^(?:data:|event:|id:|retry:|:)/.test(text)) initialize('sse');
    else if (text.startsWith('<') || prefix.length>=2048 || atEnd) {end({error:'unsupported_response_type'}); return;}
    if (meta) {const saved=prefix; prefix=Buffer.alloc(0); meta.push(saved);}
  };
  const consume = chunk => {
    if (done) return;
    decodedBytes += chunk.length;
    if (decodedBytes>limit) {end({error:'response_too_large'}); return;}
    if (meta) meta.push(chunk);
    else {prefix=Buffer.concat([prefix,chunk]); detect(false);}
    assess(false);
  };
  res.on('data', chunk => {
    rawBytes+=chunk.length;
    if (rawBytes>limit) end({error:'response_too_large'});
  });
  if (encoding==='gzip') decoder=createGunzip();
  else if (encoding==='deflate') decoder=createInflate();
  else if (encoding==='br') decoder=createBrotliDecompress();
  const input = decoder || res;
  input.on('data',consume);
  input.on('error',()=>end({error:decoder?'response_decode_error':'upstream_stream_error'}));
  input.on('end',()=>{
    if (done) return;
    if (!meta) detect(true);
    if (done) return;
    meta?.end(); assess(true);
  });
  res.on('aborted',()=>end({error:'upstream_aborted'}));
  res.on('error',()=>end({error:'upstream_stream_error'}));
  if (decoder) res.pipe(decoder);
  return cleanup;
}
