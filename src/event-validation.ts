/**
 * Property validation + coercion for Node SDK payloads.
 *
 * Ported directly from `@cross-deck/web` so web + node share the same
 * sanitisation contract for traits and event property bags.
 */

type EventProperties = Record<string, unknown>;

export interface ValidationOptions {
  maxStringLength?: number;
  maxBatchPropertyBytes?: number;
  maxDepth?: number;
}

export interface ValidationWarning {
  kind:
    | "dropped_function"
    | "dropped_symbol"
    | "dropped_undefined"
    | "coerced_date"
    | "coerced_bigint"
    | "coerced_error"
    | "coerced_map"
    | "coerced_set"
    | "truncated_string"
    | "circular_reference"
    | "depth_exceeded"
    | "non_serialisable"
    | "size_cap_exceeded";
  key: string;
}

export interface ValidationResult {
  properties: EventProperties;
  warnings: ValidationWarning[];
}

const DEFAULT_MAX_STRING = 1024;
const DEFAULT_MAX_BYTES = 8 * 1024;
const DEFAULT_MAX_DEPTH = 5;

export function validateEventProperties(
  input: EventProperties | undefined,
  options: ValidationOptions = {},
): ValidationResult {
  const warnings: ValidationWarning[] = [];
  if (!input) return { properties: {}, warnings };

  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const maxBatchPropertyBytes = options.maxBatchPropertyBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const seen = new WeakSet<object>();

  const visit = (
    value: unknown,
    key: string,
    depth: number,
  ): { keep: boolean; value: unknown } => {
    if (depth > maxDepth) {
      warnings.push({ kind: "depth_exceeded", key });
      return { keep: true, value: "[depth-exceeded]" };
    }
    if (value === null) return { keep: true, value: null };
    const t = typeof value;
    if (t === "string") {
      const s = value as string;
      if (s.length > maxStringLength) {
        warnings.push({ kind: "truncated_string", key });
        return { keep: true, value: s.slice(0, maxStringLength - 1) + "…" };
      }
      return { keep: true, value: s };
    }
    if (t === "number") {
      if (!Number.isFinite(value as number)) {
        warnings.push({ kind: "non_serialisable", key });
        return { keep: true, value: null };
      }
      return { keep: true, value };
    }
    if (t === "boolean") return { keep: true, value };
    if (t === "bigint") {
      warnings.push({ kind: "coerced_bigint", key });
      return { keep: true, value: (value as bigint).toString() };
    }
    if (t === "function") {
      warnings.push({ kind: "dropped_function", key });
      return { keep: false, value: undefined };
    }
    if (t === "symbol") {
      warnings.push({ kind: "dropped_symbol", key });
      return { keep: false, value: undefined };
    }
    if (t === "undefined") {
      warnings.push({ kind: "dropped_undefined", key });
      return { keep: false, value: undefined };
    }

    if (value instanceof Date) {
      warnings.push({ kind: "coerced_date", key });
      const iso = Number.isFinite(value.getTime()) ? value.toISOString() : null;
      return { keep: true, value: iso };
    }
    if (value instanceof Error) {
      warnings.push({ kind: "coerced_error", key });
      return {
        keep: true,
        value: {
          name: value.name,
          message: value.message,
          stack:
            typeof value.stack === "string"
              ? value.stack.slice(0, maxStringLength)
              : undefined,
        },
      };
    }
    if (value instanceof Map) {
      warnings.push({ kind: "coerced_map", key });
      const obj: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        const subKey = typeof k === "string" ? k : String(k);
        const result = visit(v, `${key}.${subKey}`, depth + 1);
        if (result.keep) obj[subKey] = result.value;
      }
      return { keep: true, value: obj };
    }
    if (value instanceof Set) {
      warnings.push({ kind: "coerced_set", key });
      const arr: unknown[] = [];
      let i = 0;
      for (const v of value.values()) {
        const result = visit(v, `${key}[${i}]`, depth + 1);
        if (result.keep) arr.push(result.value);
        i++;
      }
      return { keep: true, value: arr };
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        warnings.push({ kind: "circular_reference", key });
        return { keep: true, value: "[circular]" };
      }
      seen.add(value);
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const result = visit(value[i], `${key}[${i}]`, depth + 1);
        if (result.keep) out.push(result.value);
      }
      return { keep: true, value: out };
    }

    if (t === "object") {
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) {
        warnings.push({ kind: "circular_reference", key });
        return { keep: true, value: "[circular]" };
      }
      seen.add(obj);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        const result = visit(obj[k], `${key}.${k}`, depth + 1);
        if (result.keep) out[k] = result.value;
      }
      return { keep: true, value: out };
    }

    warnings.push({ kind: "non_serialisable", key });
    try {
      return { keep: true, value: String(value) };
    } catch {
      return { keep: false, value: undefined };
    }
  };

  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const result = visit(input[k], k, 0);
    if (result.keep) cleaned[k] = result.value;
  }

  const serialised = safeStringify(cleaned);
  if (serialised && byteLength(serialised) > maxBatchPropertyBytes) {
    warnings.push({ kind: "size_cap_exceeded", key: "*" });
    const sizes = Object.keys(cleaned)
      .map((k) => ({ k, size: byteLength(safeStringify(cleaned[k]) ?? "") }))
      .sort((a, b) => b.size - a.size);
    let currentSize = byteLength(serialised);
    for (const { k } of sizes) {
      if (currentSize <= maxBatchPropertyBytes) break;
      currentSize -= sizes.find((s) => s.k === k)!.size;
      delete cleaned[k];
    }
    cleaned.__truncated = true;
  }

  return { properties: cleaned, warnings };
}

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

function byteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s).length;
  }
  return s.length * 4;
}
