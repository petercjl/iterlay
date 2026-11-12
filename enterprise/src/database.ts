import pg from "pg";
import type { PoolClient } from "pg";

export const schema = `
CREATE TABLE IF NOT EXISTS tuda_members (
 org_id text NOT NULL, user_id text NOT NULL, union_id text NOT NULL, name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','editor','viewer')), active boolean NOT NULL DEFAULT true,
 checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,user_id));
CREATE TABLE IF NOT EXISTS tuda_sessions (
 token_hash text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(org_id,user_id) REFERENCES tuda_members(org_id,user_id));
CREATE TABLE IF NOT EXISTS tuda_logins (
 id uuid PRIMARY KEY, state_hash text UNIQUE NOT NULL, verifier_hash text NOT NULL, expires_at timestamptz NOT NULL,
 result text, error text, used boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS tuda_boards (
 org_id text NOT NULL, id text NOT NULL, epoch uuid NOT NULL, state bytea NOT NULL,
 revision bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,id));
CREATE TABLE IF NOT EXISTS tuda_board_updates (
 org_id text NOT NULL, board_id text NOT NULL, epoch uuid NOT NULL, revision bigint NOT NULL,
 update bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,board_id,epoch,revision));
CREATE TABLE IF NOT EXISTS tuda_documents (org_id text NOT NULL, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(org_id,key));
CREATE TABLE IF NOT EXISTS tuda_receipts (
 org_id text NOT NULL, user_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,user_id,request_id));
CREATE TABLE IF NOT EXISTS tuda_assets (
 org_id text NOT NULL, id uuid NOT NULL, name text NOT NULL, mime text NOT NULL, size bigint NOT NULL,
 hash text NOT NULL, file text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,id));
CREATE TABLE IF NOT EXISTS tuda_jobs (
 org_id text NOT NULL, id uuid NOT NULL, user_id text NOT NULL, request_hash text NOT NULL,
 input jsonb NOT NULL, status text NOT NULL CHECK(status IN ('queued','submitting','running','succeeded','failed','unknown','cancelled')),
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,id));
CREATE TABLE IF NOT EXISTS tuda_provider_accounts (
 org_id text NOT NULL, user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('image','text')),
 secret text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,user_id,kind),
 FOREIGN KEY(org_id,user_id) REFERENCES tuda_members(org_id,user_id));
ALTER TABLE tuda_jobs ADD COLUMN IF NOT EXISTS provider_secret text;
CREATE TABLE IF NOT EXISTS tuda_audit (
 id bigserial PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, action text NOT NULL,
 target text, created_at timestamptz NOT NULL DEFAULT now());
`;

export class Database {
  readonly pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 10_000 }); this.pool.on("error", () => console.error("Enterprise database connection interrupted")); }
  async initialize() {
    await this.transaction(async client => { await client.query("SELECT pg_advisory_xact_lock(851437)"); await client.query(schema); });
  }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  close() { return this.pool.end(); }
}
