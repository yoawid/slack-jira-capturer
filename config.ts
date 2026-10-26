// Configuration: non-secret settings from a JSON file, secrets from env.
// Validated up front so a typo fails here with the key named, not three API
// calls later with a Jira 400.
import { readFileSync } from "node:fs";
import { z } from "zod";

const ChannelId = z.string().regex(/^[CG][A-Z0-9]+$/, "a Slack channel ID like C0123ABCDEF");

const ConfigSchema = z.object({
  slack: z
    .object({
      /** One channel to watch. Kept so existing configs keep working. */
      channel_id: ChannelId.optional(),
      /** Several channels to watch; combined with channel_id if both are set. */
      channel_ids: z.array(ChannelId).optional(),
      since_hours: z.number().int().positive().default(168),
    })
    .refine((s) => Boolean(s.channel_id) || (s.channel_ids?.length ?? 0) > 0, {
      message: "set channel_id or channel_ids (at least one Slack channel ID)",
      path: ["channel_id"],
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
          /** Option name for widget reports (Ybug, AIDA feedback), which never state a product area. */
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

/** Every channel to scan, in config order, without duplicates. */
export function channelIds(cfg: Config): string[] {
  const all = [...(cfg.slack.channel_id ? [cfg.slack.channel_id] : []), ...(cfg.slack.channel_ids ?? [])];
  return [...new Set(all)];
}

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
