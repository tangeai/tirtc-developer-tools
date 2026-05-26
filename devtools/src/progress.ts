const SPINNER_FRAMES = ['|', '/', '-', '\\'];
export const SPINNER_INTERVAL_MS = 120;

type ProgressStream = {
  isTTY?: boolean;
  write(chunk: string): boolean;
};

function clearLine(text: string): string {
  return `\r\u001b[2K${text}`;
}

export class ProgressIndicator {
  private timer: NodeJS.Timeout | undefined;
  private frameIndex = 0;
  private activeMessage: string | undefined;

  constructor(private readonly stream: ProgressStream = process.stderr) {}

  start(message: string): void {
    this.activeMessage = message;
    if (this.stream.isTTY) {
      if (this.timer === undefined) {
        this.render();
        this.timer = setInterval(() => {
          this.render();
        }, SPINNER_INTERVAL_MS);
        return;
      }
      this.render();
      return;
    }
    this.stream.write(`${message}...\n`);
  }

  update(message: string): void {
    this.start(message);
  }

  succeed(message: string): void {
    this.finish('OK', message);
  }

  fail(message: string): void {
    this.finish('FAIL', message);
  }

  private render(): void {
    if (this.activeMessage === undefined) {
      return;
    }
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
    this.frameIndex += 1;
    this.stream.write(clearLine(`${frame} ${this.activeMessage}...`));
  }

  private finish(tag: 'OK' | 'FAIL', message: string): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.stream.isTTY) {
      this.stream.write(`${clearLine(`[${tag}] ${message}`)}\n`);
    } else {
      this.stream.write(`[${tag}] ${message}\n`);
    }
    this.activeMessage = undefined;
  }
}
