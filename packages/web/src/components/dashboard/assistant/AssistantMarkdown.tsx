import { memo } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./assistant-markdown.css";

const SAFE_LINK = /^(?:https?:|mailto:)/i;

const markdownComponents: Components = {
  a: ({ href, children }) => {
    const safeHref = typeof href === "string" ? href : "";
    if (!SAFE_LINK.test(safeHref)) {
      return <span className="amd-text">{children}</span>;
    }
    return (
      <a
        className="amd-link"
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  // Remote images intentionally disabled: markdown images must not trigger
  // implicit network requests from the dashboard.
  img: ({ alt }) => (
    <span className="amd-image">
      {alt ? `[image: ${alt}]` : "[image]"}
    </span>
  ),
  table: ({ children }) => (
    <div className="amd-table-wrap" role="region" aria-label="Response table" tabIndex={0}>
      <table className="amd-table">{children}</table>
    </div>
  ),
};

export type AssistantMarkdownProps = {
  content: string;
  className?: string;
};

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  className,
}: AssistantMarkdownProps) {
  return (
    <div className={className ? `amd-body ${className}` : "amd-body"}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={defaultUrlTransform}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
});
