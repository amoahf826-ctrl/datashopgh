import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MessageSquareWarning, Send, X } from 'lucide-react';

type OrderInfo = { phone: string; bundle: string; network: string; createdAt: string };
type ComplaintStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

const statusLabels: Record<ComplaintStatus, string> = {
  open: 'Open',
  in_progress: 'Under review',
  resolved: 'Solved',
  closed: 'Closed',
};

const complaintText = (order: OrderInfo, note: string) => {
  const date = new Date(order.createdAt);
  const dateText = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  const timeText = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `NOT RECEIVED ORDER\n1. Recipient Number : ${order.phone}\n2. Data Size: ${order.bundle}\n3. Time: ${timeText}\n4. Date: ${dateText}\n5. Network: ${order.network}${note.trim() ? `\n\nAdditional details: ${note.trim()}` : ''}`;
};

export default function OrderComplaintAction({ client, userId, orderId, delivered, order }: {
  client: SupabaseClient | null;
  userId: string;
  orderId: string;
  delivered: boolean;
  order: OrderInfo;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [complaintStatus, setComplaintStatus] = useState<ComplaintStatus | null>(null);

  useEffect(() => {
    let active = true;
    if (!client || !userId || !orderId || !delivered) return () => { active = false; };
    void client.from('order_complaints').select('status').eq('order_id', orderId).eq('user_id', userId).maybeSingle()
      .then(({ data }) => {
        if (active && data?.status && data.status in statusLabels) setComplaintStatus(data.status as ComplaintStatus);
      });
    return () => { active = false; };
  }, [client, userId, orderId, delivered]);

  if (!delivered || !orderId || !client) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice('');
    try {
      const { error } = await client!.from('order_complaints').insert({
        order_id: orderId,
        user_id: userId,
        message: complaintText(order, message),
      });
      if (error) {
        if (error.code === '23505') {
          const { data } = await client!.from('order_complaints').select('status').eq('order_id', orderId).eq('user_id', userId).maybeSingle();
          if (data?.status && data.status in statusLabels) setComplaintStatus(data.status as ComplaintStatus);
          setNotice(data?.status ? 'A complaint has already been submitted for this order.' : 'This order already has a complaint. Refresh the page to see its status.');
        } else if (error.code === '42P01' || error.code === 'PGRST205') {
          setNotice('Complaint reporting is not enabled yet. Please contact support.');
        } else if (error.code === '42501') {
          setNotice('This order could not be matched to your signed-in account. Refresh and try again.');
        } else if (error.code === '23514') {
          setNotice('The complaint details could not be saved. Shorten the additional details and try again.');
        } else {
          setNotice(`Complaint could not be submitted (${error.code || 'connection error'}). Please try again.`);
        }
        return;
      }
      setComplaintStatus('open');
      setOpen(false);
      setMessage('');
    } catch {
      setNotice('The complaint could not reach the server. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="order-complaint-action">
    {complaintStatus
      ? <span className="order-complaint-sent">Reported · {statusLabels[complaintStatus]}</span>
      : <button type="button" className="order-complaint-button" onClick={() => { setNotice(''); setOpen(value => !value); }}><MessageSquareWarning size={15} />{open ? 'Close complaint' : 'Report not received'}</button>}
    {notice && <small role="status">{notice}</small>}
    {open && !complaintStatus && <form className="order-complaint-form" onSubmit={event => void submit(event)}>
      <p className="order-complaint-preview">{complaintText(order, '')}</p>
      <label>Additional details (optional)<textarea maxLength={1500} rows={2} value={message} onChange={event => setMessage(event.target.value)} placeholder="Add anything else the admin should know." /></label>
      <div><button type="button" onClick={() => setOpen(false)}><X size={14} /> Cancel</button><button type="submit" disabled={saving}><Send size={14} />{saving ? 'Sending…' : 'Send complaint'}</button></div>
    </form>}
  </div>;
}
