import { ThreadSidebar } from "../components/thread-sidebar";

export default function ChatIndex() {
  return (
    <div className="flex h-screen">
      <ThreadSidebar />
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        Create or select a thread to start chatting
      </div>
    </div>
  );
}
