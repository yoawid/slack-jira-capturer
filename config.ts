// Configuration: non-secret settings from a JSON file, secrets from env.
// Validated up front so a typo fails here with the key named, not three API
// calls later with a Jira 400.
import { readFileSync } from "node:fs";
import { z } from "zod";

const ConfigSchema = z.object({
  slack: z.object({
    channel_id: z.string().regex(/^[CG][A-Z0-9]+$/, "a Slack channel ID like C0123ABCDEF"),
    since_hours: z.number().int().positive().default(168),
  }),
  jira: z.object({
    site: z.string().min(1),
    idea: z.object({
      project_key: z.string().min(1),
      issue_type_id: z.string().min(1),
      planning_status: z.object({ field_id: z.string().min(1), option_id: z.string().min(1) }).optional(),
      product_area: z
        .object({
          field_id: z.string().min(1),
          options: z.record(z.string(), z.string()),
          /** Option name to use for Ybug reports, which never state a product area. */
          default_for_ybug: z.string().optional(),
        })
        .optional(),
      /** Polaris rating field to receive the form's "Impact: N" (1–5). */
      impact_field_id: z.string().optional(),
    }),
    bug: z.object({
      project_key: z.string().min(1),
      issue_type_id: z.string().min(1),
    }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(json: string, origin = "config"): Config {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`${origin} is not valid JSON: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(data);
  if (!result.success) throw new Error(`${origin} is invalid:\n${z.prettifyError(result.error)}`);
  const cfg = result.data;
  const pa = cfg.jira.idea.product_area;
  if (pa?.default_for_ybug && !(pa.default_for_ybug in pa.options)) {
    throw new Error(`${origin}: product_area.default_for_ybug "${pa.default_for_ybug}" is not one of the options`);
  }
  return cfg;
}

export function loadConfig(path = process.env.CAPTURE_CONFIG || "./capture.config.json"): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Config file not found: ${path}. Copy capture.config.example.json to capture.config.json, or set CAPTURE_CONFIG.`,
    );
  }
  return parseConfig(raw, path);
}

export type Secrets = { slackBotToken: string; atlassianEmail: string; atlassianApiToken: string };

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  return {
    slackBotToken: need("SLACK_BOT_TOKEN"),
    atlassianEmail: need("ATLASSIAN_EMAIL"),
    atlassianApiToken: need("ATLASSIAN_API_TOKEN"),
  };
}
