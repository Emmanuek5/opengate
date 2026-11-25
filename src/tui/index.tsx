import { render } from "ink";
import { App } from "./app";
import { Controller } from "./controller";
import { LineTui, type TuiOptions } from "./line";
import { c } from "./theme";

export { PrintUI } from "./print";
export { ago, c } from "./theme";
export { LineTui, type TuiOptions } from "./line";
export { Controller } from "./controller";

/**
 * The interactive terminal UI: a full Ink app on a terminal, the plain line UI otherwise
 * (piped stdin/stdout, TERM=dumb, or OPENGATE_PLAIN=1).
 */
export class Tui {
  constructor(private o: TuiOptions) {}

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb" || process.env.OPENGATE_PLAIN) {
      await new LineTui(this.o).run();
      // The line UI exits the process itself when stdin closes or on /exit.
      return new Promise<void>(() => {});
    }
    const ctl = new Controller(this.o);
    ctl.start();
    const ink = render(<App ctl={ctl} />, {
      exitOnCtrlC: false,
      patchConsole: true,
      maxFps: 30,
      incrementalRendering: true,
      kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
    });
    const stop = () => ctl.exit();
    const signals = (["SIGTERM", "SIGHUP"] as const).filter((sig) => {
      try {
        process.on(sig, stop);
        return true;
      } catch {
        return false; // not every signal exists on every platform
      }
    });
    try {
      await ink.waitUntilExit();
    } finally {
      for (const sig of signals) process.off(sig, stop);
    }
    const s = ctl.session;
    await Promise.race([s.dispose().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    if (s.data.messages.length) process.stdout.write(c.dim(`Resume this session with: opengate -r ${s.id}\n`));
  }
}
