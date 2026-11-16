import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { formatErrorMessage, isCancelledError, rawErrorDetail, reportError } from "../utils/errors";

vi.mock("../api/client", () => ({
  logClientError: vi.fn(async () => {}),
}));

describe("errors utility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects cancelled errors cleanly", () => {
    expect(isCancelledError({ code: "cancelled", message: "操作已取消" })).toBe(true);
    expect(isCancelledError({ code: "git", message: "failed" })).toBe(false);
    expect(isCancelledError("cancelled")).toBe(false);
  });

  it("strips Rust error prefixes and translates common git errors", () => {
    expect(formatErrorMessage({ code: "git", message: "git error: something broke" })).toBe(
      "something broke",
    );
    expect(
      formatErrorMessage({
        code: "git",
        message: "git error: fatal: Authentication failed for 'https://github.com/x.git'",
      }),
    ).toContain("远程认证失败");
    expect(
      formatErrorMessage({
        code: "git",
        message: "git error: ! [rejected] main -> main (non-fast-forward)",
      }),
    ).toContain("推送被拒绝");
  });

  it("extracts raw details and forwards non-cancelled errors to local logger", () => {
    expect(rawErrorDetail({ code: "io", message: "disk full" })).toBe("[io] disk full");

    const msg = reportError("pushRepo", {
      code: "git",
      message: "git error: could not resolve host",
    });
    expect(msg).toContain("无法连接远程仓库");
    expect(api.logClientError).toHaveBeenCalledWith(
      "error",
      "pushRepo",
      "[git] git error: could not resolve host",
    );

    reportError("fetchRemote", { code: "cancelled", message: "操作已取消" });
    expect(api.logClientError).toHaveBeenCalledTimes(1);
  });
});
