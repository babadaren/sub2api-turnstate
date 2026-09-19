// A failed candidate is not a usable state. Retrying does not relax adoption checks.
// Only successful HTTP responses with a length/model miss are retryable.
export function retryableProbeResult(result) {
  return Number.isInteger(result?.status) && result.status >= 200 && result.status < 300 &&
    ['length_miss', 'model_mismatch'].includes(result.error);
}
export function validAttemptCount(value) {
  return Number.isSafeInteger(value) && value >= 1;
}
export function validRunSeconds(value, min = 5) {
  return Number.isInteger(value) && value >= min && value <= 3600;
}
export const MAX_RECENT_ATTEMPTS = 100;
