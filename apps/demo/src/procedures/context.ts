import type { Chat } from "chat";

export interface Context {
  chat: Chat;
  request: Request;
}
