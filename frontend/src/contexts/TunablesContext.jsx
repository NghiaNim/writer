import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  TUNABLES,
  TUNABLES_BY_KEY,
  readTunablesFromUrl,
  resolveTunable,
} from '../tunables.js';
import { useAuth } from './AuthContext';
import { api } from '../api';

/**
 * Tunables (feature-flag) context.
 *
 * Holds the merged tunable state for the current user. Reads at three
 * levels (URL → user row → registry default); writes go through
 * `useTunableSetter` which PUTs to /api/tunables.
 *
 * URL overrides are read once on mount — they're for fast manual A/B and
 * don't need reactive re-reading. To change one, edit the URL and reload.
 *
 * User-row overrides load lazily after auth; until they arrive, callers
 * see registry defaults. This is fine: tunables should default to the
 * safe value (usually OFF), so a brief pre-load flash doesn't show a
 * half-built feature.
 */

const TunablesContext = createContext({
  values: {},
  setOverride: () => Promise.resolve(),
  clearOverride: () => Promise.resolve(),
  loaded: false,
  urlOverrides: {},
  userOverrides: {},
});

function buildValues({ urlOverrides, userOverrides }) {
  const values = {};
  for (const t of TUNABLES) {
    values[t.key] = resolveTunable(t.key, { urlOverrides, userOverrides });
  }
  // Surface any URL-only keys (e.g. a flag in flight that isn't registered
  // yet) so power users can still A/B them.
  for (const k of Object.keys(urlOverrides)) {
    if (!(k in values)) values[k] = urlOverrides[k];
  }
  return values;
}

export function TunablesProvider({ children }) {
  const { user, restoring, isAuthenticated } = useAuth();
  const urlOverrides = useMemo(() => readTunablesFromUrl(), []);
  const [userOverrides, setUserOverrides] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Wait until AuthContext has finished restoring the session from
    // localStorage. Until then we don't know whether the user is logged in.
    if (restoring) return;
    if (!isAuthenticated || !user) {
      setUserOverrides({});
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.tunables.get();
        if (cancelled) return;
        setUserOverrides(resp?.tunables || {});
      } catch (e) {
        // Eat the error; defaults win. Tunables loading should never block
        // the app shell from rendering.
        // eslint-disable-next-line no-console
        console.warn('Tunables fetch failed; using defaults.', e);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restoring, isAuthenticated, user]);

  const setOverride = useCallback(async (key, value) => {
    // Optimistic update — the Lab UI feels instant. Roll back on error.
    setUserOverrides((prev) => ({ ...prev, [key]: value }));
    try {
      const resp = await api.tunables.update({ [key]: value });
      if (resp?.tunables) setUserOverrides(resp.tunables);
    } catch (e) {
      // Refetch to recover authoritative state.
      try {
        const fresh = await api.tunables.get();
        setUserOverrides(fresh?.tunables || {});
      } catch {
        // Network is fully down — leave the optimistic state.
      }
      throw e;
    }
  }, []);

  const clearOverride = useCallback(async (key) => {
    setUserOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const resp = await api.tunables.update({ [key]: null });
      if (resp?.tunables) setUserOverrides(resp.tunables);
    } catch (e) {
      try {
        const fresh = await api.tunables.get();
        setUserOverrides(fresh?.tunables || {});
      } catch {
        // ignore
      }
      throw e;
    }
  }, []);

  const values = useMemo(
    () => buildValues({ urlOverrides, userOverrides }),
    [urlOverrides, userOverrides]
  );

  const ctx = useMemo(
    () => ({
      values,
      setOverride,
      clearOverride,
      loaded,
      urlOverrides,
      userOverrides,
    }),
    [values, setOverride, clearOverride, loaded, urlOverrides, userOverrides]
  );

  return <TunablesContext.Provider value={ctx}>{children}</TunablesContext.Provider>;
}

/**
 * Read one tunable's resolved value.
 *
 *   const showNewSidebar = useTunable('sidebarV2');
 *
 * Unknown keys return `undefined`. Boolean tunables return true/false. The
 * value updates reactively when overrides change (e.g. when the user
 * flips it in the Lab UI).
 */
export function useTunable(key) {
  const { values } = useContext(TunablesContext);
  return values[key] ?? TUNABLES_BY_KEY[key]?.default;
}

/**
 * Lab-UI hook for setting/clearing an override. Most components do NOT
 * need this — only the Lab settings panel and any explicit "flip this
 * flag" UI surfaces.
 */
export function useTunableSetter() {
  const { setOverride, clearOverride, userOverrides, urlOverrides, loaded } =
    useContext(TunablesContext);
  return { setOverride, clearOverride, userOverrides, urlOverrides, loaded };
}
