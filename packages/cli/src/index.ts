import { Command } from "commander";
import { registerInit } from "./commands/init.ts";
import { registerStart } from "./commands/start.ts";

export const program = new Command()
  .name("guppy")
  .description("The Guppy framework CLI")
  .version("0.0.0");

registerInit(program);
registerStart(program);
