// Deliberately no cross-request pin/replay. The ingress cannot prove the
// selected Sub2API account, authentication generation, or logical turn.
export const HEADER = 'x-codex-turn-state';
export function inspectState(value, mode, eligible = true) {
  const state = Array.isArray(value) ? value.join(', ') : (value ?? '');
  const length = Buffer.byteLength(state);
  if (!eligible || mode === 'off') return { incomingLength: length, outgoingLength: length, action: 'bypass', remove: false };
  if (mode === 'drop312' && length === 312) return { incomingLength: length, outgoingLength: 0, action: 'drop312', remove: true };
  return { incomingLength: length, outgoingLength: length, action: mode === 'observe' ? 'observe' : 'keep', remove: false };
}
export function routeName(rawUrl) {
  const pathname = String(rawUrl || '').split('?')[0];
  if (/^\/v1\/responses(?:\/|$)/.test(pathname)) return pathname === '/v1/responses/compact' ? '/v1/responses/compact' : '/v1/responses';
  return null;
}
export function cleanHeaders(headers, upgrade = false) {
  const result = { ...headers };
  const connectionTokens = String(headers.connection || '').split(',').map(v => v.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-turnstate-control', ...connectionTokens]) delete result[name];
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}
