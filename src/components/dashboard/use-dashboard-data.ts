import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { empty } from "./constants";
import type { Catalog, PhoneState, State } from "./types";

export function useDashboardData(setError: (message: string) => void) {
  const [state, setState] = useState<State>(empty),
    [catalog, setCatalog] = useState<Catalog>({ species: [], moves: [] });
  const [loading, setLoading] = useState(true);
  const [phoneState, setPhoneState] = useState<PhoneState | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await api<State>("state");
      setState(result);
      setError("");
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, [setError]);
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>("species"));
    } catch {}
  }, []);
  const refreshPhone = useCallback(async () => {
    try {
      setPhoneState(await api<PhoneState>("iphone"));
    } catch {
      /* main state keeps its own error */
    }
  }, []);
  useEffect(() => {
    void refresh();
    void loadCatalog();
    void refreshPhone();
  }, [refresh, loadCatalog, refreshPhone]);
  useEffect(() => {
    const timer = setInterval(() => void refreshPhone(), 3000);
    return () => clearInterval(timer);
  }, [refreshPhone]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { state, catalog, loading, phoneState, refresh, loadCatalog, refreshPhone };
}
