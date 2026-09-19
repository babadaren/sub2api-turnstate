'use strict';

// Small dependency-free controller shared by the console and its UI tests.
// Only page one is live. Other pages keep a fixed anchor and their current rows.
function createRecordsPager({ fetchPage, render, onError }) {
  let revision = 0;
  let state = { page: 1, totalPages: 1, total: 0, pageSize: 20, anchor: null,
    rangeStart: 0, rangeEnd: 0, hasPrevious: false, hasNext: false,
    loading: false, live: true, hasData: false };
  const snapshot = () => ({ ...state });
  async function load(page, live, allowRecovery = true) {
    if (state.loading) return;
    const run = ++revision;
    const previous = snapshot();
    state.loading = true;
    render(null, snapshot());
    const query = new URLSearchParams({ page: String(page), limit: '20' });
    if (!live && state.anchor) query.set('anchor', state.anchor);
    try {
      const data = await fetchPage('/api/records?' + query);
      if (run !== revision) return;
      const { records, ...pagination } = data;
      state = { ...state, ...pagination, live, loading: false, hasData: true };
      render(records, snapshot());
    } catch (error) {
      if (run !== revision) return;
      state = { ...previous, loading: false };
      if (allowRecovery && error.code === 'records_snapshot_expired') {
        state.anchor = null;
        onError(new Error('历史记录已超出保留范围，已返回最新一页。'));
        await load(1, true, false);
        return;
      }
      onError(error);
    } finally {
      if (run === revision) { state.loading = false; render(null, snapshot()); }
    }
  }
  return {
    snapshot,
    refresh: () => state.live ? load(1, true) : Promise.resolve(),
    latest: () => load(1, true),
    next: () => state.hasNext ? load(state.page + 1, false) : Promise.resolve(),
    previous: () => state.hasPrevious ? load(state.page - 1, state.page === 2) : Promise.resolve(),
    go: page => Number.isSafeInteger(page) && page >= 1 && page <= state.totalPages
      ? load(page, page === 1) : Promise.resolve(),
    reset: () => {
      revision++;
      state = { page: 1, totalPages: 1, total: 0, pageSize: 20, anchor: null,
        rangeStart: 0, rangeEnd: 0, hasPrevious: false, hasNext: false,
        loading: false, live: true, hasData: false };
      render([], snapshot());
    }
  };
}
