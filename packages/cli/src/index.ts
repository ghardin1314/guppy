#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { create } from "./commands/create";
import { addTransportCommand } from "./commands/add-transport";
import type { TransportId } from "./transports/types";
import type { DeployTarget } from "./scaffold/templates/deploy";

const VERSION = "0.0.1";

const HELP = `
guppy — scaffold and manage Guppy agents

Commands:
  create [name]         Create a new Guppy agent project
  add transport [id]    Add a transport to an existing project

Options:
  --help, -h            Show help
  --version, -v         Show version

Run \`guppy <command> --help\` for command-specific options.
`.trim();

const CREATE_HELP = `
guppy create [name] — scaffold a new Guppy agent project

Arguments:
  name                  Bot name (lowercase, hyphens). Prompted if omitted.

Options:
  -p, --provider <id>     Model provider (anthropic, openai, google, mistral, xai, groq, openrouter)
  -m, --model <id>        Model ID (e.g. claude-sonnet-4-5, gpt-4o)
  -k, --api-key <key>     API key for the model provider
  -t, --transport <id>    Transport to add (slack, discord, teams, gchat). Repeatable.
  -e, --env <KEY=VALUE>   Set an env var (credentials, etc). Repeatable.
  -u, --base-url <url>    Public URL where the bot will be reachable
  -d, --deploy <target>   Deploy target (manual, docker-compose, systemd, railway, fly)
  -h, --help              Show this help

All options are prompted interactively if omitted.

Examples:
  guppy create
  guppy create my-agent
  guppy create my-agent -p anthropic -m claude-sonnet-4-5 -t slack -t discord
  guppy create my-agent -p anthropic -m claude-sonnet-4-5 -k sk-ant-... \\
    -t slack -e SLACK_BOT_TOKEN=xoxb-... -e SLACK_SIGNING_SECRET=... \\
    -u https://my-agent.up.railway.app -d railway
`.trim();

const ADD_TRANSPORT_HELP = `
guppy add transport [id] — add a transport to an existing project

Arguments:
  id                    Transport ID (slack, discord, teams, gchat). Prompted if omitted.

Run this from the root of a Guppy project (where src/index.ts exists).
Detects already-configured transports and prompts for credentials.

Examples:
  guppy add transport
  guppy add transport slack
  guppy add transport discord
`.trim();

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || (args[0] !== "create" && args[0] !== "add" && hasFlag(args, "--help", "-h"))) {
    console.log(HELP);
    return;
  }

  if (hasFlag(args, "--version", "-v")) {
    console.log(VERSION);
    return;
  }

  const command = args[0];

  if (command === "create") {
    if (hasFlag(args, "--help", "-h")) {
      console.log(CREATE_HELP);
      return;
    }

    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        transport: { type: "string", multiple: true, short: "t" },
        provider: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        "api-key": { type: "string", short: "k" },
        env: { type: "string", multiple: true, short: "e" },
        deploy: { type: "string", short: "d" },
        "base-url": { type: "string", short: "u" },
      },
      allowPositionals: true,
    });

    const name = positionals[0];
    const transports = values.transport as TransportId[] | undefined;
    const provider = values.provider;
    const model = values.model;
    const apiKey = values["api-key"];
    const deployTarget = values.deploy as DeployTarget | undefined;
    const baseUrl = values["base-url"];

    // Parse --env KEY=VALUE pairs into a record
    const envVars: Record<string, string> = {};
    for (const entry of values.env ?? []) {
      const eq = entry.indexOf("=");
      if (eq === -1) {
        console.error(`Invalid --env format: ${entry} (expected KEY=VALUE)`);
        process.exit(1);
      }
      envVars[entry.slice(0, eq)] = entry.slice(eq + 1);
    }

    create({ name, transports, provider, model, apiKey, envVars, deployTarget, baseUrl });
    return;
  }

  if (command === "add" && args[1] === "transport") {
    if (hasFlag(args, "--help", "-h")) {
      console.log(ADD_TRANSPORT_HELP);
      return;
    }

    const transportId = args[2] as TransportId | undefined;
    addTransportCommand(process.cwd(), transportId);
    return;
  }

  console.error(`Unknown command: ${args.join(" ")}`);
  console.error("Run \`guppy --help\` for usage.");
  process.exit(1);
}

main();
