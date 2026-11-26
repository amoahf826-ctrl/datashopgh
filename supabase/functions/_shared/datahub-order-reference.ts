/** Extract the DataHub transaction identifier used by /api/external/order-status. */
export function dataHubOrderReference(payload: unknown): string | null {
  const queue = [{ value: payload, allowId: false, depth: 0 }];
  const seen = new Set<object>();
  const candidates: Array<{ value: string; rank: number; depth: number; order: number }> = [];
  let order = 0;
  while (queue.length) {
    const { value, allowId, depth } = queue.shift()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const fields: Array<[unknown, number]> = [
      [record.orderNumber, 0], [record.order_number, 1], [record.reference, 2],
      [record.transaction_id, 3], [record.tracking_id, 4], [record.transactionReference, 5],
      ...(allowId ? [[record.id, 6] as [unknown, number]] : []),
    ];
    for (const [candidate, rank] of fields) {
      if (typeof candidate !== "string" && typeof candidate !== "number") continue;
      const reference = String(candidate).trim();
      if (reference && reference.length <= 180) candidates.push({ value: reference, rank, depth, order: order++ });
    }
    for (const key of ["response", "data", "order", "result", "transaction", "transactions", "details"]) {
      const nested = record[key];
      const allowNestedId = key === "transaction" || key === "transactions";
      if (Array.isArray(nested)) {
        for (const item of nested) queue.push({ value: item, allowId: allowNestedId, depth: depth + 1 });
      } else if (nested && typeof nested === "object") {
        queue.push({ value: nested, allowId: allowNestedId, depth: depth + 1 });
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || b.depth - a.depth || a.order - b.order);
  return candidates[0]?.value ?? null;
}
