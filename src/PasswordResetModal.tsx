import { useEffect, useState } from 'react';
import { ArrowRight, KeyRound, Mail, X } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SITE_URL } from './siteConfig';

export default function PasswordResetModal({ client, onClose, onNotice, recoveryReady = false, initialEmail = '' }: {
  client: SupabaseClient | null; onClose: () => void; onNotice: (message: string) => void;
  recoveryReady?: boolean; initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'email' | 'sent' | 'password'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (recoveryReady) setStep('password'); }, [recoveryReady]);

  async function sendResetLink() {
    setError('');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter the email address for your account.'); return; }
    if (!client) { setError('Password recovery is unavailable right now.'); return; }
    setBusy(true);
    const { error: resetError } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: PUBLIC_SITE_URL + '/?view=dashboard',
    });
    setBusy(false);
    if (resetError) { setError(resetError.message); return; }
    setStep('sent');
  }

  async function savePassword() {
    setError('');
    if (password.length < 8 || password.length > 128) { setError('Use a password between 8 and 128 characters.'); return; }
    if (!client) { setError('Password recovery is unavailable right now.'); return; }
    setBusy(true);
    const { error: updateError } = await client.auth.updateUser({ password });
    setBusy(false);
    if (updateError) { setError(updateError.message); return; }
    onClose();
    onNotice('Your password has been reset. You can now sign in with the new password.');
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal reset-modal" role="dialog" aria-modal="true" aria-labelledby="password-reset-title">
      <button className="modal-close" type="button" onClick={onClose} aria-label="Close"><X size={19}/></button>
      <div className="modal-icon"><KeyRound/></div><div className="eyebrow">ACCOUNT RECOVERY</div>
      <h2 id="password-reset-title">{step === 'email' ? 'Reset your password' : step === 'sent' ? 'Check your email' : 'Choose a new password'}</h2>
      <p className="modal-desc">{step === 'email' ? 'We’ll send a secure password reset link to your account email.' : step === 'sent' ? 'Open the reset link in your email to continue. Check your spam folder if it does not arrive.' : 'Choose a new password for your account.'}</p>
      {step === 'email' && <><label className="field-label">Account email address</label><input className="form-input" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"/><button className="primary modal-primary" type="button" onClick={() => void sendResetLink()} disabled={busy}>{busy ? 'Sending…' : 'Email reset link'} <Mail size={16}/></button></>}
      {step === 'sent' && <div className="storefront-report-success" role="status">If an account uses <b>{email}</b>, a password reset link has been sent.</div>}
      {step === 'password' && <><label className="field-label">New password</label><input className="form-input" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters"/><button className="primary modal-primary" type="button" onClick={() => void savePassword()} disabled={busy}>{busy ? 'Saving…' : 'Save new password'} <ArrowRight size={16}/></button></>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </section>
  </div>;
}
