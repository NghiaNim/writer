import React from 'react';

export default function PromptSettings({
    prompts,
    handlePromptChange,
    handleResetPrompt,
    activePromptTab,
    setActivePromptTab,
    stage2Temperature,
    setStage2Temperature,
    // Stage 1 council personas (Phase 1: essay-writing personas)
    councilPersonas = [],
    activePersonaIndex = 0,
    setActivePersonaIndex = () => {},
    onPersonaFieldChange = () => {},
    onResetPersona = () => {},
    onResetAllPersonas = () => {},
}) {
    const safeIndex = Math.min(activePersonaIndex, Math.max(0, councilPersonas.length - 1));
    const activePersona = councilPersonas[safeIndex];

    return (
        <section className="settings-section">
            <h3>System Prompts</h3>
            <p className="section-description">
                Customize the instructions given to the models at each stage.
            </p>

            <div className="prompts-tabs">
                <button
                    className={`prompt-tab ${activePromptTab === 'stage1' ? 'active' : ''}`}
                    onClick={() => setActivePromptTab('stage1')}
                >
                    Stage 1
                </button>
                <button
                    className={`prompt-tab ${activePromptTab === 'stage2' ? 'active' : ''}`}
                    onClick={() => setActivePromptTab('stage2')}
                >
                    Stage 2
                </button>
                <button
                    className={`prompt-tab ${activePromptTab === 'stage3' ? 'active' : ''}`}
                    onClick={() => setActivePromptTab('stage3')}
                >
                    Stage 3
                </button>
            </div>

            <div className="prompt-editor">
                {activePromptTab === 'stage1' && (
                    <div className="prompt-content">
                        <label>Stage 1: Council Personas</label>
                        <p className="section-description" style={{ marginBottom: '10px' }}>
                            Member <strong>1</strong> uses persona 1, member <strong>2</strong> uses persona 2, and so on. Extras fall back to the generic prompt below.
                        </p>

                        {councilPersonas.length > 0 ? (
                            <>
                                {/* Persona sub-tabs */}
                                <div
                                    className="prompts-tabs"
                                    style={{ marginBottom: '12px', flexWrap: 'wrap' }}
                                >
                                    {councilPersonas.map((p, idx) => (
                                        <button
                                            key={idx}
                                            className={`prompt-tab ${idx === safeIndex ? 'active' : ''}`}
                                            onClick={() => setActivePersonaIndex(idx)}
                                            title={p.description || ''}
                                        >
                                            {idx + 1}. {p.name || `Persona ${idx + 1}`}
                                        </button>
                                    ))}
                                </div>

                                {activePersona && (
                                    <div
                                        className="persona-editor"
                                        style={{
                                            padding: '14px',
                                            background: 'rgba(59, 130, 246, 0.06)',
                                            borderRadius: '8px',
                                            border: '1px solid rgba(59, 130, 246, 0.18)',
                                        }}
                                    >
                                        <label
                                            style={{
                                                display: 'block',
                                                fontSize: '12px',
                                                opacity: 0.85,
                                                marginBottom: '6px',
                                            }}
                                        >
                                            Persona name
                                        </label>
                                        <input
                                            type="text"
                                            value={activePersona.name || ''}
                                            onChange={(e) =>
                                                onPersonaFieldChange(safeIndex, 'name', e.target.value)
                                            }
                                            style={{
                                                width: '100%',
                                                marginBottom: '10px',
                                                padding: '8px 10px',
                                                background: 'rgba(0,0,0,0.25)',
                                                color: '#e2e8f0',
                                                border: '1px solid rgba(255,255,255,0.1)',
                                                borderRadius: '6px',
                                                fontFamily: 'inherit',
                                            }}
                                        />

                                        <label
                                            style={{
                                                display: 'block',
                                                fontSize: '12px',
                                                opacity: 0.85,
                                                marginBottom: '6px',
                                            }}
                                        >
                                            Short description (optional)
                                        </label>
                                        <input
                                            type="text"
                                            value={activePersona.description || ''}
                                            onChange={(e) =>
                                                onPersonaFieldChange(
                                                    safeIndex,
                                                    'description',
                                                    e.target.value
                                                )
                                            }
                                            placeholder="e.g. Structure and argument flow."
                                            style={{
                                                width: '100%',
                                                marginBottom: '10px',
                                                padding: '8px 10px',
                                                background: 'rgba(0,0,0,0.25)',
                                                color: '#e2e8f0',
                                                border: '1px solid rgba(255,255,255,0.1)',
                                                borderRadius: '6px',
                                                fontFamily: 'inherit',
                                            }}
                                        />

                                        <p className="prompt-help">
                                            Variables: <code>{'{user_query}'}</code>,{' '}
                                            <code>{'{search_context_block}'}</code>
                                        </p>
                                        <textarea
                                            value={activePersona.prompt || ''}
                                            onChange={(e) =>
                                                onPersonaFieldChange(
                                                    safeIndex,
                                                    'prompt',
                                                    e.target.value
                                                )
                                            }
                                            rows={14}
                                        />
                                        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                            <button
                                                className="reset-prompt-btn"
                                                onClick={() => onResetPersona(safeIndex)}
                                            >
                                                Reset This Persona
                                            </button>
                                            <button
                                                className="reset-prompt-btn"
                                                onClick={onResetAllPersonas}
                                            >
                                                Reset All Personas
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="section-description">
                                No personas configured. Use "Reset to Defaults" in Backup &amp; Reset
                                to load the default essay-writing personas.
                            </p>
                        )}

                        {/* Generic Stage 1 fallback prompt */}
                        <div style={{ marginTop: '24px' }}>
                            <label>Generic Stage 1 fallback prompt</label>
                            <p
                                className="section-description"
                                style={{ marginBottom: '10px' }}
                            >
                                Used for council members beyond the persona list.
                            </p>
                            <p className="prompt-help">
                                Variables: <code>{'{user_query}'}</code>,{' '}
                                <code>{'{search_context_block}'}</code>
                            </p>
                            <textarea
                                value={prompts.stage1_prompt}
                                onChange={(e) => handlePromptChange('stage1_prompt', e.target.value)}
                                rows={8}
                            />
                            <button
                                className="reset-prompt-btn"
                                onClick={() => handleResetPrompt('stage1_prompt')}
                            >
                                Reset to Default
                            </button>
                        </div>
                    </div>
                )}
                {activePromptTab === 'stage2' && (
                    <div className="prompt-content">
                        <label>Stage 2: Peer Ranking</label>

                        {/* Stage 2 Temperature Slider - Positioned prominently */}
                        <div className="stage2-heat-section" style={{ marginTop: '12px', marginBottom: '16px', padding: '15px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                            <div className="heat-slider-header">
                                <h4 style={{ margin: 0, fontSize: '14px', color: '#e2e8f0' }}>Stage 2 Heat</h4>
                                <span className="heat-value">{stage2Temperature.toFixed(1)}</span>
                            </div>
                            <p className="section-description" style={{ fontSize: '12px', margin: '8px 0' }}>
                                Keep this low — Stage 2 needs to parse.
                            </p>
                            <div className="heat-slider-container">
                                <span className="heat-icon cold">❄️</span>
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.1"
                                    value={stage2Temperature}
                                    onChange={(e) => setStage2Temperature(parseFloat(e.target.value))}
                                    className="heat-slider"
                                />
                                <span className="heat-icon hot">🔥</span>
                            </div>
                        </div>

                        <p className="section-description" style={{ marginBottom: '10px' }}>
                            Instructs models how to rank and evaluate peer responses.
                        </p>
                        <p className="prompt-help">Variables: <code>{'{user_query}'}</code>, <code>{'{responses_text}'}</code>, <code>{'{search_context_block}'}</code></p>
                        <textarea
                            value={prompts.stage2_prompt}
                            onChange={(e) => handlePromptChange('stage2_prompt', e.target.value)}
                            rows={15}
                        />
                        <button className="reset-prompt-btn" onClick={() => handleResetPrompt('stage2_prompt')}>Reset to Default</button>
                    </div>
                )}
                {activePromptTab === 'stage3' && (
                    <div className="prompt-content">
                        <label>Stage 3: Chairman Synthesis</label>
                        <p className="section-description" style={{ marginBottom: '10px' }}>
                            Directs the chairman to synthesize a final answer from all inputs.
                        </p>
                        <p className="prompt-help">Variables: <code>{'{user_query}'}</code>, <code>{'{stage1_text}'}</code>, <code>{'{stage2_text}'}</code>, <code>{'{search_context_block}'}</code></p>
                        <textarea
                            value={prompts.stage3_prompt}
                            onChange={(e) => handlePromptChange('stage3_prompt', e.target.value)}
                            rows={15}
                        />
                        <button className="reset-prompt-btn" onClick={() => handleResetPrompt('stage3_prompt')}>Reset to Default</button>
                    </div>
                )}
            </div>
        </section>
    );
}
