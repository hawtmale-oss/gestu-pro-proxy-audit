/**
 * Node/Vitest shim for `cloudflare:workers` base classes.
 *
 * In Cloudflare's runtime (`workerd`), `cloudflare:workers` provides `WorkerEntrypoint` and
 * `DurableObject`. In local Node-based Vitest runs, this alias supplies minimal base classes
 * with identical constructor signatures (`(ctx, env)`).
 */

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
