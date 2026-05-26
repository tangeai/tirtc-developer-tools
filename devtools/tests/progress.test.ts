import {ProgressIndicator} from '../src/progress';

type MockStream = {
  isTTY?: boolean;
  writes: string[];
  write(chunk: string): boolean;
};

function createMockStream(isTTY?: boolean): MockStream {
  return {
    isTTY,
    writes: [],
    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    },
  };
}

describe('progress indicator', () => {
  it('prints plain progress lines on non-tty stream', () => {
    const stream = createMockStream(false);
    const progress = new ProgressIndicator(stream);

    progress.start('Preparing MP4 assets');
    progress.update('Starting service session');
    progress.succeed('Service session is ready');

    expect(stream.writes).toEqual([
      'Preparing MP4 assets...\n',
      'Starting service session...\n',
      '[OK] Service session is ready\n',
    ]);
  });

  it('prints failure summary on non-tty stream', () => {
    const stream = createMockStream(false);
    const progress = new ProgressIndicator(stream);

    progress.start('Preparing MP4 assets');
    progress.fail('Service start failed');

    expect(stream.writes).toEqual([
      'Preparing MP4 assets...\n',
      '[FAIL] Service start failed\n',
    ]);
  });
});
