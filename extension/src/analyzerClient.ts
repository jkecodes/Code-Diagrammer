import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ClassInfo, Graph, InputSpec, ScannedClass } from "./ir";

export type AnalyzerError = {
  kind: "python-not-found" | "timeout" | "bad-output" | "syntax" | "not-found" | "bad-request" | "internal"
    | "cancelled";
  message: string;
  log: string;
};

export type Result<T> = { ok: true; value: T; log?: string } | { ok: false; error: AnalyzerError };

export type StaticRequest = { file: string; entry: string; workspaceRoot: string };

export type TraceRequest = StaticRequest & {
  ctorKwargs: Record<string, unknown>;
  inputs: Record<string, InputSpec>;
  device: "auto" | "meta" | "cpu";
};

export type AnalyzerOptions = {
  pythonPath: string | (() => string); // a function is called for every request
  analyzerDir: string; // folder that contains the `code_diagrammer` package
  timeoutMs: number;
  moduleName?: string;
};

/** Runs the Python analyzer as a subprocess: one JSON request on stdin, one JSON response on stdout. */
export class AnalyzerClient {
  constructor(private readonly opts: AnalyzerOptions) {}

  async listClasses(file: string): Promise<Result<ClassInfo[]>> {
    return this.run({ command: "list", file }, (r) => r.classes as ClassInfo[]);
  }

  async scan(workspaceRoot: string, signal?: AbortSignal): Promise<Result<ScannedClass[]>> {
    return this.run({ command: "scan", workspaceRoot }, (r) => r.classes as ScannedClass[], signal);
  }

  async analyzeStatic(req: StaticRequest, signal?: AbortSignal): Promise<Result<Graph>> {
    return this.run({ command: "static", ...req }, (r) => r.graph as Graph, signal);
  }

  async trace(req: TraceRequest): Promise<Result<Graph>> {
    return this.run({ command: "trace", ...req }, (r) => r.graph as Graph);
  }

  private run<T>(request: object, pick: (response: any) => T, signal?: AbortSignal): Promise<Result<T>> {
    const { analyzerDir, timeoutMs, moduleName } = this.opts;
    const cancelled: Result<T> = {
      ok: false, error: { kind: "cancelled", message: "The analysis was cancelled", log: "" },
    };
    if (signal?.aborted) return Promise.resolve(cancelled);
    const pythonPath = typeof this.opts.pythonPath === "function" ? this.opts.pythonPath() : this.opts.pythonPath;
    return new Promise((resolve) => {
      const existing = process.env.PYTHONPATH;
      const child = spawn(pythonPath, ["-X", "utf8", "-m", moduleName ?? "code_diagrammer"], {
        shell: false, // never build a command string: paths may contain spaces
        windowsHide: true,
        cwd: analyzerDir, // never the workspace: its files must not shadow the analyzer's imports
        env: {
          ...process.env,
          PYTHONPATH: existing ? analyzerDir + path.delimiter + existing : analyzerDir,
          PYTHONIOENCODING: "utf-8",
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (result: Result<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        child.kill();
        finish(cancelled);
      };
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        child.kill();
        finish({
          ok: false,
          error: {
            kind: "timeout",
            message: `The analyzer did not finish within ${Math.round(timeoutMs / 1000)} s`,
            log: Buffer.concat(err).toString("utf8"),
          },
        });
      }, timeoutMs);

      child.on("error", (e: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          error: {
            kind: e.code === "ENOENT" ? "python-not-found" : "internal",
            message: e.code === "ENOENT" ? `Python interpreter not found: ${pythonPath}` : e.message,
            log: String(e),
          },
        });
      });
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.stdin.on("error", () => undefined); // the process may exit before reading
      child.on("close", () => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        let response: any;
        try {
          response = JSON.parse(stdout);
        } catch {
          finish({
            ok: false,
            error: {
              kind: "bad-output",
              message: "The analyzer did not return a valid response",
              log: stderr || stdout,
            },
          });
          return;
        }
        if (response && response.ok === true) {
          finish({ ok: true, value: pick(response), log: response.log });
        } else {
          const e = response?.error ?? {};
          finish({
            ok: false,
            error: {
              kind: e.kind ?? "internal",
              message: e.message ?? "The analyzer reported an error",
              log: e.log || stderr,
            },
          });
        }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}
