import pino from "pino";

export function createRedactor(extra: string[] = []): (text: string) => string {
  const secrets = [
    ...extra,
    ...Object.entries(process.env)
      .filter(([name]) =>
        /TOKEN|PASSWORD|SECRET|API_KEY|DATABASE_URL/.test(name),
      )
      .map(([, value]) => value),
  ]
    .filter((value): value is string => !!value && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (text) =>
    secrets.reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      text,
    );
}
export function redactValue(
  value: unknown,
  redact: (text: string) => string,
): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, redact),
      ]),
    );
  return value;
}
export function runtimeLogger(redact: (text: string) => string) {
  const logger = pino({ level: "warn" }, pino.destination(2));
  return {
    info: (entry: unknown) => logger.info(redact(String(entry))),
    debug: (entry: unknown) => logger.debug(redact(String(entry))),
    warn: (entry: unknown) => logger.warn(redact(String(entry))),
    error: (entry: unknown) => logger.error(redact(String(entry))),
  };
}
