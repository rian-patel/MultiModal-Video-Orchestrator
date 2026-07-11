import { useState } from 'react';
import { supabase } from '../hosted/client';

/**
 * Magic-link sign-in for hosted mode. The alpha is invite-only: signups are
 * disabled in Supabase, so only invited addresses receive a working link.
 */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setError(null);
    const { error: err } = await supabase().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (err) {
      setError(err.message);
      setState('error');
    } else {
      setState('sent');
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
      <h2 className="text-lg font-semibold">Sign in</h2>
      <p className="mt-1 text-sm text-slate-400">
        This alpha is invite-only. Enter your invited email and we'll send you a sign-in link.
      </p>

      {state === 'sent' ? (
        <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-300">
          Link sent to {email}. Open it on this device to sign in.
        </div>
      ) : (
        <form onSubmit={sendLink} className="mt-5 flex gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@realty.com"
            className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={state === 'sending' || !email.trim()}
            className="whitespace-nowrap rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {state === 'sending' ? 'Sending…' : 'Send link'}
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
    </div>
  );
}
