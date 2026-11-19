export type BundleProvider = "datahub" | "hubnet";

export function defaultNetworkType(provider: BundleProvider, network: string, category = "", subcategory = "", size = ""): string {
  const label = `${category} ${subcategory} ${size}`.toLowerCase();
  const normalizedNetwork = network.trim().toLowerCase();
  if (provider === "hubnet") {
    if (normalizedNetwork === "mtn") return "mtn-new-transaction";
    if (normalizedNetwork === "telecel") return "telecel-new-transaction";
    return /big[\s-]?time/.test(label) ? "big-time-new-transaction" : "at-new-transaction";
  }
  if (normalizedNetwork === "mtn") return /express|xpress/.test(label) ? "mtn_xpress" : "YELLO";
  if (normalizedNetwork === "telecel") return "TELECEL";
  return /big[\s-]?time/.test(label) ? "AT_BIGTIME" : "AT_PREMIUM";
}

export function resolveBundleRoute(
  plan: { network: string; category?: string | null; subcategory?: string | null; size?: string | null; delivery_provider?: string | null; delivery_network_type?: string | null },
  fallback: BundleProvider,
) {
  const provider: BundleProvider = plan.delivery_provider === "hubnet" || plan.delivery_provider === "datahub"
    ? plan.delivery_provider : fallback;
  const configuredType = plan.delivery_network_type?.trim() ?? "";
  const providerTypes = provider === "hubnet"
    ? new Set(["mtn-new-transaction", "telecel-new-transaction", "at-new-transaction", "big-time-new-transaction"])
    : new Set(["YELLO", "mtn_xpress", "TELECEL", "AT_PREMIUM", "AT_BIGTIME"]);
  // A plan can retain a network type from its previous delivery provider.
  // Never send an endpoint key from one provider to the other provider's API.
  const networkType = configuredType && providerTypes.has(configuredType)
    ? configuredType
    : defaultNetworkType(provider, plan.network, plan.category ?? "", plan.subcategory ?? "", plan.size ?? "");
  return { provider, networkType };
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
