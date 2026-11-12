export type VoucherPurchase = { vouchers: Array<{ serial: string; pin: string; type?: string; price?: number; purchasedAt?: string }>; transactions: Array<Record<string, unknown>>; message: string };

export async function purchaseDataHubVouchers(apiKey: string, voucherType: "BECE" | "WASSCE", recipient: string, quantity: number, appOrigin?: string): Promise<{ ok: true; result: VoucherPurchase } | { ok: false; definite: boolean; message: string }> {
  try {
    const response = await fetch("https://user.datahubgh.com/api/external/voucher-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey, Accept: "application/json", ...(appOrigin ? { Origin: appOrigin, Referer: `${appOrigin}/` } : {}) },
      body: JSON.stringify({ VoucherType: voucherType, Recipient: recipient, Quantity: quantity }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) {
      const message = String(data?.error ?? data?.message ?? "DataHub could not complete the voucher purchase.").replace(/[<>\r\n]+/g, " ").slice(0, 240);
      return { ok: false, definite: response.status >= 400 && response.status < 500, message };
    }
    const vouchers = Array.isArray(data?.vouchers) ? data.vouchers : [];
    const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
    if (vouchers.length !== quantity || vouchers.some((voucher: any) => typeof voucher?.serial !== "string" || typeof voucher?.pin !== "string")) {
      return { ok: false, definite: false, message: "DataHub accepted the purchase but returned an unexpected voucher count. Contact support with your order reference." };
    }
    return { ok: true, result: { vouchers, transactions, message: String(data?.message ?? "Voucher purchase completed") } };
  } catch {
    return { ok: false, definite: false, message: "DataHub's response could not be confirmed. The order is being reviewed; do not retry it yet." };
  }
}
