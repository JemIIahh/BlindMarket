import { useEffect } from 'react';

export function ThemeSync() {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  }, []);
  return null;
}
