import { execFile } from "node:child_process";
import { z } from "zod";

// The model alias the local Claude CLI is asked for. Sonnet keeps bulk spec extraction
// from eating the subscription's usage limits; change it here for a more capable model.
const CLAUDE_CLI_MODEL = "sonnet";
const TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const resultSchema = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
});

export interface ClaudeCliRequest<T> {
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  effort: "low" | "medium" | "high";
  /** A directory whose files the model may read (for images). Without it the model gets no tools at all. */
  readableDir?: string;
}

/** Runs the `claude` binary: arguments in, prompt on stdin, stdout back. Replaceable in tests. */
export type ClaudeExec = (args: string[], options: { stdin: string; cwd?: string }) => Promise<string>;

const runBinary: ClaudeExec = (args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile("claude", args, { cwd: options.cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) {
        const missing = "code" in error && error.code === "ENOENT";
        reject(new Error(missing ? "The `claude` command was not found. Install Claude Code and sign in, or set AI_PROVIDER=anthropic-api." : `claude exited with an error: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.end(options.stdin);
  });

/**
 * Asks the locally installed Claude CLI for a structured answer. It runs on the
 * signed-in Claude subscription, so there is no per-call API charge, but calls
 * count against that subscription's usage limits.
 * The CLI runs in restricted mode with no tools, or with the read-only file tool
 * confined to one directory when images are involved.
 */
export async function askClaudeCli<T>(request: ClaudeCliRequest<T>, exec: ClaudeExec = runBinary): Promise<T> {
  // The CLI rejects a schema that names its dialect, so Zod's "$schema" marker is dropped.
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(request.schema) };
  delete jsonSchema.$schema;
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    CLAUDE_CLI_MODEL,
    "--effort",
    request.effort,
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--system-prompt",
    request.system,
    "--json-schema",
    JSON.stringify(jsonSchema),
    ...(request.readableDir ? ["--tools", "Read", "--allowedTools", "Read", "--permission-mode", "dontAsk"] : ["--tools", ""]),
  ];
  const stdout = await exec(args, { stdin: request.prompt, cwd: request.readableDir });

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude CLI returned no usable ${request.task}: the output was not JSON`);
  }
  const result = resultSchema.parse(json);
  if (result.is_error || result.structured_output === undefined || result.structured_output === null) {
    throw new Error(`Claude CLI returned no usable ${request.task}: ${result.result ?? result.subtype ?? "no structured output"}`);
  }
  return request.schema.parse(result.structured_output);
}
