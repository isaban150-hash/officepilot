export type FileTypeIconSize = 'sm' | 'md' | 'lg';

export interface FileTypeIconProps {
  mimeType?: string | null;
  fileName?: string | null;
  size?: FileTypeIconSize;
  className?: string;
}

function resolveFileLabel(mimeType?: string | null, fileName?: string | null): string {
  const mime = (mimeType ?? '').toLowerCase();
  const name = (fileName ?? '').toLowerCase();

  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(name)) return 'IMG';
  if (mime.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return 'DOC';
  if (mime.includes('sheet') || mime.includes('excel') || name.endsWith('.xlsx')) return 'XLS';
  return 'DOK';
}

export function FileTypeIcon({
  mimeType,
  fileName,
  size = 'md',
  className = '',
}: FileTypeIconProps) {
  const label = resolveFileLabel(mimeType, fileName);

  return (
    <span
      className={`file-type-icon file-type-icon--${size}${className ? ` ${className}` : ''}`}
      aria-hidden
      data-testid="file-type-icon"
    >
      {label}
    </span>
  );
}
