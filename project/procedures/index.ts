import { health } from "./health";
import { list, get, prompt, stop, steer } from "./threads";

export const router = {
  health,
  threads: { list, get, prompt, stop, steer },
};

export type Router = typeof router;
