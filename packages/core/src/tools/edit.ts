import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";

const EditParams = Type.Object({
  path: Type.String({ description: "File path (absolute or relative to workspace)" }),
  old_string: Type.String({ description: "Exact string to find and replace" }),
  new_string: Type.String({ description: "Replacement string" }),
  replace_all: Type.Optional(
    Type.Boolean({ description: "Replace all occurrences (default false)" }),
  ),
});

type EditParams = Static<typeof EditParams>;

export function createEditTool(workspacePath: string): AgentTool<typeof EditParams, undefined> {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Replace exact string matches in a file. By default requires exactly one match.",
    parameters: EditParams,

    async execute(
      _toolCallId: string,
      params: EditParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const absPath = resolve(workspacePath, params.path);
      const file = Bun.file(absPath);

      if (!(await file.exists())) {
        throw new Error(`File not found: ${params.path}`);
      }

      const text = await file.text();
      const { old_string, new_string, replace_all } = params;

      // Count occurrences
      let count = 0;
      let idx = 0;
      let firstMatchLine = -1;
      while (true) {
        idx = text.indexOf(old_string, idx);
        if (idx === -1) break;
        if (count === 0) {
          firstMatchLine = text.slice(0, idx).split("\n").length;
        }
        count++;
        idx += old_string.length;
      }

      if (count === 0) {
        throw new Error(`No match found for old_string in ${params.path}`);
      }

      if (!replace_all && count > 1) {
        throw new Error(
          `Found ${count} matches for old_string in ${params.path}. Use replace_all or provide a more specific string.`,
        );
      }

      let result: string;
      if (replace_all) {
        result = text.split(old_string).join(new_string);
      } else {
        const pos = text.indexOf(old_string);
        result =
          text.slice(0, pos) + new_string + text.slice(pos + old_string.length);
      }

      await Bun.write(absPath, result);

      const msg = replace_all
        ? `Replaced ${count} occurrences in ${params.path}`
        : `Replaced at line ${firstMatchLine} in ${params.path}`;

      const content: TextContent[] = [{ type: "text", text: msg }];
      return { content, details: undefined };
    },
  };
}
