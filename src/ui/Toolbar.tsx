import { IconRefresh, IconUp, IconDown, IconNewFolder, IconTrash } from './icons';

interface Props {
  onRefresh?: () => void;
  onUpload?: () => void;
  onDownload?: () => void;
  onNewFolder?: () => void;
  onDelete?: () => void;
}

function TBtn({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex items-center gap-1 px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function Toolbar(p: Props) {
  return (
    <div className="flex items-center gap-1 px-2 h-9 bg-surface border-b border-border">
      <TBtn label="Refresh" icon={<IconRefresh />} onClick={p.onRefresh} />
      <TBtn label="Upload" icon={<IconUp />} onClick={p.onUpload} />
      <TBtn label="Download" icon={<IconDown />} onClick={p.onDownload} />
      <TBtn label="New folder" icon={<IconNewFolder />} onClick={p.onNewFolder} />
      <TBtn label="Delete" icon={<IconTrash />} onClick={p.onDelete} />
    </div>
  );
}
