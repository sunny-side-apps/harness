import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  approvalChannel: text("approval_channel"), // 'slack' | 'telegram' | null
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const activeSessions = pgTable("active_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  agentId: uuid("agent_id").references(() => agents.id),
  dsl: text("dsl"),
  cedar: text("cedar"),
  sidecar: text("sidecar"), // JSON string of ApplicationSidecar
  naturalLanguage: text("natural_language"),
  enabled: boolean("enabled").default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  version: integer("version").default(1),
  source: text("source").default("manual"), // 'manual' | 'approval'
  autoExpire: boolean("auto_expire").default(false),
});

export const sessionGrants = pgTable("session_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => activeSessions.id),
  action: text("action").notNull(),
  grantType: text("grant_type").notNull(), // 'once' | 'session'
  consumed: boolean("consumed").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  decision: text("decision").notNull(), // 'permit' | 'deny' | 'pending_approval'
  matchedPolicies: text("matched_policies").array(),
  workflowRunId: text("workflow_run_id"),
  outcome: text("outcome").notNull(), // 'executed' | 'blocked' | 'pending_approval'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
