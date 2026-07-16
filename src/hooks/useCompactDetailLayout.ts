import { useEffect, useState } from 'react';

const COMPACT_DETAIL_QUERY = '(max-width: 767px)';

/** True when the viewport should use the compact inbox/document detail layout. */
export function getCompactDetailLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(COMPACT_DETAIL_QUERY).matches;
}

export function useCompactDetailLayout(): boolean {
  const [compact, setCompact] = useState(getCompactDetailLayout);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_DETAIL_QUERY);
    const onChange = () => setCompact(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return compact;
}
