/**
 * BackupSettings — Settings → Advanced → Backup & Reset section.
 *
 * Extracted from the inline block in Settings.jsx so each settings
 * section is its own component file. That makes the Settings code split
 * possible (React.lazy per section) and matches the existing pattern of
 * VoiceProfileSettings / MemorySettings / SearchSettings / PromptSettings.
 *
 * Props:
 *   onImport(file)   — async import handler, given a File from the picker
 *   onExport()       — async export handler (triggers download)
 *   onResetDefaults()— async "reset everything" handler
 */
export default function BackupSettings({ onImport, onExport, onResetDefaults }) {
    const handleImportFile = (event) => {
        const file = event.target.files?.[0];
        if (file && onImport) onImport(file);
        // Reset the input so the same file can be re-picked if needed.
        event.target.value = '';
    };

    return (
        <section className="settings-section">
            <h3>Backup & Reset</h3>
            <p className="section-description">
                Save or restore your council configuration (models, prompts, settings).
                <br /><em>Note: API keys are NOT exported for security.</em>
            </p>

            <div className="subsection">
                <div
                    className="council-actions"
                    style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}
                >
                    <input
                        type="file"
                        id="import-council"
                        style={{ display: 'none' }}
                        accept=".json"
                        onChange={handleImportFile}
                    />
                    <button
                        className="action-btn"
                        onClick={() => document.getElementById('import-council').click()}
                        title="Import Configuration"
                    >
                        Import Config
                    </button>
                    <button
                        className="action-btn"
                        onClick={onExport}
                        title="Export Configuration"
                    >
                        Export Config
                    </button>
                </div>
            </div>

            <div
                className="subsection"
                style={{
                    marginTop: '32px',
                    paddingTop: '20px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                }}
            >
                <h4 style={{ color: '#f87171' }}>Danger Zone</h4>
                <p className="section-description">
                    Reset all settings to their default values. This will clear your council
                    selection and custom prompts. API keys will be preserved.
                </p>
                <button
                    className="reset-button"
                    type="button"
                    onClick={onResetDefaults}
                    style={{ marginTop: '10px' }}
                >
                    Reset to Defaults
                </button>
            </div>
        </section>
    );
}
