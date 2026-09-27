import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Agent-output renderer. The worker prompt asks executors for Markdown, so
 * tables / links / headings in `resultData.output` must render formatted —
 * not as the raw source text the old whitespace-pre-wrap <p> showed.
 *
 * Plain-text outputs (no Markdown markers) keep the old <p> rendering so a
 * single-newline layout the author intended is preserved — Markdown would
 * collapse those line breaks into one paragraph.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) || // headings
    /```/.test(text) || // fenced code
    /^\s*\|.*\|\s*$/m.test(text) || // tables
    /\[[^\]]+\]\([^)]+\)/.test(text) || // links
    /^\s*([-*+]|\d+[.)])\s+/m.test(text) || // lists
    /\*\*[^*]+\*\*/.test(text) || // bold
    /^> /m.test(text) // quotes
  );
}

export function Markdown({ text }: { text: string }) {
  if (!looksLikeMarkdown(text)) {
    return <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{text}</p>;
  }
  return (
    <div className="text-sm text-ink-2 leading-relaxed space-y-3 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noreferrer' : undefined}
              className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="text-lg font-semibold text-ink">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold text-ink">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-ink">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold text-ink">{children}</h4>,
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line-2 pl-3 italic text-ink-3">{children}</blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded-sm font-mono text-xs bg-surface-2 px-1 py-0.5 break-all">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="rounded-lg text-xs font-mono text-ink bg-surface-2 border border-line p-3 overflow-x-auto whitespace-pre-wrap">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-surface-2 px-2 py-1.5 text-left font-semibold text-ink">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-line px-2 py-1.5 align-top">{children}</td>,
          hr: () => <hr className="border-line" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
