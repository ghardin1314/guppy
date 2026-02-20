import { health } from "./health";
import { list, get, messages, prompt, stop, steer, events } from "./threads";

export const router = {
  health,
  threads: { list, get, messages, prompt, stop, steer, events },
};

export type Router = typeof router;
