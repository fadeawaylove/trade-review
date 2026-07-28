export const LEDGER_PAGE_SIZE = 10;

export function paginateLedgerRows(rows, requestedPage = 1, pageSize = LEDGER_PAGE_SIZE) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : LEDGER_PAGE_SIZE;
  const totalItems = safeRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const parsedPage = Number.isFinite(Number(requestedPage)) ? Math.floor(Number(requestedPage)) : 1;
  const page = Math.min(totalPages, Math.max(1, parsedPage));
  const offset = (page - 1) * safePageSize;
  const items = safeRows.slice(offset, offset + safePageSize);

  return {
    items,
    page,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    rangeStart: totalItems ? offset + 1 : 0,
    rangeEnd: totalItems ? offset + items.length : 0,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}
