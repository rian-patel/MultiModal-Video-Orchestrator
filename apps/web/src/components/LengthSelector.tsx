export type TourLength = 30 | 45 | 60;

const OPTIONS: TourLength[] = [30, 45, 60];

interface Props {
  value: TourLength;
  onChange: (v: TourLength) => void;
  disabled?: boolean;
}

export function LengthSelector({ value, onChange, disabled }: Props) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-300">Video length</p>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Video length">
        {OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={[
              'rounded-lg border py-2.5 text-sm font-semibold transition-colors',
              value === opt
                ? 'border-sky-400 bg-sky-500/20 text-sky-300'
                : 'border-slate-600 bg-slate-800/40 text-slate-300 hover:border-slate-400',
              disabled ? 'opacity-50' : '',
            ].join(' ')}
          >
            {opt}s
          </button>
        ))}
      </div>
    </div>
  );
}
