interface Props {
  left: string;
  right?: string;
}

export function StatusBar({ left, right }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-6 bg-surface border-t border-border text-muted text-[11px]">
      <span>{left}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
