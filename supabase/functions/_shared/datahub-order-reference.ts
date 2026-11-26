/** Extract the DataHub transaction identifier used by /api/external/order-status. */
export function dataHubOrderReference(payload: unknown): string | null {
  const queue = [{ value: payload, allowId: false }];
  const seen = new Set<object>();
  while (queue.length) {
    const { value, allowId } = queue.shift()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const candidate of [
      record.orderNumber, record.order_number, record.reference, record.transaction_id,
      record.tracking_id, record.transactionReference, ...(allowId ? [record.id] : []),
    ]) {
      if (typeof candidate !== "string" && typeof candidate !== "number") continue;
      const reference = String(candidate).trim();
      if (reference && reference.length <= 180) return reference;
    }
    for (const key of ["response", "data", "order", "result", "transaction", "transactions", "details"]) {
      const nested = record[key];
      const allowNestedId = key === "transaction" || key === "transactions";
      if (Array.isArray(nested)) {
        for (const item of nested) queue.push({ value: item, allowId: allowNestedId });
      } else if (nested && typeof nested === "object") {
        queue.push({ value: nested, allowId: allowNestedId });
      }
    }
  }
  return null;
}
