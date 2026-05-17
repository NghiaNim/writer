import { useState } from 'react';
import { TUNABLES } from '../../tunables.js';
import { useTunableSetter, useTunable } from '../../contexts/TunablesContext.jsx';

/**
 * Lab — per-user feature-flag toggles.
 *
 * Lists every entry from frontend/src/tunables.js with its current
 * resolved value and a toggle to override it. URL params override
 * everything else, so when a flag is forced by ?tunables.<key>=on we
 * disable the row and tell the user where the value is coming from.
 */
export default function LabSettings() {
  if (!TUNABLES.length) {
    return (
      <section className="settings-section">
        <h3>Lab</h3>
        <p className="section-description">
          Feature flags for in-flight UI experiments. Nothing here yet — when
          new toggles are added they'll appear automatically.
        </p>
        <div className="lab-empty">
          <code>frontend/src/tunables.js</code> is the registry. Add an entry
          there and the row will show up here on next reload.
        </div>
      </section>
    );
  }
  return (
    <section className="settings-section">
      <h3>Lab</h3>
      <p className="section-description">
        Per-user feature flags for UI experiments. Changes save instantly.
        Add <code>?tunables.&lt;key&gt;=on</code> to the URL to override
        without saving.
      </p>
      <div className="lab-tunable-list">
        {TUNABLES.map((t) => (
          <LabTunableRow key={t.key} tunable={t} />
        ))}
      </div>
    </section>
  );
}

function LabTunableRow({ tunable }) {
  const resolved = useTunable(tunable.key);
  const { setOverride, clearOverride, urlOverrides, userOverrides } =
    useTunableSetter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const hasUrlOverride = Object.prototype.hasOwnProperty.call(
    urlOverrides,
    tunable.key
  );
  const hasUserOverride = Object.prototype.hasOwnProperty.call(
    userOverrides,
    tunable.key
  );

  const source = hasUrlOverride
    ? 'URL'
    : hasUserOverride
    ? 'Your override'
    : 'Default';

  const handleToggle = async (e) => {
    const next = e.target.checked;
    setError(null);
    setSaving(true);
    try {
      await setOverride(tunable.key, next);
    } catch (err) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setError(null);
    setSaving(true);
    try {
      await clearOverride(tunable.key);
    } catch (err) {
      setError(err?.message || 'Failed to reset');
    } finally {
      setSaving(false);
    }
  };

  // Only bools render as a switch. String/number flags get a text input
  // so the same registry can serve all three types.
  const type = tunable.type || 'bool';

  return (
    <div className={`lab-tunable-row ${hasUrlOverride ? 'is-url-locked' : ''}`}>
      <div className="lab-tunable-meta">
        <div className="lab-tunable-key-row">
          <code className="lab-tunable-key">{tunable.key}</code>
          <span className="lab-tunable-source">{source}</span>
          {tunable.addedOn && (
            <span className="lab-tunable-added">added {tunable.addedOn}</span>
          )}
        </div>
        <div className="lab-tunable-description">{tunable.description}</div>
        {error && <div className="lab-tunable-error">{error}</div>}
      </div>
      <div className="lab-tunable-control">
        {type === 'bool' ? (
          <label className="lab-tunable-switch">
            <input
              type="checkbox"
              checked={Boolean(resolved)}
              onChange={handleToggle}
              disabled={hasUrlOverride || saving}
            />
            <span>{resolved ? 'On' : 'Off'}</span>
          </label>
        ) : (
          <input
            className="lab-tunable-text"
            type={type === 'number' ? 'number' : 'text'}
            value={resolved == null ? '' : String(resolved)}
            onChange={async (e) => {
              const v =
                type === 'number'
                  ? e.target.value === ''
                    ? null
                    : Number(e.target.value)
                  : e.target.value;
              setError(null);
              setSaving(true);
              try {
                if (v === null || v === '') {
                  await clearOverride(tunable.key);
                } else {
                  await setOverride(tunable.key, v);
                }
              } catch (err) {
                setError(err?.message || 'Failed to save');
              } finally {
                setSaving(false);
              }
            }}
            disabled={hasUrlOverride || saving}
          />
        )}
        {hasUserOverride && !hasUrlOverride && (
          <button
            type="button"
            className="lab-tunable-reset"
            onClick={handleReset}
            disabled={saving}
            title="Clear your override and use the registry default"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
