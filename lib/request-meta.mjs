import { validModel } from './states.mjs';
// Inspect a bounded JSON request before dispatch. Large/encoded bodies bypass
// pinning and are forwarded byte-for-byte, not rejected or assigned a fake model.
export function requestMetadata(req, eligible, limit = 1024 * 1024) {
  if (!eligible || !['POST','PUT','PATCH'].includes(req.method) || req.headers['content-encoding']) return Promise.resolve({ prefix: null, complete: false, model: null, payload: null });
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    const cleanup = () => { req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAbort); };
    const onError = e => { cleanup(); reject(e); };
    const onAbort = () => onError(new Error('Client aborted'));
    const onData = chunk => {
      bytes += chunk.length; chunks.push(chunk);
      if (bytes > limit) { req.pause(); cleanup(); resolve({ prefix: Buffer.concat(chunks), complete: false, model: null, payload: null }); chunks = []; }
    };
    const onEnd = () => {
      cleanup(); const prefix = Buffer.concat(chunks); let parsed;
      try { parsed = JSON.parse(prefix.toString('utf8')); } catch {}
      // Retain only routing identifiers, never input/messages/content.
      const payload = parsed && { prompt_cache_key: typeof parsed.prompt_cache_key === 'string' ? parsed.prompt_cache_key : null,
        metadata: { turn_id: typeof parsed.metadata?.turn_id === 'string' ? parsed.metadata.turn_id : null } };
      resolve({ prefix, complete: true, model: validModel(parsed?.model) ? parsed.model : null, payload });
    };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}
