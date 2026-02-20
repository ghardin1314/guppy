import type {
  AssistantMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultsMap,
} from "./message-types";

export const AssistantMessageItem = ({
  message,
  toolResults,
}: {
  message: AssistantMessage;
  toolResults: ToolResultsMap;
}) => {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] space-y-2">
        {message.content.map((content, i) => {
          if (content.type === "text") {
            return <TextContentItem key={i} content={content} />;
          } else if (content.type === "thinking") {
            return <ThinkingContentItem key={i} content={content} />;
          } else if (content.type === "toolCall") {
            return (
              <ToolCallItem
                key={i}
                content={content}
                toolResults={toolResults}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
};

const TextContentItem = ({ content }: { content: TextBlock }) => (
  <div className="rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-zinc-800 text-zinc-200">
    <pre className="whitespace-pre-wrap font-[inherit]">{content.text}</pre>
  </div>
);

const ThinkingContentItem = ({ content }: { content: ThinkingBlock }) => (
  <details className="rounded-xl bg-zinc-900 border border-zinc-800 text-xs">
    <summary className="px-4 py-2 text-zinc-500 cursor-pointer select-none">
      Thinking...
    </summary>
    <pre className="whitespace-pre-wrap font-mono text-zinc-600 px-4 pb-2 max-h-48 overflow-y-auto">
      {content.thinking}
    </pre>
  </details>
);

const ToolCallItem = ({
  content,
  toolResults,
}: {
  content: ToolCallBlock;
  toolResults: ToolResultsMap;
}) => {
  const result = toolResults.get(content.id);
  const isError = result?.isError;
  const isPending = !isError && result?.content.length === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {isPending ? (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        ) : isError ? (
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        )}
        <span className="text-zinc-400 font-mono">{content.name}</span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-zinc-600 max-h-20 overflow-y-auto mt-1">
        {JSON.stringify(content.arguments, null, 2)}
      </pre>
      {result && (
        <pre className="whitespace-pre-wrap font-mono text-zinc-500 max-h-32 overflow-y-auto mt-1">
          {result.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")}
        </pre>
        // TODO: handle image content
      )}
    </div>
  );
};
