import http from 'node:http';
import { ResponseMetadata } from './response-meta.mjs';

const HEADER = 'x-codex-turn-state';
const IDENTITY_HEADERS = ['authorization','x-api-key','session_id','session-id','x-session-id','conversation_id','x-codex-turn-id','originator','user-agent'];
export function identity(headers, payload) {
  const safe = {};
  for (const key of IDENTITY_HEADERS) {
    const value = headers[key];
    if (typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/.test(value)) safe[key] = value;
  }
  return { headers: safe, payload: { prompt_cache_key: payload?.prompt_cache_key || undefined,
    metadata: payload?.metadata?.turn_id ? { turn_id: payload.metadata.turn_id } : undefined } };
}

// Uses only the fixed local Sub2API target. No redirects, proxy environment,
// account selection overrides, TLS interception, original prompts, or state replay.
export function probeOnce(target, model, routing, endpoint, targetLengths, signal, timeoutSeconds = 15) {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('Probe target must be the configured loopback Sub2API origin');
  if (!['/responses','/v1/responses'].includes(endpoint)) throw new Error('Invalid probe endpoint');
  return new Promise(resolve => {
    let request, response, timer, done = false;
    const result = { status: 0, length: 0, responseModel: null, state: '', error: null, completed: false, accepted: false };
    const finish = extra => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      const out = { ...result, ...extra }; response?.destroy(); request?.destroy(); resolve(out);
    };
    const aborted = () => finish({ error: 'cancelled' });
    if (signal?.aborted) { finish({ error: 'cancelled' }); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    const body = Buffer.from(JSON.stringify({ model, stream: true, store: false, instructions: 'Reply only OK.', input: 'ping', max_output_tokens: 16,
      ...routing.payload }));
    const headers = { ...routing.headers, 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': body.length };
    delete headers[HEADER];
    try {
      request = http.request({ hostname: url.hostname, port: url.port || 80, path: endpoint, method: 'POST', headers, agent: false }, res => {
        response = res; result.status = res.statusCode;
        const values = res.headersDistinct?.[HEADER] || [];
        const state = values.length === 1 ? values[0] : '';
        result.length = typeof res.headers[HEADER] === 'string' ? Buffer.byteLength(res.headers[HEADER]) : 0;
        if (res.statusCode < 200 || res.statusCode >= 300) { finish({ error: 'http_' + res.statusCode }); return; }
        const meta = new ResponseMetadata(res.headers);
        if (!meta.enabled) { finish({ error: 'unsupported_response_type' }); return; }
        const wanted = targetLengths.includes(result.length) && state.length === result.length && /^[\x21-\x7e]+$/.test(state);
        res.on('data', chunk => {
          meta.push(chunk); result.responseModel = meta.model;
          if (meta.failed) finish({ error: 'response_failed' });
          else if (meta.modelConflict || (meta.model && meta.model !== model)) finish({ error: 'model_mismatch' });
          else if (meta.truncated) finish({ error: 'response_too_large' });
          // For a non-target length, stop reading as soon as the model is known.
          else if (meta.model && !wanted) finish({ error: 'length_miss' });
          else if (wanted && (meta.completed || meta.outputLimitReached) && meta.model === model) finish({ state, completed: meta.completed, accepted: true });
        });
        res.on('end', () => {
          meta.end(); result.responseModel = meta.model;
          if (meta.failed) finish({ error: 'response_failed' });
          else if (meta.modelConflict || meta.model !== model) finish({ error: meta.model ? 'model_mismatch' : 'response_model_missing' });
          else if (!wanted) finish({ error: 'length_miss' });
          else if (meta.completed || meta.outputLimitReached || (!meta.sse && !meta.truncated)) finish({ state, completed: meta.completed, accepted: true });
          else finish({ error: 'incomplete_response' });
        });
        res.on('aborted', () => finish({ error: 'upstream_aborted' }));
        res.on('error', () => finish({ error: 'upstream_stream_error' }));
      });
      timer = setTimeout(() => finish({ error: 'timeout' }), timeoutSeconds * 1000);
      request.on('error', () => finish({ error: 'connection_error' })); request.end(body);
    } catch { finish({ error: 'invalid_request' }); }
  });
}

