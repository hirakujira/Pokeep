import { useState } from "react";
import type { RunAction } from "./types";

export function useActions(
  refresh: () => Promise<void>,
  refreshPhone: () => Promise<void>,
  setError: (message: string) => void,
) {
  const [busy, setBusy] = useState("");
  const act: RunAction = async (label, fn) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const phoneAct: RunAction = async (label, fn) => {
    await act(label, fn);
    await refreshPhone();
  };
  return { busy, act, phoneAct };
}
