import type { ToolResultMessage } from "./message-types";

export const ToolResultMessageItem = ({
  message,
}: {
  message: ToolResultMessage;
}) => {
  const text = message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
  const isRunning = message.content.length === 0;

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            ) : message.isError ? (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            )}
            <span className="text-zinc-400 font-mono">{message.toolName}</span>
          </div>
          {text && (
            <pre className="whitespace-pre-wrap font-mono text-zinc-500 max-h-32 overflow-y-auto mt-1">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
