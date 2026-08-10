interface PaginationProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const buttonClass =
    'rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="flex items-center justify-center gap-4 py-8">
      <button type="button" className={buttonClass} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Précédent
      </button>
      <span className="text-sm text-zinc-500">
        Page {page} / {totalPages}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Suivant
      </button>
    </div>
  );
}
