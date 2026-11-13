import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Radio, RefreshCw, Save } from 'lucide-react';

type AirtimeNetwork = 'MTN' | 'AT' | 'Telecel';
type AirtimePrice = { network: AirtimeNetwork; main_markup_percent: string; agent_markup_percent: string };
const networks: Array<{ id: AirtimeNetwork; title: string; label: string }> = [
  { id: 'MTN', title: 'MTN Airtime', label: 'MTN' },
  { id: 'AT', title: 'Tigo Airtime', label: 'Tigo' },
  { id: 'Telecel', title: 'Telecel Airtime', label: 'Telecel' },
];

export default function AirtimeAdmin({ client, notify }: { client: SupabaseClient; notify: (message: string) => void }) {
  const [prices, setPrices] = useState<Record<AirtimeNetwork, AirtimePrice>>({
    MTN: { network: 'MTN', main_markup_percent: '0', agent_markup_percent: '0' },
    AT: { network: 'AT', main_markup_percent: '0', agent_markup_percent: '0' },
    Telecel: { network: 'Telecel', main_markup_percent: '0', agent_markup_percent: '0' },
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await client.rpc('get_airtime_pricing');
    setLoading(false);
    if (error) {
      notify('Airtime price settings could not load. Apply migration 202611130002_airtime_price_settings.sql.');
      return;
    }
    setPrices(current => {
      const next = { ...current };
      for (const row of data ?? []) {
        const network = row.network as AirtimeNetwork;
        if (network in next) next[network] = { network, main_markup_percent: String(row.main_markup_percent), agent_markup_percent: String(row.agent_markup_percent) };
      }
      return next;
    });
  }
  useEffect(() => { void load(); }, [client]);

  function update(network: AirtimeNetwork, field: 'main_markup_percent' | 'agent_markup_percent', value: string) {
    setPrices(current => ({ ...current, [network]: { ...current[network], [field]: value } }));
  }
  async function save() {
    const payload = networks.map(({ id }) => {
      const row = prices[id];
      return { network: row.network, main_markup_percent: Number(row.main_markup_percent), agent_markup_percent: Number(row.agent_markup_percent) };
    });
    if (payload.some(row => [row.main_markup_percent, row.agent_markup_percent].some(value => !Number.isFinite(value) || value < 0 || value > 100))) {
      notify('Set each airtime markup from 0% to 100%.');
      return;
    }
    setSaving(true);
    const { error } = await client.rpc('admin_save_airtime_prices', { p_prices: payload });
    setSaving(false);
    if (error) {
      notify(`Airtime prices could not be saved: ${error.message}`);
      return;
    }
    notify('Main storefront and agent airtime prices saved.');
    await load();
  }

  return <div className="airtime-admin-page">
    <section className="admin-card">
      <div className="admin-card-heading">
        <div><h2>Airtime price settings</h2><p>Set the default markup for the main storefront and for agent stores. Agents may set a different markup for each network.</p></div>
        <button className="admin-refresh-button" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button>
      </div>
      <div className="airtime-admin-note"><Radio size={17}/><span>Markup is added to the airtime face value. For example, GHS 10 at 5% markup displays as GHS 10.50. Airtime delivery is not connected yet, so these settings provide price estimates only.</span></div>
      <div className="airtime-admin-grid">{networks.map(({ id, title }) => <article key={id}>
        <h3>{title}</h3>
        <label>Main storefront markup (%)<input type="number" min="0" max="100" step="0.01" value={prices[id].main_markup_percent} onChange={event => update(id, 'main_markup_percent', event.target.value)}/></label>
        <label>Default agent storefront markup (%)<input type="number" min="0" max="100" step="0.01" value={prices[id].agent_markup_percent} onChange={event => update(id, 'agent_markup_percent', event.target.value)}/></label>
      </article>)}</div>
      <button className="admin-save-button" type="button" disabled={loading || saving} onClick={() => void save()}><Save size={15}/>{saving ? 'Saving…' : 'Save airtime prices'}</button>
    </section>
  </div>;
}
