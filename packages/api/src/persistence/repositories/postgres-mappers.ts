function toIsoString(
  value: Date | string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function requiredIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function optionalIsoString(
  value: Date | string | null | undefined,
): string | undefined {
  return toIsoString(value);
}

export function toDateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

export function toJsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
