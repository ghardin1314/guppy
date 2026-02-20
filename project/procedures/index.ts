import { health } from "./health";
import { list, get } from "./threads";

export const router = {
  health,
  threads: { list, get },
};

export type Router = typeof router;
