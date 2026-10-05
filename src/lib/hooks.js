import { useEffect, useState } from 'react';

// Executa uma função assíncrona e devolve { data, loading, error }. Cancela resultados obsoletos.
export function useAsync(fn, deps) {
  const [s, set] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    set((p) => ({ ...p, loading: true, error: null }));
    fn()
      .then((data) => alive && set({ data, loading: false, error: null }))
      .catch((error) => { console.error(error); alive && set({ data: null, loading: false, error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}
