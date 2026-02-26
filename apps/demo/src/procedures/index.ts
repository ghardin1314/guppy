import { health } from "./health";
import { slack } from "./webhooks/slack";
import { discord } from "./webhooks/discord";

export const router = {
  health,
  webhooks: {
    slack,
    discord,
  },
};
