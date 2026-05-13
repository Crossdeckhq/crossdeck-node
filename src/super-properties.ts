/**
 * Super-properties + group analytics — Mixpanel pattern.
 *
 * Super properties are key/value pairs the developer registers ONCE
 * via `server.register({ tenant: "acme" })` that get attached to
 * every subsequent event of THIS SDK instance. They're the single
 * most-used feature in Mixpanel-style analytics: "every event from
 * this process should have `tenant` and `serviceName` on it" instead
 * of remembering to pass them on every `track()` call.
 *
 * Groups are organisational identifiers: a customer might belong to
 * an `org` ("acme"), a `team` ("design"), and a `plan` ("enterprise").
 * Each event carries `$groups.{type}: id` so B2B dashboards can pivot:
 * "Acme's team:design fired 142 paywall_shown events this week".
 *
 * Node port differences from `@cross-deck/web/src/super-properties.ts`:
 *   - No `KeyValueStorage` backing. In-memory only. Node processes are
 *     short-lived (Lambda freezes between invocations, Cloud Functions
 *     tear down containers); super-properties typically belong to the
 *     SDK instance lifetime, not persistence-across-process.
 *   - The Store reset clears both bags (parity with web's clear()).
 *
 * The store is reset on `server.shutdown()` — both super properties
 * and groups are cleared because their lifetime is tied to the SDK
 * instance, not to the process.
 */

export interface GroupMembership {
  id: string;
  traits?: Record<string, unknown>;
}

export class SuperPropertyStore {
  private superProps: Record<string, unknown> = {};
  private groups: Record<string, GroupMembership> = {};

  /**
   * Merge new keys into the super-property bag. Returns a snapshot
   * of the resulting bag. Values that are `null` are deleted
   * (Mixpanel's explicit "stop tracking this key" idiom).
   */
  register(props: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(props)) {
      if (v === null) {
        delete this.superProps[k];
      } else if (v !== undefined) {
        this.superProps[k] = v;
      }
    }
    return { ...this.superProps };
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    if (key in this.superProps) {
      delete this.superProps[key];
    }
  }

  /** Defensive snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    return { ...this.superProps };
  }

  /**
   * Set a group membership. Passing `id: null` clears the membership
   * for that type — the SDK stops attaching it to events.
   */
  setGroup(type: string, id: string | null, traits?: Record<string, unknown>): void {
    if (id === null) {
      delete this.groups[type];
    } else {
      this.groups[type] = traits !== undefined ? { id, traits } : { id };
    }
  }

  /**
   * Defensive snapshot of the current groups map, keyed by group type.
   * The `traits` sub-object is the most-recent traits payload passed
   * to `setGroup` for that type.
   */
  getGroups(): Record<string, GroupMembership> {
    // Defensive deep copy — caller mutations to traits don't bleed
    // into the store.
    const out: Record<string, GroupMembership> = {};
    for (const [type, membership] of Object.entries(this.groups)) {
      out[type] = {
        id: membership.id,
        ...(membership.traits ? { traits: { ...membership.traits } } : {}),
      };
    }
    return out;
  }

  /**
   * Flat `{ type: id }` projection used for event-attachment. Stable
   * for fast every-event merge — we don't JSON-clone on each
   * `track()` call (hot path).
   */
  getGroupIds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [type, info] of Object.entries(this.groups)) {
      out[type] = info.id;
    }
    return out;
  }

  /** Wipe both bags. Called by `server.shutdown()`. */
  clear(): void {
    this.superProps = {};
    this.groups = {};
  }
}
