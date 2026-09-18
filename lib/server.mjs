import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { atomicJSON, equalSecret, MODES, VERSION } from './config.mjs';
import { HEADER, inspectState, cleanHeaders, routeName } from './policy.mjs';
import { Journal } from './journal.mjs';
import { StateStore } from './states.mjs';
import { requestMetadata } from './request-meta.mjs';

const derive = promisify(scrypt);
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function readJSON(req, max = 8192) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function writeSocketHeaders(socket, response, headers) {
  let raw = `HTTP/1.1 ${response.statusCode} ${response.statusMessage || ''}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) raw += `${key}: ${v}\r\n`;
  }
  socket.write(raw + '\r\n');
}

export async function createExtension(config, home, options = {}) {
  const journal = new Journal(home, config);
  const states = new StateStore(home, config.logSalt, event => journal.add(event));
  const runtimePath = path.join(home, 'runtime.json');
  let mode = config.mode;
  try { const saved = JSON.parse(fs.readFileSync(runtimePath, 'utf8')); if (MODES.includes(saved.mode)) mode = saved.mode; } catch {}
  const sessions = new Map(), failures = new Map(), sockets = new Set();
  const startedAt = new Date().toISOString();
  let active = 0, loginBusy = 0, metadataReaders = 0;
  const target = new URL(config.target);
  // A private native HTTP Agent does not read HTTP_PROXY, HTTPS_PROXY or ALL_PROXY.
  // This hop is ALWAYS a loopback HTTP connection, never the account egress proxy.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });
  const clientID = req => createHmac('sha256', config.logSalt).update(String(req.headers.authorization || 'anonymous')).digest('hex').slice(0, 12);
  const setMode = value => {
    if (!MODES.includes(value)) throw new Error('Unknown mode');
    atomicJSON(runtimePath, { mode: value });
    const previous = mode; mode = value;
    journal.add({ kind: 'admin', action: 'mode_change', previous, mode });
  };
  const health = () => ({ ok: true, service: 'sub2api-turnstate-extension', version: VERSION });

  function prepare(req, upgrade = false, metadata = {}) {
    const eligible = !!routeName(req.url), currentMode = mode;
    const headers = cleanHeaders(req.headers, upgrade);
    const context = states.context(metadata.model, req.headers, metadata.payload);
    const decision = !eligible || currentMode === 'drop312' ? inspectState(req.headers[HEADER], currentMode, eligible) : states.decide(context, req.headers[HEADER], 'request', currentMode);
    if (decision.remove) delete headers[HEADER];
    if (decision.value !== undefined) headers[HEADER] = decision.value;
    return { eligible, currentMode, headers, decision, context };
  }
  function trackSocket(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  }
  const proxy = http.createServer(async (req, res) => {
    if (req.url === '/__turnstate_health' && req.method === 'GET') return sendJSON(res, 200, health());
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return sendJSON(res, 400, { error: 'Origin-form paths required' });
    let metadata;
    const inspectBody = !!routeName(req.url) && metadataReaders < 32;
    if (inspectBody) metadataReaders++;
    try { metadata = await requestMetadata(req, inspectBody); }
    catch { if (!res.destroyed) res.destroy(); return; }
    finally { if (inspectBody) metadataReaders--; }
    if (req.destroyed && !req.complete) return;
    const { eligible, currentMode, headers, decision, context } = prepare(req, false, metadata);
    const begin = performance.now();
    let logged = false, status = 0, headersMs = null, responseDecision = null, requestBytes = 0, responseBytes = 0;
    let model = metadata.model, finished = false;
    active++;
    const log = error => {
      if (logged) return;
      logged = true; active--;
      if (!eligible) return;
      journal.add({ kind: 'request', protocol: 'http', method: req.method,
        path: routeName(req.url), model, client: clientID(req), mode: currentMode,
        status, headersMs, durationMs: Math.round(performance.now() - begin), requestBytes, responseBytes,
        requestStateLength: decision.incomingLength, forwardedStateLength: decision.outgoingLength,
        responseStateLength: responseDecision?.incomingLength ?? 0,
        returnedStateLength: responseDecision?.outgoingLength ?? 0,
        requestAction: decision.action, responseAction: responseDecision?.action ?? 'none',
        error: error || undefined });
    };
    const upstream = http.request({ protocol: 'http:', hostname: target.hostname, port: target.port || 80,
      method: req.method, path: req.url, headers, agent }, response => {
      status = response.statusCode;
      headersMs = Math.round(performance.now() - begin);
      const out = cleanHeaders(response.headers);
      responseDecision = !eligible || currentMode === 'drop312' ? inspectState(response.headers[HEADER], currentMode, eligible) : states.decide(context, response.headers[HEADER], 'response', currentMode, status);
      if (responseDecision.remove) delete out[HEADER];
      if (responseDecision.value !== undefined) out[HEADER] = responseDecision.value;
      res.writeHead(status, out);
      // Important for SSE: flush headers and pipe incrementally; never buffer response bodies.
      res.flushHeaders();
      response.on('data', chunk => { responseBytes += chunk.length; });
      response.on('aborted', () => { log('upstream_aborted'); res.destroy(); });
      response.on('error', () => { log('upstream_stream_error'); res.destroy(); });
      response.pipe(res);
    });
    // No replay/retry, including on 429 or 5xx. A timeout can happen after acceptance.
    upstream.setTimeout(3600_000, () => upstream.destroy(new Error('Upstream idle timeout')));
    upstream.on('error', () => {
      status ||= 502;
      if (!res.headersSent && !res.destroyed) sendJSON(res, 502, { error: 'Sub2API connection failed; request was not retried' });
      else res.destroy();
      log('upstream_connection_error');
    });
    req.on('data', chunk => { requestBytes += chunk.length; });
    req.on('aborted', () => { upstream.destroy(); log('client_aborted'); });
    req.on('error', () => { upstream.destroy(); log('client_request_error'); });
    res.on('finish', () => { finished = true; log(); });
    res.on('close', () => { if (!finished) { upstream.destroy(); log('client_disconnected'); } });
    if (metadata.prefix) { requestBytes += metadata.prefix.length; upstream.write(metadata.prefix); metadata.prefix = null; }
    if (metadata.complete) upstream.end(); else req.pipe(upstream);
  });
  proxy.requestTimeout = 3600_000;
  proxy.on('connect', (_req, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); });
  proxy.on('connection', trackSocket);
  proxy.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  proxy.on('upgrade', (req, socket, head) => {
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const { eligible, currentMode, headers, decision } = prepare(req, true);
    const begin = performance.now();
    let recorded = false, handshakeSent = false;
    active++;
    const record = (status, responseDecision = null, error = undefined) => {
      if (recorded) return;
      recorded = true;
      if (eligible) journal.add({ kind: 'request', protocol: 'websocket', method: req.method, path: routeName(req.url),
        client: clientID(req), mode: currentMode, status, headersMs: Math.round(performance.now() - begin),
        requestStateLength: decision.incomingLength, forwardedStateLength: decision.outgoingLength,
        responseStateLength: responseDecision?.incomingLength ?? 0, returnedStateLength: responseDecision?.outgoingLength ?? 0,
        requestAction: decision.action, responseAction: responseDecision?.action ?? 'none', error });
    };
    socket.once('close', () => { active--; });
    const upstream = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers, agent: false });
    const timer = setTimeout(() => upstream.destroy(new Error('WebSocket handshake timeout')), 30_000);
    upstream.once('upgrade', (response, outgoing, upstreamHead) => {
      clearTimeout(timer); trackSocket(outgoing);
      const d = inspectState(response.headers[HEADER], currentMode, eligible);
      const out = cleanHeaders(response.headers, true);
      if (d.remove) delete out[HEADER];
      handshakeSent = true;
      writeSocketHeaders(socket, response, out);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) outgoing.write(head);
      record(101, d);
      // Frames are opaque and forwarded byte-for-byte. No model/turn inference here.
      socket.pipe(outgoing); outgoing.pipe(socket);
      socket.once('close', () => outgoing.destroy());
      outgoing.once('close', () => socket.destroy());
    });
    upstream.once('response', response => {
      clearTimeout(timer);
      const d = inspectState(response.headers[HEADER], currentMode, eligible), out = cleanHeaders(response.headers);
      if (d.remove) delete out[HEADER];
      out.connection = 'close';
      handshakeSent = true;
      writeSocketHeaders(socket, response, out);
      record(response.statusCode, d);
      response.on('error', () => socket.destroy());
      response.pipe(socket);
    });
    upstream.once('error', () => {
      clearTimeout(timer); record(502, null, 'websocket_handshake_error');
      if (handshakeSent) socket.destroy();
      else if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.once('close', () => { clearTimeout(timer); upstream.destroy(); record(499, null, 'client_disconnected'); });
    upstream.end();
  });

  function sessionFor(req) {
    const token = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('ts_session='))?.slice(11);
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
    return { ...session, token };
  }
  function securityHeaders(res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.setHeader('cache-control', 'no-store');
  }
  const admin = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const control = equalSecret(req.headers['x-turnstate-control'], config.controlToken);
      const allowedHosts = [new URL(config.adminOrigin).host, `127.0.0.1:${config.adminPort}`];
      if (!allowedHosts.includes(req.headers.host)) return sendJSON(res, 421, { error: 'Unrecognized Host' });
      const url = new URL(req.url, config.adminOrigin);
      if (url.pathname === '/api/health' && req.method === 'GET') return sendJSON(res, 200, health());
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && !control) {
        if (req.headers.origin !== config.adminOrigin || !String(req.headers['content-type'] || '').startsWith('application/json')) {
          return sendJSON(res, 403, { error: 'Origin or Content-Type rejected' });
        }
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        // Trust only the Nginx-overwritten single X-Real-IP on the loopback admin hop.
        const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').slice(0, 100);
        const now = Date.now(), bucket = failures.get(ip);
        if (loginBusy >= 4 || (bucket && bucket.until > now && bucket.count >= 5)) return sendJSON(res, 429, { error: 'Too many attempts; retry later' });
        const body = await readJSON(req);
        if (typeof body.password !== 'string' || body.password.length > 1024) return sendJSON(res, 400, { error: 'Invalid credentials' });
        if (loginBusy >= 4) return sendJSON(res, 429, { error: 'Too many concurrent attempts' });
        loginBusy++;
        let hashed;
        try { hashed = await derive(body.password, config.adminPassword.salt, 32); } finally { loginBusy--; }
        if (body.username !== config.adminUser || !equalSecret(hashed.toString('hex'), config.adminPassword.hash)) {
          if (failures.size > 1024) failures.clear();
          failures.set(ip, { count: bucket && bucket.until > now ? bucket.count + 1 : 1, until: now + 60_000 });
          journal.add({ kind: 'admin', action: 'login_failed' });
          await sleep(150);
          return sendJSON(res, 401, { error: 'Invalid username or password' });
        }
        failures.delete(ip);
        for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
        sessions.set(token, { expires: now + 8 * 3600_000, csrf });
        const secure = config.adminOrigin.startsWith('https:') ? '; Secure' : '';
        journal.add({ kind: 'admin', action: 'login_success' });
        return sendJSON(res, 200, { ok: true, csrf }, { 'set-cookie': `ts_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
      }
      const session = sessionFor(req);
      if (url.pathname.startsWith('/api/')) {
        if (!control && !session) return sendJSON(res, 401, { error: 'Login required' });
        if (mutation && !control && !equalSecret(req.headers['x-csrf-token'], session.csrf)) return sendJSON(res, 403, { error: 'CSRF token required' });
        if (url.pathname === '/api/status' && req.method === 'GET') return sendJSON(res, 200, {
          ...health(), mode, active, startedAt, counters: journal.total, droppedLogRecords: journal.dropped,
          target: config.target, csrf: session?.csrf, pinningSupported: true,
          notice: 'Pinning is an opt-in compatibility policy, not a validity check. Scope cannot identify internal Sub2API account switches. Refresh invalidates and waits for a real response. WebSocket model-unknown handshakes remain passthrough.'
        });
        if (url.pathname === '/api/records' && req.method === 'GET') {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const kind = url.searchParams.get('kind'), status = url.searchParams.get('status');
          const records = journal.recent.filter(r => (!kind || r.kind === kind) && (!status || String(r.status) === status)).slice(-limit).reverse();
          return sendJSON(res, 200, { records, retained: journal.recent.length });
        }
        if (url.pathname === '/api/mode' && req.method === 'POST') {
          const body = await readJSON(req);
          if (!MODES.includes(body.mode)) return sendJSON(res, 400, { error: 'Unknown mode' });
          if (['drop312','pin'].includes(body.mode) && body.acknowledgeExperimental !== true) return sendJSON(res, 400, { error: 'Experimental filter requires explicit acknowledgement' });
          setMode(body.mode); return sendJSON(res, 200, { ok: true, mode });
        }
        if (url.pathname === '/api/states' && req.method === 'GET') return sendJSON(res, 200, { ...states.snapshot(), mode });
        if (url.pathname === '/api/rules' && req.method === 'POST') {
          const body = await readJSON(req, 65536);
          if (body.acknowledgeExperimental !== true) return sendJSON(res, 400, { error: 'Model replay policies require acknowledgement' });
          states.configure(body.rules); journal.add({ kind: 'admin', action: 'rules_updated' });
          return sendJSON(res, 200, { ok: true, ...states.snapshot() });
        }
        if (url.pathname === '/api/pins/refresh' && req.method === 'POST') return sendJSON(res, 200, states.refresh(await readJSON(req)));
        if (url.pathname === '/api/pins/reveal' && req.method === 'POST') return sendJSON(res, 200, states.reveal((await readJSON(req)).id));
        if (url.pathname === '/api/pins/set' && req.method === 'POST') {
          const body = await readJSON(req, 16384);
          if (body.acknowledgeExperimental !== true) return sendJSON(res, 400, { error: 'Manual pin requires acknowledgement' });
          states.manual(body.id, body.state); return sendJSON(res, 200, { ok: true });
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          if (session) sessions.delete(session.token);
          return sendJSON(res, 200, { ok: true }, { 'set-cookie': 'ts_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }
        return sendJSON(res, 404, { error: 'Not found' });
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const file = files[url.pathname];
      if (req.method !== 'GET' || !file) return sendJSON(res, 404, { error: 'Not found' });
      res.setHeader('content-type', file[1]);
      fs.createReadStream(path.join(PUBLIC, file[0])).on('error', () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent && !res.destroyed) sendJSON(res, 400, { error: 'Invalid request or operation failed' }); }
  });
  admin.requestTimeout = 15_000; admin.headersTimeout = 10_000;
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, config.host, () => { server.removeListener('error', reject); resolve(); });
  });
  try { await listen(proxy, options.proxyPort ?? config.proxyPort); await listen(admin, options.adminPort ?? config.adminPort); }
  catch (e) { proxy.close(); admin.close(); agent.destroy(); throw e; }
  return { proxy, admin, journal, states, get mode() { return mode; }, setMode,
    async close(graceMs = 3000) {
      const timer = setTimeout(() => { for (const s of sockets) s.destroy(); proxy.closeAllConnections(); admin.closeAllConnections(); }, graceMs);
      timer.unref();
      await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => admin.close(resolve))]);
      clearTimeout(timer); agent.destroy(); states.flush(); await journal.flush();
    }
  };
}
