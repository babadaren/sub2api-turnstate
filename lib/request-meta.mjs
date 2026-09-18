import { validModel } from './states.mjs';
// Inspect a bounded JSON request before dispatch. Large/encoded bodies bypass
// pinning and are forwarded byte-for-byte, not rejected or assigned a fake model.
export function requestMetadata(req, eligible, limit = 8 * 1024 * 1024) {
  let reason = !eligible ? 'not_inspected' : !['POST','PUT','PATCH'].includes(req.method) ? 'no_json_body' : null;
  if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') reason = 'encoded_body';
  if (reason) return Promise.resolve({ prefix: null, complete: false, model: null, payload: null, reason });
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    const cleanup = () => { req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAbort); };
    const onError = e => { cleanup(); reject(e); };
    const onAbort = () => onError(new Error('Client aborted'));
    const onData = chunk => {
      bytes += chunk.length; chunks.push(chunk);
      if (bytes > limit) { req.pause(); cleanup(); resolve({ prefix: Buffer.concat(chunks), complete: false, model: null, payload: null, reason: 'body_too_large' }); chunks = []; }
    };
    const onEnd = () => {
      cleanup(); const prefix = Buffer.concat(chunks); let parsed;
      let validJSON = true;
      try { parsed = JSON.parse(prefix.toString('utf8')); } catch { validJSON = false; }
      // Retain only routing identifiers, never input/messages/content.
      const payload = parsed && { prompt_cache_key: typeof parsed.prompt_cache_key === 'string' ? parsed.prompt_cache_key : null,
        metadata: { turn_id: typeof parsed.metadata?.turn_id === 'string' ? parsed.metadata.turn_id : null } };
      const model = validModel(parsed?.model) ? parsed.model : null;
      const reason = model ? 'json_model' : !validJSON ? 'invalid_json' : parsed?.model == null ? 'missing_model' : 'invalid_model';
      resolve({ prefix, complete: true, model, payload, reason });
    };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}
