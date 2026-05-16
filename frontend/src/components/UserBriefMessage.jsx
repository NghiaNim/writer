import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import './UserBriefMessage.css';

/**
 * UserBriefMessage — renders the user's first message in a conversation.
 *
 * The first message persisted to a conversation is a scaffolded block:
 *
 *   TOPIC: <topic>
 *   AUDIENCE: <audience>
 *
 *   CORE IDEA:
 *   <one-paragraph spine>
 *
 *   USER BRIEF (collected from a short prep conversation):
 *   - Q: <question>
 *     A: <answer>
 *   ...
 *
 *   AUTHORS THE USER ADMIRES (lean toward this stylistic register without
 *   naming them in the essay): X, Y, Z
 *
 * OR (draft branch):
 *
 *   TOPIC: <topic>
 *   AUDIENCE: <audience>
 *
 *   USER'S DRAFT:
 *   <pasted draft>
 *
 * Rendered raw via ReactMarkdown, this looks like the LLM prompt the user
 * never wanted to see. This component parses the structure and surfaces:
 *
 *   - Topic as the heading
 *   - Audience as a subtle "for X" subline
 *   - Everything else hidden behind a "Show what I told the council" toggle
 *
 * Non-scaffolded messages (older conversations, manual sends) fall through
 * to a plain markdown render.
 */
function parseScaffoldedBrief(content) {
    if (!content || typeof content !== 'string') return null;
    const text = content.trim();
    if (!/^TOPIC\s*:/i.test(text)) return null;

    // Section headers we recognize. Order matters only for fallthrough — the
    // parser captures by header regardless of where it appears.
    const HEADERS = [
        { key: 'topic', label: 'Topic', re: /^TOPIC\s*:\s*(.*)$/i },
        { key: 'audience', label: 'Audience', re: /^AUDIENCE\s*:\s*(.*)$/i },
        { key: 'coreIdea', label: 'Core idea', re: /^CORE IDEA\s*:\s*(.*)$/i },
        { key: 'brief', label: 'Brief', re: /^USER BRIEF[^:]*:\s*(.*)$/i },
        { key: 'draft', label: 'Draft', re: /^USER'?S DRAFT\s*:\s*(.*)$/i },
        { key: 'authors', label: 'Authors', re: /^AUTHORS THE USER ADMIRES[^:]*:\s*(.*)$/i },
    ];

    const sections = {};
    let currentKey = null;
    let buffer = [];

    const commit = () => {
        if (currentKey) {
            sections[currentKey] = buffer.join('\n').trim();
        }
        buffer = [];
    };

    for (const line of text.split('\n')) {
        const matched = HEADERS.find((h) => h.re.test(line));
        if (matched) {
            commit();
            currentKey = matched.key;
            const m = line.match(matched.re);
            const inline = (m && m[1]) || '';
            if (inline.trim()) buffer.push(inline.trim());
            continue;
        }
        if (currentKey) buffer.push(line);
    }
    commit();

    // A valid scaffolded message has at minimum a topic. Without one, fall
    // back to raw rendering so we don't accidentally swallow a normal
    // message that happens to contain "TOPIC: ..." mid-text.
    if (!sections.topic) return null;
    return sections;
}

export default function UserBriefMessage({ content }) {
    const parsed = parseScaffoldedBrief(content);
    const [expanded, setExpanded] = useState(false);

    if (!parsed) {
        return (
            <div className="markdown-content">
                <ReactMarkdown>{content || ''}</ReactMarkdown>
            </div>
        );
    }

    const { topic, audience, coreIdea, brief, draft, authors } = parsed;
    const hasMore = !!(coreIdea || brief || draft || authors);

    return (
        <div className="user-brief">
            <div className="user-brief-headline">
                <span className="user-brief-label">Topic</span>
                <span className="user-brief-topic">{topic}</span>
            </div>
            {audience ? (
                <div className="user-brief-audience">for {audience}</div>
            ) : null}

            {hasMore && (
                <button
                    type="button"
                    className="user-brief-toggle"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                >
                    <span className="user-brief-toggle-icon" aria-hidden="true">
                        {expanded ? '▾' : '▸'}
                    </span>
                    {expanded
                        ? 'Hide what I told the council'
                        : 'Show what I told the council'}
                </button>
            )}

            {expanded && hasMore && (
                <div className="user-brief-details">
                    {coreIdea && (
                        <section className="user-brief-section">
                            <h4>Core idea</h4>
                            <div className="markdown-content">
                                <ReactMarkdown>{coreIdea}</ReactMarkdown>
                            </div>
                        </section>
                    )}
                    {brief && (
                        <section className="user-brief-section">
                            <h4>From the intake questions</h4>
                            <div className="markdown-content">
                                <ReactMarkdown>{brief}</ReactMarkdown>
                            </div>
                        </section>
                    )}
                    {draft && (
                        <section className="user-brief-section">
                            <h4>Your draft</h4>
                            <div className="markdown-content user-brief-draft">
                                <ReactMarkdown>{draft}</ReactMarkdown>
                            </div>
                        </section>
                    )}
                    {authors && (
                        <section className="user-brief-section">
                            <h4>Authors you admire</h4>
                            <div className="user-brief-authors">{authors}</div>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
