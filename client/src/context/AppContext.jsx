import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const AppContext = createContext(null);
const FY_KEY = 'lp-fy';

function initialFy() {
  try {
    const v = Number(localStorage.getItem(FY_KEY));
    if (Number.isInteger(v) && v > 2000) return v;
  } catch (e) { /* ignore */ }
  return new Date().getFullYear() + 1; // the annual plan is prepared for next year
}

// Shared reference data (departments, categories, method lists, limits) and the selected plan cycle.
export function AppProvider({ children }) {
  const [lookups, setLookups] = useState(null);
  const [fy, setFyState] = useState(initialFy);

  const reload = useCallback(() => api.get('/lookups').then(setLookups), []);
  useEffect(() => { reload(); }, [reload]);

  const setFy = useCallback(v => {
    setFyState(v);
    try { localStorage.setItem(FY_KEY, String(v)); } catch (e) { /* ignore */ }
  }, []);

  if (!lookups) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
  return <AppContext.Provider value={{ lookups, reload, fy, setFy }}>{children}</AppContext.Provider>;
}

export function useApp() { return useContext(AppContext); }
