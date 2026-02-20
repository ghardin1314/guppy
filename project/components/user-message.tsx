import type { ImageBlock, UserMessage } from "./message-types";

export const UserMessageItem = ({ message }: { message: UserMessage }) => {
  if (typeof message.content === "string") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-blue-600 text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-blue-600 text-white whitespace-pre-wrap space-y-2">
        {message.content.map((content, i) => {
          if (content.type === "text") {
            return <span key={i}>{content.text}</span>;
          } else if (content.type === "image") {
            return <ImageContentItem key={i} content={content} />;
          }
          return null;
        })}
      </div>
    </div>
  );
};

const ImageContentItem = ({ content }: { content: ImageBlock }) => (
  <img
    src={`data:${content.mimeType};base64,${content.data}`}
    className="max-w-full rounded-lg"
  />
);
