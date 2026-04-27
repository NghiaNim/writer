import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import SearchableModelSelect from './SearchableModelSelect';
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
 *  - Models are pulled from the full OpenRouter catalog (~300 models). A
 *    "Free only" toggle filters to the free-tier subset for casual use.
 */
export default function CouncilConfig({
  value: externalValue,
  onChange,
  onSave,
  showSave = true,
  compact = false,
}) {
  const [config, setConfig] = useState(externalValue || null);
  const [allModels, setAllModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [freeOnly, setFreeOnly] = useState(false);
  const [loading, setLoading] = useState(!externalValue);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingModels(true);
      try {
        const data = await api.models.list();
        if (!cancelled) setAllModels(data.models || []);
      } catch (e) {
        // Non-fatal: UI still renders, dropdowns just look empty.
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Apply the free-only filter to the picker, but keep the *current* selection
  // visible even when filtered out via SearchableModelSelect's allModels prop.
  const visibleModels = useMemo(() => {
    if (!freeOnly) return allModels;
    return allModels.filter((m) => m.is_free);
  }, [allModels, freeOnly]);

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

  // Set returning a fast id-lookup so we can flag saved values that aren't in
  // the live catalog (e.g. OpenRouter deprecated the model). When the saved
  // value isn't found, the SearchableModelSelect renders empty, so we explain
  // why and prompt the user to pick a fresh one.
  const allModelIds = useMemo(
    () => new Set(allModels.map((m) => m.id)),
    [allModels]
  );

  const handleFeelingLucky = () => {
    if (visibleModels.length === 0) return;
    const pick = () =>
      visibleModels[Math.floor(Math.random() * visibleModels.length)].id;
    const personas = orderedPersonas.map((p) =>
      p.enabled ? { ...p, model: pick() } : p
    );
    updateConfig({
      ...config,
      personas,
      chairman_model: pick(),
    });
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        personas: orderedPersonas,
        chairman_model: config?.chairman_model || '',
      });
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
          {enabledCount} of 4 members enabled. Pick a model for each. They
          write drafts in parallel, peer-review each other, then the Chairman
          synthesizes the final essay.
        </p>
        <div className="cc-controls">
          <label className="cc-free-toggle">
            <input
              type="checkbox"
              checked={freeOnly}
              onChange={(e) => setFreeOnly(e.target.checked)}
            />
            <span>Free models only</span>
            <span className="cc-free-count">
              ({visibleModels.length} / {allModels.length})
            </span>
          </label>
          <button
            type="button"
            className="cc-lucky"
            onClick={handleFeelingLucky}
            disabled={visibleModels.length === 0}
            title="Pick random models for every enabled member + chairman"
          >
            I&rsquo;m feeling lucky
          </button>
        </div>
      </div>

      <div className="cc-personas">
        {orderedPersonas.map((p) => {
          const meta = PERSONA_META[p.key] || { name: p.key, blurb: '' };
          const enabled = !!p.enabled;
          const modelMissing = enabled && !p.model;
          const modelStale =
            enabled && p.model && allModelIds.size > 0 && !allModelIds.has(p.model);
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
              {!compact && (
                <div className="cc-persona-blurb">{meta.blurb}</div>
              )}
              <div className={`cc-model-wrap ${modelMissing ? 'missing' : ''}`}>
                <SearchableModelSelect
                  models={visibleModels}
                  allModels={allModels}
                  value={p.model || ''}
                  onChange={(modelId) => setPersonaModel(p.key, modelId)}
                  placeholder={
                    enabled ? 'Search and select a model…' : 'Disabled'
                  }
                  isDisabled={!enabled}
                  isLoading={loadingModels}
                />
              </div>
              {modelMissing && (
                <div className="cc-warn">
                  Pick a model or disable this member.
                </div>
              )}
              {modelStale && (
                <div className="cc-warn">
                  Saved model <code>{p.model}</code> isn&rsquo;t in the current
                  catalog (likely deprecated). Pick a new one.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cc-chairman">
        <label className="cc-chair-label">Chairman (final synthesis)</label>
        <SearchableModelSelect
          models={visibleModels}
          allModels={allModels}
          value={config?.chairman_model || ''}
          onChange={setChairmanModel}
          placeholder="Search and select a model…"
          isLoading={loadingModels}
        />
        {config?.chairman_model &&
          allModelIds.size > 0 &&
          !allModelIds.has(config.chairman_model) && (
            <div className="cc-warn">
              Saved model <code>{config.chairman_model}</code> isn&rsquo;t in
              the current catalog. Pick a new one.
            </div>
          )}
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
