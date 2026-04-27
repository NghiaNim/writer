import './CouncilChips.css';

/**
 * Persona-chip status row visible during generation (extension #1, "show
 * the mechanism" choice A).
 *
 * Shows one chip per active council persona with its model name. As Stage 1
 * progresses, chips light up; as Stage 2 / Stage 3 run, the relevant chips
 * advance their status text. The Chairman gets its own gold-tinted chip.
 *
 * Props:
 *   - personas:    [{ key, name, model }]   in execution order
 *   - chairman:    { name, model }
 *   - stage1Done:  number — count of personas that have completed Stage 1
 *   - stage:       'idle' | 'search' | 'stage1' | 'stage2' | 'stage3' | 'done'
 *   - wordTarget:  optional integer
 *
 * The component is purely visual; the parent owns the actual progress state
 * (read off the SSE stream).
 */

const SHORT_MODEL_LABEL_OVERRIDES = {
  'openrouter:openai/gpt-4o': 'GPT-4o',
  'openrouter:openai/gpt-4o-mini': 'GPT-4o Mini',
  'openrouter:anthropic/claude-3.5-sonnet': 'Claude 3.5 Sonnet',
  'openrouter:anthropic/claude-3-opus': 'Claude 3 Opus',
  'openrouter:anthropic/claude-3-haiku': 'Claude 3 Haiku',
  'openrouter:google/gemini-pro-1.5': 'Gemini 1.5 Pro',
  'openrouter:google/gemini-flash-1.5': 'Gemini 1.5 Flash',
  'openrouter:meta-llama/llama-3.1-70b-instruct': 'Llama 3.1 70B',
  'openrouter:meta-llama/llama-3.1-405b-instruct': 'Llama 3.1 405B',
  'openrouter:mistralai/mistral-large': 'Mistral Large',
  'openrouter:deepseek/deepseek-chat': 'DeepSeek V3',
};

function shortModelLabel(modelId) {
  if (!modelId) return '';
  if (SHORT_MODEL_LABEL_OVERRIDES[modelId]) return SHORT_MODEL_LABEL_OVERRIDES[modelId];
  // Strip provider prefix
  const after = modelId.includes(':') ? modelId.split(':').slice(1).join(':') : modelId;
  // openai/gpt-4o -> GPT-4o
  const last = after.includes('/') ? after.split('/').pop() : after;
  return last;
}

function statusForPersona(stage, idx, stage1Done) {
  if (stage === 'idle' || stage === 'search') return 'waiting';
  if (stage === 'stage1') {
    return idx < stage1Done ? 'done' : 'working';
  }
  if (stage === 'stage2') return 'reviewing';
  if (stage === 'stage3') return 'done';
  if (stage === 'done') return 'done';
  return 'waiting';
}

function statusForChairman(stage) {
  if (stage === 'stage3') return 'working';
  if (stage === 'done') return 'done';
  return 'waiting';
}

const STATUS_LABEL = {
  waiting: 'queued',
  working: 'drafting',
  reviewing: 'peer review',
  done: 'done',
};

export default function CouncilChips({
  personas = [],
  chairman = null,
  stage = 'idle',
  stage1Done = 0,
  wordTarget = null,
}) {
  if (!personas.length && !chairman) return null;

  return (
    <div className="cchips-root">
      <div className="cchips-row">
        {personas.map((p, idx) => {
          const status = statusForPersona(stage, idx, stage1Done);
          return (
            <div key={p.key || idx} className={`cchip persona ${status}`}>
              <div className="cchip-pulse" aria-hidden="true" />
              <div className="cchip-main">
                <div className="cchip-name">{p.name}</div>
                <div className="cchip-model">{shortModelLabel(p.model)}</div>
              </div>
              <div className="cchip-status">{STATUS_LABEL[status]}</div>
            </div>
          );
        })}
        {chairman && (
          <div className={`cchip chairman ${statusForChairman(stage)}`}>
            <div className="cchip-pulse" aria-hidden="true" />
            <div className="cchip-main">
              <div className="cchip-name">Chairman</div>
              <div className="cchip-model">{shortModelLabel(chairman.model)}</div>
            </div>
            <div className="cchip-status">
              {STATUS_LABEL[statusForChairman(stage)]}
            </div>
          </div>
        )}
      </div>
      {wordTarget ? (
        <div className="cchips-meta">Target: ~{wordTarget} words</div>
      ) : null}
    </div>
  );
}
