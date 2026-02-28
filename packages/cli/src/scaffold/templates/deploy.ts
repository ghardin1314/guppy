export type DeployTarget =
  | "systemd"
  | "docker-compose"
  | "railway"
  | "fly"
  | "manual";

interface DeployFile {
  path: string;
  content: string;
}

const DOCKERFILE = `FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 80
CMD ["bun", "src/index.ts"]
`;

function systemdFiles(name: string): DeployFile[] {
  return [
    {
      path: `${name}.service`,
      content: `[Unit]
Description=${name}
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/${name}
ExecStart=/usr/local/bin/bun src/index.ts
Restart=on-failure
EnvironmentFile=/opt/${name}/.env

[Install]
WantedBy=multi-user.target
`,
    },
  ];
}

function dockerComposeFiles(name: string): DeployFile[] {
  return [
    { path: "Dockerfile", content: DOCKERFILE },
    {
      path: "docker-compose.yml",
      content: `services:
  ${name}:
    build: .
    ports:
      - "\${PORT:-80}:\${PORT:-80}"
    env_file:
      - .env
    restart: unless-stopped
`,
    },
  ];
}

function railwayFiles(): DeployFile[] {
  return [
    { path: "Dockerfile", content: DOCKERFILE },
    {
      path: "railway.toml",
      content: `[build]
builder = "dockerfile"

[deploy]
restartPolicyType = "on_failure"
`,
    },
  ];
}

function flyFiles(name: string): DeployFile[] {
  return [
    { path: "Dockerfile", content: DOCKERFILE },
    {
      path: "fly.toml",
      content: `app = "${name}"

[build]

[http_service]
  internal_port = 80
  force_https = true

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
`,
    },
  ];
}

export function getDeployFiles(
  target: DeployTarget,
  name: string,
): DeployFile[] {
  switch (target) {
    case "systemd":
      return systemdFiles(name);
    case "docker-compose":
      return dockerComposeFiles(name);
    case "railway":
      return railwayFiles();
    case "fly":
      return flyFiles(name);
    case "manual":
      return [];
  }
}
