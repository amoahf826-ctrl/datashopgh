import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudDownload, FolderOpen, RefreshCw } from 'lucide-react';

type BuyerRow = { recipient_phone: string | null; bundle_id: string | null; status: string | null; payment_status: string | null; delivery_status: string | null; is_demo: boolean | null };

export default function HubnetNumberFolderAdmin({ client }: { client: SupabaseClient }) {
  const [phones, setPhones] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const orders: BuyerRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error: queryError } = await client
        .from('orders')
        .select('recipient_phone,bundle_id,status,payment_status,delivery_status,is_demo')
        .eq('payment_status', 'successful')
        .eq('is_demo', false)
        .order('created_at', { ascending: false })
        .range(offset, offset + 999);
      if (queryError) {
        setError(queryError.message);
        setPhones([]);
        setLoading(false);
        return;
      }
      const page = data ?? [];
      orders.push(...page as BuyerRow[]);
      if (page.length < 1000) break;
    }

    const bundleIds = [...new Set(orders.map(order => order.bundle_id).filter((id): id is string => Boolean(id)))];
    const networksByBundle = new Map<string, string>();
    for (let offset = 0; offset < bundleIds.length; offset += 500) {
      const { data, error: bundleError } = await client.from('bundles').select('id,network').in('id', bundleIds.slice(offset, offset + 500));
      if (bundleError) {
        setError(bundleError.message);
        setPhones([]);
        setLoading(false);
        return;
      }
      for (const bundle of data ?? []) networksByBundle.set(String(bundle.id), String(bundle.network ?? ''));
    }

    const numbers = new Set<string>();
    for (const order of orders) {
      const stage = String(order.delivery_status ?? order.status ?? '').toLowerCase();
      if (['failed', 'refunded', 'cancelled', 'canceled'].includes(stage)) continue;
      const network = networksByBundle.get(String(order.bundle_id ?? ''))?.trim().toLowerCase() ?? '';
      if (!network.startsWith('mtn') && !network.includes('xpress') && network !== 'yello') continue;
      const phone = String(order.recipient_phone ?? '').replace(/\D/g, '');
      if (/^0\d{9}$/.test(phone)) numbers.add(phone);
    }
    setPhones([...numbers].sort());
    setLoading(false);
  }, [client]);

  useEffect(() => { void load(); }, [load, refresh]);

  const updatedAt = useMemo(() => new Date().toLocaleString(), [loading, phones.length]);

  function download() {
    if (!phones.length) return;
    const contents = ['phone', ...phones].map(value => `"${value.replaceAll('"', '""')}"`).join('\r\n');
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hubnet-mtn-verification-numbers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return <section className="admin-card hubnet-number-folder">
    <div className="admin-card-heading">
      <div><h2><FolderOpen size={20}/> Hubnet MTN verification folder</h2><p>Unique recipient numbers from paid MTN and MTN Express bundle orders, ready for manual verification in Hubnet.</p></div>
      <span className="admin-config-badge">{loading ? 'Loading…' : `${phones.length} numbers`}</span>
    </div>
    <div className="hubnet-folder-toolbar">
      <div><b>{loading ? 'Gathering paid MTN recipients…' : `${phones.length} unique numbers`}</b><small>Excludes unpaid, demo, failed, refunded, and cancelled orders. Duplicate numbers appear once.</small></div>
      <div className="hubnet-folder-actions"><button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16}/> Refresh</button><button type="button" onClick={download} disabled={loading || phones.length === 0}><CloudDownload size={17}/> Download CSV</button></div>
    </div>
    {error ? <div className="admin-empty" role="alert">Could not load the MTN order numbers: {error}</div> : loading ? <div className="admin-empty">Loading paid MTN orders…</div> : phones.length ? <div className="hubnet-folder-content"><div className="hubnet-folder-meta"><FolderOpen size={18}/><b>MTN numbers</b><span>Updated {updatedAt}</span></div><ol>{phones.map(phone => <li key={phone}><code>{phone}</code></li>)}</ol></div> : <div className="admin-empty">No eligible paid MTN numbers found yet.</div>}
    <p className="hubnet-folder-note">This downloads a CSV file for you to upload or enter in Hubnet. Verification is still completed manually in Hubnet; downloading does not verify the numbers automatically.</p>
  </section>;
}
