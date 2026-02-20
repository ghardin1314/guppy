import { memo, useRef, useEffect, useCallback } from "react";
import { AgentMessage } from "@guppy/core";
import { AssistantMessageItem } from "./assistant-message";
import { UserMessageItem } from "./user-message";
import type { ToolResultsMap } from "./message-types";

const SCROLL_THRESHOLD = 50;

export const MessageList = memo(function MessageList({
  messages,
  toolResults,
}: {
  messages: { content: AgentMessage; id: string }[];
  toolResults: ToolResultsMap;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isNearBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-4"
    >
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          toolResults={toolResults}
        />
      ))}
    </div>
  );
});

const MessageItem = ({
  message,
  toolResults,
}: {
  message: { content: AgentMessage; id: string };
  toolResults: ToolResultsMap;
}) => {
  const { content } = message;
  switch (content.role) {
    case "assistant":
      return (
        <AssistantMessageItem message={content} toolResults={toolResults} />
      );
    case "user":
      return <UserMessageItem message={content} />;
    case "toolResult":
      return null;
  }
};
