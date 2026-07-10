import { useRef, useState } from 'react';
import type { DragEvent } from 'react';

// Keep in sync with @rev/engine-upload (MIN_PHOTOS/MAX_PHOTOS). The UI may
// only `import type` from workspace packages, so the values are mirrored here.
const MIN_PHOTOS = 10;
const MAX_PHOTOS = 40;

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

/** Captures real image File objects; startRun() uploads them as multipart. */
export function Dropzone({ files, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const accept = (list: FileList | null) => {
    if (!list || disabled) return;
    const picked = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (picked.length > 0) onChange(picked);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    accept(e.dataTransfer.files);
  };

  const count = files.length;
  const countValid = count >= MIN_PHOTOS && count <= MAX_PHOTOS;
  const totalMb = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);

  return (
    <div>
      <div
        role="button"
        aria-label="Photo dropzone"
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          'cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors',
          dragOver ? 'border-sky-400 bg-sky-950/40' : 'border-slate-600 bg-slate-800/40',
          disabled ? 'pointer-events-none opacity-50' : 'hover:border-slate-400',
        ].join(' ')}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => accept(e.target.files)}
        />
        {count === 0 ? (
          <>
            <p className="text-lg font-medium text-slate-200">
              Drag {MIN_PHOTOS}–{MAX_PHOTOS} property photos here
            </p>
            <p className="mt-1 text-sm text-slate-400">or click to browse</p>
            <p className="mt-3 text-xs text-slate-500">
              None selected — Generate will use the built-in 14-photo demo set
            </p>
          </>
        ) : (
          <>
            <p className={`text-lg font-medium ${countValid ? 'text-slate-200' : 'text-amber-400'}`}>
              {count} photo{count === 1 ? '' : 's'} selected · {totalMb.toFixed(1)} MB
            </p>
            {!countValid && (
              <p className="mt-1 text-sm text-amber-400">
                Select between {MIN_PHOTOS} and {MAX_PHOTOS} photos
              </p>
            )}
            <p className="mt-2 line-clamp-2 text-xs text-slate-500">
              {files.slice(0, 6).map((f) => f.name).join(', ')}
              {count > 6 ? ` +${count - 6} more` : ''}
            </p>
          </>
        )}
      </div>
      {count > 0 && !disabled && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="mt-2 text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
        >
          Clear selection
        </button>
      )}
    </div>
  );
}
