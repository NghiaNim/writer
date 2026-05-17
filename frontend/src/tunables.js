/**
 * Tunables registry — single source of truth for UI feature flags.
 *
 * Resolution priority (highest wins):
 *   1. URL param   ?tunables.<key>=on|off|<value>
 *   2. User override stored in user_settings.tunables (Supabase)
 *   3. Registry default below
 *
 * To add a tunable:
 *   1. Add an entry below with key + default + description + addedOn.
 *   2. Read it in a component:
 *        import { useTunable } from './tunables';
 *        const on = useTunable('mySidebarV2');
 *   3. Done. It appears in Settings → Advanced → Lab automatically.
 *
 * To retire a tunable:
 *   1. Pick the surviving branch and inline it (drop the conditional).
 *   2. Delete the entry from the registry below.
 *   Old user-row values for the key are ignored by the hook (unknown keys
 *   are dropped), so no migration is needed.
 *
 * Conventions:
 *   - key:         camelCase, short, scoped (e.g. `sidebarTwoLineTitles`).
 *   - type:        'bool' for on/off (default), 'string' or 'number' otherwise.
 *   - default:     the value used when no override is set anywhere.
 *   - description: one-liner shown in the Lab UI. Write it for the operator
 *                  flipping the flag, not for the engineer reading the code.
 *   - addedOn:     ISO date. Used to flag stale flags during periodic cleanup.
 *   - owner:       email or handle of the person who introduced it.
 *
 * KEEP THIS LIST SHORT. A tunable that's been on/off for everyone for two
 * weeks should be inlined and removed — long-lived flags rot into dead code.
 */

export const TUNABLES = [
  {
    key: 'brewMode',
    type: 'bool',
    default: false,
    description:
      'Re-skin the essay loading panel with espresso-brewing language and a CSS "bloom" indicator (the 30s pre-infusion CO2 release in pour-over coffee). Less generic-AI, more cafe.',
    addedOn: '2026-05-17',
    owner: 'sraval',
    // Random-walk reference: James Hoffmann's pour-over bloom explainer
    // and the r/Coffee specialty-prep vocabulary (sourcing → grinding →
    // pulling → tasting → pour). The bloom is a real phenomenon: fresh-
    // ground coffee releases CO2 when first wet, producing a slowly-
    // expanding cap of fine bubbles. The CSS pulse here is the closest
    // single-element approximation.
  },
];

/**
 * Build a lookup map from the registry for fast resolution.
 * Keeps the registry an array (preserves authoring order in the Lab UI).
 */
export const TUNABLES_BY_KEY = Object.freeze(
  TUNABLES.reduce((acc, t) => {
    acc[t.key] = Object.freeze({ ...t });
    return acc;
  }, {})
);

/**
 * Parse a single URL-param value for a tunable.
 * Accepts: on/true/1/yes → true, off/false/0/no → false. Returns the raw
 * string otherwise (for string/number tunables). Returns undefined if the
 * param isn't set so the resolution chain falls through.
 */
export function parseTunableParam(raw) {
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  return raw;
}

/**
 * Read every tunables.<key>=... param off `window.location.search` and
 * return them as a flat dict keyed by tunable key. Unknown keys are kept
 * (the URL is the source-of-truth override; we don't second-guess it).
 */
export function readTunablesFromUrl() {
  if (typeof window === 'undefined' || !window.location) return {};
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const [k, v] of params.entries()) {
    if (!k.startsWith('tunables.')) continue;
    const key = k.slice('tunables.'.length);
    if (!key) continue;
    out[key] = parseTunableParam(v);
  }
  return out;
}

/**
 * Resolve a tunable's final value given the override sources.
 *
 *   resolveTunable('sidebarV2', { urlOverrides, userOverrides })
 *     → urlOverrides.sidebarV2  if set
 *     → userOverrides.sidebarV2 if set
 *     → registry default
 *     → undefined if the key isn't registered AND not overridden anywhere
 */
export function resolveTunable(
  key,
  { urlOverrides = {}, userOverrides = {} } = {}
) {
  if (Object.prototype.hasOwnProperty.call(urlOverrides, key)) {
    return urlOverrides[key];
  }
  if (Object.prototype.hasOwnProperty.call(userOverrides, key)) {
    return userOverrides[key];
  }
  const entry = TUNABLES_BY_KEY[key];
  return entry ? entry.default : undefined;
}

// Re-export the hook for ergonomics: most callers want
//   import { useTunable } from './tunables'
// rather than reaching into the context module.
export { useTunable, useTunableSetter, TunablesProvider } from './contexts/TunablesContext.jsx';
