import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyConfiguredNumber } from "../_shared/numberVerification.ts";

type Bundle = { id: string; network: string; size: string; price: number; category?: string | null; subcategory?: string | null; delivery_provider?: string | null };
const textResponse = (text: string, end = false) => new Response(`${end ? "END" : "CON"} ${text}`, {
  status: 200,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
});

function serviceKey(): string | undefined {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, unknown>;
    if (typeof keys.default === "string") return keys.default;
    const first = Object.values(keys).find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  } catch { return undefined; }
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value ?? "")]));
  }
  const form = new URLSearchParams(await request.text());
  return Object.fromEntries(form.entries());
}

async function sessionIds(sessionId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId)));
  const hash = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return {
    uuid: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    payment: `DSGH-${hash.slice(0, 32)}`,
    delivery: `DS${hash.slice(0, 23)}`,
    email: `ussd-${hash.slice(0, 24)}@checkout.cheapdatabundle.com`,
  };
}

function menuText(bundles: Bundle[]): string {
  const networks = ["MTN", "Telecel", "AT"].filter((network) => bundles.some((bundle) => bundle.network === network));
  return `CheapDataBundle\n${networks.map((network, index) => `${index + 1}. ${network}`).join("\n")}\n0. Cancel`;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return textResponse("USSD service is ready. Please dial the code from your phone.", true);
  let input: Record<string, string>;
  try { input = await readForm(request); } catch { return textResponse("Invalid request. Please try again.", true); }
  const sessionId = (input.sessionId ?? "").trim();
  const phoneNumber = (input.phoneNumber ?? "").trim();
  const path = (input.text ?? "").trim();
  if (!sessionId || sessionId.length > 128 || !phoneNumber || phoneNumber.length > 32 || path.length > 256) {
    return textResponse("Could not read this USSD session. Please dial again.", true);
  }
  if (path === "") return textResponse("Welcome to CheapDataBundle\n1. Buy data bundles\n0. Cancel");
  const steps = path.split("*");
  if (steps[0] !== "1") return textResponse("Thank you for using CheapDataBundle.", true);
  if (steps.length === 1) return textResponse("Choose network:\n1. MTN\n2. Telecel\n3. AT\n0. Cancel");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const key = serviceKey();
  const paystackKey = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();
  if (!supabaseUrl || !key || !paystackKey?.startsWith("sk_live_")) {
    return textResponse("USSD purchases are temporarily unavailable. Please use cheapdatabundle.com.", true);
  }
  const service = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: sales } = await service.from("platform_settings").select("value").eq("key", "storefront_live_sales").maybeSingle();
  if (sales?.value?.enabled !== true) return textResponse("Data sales are temporarily unavailable. Please try again later.", true);
  const { data: providerSetting } = await service.from("platform_settings").select("value").eq("key", "active_bundle_provider").maybeSingle();
  const enabled = providerSetting?.value?.enabled ?? {};
  const { data: activeNetworks } = await service.from("networks").select("id").eq("is_active", true);
  if (!activeNetworks?.length) return textResponse("Data sales are temporarily unavailable. Please try again later.", true);
  const { data: rows, error: bundleError } = await service.from("bundles")
    .select("id,network,size,price,category,subcategory,delivery_provider,is_demo")
    .in("network", activeNetworks.map((row: { id: string }) => row.id))
    .eq("is_active", true).eq("is_demo", false).order("network").order("size");
  if (bundleError || !rows) return textResponse("Could not load data bundles. Please try again later.", true);
  const bundles = (rows as Bundle[]).filter((bundle) => {
    const routedProvider = providerSetting?.value?.provider === "hubnet" ? "hubnet" : "datahub";
    return enabled[bundleProvider(bundle, routedProvider)] !== false;
  });
  const networks = ["MTN", "Telecel", "AT"].filter((network) => bundles.some((bundle) => bundle.network === network));
  const network = networks[Number(steps[1]) - 1];
  if (!network) return textResponse(menuText(bundles));
  const plans = bundles.filter((bundle) => bundle.network === network);
  if (steps.length === 2) {
    const visible = plans.slice(0, 7);
    const { data: mainPrices } = await service.from("main_storefront_bundle_prices").select("bundle_id,customer_price")
      .in("bundle_id", visible.map((bundle) => bundle.id));
    const priceById = new Map((mainPrices ?? []).map((row: { bundle_id: string; customer_price: number }) => [row.bundle_id, Number(row.customer_price)]));
    return textResponse(`Choose ${network} bundle:\n${visible.map((bundle, index) => `${index + 1}. ${bundle.size} - GHS ${(priceById.get(bundle.id) ?? Number(bundle.price)).toFixed(2)}`).join("\n")}\n0. Cancel`);
  }
  const plan = plans[Number(steps[2]) - 1];
  if (!plan) return textResponse(`Choose a valid ${network} bundle. Dial again to restart.`, true);
  if (steps.length === 3) return textResponse(`Enter the recipient's 10-digit Ghana phone number (e.g. 0241234567):`);
  const recipient = steps[3];
  if (!/^0\d{9}$/.test(recipient ?? "")) return textResponse("Invalid number. Enter 10 digits starting with 0:");
  if (steps.length === 4) return textResponse("Choose the MoMo network to pay from:\n1. MTN MoMo\n2. AT Money\n3. Telecel Cash\n0. Cancel");
  const payNetworks = ["mtn", "atl", "vod"];
  const momoProvider = payNetworks[Number(steps[4]) - 1];
  if (!momoProvider) return textResponse("Choose a valid MoMo network:\n1. MTN MoMo\n2. AT Money\n3. Telecel Cash\n0. Cancel");
  if (steps.length === 5) return textResponse("Enter the 10-digit phone number that will approve the MoMo payment:");
  const payer = steps[5];
  if (!/^0\d{9}$/.test(payer ?? "")) return textResponse("Invalid MoMo number. Enter 10 digits starting with 0:");

  const verification = await verifyConfiguredNumber(service, recipient);
  if ("error" in verification) return textResponse("Number verification is temporarily unavailable. No payment was started. Please use the website or try later.", true);
  if (verification.status !== "verified") return textResponse("Phone Number is Not Verified. You can't buy Data Now. Check again Next Week until your Number is Verified.", true);
  const routedProvider = providerSetting?.value?.provider === "hubnet" ? "hubnet" : "datahub";
  const planProvider = bundleProvider(plan, routedProvider);
  if (enabled[planProvider] === false) return textResponse("This data service is temporarily unavailable.", true);

  const { data: feeSetting, error: feeError } = await service.from("platform_settings").select("value").eq("key", "paystack_fee_recovery").maybeSingle();
  if (feeError) return textResponse("Could not prepare payment. Please try again later.", true);
  const rate = feeSetting?.value?.enabled === true ? Number(feeSetting.value.rate_percent) : 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 10) return textResponse("Payment settings are unavailable. Please use the website.", true);

  const ids = await sessionIds(sessionId);
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? `ussd:${sessionId}`;
  const { data: order, error: orderError } = await service.rpc("create_guest_live_checkout_order", {
    p_email: ids.email, p_bundle_id: plan.id, p_recipient_phone: recipient, p_idempotency_key: ids.uuid,
    p_payment_reference: ids.payment, p_delivery_reference: ids.delivery, p_agent_referral_code: null, p_client_ip: ip,
  });
  if (orderError || !order || order.rate_limited) return textResponse("Could not start this order. Please try again or use cheapdatabundle.com.", true);
  if (order.payment_status === "successful") return textResponse("This USSD session has already been paid. Check your order status on cheapdatabundle.com.", true);
  const baseCents = Math.round(Number(order.price) * 100);
  const feeCents = Math.round(baseCents * rate / 100);
  const chargeCents = baseCents + feeCents;
  if (!Number.isSafeInteger(chargeCents) || chargeCents < 100 || chargeCents > 1000000) return textResponse("This bundle cannot be paid for through USSD. Please use the website.", true);
  const { error: prepareError } = await service.rpc("prepare_paystack_order_charge", {
    p_order_id: order.id, p_fee_amount: feeCents / 100, p_charge_amount: chargeCents / 100,
  });
  if (prepareError) return textResponse("Could not prepare payment. Please restart your order.", true);

  try {
    const chargeResponse = await fetch("https://api.paystack.co/charge", {
      method: "POST", headers: { Authorization: `Bearer ${paystackKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: ids.email, amount: chargeCents, currency: "GHS", reference: ids.payment,
        mobile_money: { phone: payer, provider: momoProvider }, metadata: { order_id: order.id, source: "africastalking_ussd", delivery_reference: ids.delivery } }),
      signal: AbortSignal.timeout(18000),
    });
    const result = await chargeResponse.json().catch(() => null);
    if (!chargeResponse.ok || result?.status !== true) {
      await service.from("orders").update({ status: "failed", payment_status: "failed", delivery_status: "not_started" })
        .eq("id", order.id).eq("payment_status", "unpaid");
      return textResponse("Paystack could not start the MoMo payment. No payment was taken. Please try again.", true);
    }
    const message = String(result?.data?.display_text ?? "Approve the payment prompt on your phone.").replace(/[<>\r\n]+/g, " ").slice(0, 150);
    return textResponse(`${message} GHS ${(chargeCents / 100).toFixed(2)} requested. Your data will be sent after Paystack confirms payment.`, true);
  } catch {
    return textResponse("Payment status is not yet confirmed. Check your MoMo phone and do not submit again. Check order status on cheapdatabundle.com.", true);
  }
});

function bundleProvider(bundle: Bundle & { delivery_provider?: string | null }, fallback: string): string {
  return bundle.delivery_provider === "hubnet" || bundle.delivery_provider === "datahub" ? bundle.delivery_provider : fallback;
}
