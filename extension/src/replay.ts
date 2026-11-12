// What the diagram panel must show again when its webview reloads. No vscode import.
import type { HostMessage } from "./protocol";

type Of<T extends HostMessage["type"]> = Extract<HostMessage, { type: T }>;

export class Replay {
  private graph: Of<"graph"> | undefined;
  private paper: Of<"paper"> | undefined;
  private located: Of<"locate"> | undefined;
  private notice: Of<"notice"> | Of<"clearNotice"> | undefined;

  /** Stages and a location belong to one graph, so a new graph forgets them. */
  remember(message: HostMessage): void {
    if (message.type === "graph") {
      this.graph = message;
      this.paper = undefined;
      this.located = undefined;
    } else if (message.type === "paper") {
      this.paper = message;
    } else if (message.type === "locate") {
      this.located = message;
    } else if (message.type === "notice" || message.type === "clearNotice") {
      this.notice = message;
    }
  }

  reset(): void {
    this.graph = this.paper = this.located = this.notice = undefined;
  }

  /** In the order the webview needs them: the graph first, then what refers to it. */
  messages(): HostMessage[] {
    if (!this.graph) return this.notice ? [this.notice] : [];
    const all: (HostMessage | undefined)[] = [this.graph, this.paper, this.located, this.notice];
    return all.filter((m): m is HostMessage => m !== undefined);
  }
}
