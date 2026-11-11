import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ClassInfo, Graph, InputSpec } from "./ir";

export type AnalyzerError = {
  kind: "python-not-found" | "timeout" | "bad-output" | "syntax" | "not-found" | "bad-request" | "internal";
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
  pythonPath: string;
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

  async analyzeStatic(req: StaticRequest): Promise<Result<Graph>> {
    return this.run({ command: "static", ...req }, (r) => r.graph as Graph);
  }

  async trace(req: TraceRequest): Promise<Result<Graph>> {
    return this.run({ command: "trace", ...req }, (r) => r.graph as Graph);
  }

  private run<T>(request: object, pick: (response: any) => T): Promise<Result<T>> {
    const { pythonPath, analyzerDir, timeoutMs, moduleName } = this.opts;
    return new Promise((resolve) => {
      const existing = process.env.PYTHONPATH;
      const child = spawn(pythonPath, ["-X", "utf8", "-m", moduleName ?? "code_diagrammer"], {
        shell: false, // never build a command string: paths may contain spaces
        windowsHide: true,
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
        resolve(result);
      };
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
