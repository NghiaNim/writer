import { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import './ThinkBlockRenderer.css';

function parseThinkBlocks(content) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = thinkRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) parts.push({ type: 'text', content: textBefore });
    }
    parts.push({ type: 'think', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const textAfter = content.slice(lastIndex).trim();
    if (textAfter) parts.push({ type: 'text', content: textAfter });
  }

  return parts;
}

function ThinkBlock({ content }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`think-block ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <button
        className="think-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="think-icon">💭</span>
        <span className="think-label">Reasoning</span>
        <span className="think-chevron">{isExpanded ? '▼' : '▶'}</span>
      </button>
      {isExpanded && (
        <div className="think-content">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export default function ThinkBlockRenderer({ content }) {
  const normalizedContent = typeof content === 'string' ? content : null;

  const parts = useMemo(
    () => (normalizedContent ? parseThinkBlocks(normalizedContent) : []),
    [normalizedContent]
  );

  if (!normalizedContent) {
    return <ReactMarkdown>{String(content || 'No response')}</ReactMarkdown>;
  }

  if (parts.length === 0) {
    return <ReactMarkdown>{normalizedContent}</ReactMarkdown>;
  }

  return (
    <>
      {parts.map((part, index) =>
        part.type === 'think' ? (
          <ThinkBlock key={index} content={part.content} />
        ) : (
          <div key={index} className="response-answer">
            <ReactMarkdown>{part.content}</ReactMarkdown>
          </div>
        )
      )}
    </>
  );
}
