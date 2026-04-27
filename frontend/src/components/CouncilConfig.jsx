import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import './CouncilConfig.css';

const PERSONA_META = {
  architect: {
    name: 'The Architect',
    blurb: 'Structure and argument flow',
  },
  editor: {
    name: 'The Editor',
    blurb: 'Cuts filler and AI tells',
  },
  devils_advocate: {
    name: "The Devil's Advocate",
    blurb: "Stress-tests the thesis, demands 'so what?'",
  },
  voice_guardian: {
    name: 'The Voice Guardian',
    blurb: "Protects your voice; flags AI-speak",
  },
};

const PERSONA_ORDER = ['architect', 'editor', 'devils_advocate', 'voice_guardian'];

const TIER_BADGE = {
  free: 'Free tier',
  low: 'Low-cost',
  standard: 'Standard',
  premium: 'Premium',
};

/**
 * Reusable council-configuration panel.
 *
 * Props:
 *  - value:      { personas: [{key, enabled, model}], chairman_model } | null
 *                If null, loads the user's default via GET /council-config.
 *  - onChange:   (config) => void   Fires on every edit (uncontrolled draft).
 *  - onSave:     async (config) => void  Optional. If provided, shows a Save
 *                button that persists via PUT /council-config and surfaces a
 *                success/error toast inline.
 *  - showSave:   boolean   default true if onSave is set.
 *  - compact:    boolean   if true, hides per-persona blurbs.
 *
 * Notes:
 *  - At least 2 personas must be enabled. UI prevents disabling below that.
 *  - Each enabled persona must have a model selected.
 */
export default function CouncilConfig({
  value: externalValue,
  onChange,
  onSave,
  showSave = true,
  compact = false,
}) {
  const [config, setConfig] = useState(externalValue || null);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(!externalValue);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  // Fetch curated models once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.models.curated();
        if (!cancelled) setModels(data.models || []);
      } catch (e) {
        // Non-fatal: UI still renders, dropdowns just look empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync from external value or load user default.
  useEffect(() => {
    if (externalValue) {
      setConfig(externalValue);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await api.councilConfig.get();
        if (!cancelled) setConfig(data);
      } catch (e) {
        if (!cancelled) setError('Could not load council settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [externalValue]);

  // Derive a normalized, ordered persona list (always all 4 entries shown).
  const orderedPersonas = useMemo(() => {
    const byKey = new Map((config?.personas || []).map((p) => [p.key, p]));
    return PERSONA_ORDER.map(
      (key) =>
        byKey.get(key) || {
          key,
          enabled: false,
          model: '',
        }
    );
  }, [config]);

  const enabledCount = orderedPersonas.filter((p) => p.enabled).length;

  const updateConfig = (next) => {
    setConfig(next);
    setSavedAt(null);
    setError(null);
    if (onChange) onChange(next);
  };

  const togglePersona = (key) => {
    const personas = orderedPersonas.map((p) => {
      if (p.key !== key) return p;
      const willDisable = p.enabled;
      // Block disabling if it would drop us below 2 enabled.
      if (willDisable && enabledCount <= 2) return p;
      return { ...p, enabled: !p.enabled };
    });
    updateConfig({ ...config, personas });
  };

  const setPersonaModel = (key, model) => {
    const personas = orderedPersonas.map((p) =>
      p.key === key ? { ...p, model } : p
    );
    updateConfig({ ...config, personas });
  };

  const setChairmanModel = (model) => {
    updateConfig({ ...config, chairman_model: model });
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ personas: orderedPersonas, chairman_model: config?.chairman_model || '' });
      setSavedAt(new Date());
    } catch (e) {
      setError(e?.message || 'Could not save council settings.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="cc-loading">Loading council settings…</div>;
  }

  return (
    <div className="cc-root">
      <div className="cc-header">
        <h3 className="cc-title">Your Council</h3>
        <p className="cc-sub">
          {enabledCount} of 4 members enabled. Pick a model for each. They write
          drafts in parallel, then peer-review each other before the Chairman
          synthesizes the final essay.
        </p>
      </div>

      <div className="cc-personas">
        {orderedPersonas.map((p) => {
          const meta = PERSONA_META[p.key] || { name: p.key, blurb: '' };
          const enabled = !!p.enabled;
          const modelMissing = enabled && !p.model;
          const blockDisable = enabled && enabledCount <= 2;

          return (
            <div
              key={p.key}
              className={`cc-persona ${enabled ? 'enabled' : 'disabled'}`}
            >
              <label className="cc-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => togglePersona(p.key)}
                  disabled={blockDisable}
                  title={
                    blockDisable
                      ? 'Council needs at least 2 active members'
                      : ''
                  }
                />
                <span className="cc-persona-name">{meta.name}</span>
              </label>
              {!compact && <div className="cc-persona-blurb">{meta.blurb}</div>}
              <select
                className={`cc-model-select ${modelMissing ? 'missing' : ''}`}
                value={p.model || ''}
                onChange={(e) => setPersonaModel(p.key, e.target.value)}
                disabled={!enabled}
              >
                <option value="">— pick a model —</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.tier ? ` · ${TIER_BADGE[m.tier] || m.tier}` : ''}
                  </option>
                ))}
              </select>
              {modelMissing && (
                <div className="cc-warn">Pick a model or disable this member.</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cc-chairman">
        <label className="cc-chair-label">Chairman (final synthesis)</label>
        <select
          className="cc-model-select"
          value={config?.chairman_model || ''}
          onChange={(e) => setChairmanModel(e.target.value)}
        >
          <option value="">— pick a model —</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.tier ? ` · ${TIER_BADGE[m.tier] || m.tier}` : ''}
            </option>
          ))}
        </select>
      </div>

      {showSave && onSave && (
        <div className="cc-actions">
          <button className="cc-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save as default'}
          </button>
          {savedAt && <span className="cc-saved">Saved.</span>}
          {error && <span className="cc-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
