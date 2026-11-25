/** Extract the DataHub transaction identifier used by /api/external/order-status. */
export function dataHubOrderReference(payload: any): string | null {
  const envelope = payload?.response ?? payload;
  const data = envelope?.data ?? payload?.data ?? envelope ?? {};
  const transaction = (Array.isArray(data?.transactions) ? data.transactions[0] : null) ??
    (Array.isArray(envelope?.transactions) ? envelope.transactions[0] : null) ??
    (Array.isArray(payload?.transactions) ? payload.transactions[0] : null) ?? {};
  const value = data?.orderNumber ?? data?.order_number ?? data?.reference ?? data?.transaction_id ??
    data?.tracking_id ?? data?.transactionReference ?? transaction?.orderNumber ?? transaction?.order_number ??
    transaction?.reference ?? transaction?.transaction_id ?? transaction?.id;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const reference = String(value).trim();
  return reference && reference.length <= 180 ? reference : null;
}
