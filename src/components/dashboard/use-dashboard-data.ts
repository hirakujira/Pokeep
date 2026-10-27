import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { empty } from "./constants";
import { trackPending } from "./track-pending";
import type { Catalog, PhoneState, State } from "./types";

export function useDashboardData(setError: (message: string) => void) {
  const [state, setState] = useState<State>(empty),
    [catalog, setCatalog] = useState<Catalog>({ species: [], moves: [] });
  const [loading, setLoading] = useState(true);
  const [phoneState, setPhoneState] = useState<PhoneState | null>(null);
  const stateLoader = useMemo(() => trackPending(async () => {
    try {
      const result = await api<State>("state");
      setState(result);
      setError("");
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }), [setError]);
  const refresh = stateLoader.run;
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>("species"));
    } catch {}
  }, []);
  const phoneLoader = useMemo(() => trackPending(async () => {
    try {
      setPhoneState(await api<PhoneState>("iphone"));
    } catch {
      /* main state keeps its own error */
    }
  }), []);
  const refreshPhone = phoneLoader.run;
  useEffect(() => {
    void refresh();
    void loadCatalog();
    void refreshPhone();
  }, [refresh, loadCatalog, refreshPhone]);
  useEffect(() => {
    const timer = setInterval(() => void phoneLoader.poll(), 3000);
    return () => clearInterval(timer);
  }, [phoneLoader]);
  useEffect(() => {
    const timer = setInterval(() => void stateLoader.poll(), 10000);
    return () => clearInterval(timer);
  }, [stateLoader]);
  return { state, catalog, loading, phoneState, refresh, loadCatalog, refreshPhone };
}
