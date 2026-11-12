export type BundleProvider = "datahub" | "hubnet";

export function defaultNetworkType(provider: BundleProvider, network: string, category = "", subcategory = ""): string {
  const label = `${category} ${subcategory}`.toLowerCase();
  if (provider === "hubnet") {
    if (network === "MTN") return "mtn-new-transaction";
    if (network === "Telecel") return "telecel-new-transaction";
    return /big[\s-]?time/.test(label) ? "big-time-new-transaction" : "at-new-transaction";
  }
  if (network === "MTN") return /express|xpress/.test(label) ? "mtn_xpress" : "YELLO";
  if (network === "Telecel") return "TELECEL";
  return /big[\s-]?time/.test(label) ? "AT_BIGTIME" : "AT_PREMIUM";
}

export function resolveBundleRoute(
  plan: { network: string; category?: string | null; subcategory?: string | null; delivery_provider?: string | null; delivery_network_type?: string | null },
  fallback: BundleProvider,
) {
  const provider: BundleProvider = plan.delivery_provider === "hubnet" || plan.delivery_provider === "datahub"
    ? plan.delivery_provider : fallback;
  return {
    provider,
    networkType: plan.delivery_network_type?.trim() || defaultNetworkType(provider, plan.network, plan.category ?? "", plan.subcategory ?? ""),
  };
}

export function hubnetPath(networkType: string): string {
  const allowed = new Set(["mtn-new-transaction", "telecel-new-transaction", "at-new-transaction", "big-time-new-transaction"]);
  if (!allowed.has(networkType)) throw new Error("Unknown Hubnet network type configured for this plan.");
  return networkType;
}

export function dataHubNetworkKey(networkType: string): string {
  const allowed = new Set(["YELLO", "mtn_xpress", "TELECEL", "AT_PREMIUM", "AT_BIGTIME"]);
  if (!allowed.has(networkType)) throw new Error("Unknown DataHub network type configured for this plan.");
  return networkType;
}
