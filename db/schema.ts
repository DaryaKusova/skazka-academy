import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One versioned document keeps multi-record plan edits atomic in D1. */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  document: text("document").notNull(),
});

export const authCredentials = sqliteTable("auth_credentials", {
  principalId: text("principal_id").primaryKey(),
  login: text("login").notNull().unique(),
  personId: text("person_id").unique(),
  salt: text("salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  iterations: integer("iterations").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  principalId: text("principal_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const authLoginAttempts = sqliteTable("auth_login_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStart: integer("window_start").notNull(),
});
