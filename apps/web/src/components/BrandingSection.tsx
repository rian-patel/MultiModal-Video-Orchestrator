import { useEffect, useRef, useState } from 'react';
import type { BrandingInput } from '../api';

interface Props {
  value: BrandingInput;
  onChange: (b: BrandingInput) => void;
  disabled?: boolean;
}

/** Agent identity fields worth remembering across sessions (never the address). */
const STORAGE_KEY = 'rev-branding-agent';

/**
 * Optional branding: property address (title card), agent name + contact
 * (end card) and a logo (end card + corner watermark). Collapsed by default —
 * the tool stays near-zero-input unless the agent wants branded output.
 * Agent identity is persisted locally so it's typed once, not per listing.
 */
export function BrandingSection({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const hydrated = useRef(false);

  // Rehydrate the agent identity once on mount.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as
        | Pick<BrandingInput, 'agentName' | 'phone' | 'email'>
        | null;
      if (saved) onChange({ ...value, ...saved });
    } catch {
      // corrupt storage — ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch: Partial<BrandingInput>) {
    const next = { ...value, ...patch };
    onChange(next);
    if ('agentName' in patch || 'phone' in patch || 'email' in patch) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ agentName: next.agentName, phone: next.phone, email: next.email }),
      );
    }
  }

  const filled = [value.address, value.agentName, value.phone, value.email, value.logo].filter(
    Boolean,
  ).length;

  const inputCls =
    'w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 ' +
    'placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-50';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="flex w-full items-center justify-between px-4 py-3 text-sm text-slate-300"
      >
        <span className="font-medium">
          Branding <span className="text-slate-500">(optional)</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          {filled > 0 && !open && <span className="text-sky-400">{filled} field{filled === 1 ? '' : 's'} set</span>}
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          >
            <path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-800 p-4">
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Property address <span className="text-slate-600">— title card</span>
            </label>
            <input
              type="text"
              value={value.address ?? ''}
              onChange={(e) => update({ address: e.target.value })}
              placeholder="128 Maple Grove Lane, Austin TX"
              disabled={disabled}
              maxLength={120}
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-slate-400">Agent name</label>
              <input
                type="text"
                value={value.agentName ?? ''}
                onChange={(e) => update({ agentName: e.target.value })}
                placeholder="Jane Smith"
                disabled={disabled}
                maxLength={120}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Phone</label>
              <input
                type="tel"
                value={value.phone ?? ''}
                onChange={(e) => update({ phone: e.target.value })}
                placeholder="(512) 555-0100"
                disabled={disabled}
                maxLength={40}
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Email</label>
              <input
                type="email"
                value={value.email ?? ''}
                onChange={(e) => update({ email: e.target.value })}
                placeholder="jane@realty.com"
                disabled={disabled}
                maxLength={120}
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">
              Logo <span className="text-slate-600">— end card + corner watermark (PNG with transparency works best)</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => update({ logo: e.target.files?.[0] ?? null })}
                disabled={disabled}
                className="text-xs text-slate-400 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-200 hover:file:bg-slate-600"
              />
              {value.logo && (
                <button
                  type="button"
                  onClick={() => update({ logo: null })}
                  disabled={disabled}
                  className="text-xs text-slate-500 underline hover:text-slate-300"
                >
                  remove
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-600">
            Adds a title card, an end card and a subtle corner watermark. Leave empty for a clean, unbranded video.
          </p>
        </div>
      )}
    </div>
  );
}
