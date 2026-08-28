import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

interface Props {
  title: string;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  danger?: boolean;
  /** When false, no text input is rendered — used for plain confirm dialogs (e.g. delete). */
  prompt?: boolean;
  /** Extra descriptive text shown above the input (or in place of it when prompt=false). */
  message?: string;
}

export function PromptModal({
  title,
  label,
  initialValue = '',
  confirmLabel = 'OK',
  onSubmit,
  onCancel,
  danger = false,
  prompt = true,
  message,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (prompt && !value.trim()) return;
    onSubmit(value.trim());
  };

  return (
    <Modal title={title} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {message && <div className="text-sm mb-2">{message}</div>}
        {prompt && (
          <label className="block mb-3">
            {label && <div className="text-[11px] text-muted mb-1">{label}</div>}
            <input
              ref={inputRef}
              type="text"
              className="w-full px-2 py-1 border border-border rounded bg-surface"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1 text-sm rounded border border-border hover:bg-accent/10"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`px-3 py-1 text-sm rounded text-white ${danger ? 'bg-danger' : 'bg-accent'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
