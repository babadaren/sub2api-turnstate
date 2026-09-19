const DEFAULT_PAGE_SIZE = 20;

function positiveInteger(params, name, fallback) {
  if (!params.has(name)) return fallback;
  const raw = params.get(name);
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    const error = new Error(`${name} must be a positive integer.`);
    error.code = 'invalid_pagination';
    throw error;
  }
  return value;
}

// Browse the existing bounded recent log, not arbitrary filesystem paths.
// An anchor fixes the newest entry while paging so incoming events do not
// shift older pages. Ring-buffer expiry is reported instead of silently jumping.
export function recordsPage(recent, params = new URLSearchParams(), retentionLimit = recent.length) {
  const requestedPage = positiveInteger(params, 'page', 1);
  const pageSize = Math.min(200, positiveInteger(params, 'limit', DEFAULT_PAGE_SIZE));
  let end = recent.length;
  const anchor = params.get('anchor');
  if (anchor) {
    if (!/^[\w-]{1,128}$/.test(anchor)) {
      const error = new Error('Invalid record anchor.');
      error.code = 'invalid_pagination';
      throw error;
    }
    const index = recent.findIndex(record => record.id === anchor);
    if (index < 0) {
      const error = new Error('Record snapshot expired; return to the latest page.');
      error.code = 'records_snapshot_expired';
      throw error;
    }
    end = index + 1;
  }
  const kind = params.get('kind'), status = params.get('status');
  const matching = recent.slice(0, end).filter(record =>
    (!kind || record.kind === kind) && (!status || String(record.status) === status)
  ).reverse();
  const total = matching.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const records = matching.slice(start, start + pageSize);
  return { records, page, pageSize, total, totalPages,
    hasPrevious: page > 1, hasNext: page < totalPages,
    rangeStart: total ? start + 1 : 0, rangeEnd: start + records.length,
    anchor: end ? recent[end - 1].id : null,
    retained: recent.length, retentionLimit };
}
