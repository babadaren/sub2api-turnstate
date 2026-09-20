// Local compatibility policy, not an exhaustive provider error catalogue.
// Free-form error messages and arbitrary error-field values are never logged.
const STATE_CODES = new Set([
  'invalid_turn_state', 'turn_state_invalid', 'turn_state_expired', 'expired_turn_state',
  'invalid_codex_turn_state', 'codex_turn_state_expired', 'invalid_x_codex_turn_state'
]);
const CODES = new Set([...STATE_CODES,
  'server_error', 'internal_server_error', 'rate_limit_exceeded', 'insufficient_quota',
  'context_length_exceeded', 'invalid_request_error', 'invalid_value', 'invalid_parameter',
  'invalid_argument', 'expired', 'content_filter', 'model_not_found', 'invalid_api_key',
  'authentication_error', 'permission_denied', 'overloaded', 'timeout', 'cancelled'
]);
const TYPES = new Set(['server_error', 'invalid_request_error', 'authentication_error',
  'permission_error', 'rate_limit_error', 'insufficient_quota', 'api_error']);
const PARAMS = new Set(['x-codex-turn-state', 'x_codex_turn_state', 'codex_turn_state', 'turn_state']);
const INVALID_VALUE_CODES = new Set(['invalid_request_error', 'invalid_value', 'invalid_parameter', 'invalid_argument', 'expired']);
const INCOMPLETE = new Set(['max_output_tokens', 'content_filter', 'context_length_exceeded', 'cancelled', 'server_error']);
const REASONS = new Set(['http_401', 'http_403', 'response_model_conflict', 'response_model_mismatch', 'explicit_turn_state_error']);
function member(value, allowed) {
  if (typeof value !== 'string' || !value) return null;
  return allowed.has(value.toLowerCase()) ? value.toLowerCase() : 'other';
}
export const safeErrorCode = value => member(value, CODES);
export const safeErrorType = value => member(value, TYPES);
export const safeErrorParam = value => member(value, PARAMS);
export const safeIncompleteReason = value => member(value, INCOMPLETE);
export const safeInvalidationReason = value => REASONS.has(value) ? value : 'unspecified';

export function errorEvidence(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = safeErrorCode(error.code), type = safeErrorType(error.type), param = safeErrorParam(error.param);
  const stateRejected = STATE_CODES.has(code) || (PARAMS.has(param) && INVALID_VALUE_CODES.has(code || type));
  return { code, type, param, stateRejected };
}

export function pinInvalidationReason(status, meta, requestedModel) {
  // Keep existing conservative authentication isolation. A generic 409 is NOT
  // evidence of an invalid state: it needs the structured state error below.
  if (status === 401 || status === 403) return 'http_' + status;
  // Model aliases / grey routing are observed, not grounds for invalidation in
  // length-based mode. Do not rewrite the actual response model to hide them.
  if (meta?.stateRejected) return 'explicit_turn_state_error';
  return null; // Ordinary generation/SSE failures do not revoke a valid pin.
}
