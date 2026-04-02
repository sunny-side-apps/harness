import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.url({ message: "DATABASE_URL must be a valid connection string" }),
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  MCP_SERVICE_SECRET: z.string().min(1, "MCP_SERVICE_SECRET is required"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  MCP_PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APPROVAL_AUTO_APPROVE: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = z.prettifyError(result.error);
    console.error("Environment validation failed:\n", formatted);
    process.exit(1);
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) {
    throw new Error("Environment not loaded. Call loadEnv() first.");
  }
  return _env;
}
