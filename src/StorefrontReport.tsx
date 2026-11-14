import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Flag, X } from 'lucide-react';

export default function StorefrontReport({ client, agentReferralCode = '', orderId, initialPhone = '' }: {
  client: SupabaseClient | null; agentReferralCode?: string; orderId?: string; initialPhone?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(initialPhone);
  const [subject, setSubject] = useState(orderId ? 'Order issue' : 'Store support');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSuccess('');
    if (name.trim().length < 2 || !/^0\d{9}$/.test(phone.replace(/\D/g, '')) || message.trim().length < 10) {
      setError('Enter your name, a valid 10-digit Ghana phone number, and at least 10 characters describing the issue.'); return;
    }
    if (!client) { setError('Reports are unavailable right now. Please try again later.'); return; }
    setBusy(true);
    try {
      const { data, error: invokeError } = await client.functions.invoke('storefront-report-submit', { body: {
        reporter_name: name.trim(), reporter_phone: phone.replace(/\D/g, ''), subject, message: message.trim(),
        agent_referral_code: agentReferralCode || null, order_id: orderId || null,
      }});
      if (invokeError || !data?.success) { setError(data?.error || 'Your report could not be sent. Please try again.'); return; }
      setSuccess(data.message || 'Your report has been sent.'); setMessage('');
    } catch { setError('Your report could not be sent. Please try again.'); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="storefront-report-trigger" onClick={() => { setError(''); setSuccess(''); setOpen(true); }}><Flag size={16}/> Report an issue</button>
    {open && <div className="modal-backdrop storefront-report-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="modal storefront-report-modal" role="dialog" aria-modal="true" aria-labelledby="storefront-report-title">
        <button className="modal-close" type="button" onClick={() => setOpen(false)} aria-label="Close report form"><X size={19}/></button>
        <div className="eyebrow">CUSTOMER SUPPORT</div><h2 id="storefront-report-title">Report an issue</h2>
        <p className="modal-desc">{agentReferralCode ? 'Your report will go to this store’s agent, who can forward it to Admin.' : 'Your report will go to CheapDataBundle support.'}</p>
        {success ? <div className="storefront-report-success" role="status">{success}</div> : <form onSubmit={event => void submit(event)}>
          <label className="field-label">Your name</label><input className="form-input" autoComplete="name" maxLength={100} value={name} onChange={event => setName(event.target.value)} required/>
          <label className="field-label">Phone number</label><input className="form-input" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))} required/>
          <label className="field-label">Issue type</label><select className="form-input" value={subject} onChange={event => setSubject(event.target.value)}><option>Order issue</option><option>Payment issue</option><option>Data delivery</option><option>Store support</option><option>Other</option></select>
          <label className="field-label">What happened?</label><textarea className="form-input storefront-report-textarea" minLength={10} maxLength={2000} rows={5} value={message} onChange={event => setMessage(event.target.value)} placeholder="Describe the issue and include an order reference if available." required/>
          {error && <p className="storefront-report-error" role="alert">{error}</p>}
          <button className="primary modal-primary" disabled={busy}>{busy ? 'Sending report…' : 'Send report'}</button>
        </form>}
        {success && <button className="primary modal-primary" type="button" onClick={() => setOpen(false)}>Done</button>}
      </section>
    </div>}
  </>;
}
