import { describe, it, expect } from "vitest";
import { createLogger, serializeError, type LogLevel } from "@/server/logging";

function capture(level: LogLevel | "silent" = "debug") {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
  const logger = createLogger({ level, sink: (lvl, line) => lines.push({ level: lvl, entry: JSON.parse(line) }) });
  return { logger, lines };
}

describe("logger", () => {
  it("writes one parseable JSON object per call with time, level and message", () => {
    const { logger, lines } = capture();
    logger.info("hello", { jobId: "j1" });
    expect(lines).toHaveLength(1);
    expect(lines[0].entry).toMatchObject({ level: "info", message: "hello", jobId: "j1" });
    expect(typeof lines[0].entry.time).toBe("string");
  });

  it("never emits secrets, even nested in logged objects", () => {
    const { logger, lines } = capture();
    logger.info("login", { user: { email: "a@b.test", password: "hunter2" }, headers: { authorization: "Bearer abc", cookie: "s=1" } });
    const raw = JSON.stringify(lines[0].entry);
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("Bearer abc");
    expect(raw).not.toContain("s=1");
    expect(raw).toContain("a@b.test");
  });

  it("child loggers add their bindings to every line", () => {
    const { logger, lines } = capture();
    logger.child({ correlationId: "c-1" }).child({ tenantId: "t-1" }).warn("w");
    expect(lines[0].entry).toMatchObject({ correlationId: "c-1", tenantId: "t-1", level: "warn" });
  });

  it("filters below the configured level", () => {
    const { logger, lines } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.error("e");
    expect(lines.map((l) => l.entry.message)).toEqual(["e"]);
  });

  it("serializes errors with name, message and stack", () => {
    expect(serializeError(new TypeError("boom"))).toMatchObject({ name: "TypeError", message: "boom" });
    expect(serializeError("oops")).toMatchObject({ message: "oops" });
  });
});
