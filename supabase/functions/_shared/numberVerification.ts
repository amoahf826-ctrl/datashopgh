type VerificationStatus = 'verified' | 'unverified' | 'queued' | 'invalid';
type VerificationResult = { status: VerificationStatus; provider: 'datahub' | 'hubnet' } | { status: 'not_required' } | { error: string };

function providerText(payload: any): string {
  try { return JSON.stringify(payload).toLowerCase(); } catch { return ''; }
}

async function readPayload(response: Response): Promise<any> {
  const body = await response.text().catch(() => '');
  try { return JSON.parse(body); } catch { return { message: body }; }
}

function providerSaysUnverified(payload: any): boolean {
  const text = providerText(payload);
  return payload?.data?.verified === false || payload?.data?.exists === false ||
    payload?.response?.data?.verified === false || payload?.response?.data?.exists === false ||
    /unverified|not[_\s-]?verified|not added.{0,60}beneficiar|not on.{0,60}beneficiar|new beneficiar.{0,60}detected|orders?.{0,60}(?:blocked|currently blocked)|beneficiar.{0,80}(?:blocked|not on)|please use a verified number/i.test(text);
}

export async function verifyConfiguredNumber(service: any, phone: string, network?: string): Promise<VerificationResult> {
  // The configured verification integrations currently verify MTN numbers only.
  // Do not send Telecel/AT recipients to an MTN-only endpoint and block checkout.
  if (network && !/\bmtn\b/i.test(network)) return { status: 'not_required' };
  const { data: setting, error: settingError } = await service.from('platform_settings')
    .select('value').eq('key', 'number_verification_provider').maybeSingle();
  if (settingError) return { error: 'Could not load the number verification service.' };
  const provider = setting?.value?.provider === 'hubnet' ? 'hubnet' : 'datahub';

  try {
    if (provider === 'datahub') {
      const apiKey = Deno.env.get('DATAHUB_API_KEY')?.trim();
      if (!apiKey) return { error: 'Number verification is temporarily unavailable.' };
      const response = await fetch('https://user.datahubgh.com/api/external/purchases/verify-number', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, Accept: 'application/json' },
        body: JSON.stringify({ phone, is_ported_number: true }), signal: AbortSignal.timeout(20000),
      });
      const payload = await readPayload(response);
      const envelope = payload?.response ?? payload;
      const data = envelope?.data ?? payload?.data ?? {};
      const status = String(data?.verification_status ?? data?.status ?? '').toLowerCase();
      if (providerSaysUnverified(payload)) return { status: 'unverified', provider };
      if (response.ok && (payload?.success === true || envelope?.success === true) &&
          (data?.verified === true || data?.exists === true || status === 'verified')) return { status: 'verified', provider };
      if ((response.ok || response.status === 400) && ['unverified', 'not_verified'].includes(status)) return { status: 'unverified', provider };
      if ((response.ok || response.status === 400) && ['invalid', 'queued'].includes(status)) return { status: status as 'invalid' | 'queued', provider };
      if (response.status === 400 && payload?.success === false) return { status: 'invalid', provider };
      return { error: 'Number verification is temporarily unavailable. Please try again.' };
    }

    const token = Deno.env.get('HUBNET_BEARER_TOKEN')?.trim();
    const apiBase = Deno.env.get('HUBNET_API_BASE_URL')?.trim().replace(/\/+$/, '');
    if (!token || !apiBase) return { error: 'Number verification is temporarily unavailable.' };
    const base = new URL(apiBase);
    if (base.protocol !== 'https:' || base.hostname !== 'console.hubnet.app' || base.username || base.password || base.search || base.hash) return { error: 'Number verification is temporarily unavailable.' };
    const endpoint = new URL(`${apiBase}/live/api/context/business/transaction/mtn-verification`);
    endpoint.searchParams.set('number', phone);
    const response = await fetch(endpoint, { method: 'GET', headers: { token: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const payload = await readPayload(response);
    const envelope = payload?.response ?? payload;
    const data = envelope?.data ?? payload?.data;
    const status = String(data?.verification_status ?? data?.status ?? '').toLowerCase();
    const ok = envelope?.status === true || envelope?.status === 'success' || payload?.status === true || payload?.status === 'success';
    if (providerSaysUnverified(payload) || status === 'unverified' || status === 'not_verified') return { status: 'unverified', provider };
    if (!response.ok || !ok || !['verified', 'unverified', 'queued', 'invalid'].includes(status)) return { error: 'Number verification is temporarily unavailable. Please try again.' };
    return { status: status as VerificationStatus, provider };
  } catch {
    return { error: 'Number verification is temporarily unavailable. Please try again.' };
  }
}
