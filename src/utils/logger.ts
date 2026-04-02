type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie/i;
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [REDACTED]"],
];

interface ParsedArgs {
  scope: string;
  message: string;
  extra?: unknown;
}

const sanitizeString = (value: string): string =>
  SECRET_VALUE_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );

export const sanitizeLogValue = (
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown => {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    const errorLike = value as Error & {
      code?: unknown;
      description?: unknown;
      status?: unknown;
    };

    return {
      name: errorLike.name,
      message: sanitizeString(errorLike.message),
      code: errorLike.code,
      status: errorLike.status,
      description:
        typeof errorLike.description === "string"
          ? sanitizeString(errorLike.description)
          : errorLike.description,
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (depth >= 4) {
    return "[Truncated]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeLogValue(entryValue, seen, depth + 1),
    ]),
  );
};

function parseArgs(
  scopeOrMessage: string,
  messageOrExtra?: string | unknown,
  maybeExtra?: unknown,
): ParsedArgs {
  if (typeof messageOrExtra === "string") {
    return {
      scope: scopeOrMessage,
      message: messageOrExtra,
      extra: maybeExtra,
    };
  }

  return {
    scope: "app",
    message: scopeOrMessage,
    extra: messageOrExtra,
  };
}

function write(
  level: LogLevel,
  scopeOrMessage: string,
  messageOrExtra?: string | unknown,
  maybeExtra?: unknown,
): void {
  const timestamp = new Date().toISOString();
  const { scope, message, extra } = parseArgs(
    scopeOrMessage,
    messageOrExtra,
    maybeExtra,
  );
  const prefix = `[${timestamp}] [${level}] [${scope}]`;

  if (extra === undefined) {
    console.log(`${prefix} ${sanitizeString(message)}`);
    return;
  }

  console.log(`${prefix} ${sanitizeString(message)}`, sanitizeLogValue(extra));
}

export const logger = {
  info(
    scopeOrMessage: string,
    messageOrExtra?: string | unknown,
    maybeExtra?: unknown,
  ): void {
    write("INFO", scopeOrMessage, messageOrExtra, maybeExtra);
  },
  warn(
    scopeOrMessage: string,
    messageOrExtra?: string | unknown,
    maybeExtra?: unknown,
  ): void {
    write("WARN", scopeOrMessage, messageOrExtra, maybeExtra);
  },
  error(
    scopeOrMessage: string,
    messageOrExtra?: string | unknown,
    maybeExtra?: unknown,
  ): void {
    write("ERROR", scopeOrMessage, messageOrExtra, maybeExtra);
  },
  debug(
    scopeOrMessage: string,
    messageOrExtra?: string | unknown,
    maybeExtra?: unknown,
  ): void {
    write("DEBUG", scopeOrMessage, messageOrExtra, maybeExtra);
  },
};
