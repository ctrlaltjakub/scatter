import { describe, expect, it } from 'vitest';
import {
  SectionWheelController,
  type SectionWheelSample,
} from './sectionWheelController';

interface DriveResult {
  stop: number;
  steps: Array<{ direction: -1 | 1; at: number }>;
}

function drive(
  controller: SectionWheelController,
  samples: SectionWheelSample[],
  startStop = 0,
  lastStop = 8,
): DriveResult {
  let stop = startStop;
  const steps: DriveResult['steps'] = [];
  for (const sample of samples) {
    const direction = controller.consume(sample, stop, lastStop);
    if (direction !== 0) {
      stop += direction;
      steps.push({ direction, at: sample.timeStamp });
    }
  }
  return { stop, steps };
}

function repeated(
  deltaY: number,
  count: number,
  gapMs: number,
  startAt = 0,
  deltaMode = 0,
): SectionWheelSample[] {
  return Array.from({ length: count }, (_, index) => ({
    deltaY,
    deltaMode,
    timeStamp: startAt + index * gapMs,
  }));
}

function sequence(
  deltas: number[],
  gapMs: number,
  startAt = 0,
): SectionWheelSample[] {
  return deltas.map((deltaY, index) => ({
    deltaY,
    deltaMode: 0,
    timeStamp: startAt + index * gapMs,
  }));
}

describe('SectionWheelController', () => {
  it('steps immediately when the first smooth direction is recognized', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(5, 2, 16), 3);

    expect(result.steps).toEqual([{ direction: 1, at: 16 }]);
  });

  it('steps immediately when smooth movement reverses direction', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, sequence([5, 5, -5], 16), 3);

    expect(result.steps).toEqual([
      { direction: 1, at: 16 },
      { direction: -1, at: 32 },
    ]);
  });

  it('uses a 200-unit distance trigger after the immediate first step', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(20, 11, 8), 0, 20);

    expect(result.steps).toEqual([
      { direction: 1, at: 8 },
      { direction: 1, at: 80 },
    ]);
  });

  it('applies the configured smooth threshold without changing coarse wheels', () => {
    const fastTrackpad = new SectionWheelController({ smoothThreshold: 50 });
    expect(drive(fastTrackpad, repeated(10, 5, 16)).steps)
      .toEqual([{ direction: 1, at: 16 }]);

    const highThresholdTrackpad = new SectionWheelController({ smoothThreshold: 200 });
    expect(drive(highThresholdTrackpad, repeated(20, 9, 10)).steps)
      .toEqual([{ direction: 1, at: 10 }]);
    expect(drive(highThresholdTrackpad, [{ deltaY: 20, deltaMode: 0, timeStamp: 90 }]).steps)
      .toEqual([]);
    expect(drive(highThresholdTrackpad, [{ deltaY: 20, deltaMode: 0, timeStamp: 100 }]).steps)
      .toEqual([{ direction: 1, at: 100 }]);

    const mouse = new SectionWheelController({ smoothThreshold: 50 });
    expect(drive(mouse, repeated(100, 1, 80, 0, 1)).steps).toEqual([]);
    expect(drive(mouse, [{ deltaY: 100, deltaMode: 1, timeStamp: 80 }]).steps)
      .toEqual([{ direction: 1, at: 80 }]);
  });

  it('preserves the confirming sample when the buffered sample already steps', () => {
    const controller = new SectionWheelController({ smoothThreshold: 50 });

    const result = drive(controller, sequence([60, 10, 40], 16));

    expect(result.steps).toEqual([
      { direction: 1, at: 16 },
      { direction: 1, at: 32 },
    ]);
  });

  it('uses the 200-unit coarse-wheel threshold', () => {
    const controller = new SectionWheelController();

    expect(drive(controller, repeated(100, 1, 80)).steps).toEqual([]);
    expect(drive(controller, [{ deltaY: 100, deltaMode: 0, timeStamp: 80 }]).steps)
      .toEqual([{ direction: 1, at: 80 }]);
  });

  it.each([1, 2])('keeps deltaMode %i on the coarse path', (deltaMode) => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(100, 2, 16, 0, deltaMode));

    expect(result.steps).toEqual([{ direction: 1, at: 16 }]);
  });

  it('preserves sparse small pixel-wheel steps in the coarse accumulator', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(70, 4, 200));

    expect(result.steps).toEqual([{ direction: 1, at: 600 }]);
  });

  it('advances gentle smooth input immediately on recognition', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(20, 5, 16));

    expect(result.steps).toEqual([{ direction: 1, at: 16 }]);
  });

  it('advances after 100ms of slow same-direction movement totaling at least 25 units', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(5, 6, 25));

    expect(result.steps).toEqual([
      { direction: 1, at: 25 },
      { direction: 1, at: 125 },
    ]);
  });

  it('does not add a timed step below 25 units of continued movement', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(4, 5, 25));

    expect(result.steps).toEqual([{ direction: 1, at: 25 }]);
  });

  it('restarts the time fallback when direction reverses', () => {
    const controller = new SectionWheelController();
    const samples = sequence([5, 5, 5, -5, -5, -5, -5, -5], 25);

    const result = drive(controller, samples, 3);

    expect(result.steps).toEqual([
      { direction: 1, at: 25 },
      { direction: -1, at: 75 },
    ]);
  });

  it('restarts the time fallback after the immediate first step', () => {
    const controller = new SectionWheelController();
    const samples = [
      ...sequence([50, 50], 16),
      ...sequence([7, 6, 6, 6], 25, 41),
    ];

    const result = drive(controller, samples);

    expect(result.steps).toEqual([
      { direction: 1, at: 16 },
      { direction: 1, at: 116 },
    ]);
  });

  it('recognizes slow touchpad updates across the full gesture window', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(20, 5, 60));

    expect(result.steps).toEqual([
      { direction: 1, at: 60 },
      { direction: 1, at: 180 },
    ]);
  });

  it('does not let an isolated old event make the next slow gesture coarse', () => {
    const controller = new SectionWheelController();
    const samples = sequence([20, 20, 20, 20, 20, 20], 0);
    samples[0]!.timeStamp = 0;
    samples[1]!.timeStamp = 200;
    samples[2]!.timeStamp = 260;
    samples[3]!.timeStamp = 320;
    samples[4]!.timeStamp = 380;
    samples[5]!.timeStamp = 440;

    const result = drive(controller, samples);

    expect(result.steps).toEqual([
      { direction: 1, at: 260 },
      { direction: 1, at: 380 },
    ]);
  });

  it('allows the first step even when a gentle gesture is already slowing down', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, sequence([25, 22, 19, 16, 13, 10], 16));

    expect(result.steps).toEqual([{ direction: 1, at: 16 }]);
  });

  it('does not let a fast flick\'s fading momentum tail overshoot', () => {
    const controller = new SectionWheelController();
    const flickAndTail = sequence(
      [20, 30, 50, 45, 40, 35, 30, 25, 20, 16, 13, 10, 8, 6, 5, 4, 3, 2, 1],
      24,
    );

    const result = drive(controller, flickAndTail);

    expect(result.steps).toEqual([
      { direction: 1, at: 24 },
      { direction: 1, at: 120 },
    ]);
  });

  it('does not let the 100ms fallback outrun slow fading-tail detection', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, sequence([20, 15, 10, 6, 3, 1], 40));

    expect(result.steps).toEqual([{ direction: 1, at: 40 }]);
  });

  it('recognizes a fading momentum tail even when individual samples wobble', () => {
    const controller = new SectionWheelController();
    const noisyFlickAndTail = sequence(
      [
        20, 30, 50,
        44, 38, 40, 32, 34, 27, 29, 22, 24, 18, 19, 15, 16, 12, 13, 10, 11, 8, 9, 6, 7, 5,
      ],
      24,
    );

    const result = drive(controller, noisyFlickAndTail);

    expect(result.steps).toEqual([
      { direction: 1, at: 24 },
      { direction: 1, at: 120 },
    ]);
  });

  it('keeps repeating when strong movement settles to a steady level', () => {
    const controller = new SectionWheelController();
    const samples = sequence([20, 30, 50, ...Array<number>(40).fill(25)], 24);

    const result = drive(controller, samples, 0, 20);

    expect(result.steps).toHaveLength(9);
    expect(result.steps[0]!.at).toBe(24);
    expect(result.steps[1]!.at).toBe(144);
    expect(result.steps.at(-1)!.at).toBe(984);
  });

  it('can repeat faster than three times per second after the immediate step', () => {
    const controller = new SectionWheelController();

    const result = drive(controller, repeated(20, 20, 16));

    expect(result.steps.map((step) => step.at)).toEqual([16, 128, 240]);
  });

  it('resumes after a fading tail when movement clearly strengthens again', () => {
    const controller = new SectionWheelController();
    const firstFlick = sequence(
      [20, 30, 50, 45, 40, 35, 30, 24, 18, 12, 8, 5, 3, 2, 1],
      24,
    );
    const renewedMotion = sequence([8, 18, 32, 45, 30], 24, 384);

    const result = drive(controller, [...firstFlick, ...renewedMotion]);

    expect(result.steps).toEqual([
      { direction: 1, at: 24 },
      { direction: 1, at: 120 },
      { direction: 1, at: 408 },
    ]);
  });

  it('resumes a stable slow movement without requiring fingers to lift', () => {
    const controller = new SectionWheelController();
    const firstFlick = sequence(
      [20, 30, 50, 45, 40, 35, 30, 24, 18, 12, 8, 5, 3, 2, 1],
      24,
    );
    const slowRenewal = sequence(Array<number>(25).fill(4), 24, 384);

    const result = drive(controller, [...firstFlick, ...slowRenewal]);

    expect(result.steps).toEqual([
      { direction: 1, at: 24 },
      { direction: 1, at: 120 },
      { direction: 1, at: 408 },
      { direction: 1, at: 576 },
      { direction: 1, at: 744 },
      { direction: 1, at: 912 },
    ]);
  });

  it('drops opposing accumulated movement when direction reverses', () => {
    const controller = new SectionWheelController();
    const samples = [
      ...repeated(15, 3, 16),
      ...repeated(-25, 4, 16, 48),
    ];

    const result = drive(controller, samples, 3);

    expect(result.steps).toEqual([
      { direction: 1, at: 16 },
      { direction: -1, at: 48 },
    ]);
  });

  it('treats input after 160ms of silence as a fresh smooth gesture', () => {
    const controller = new SectionWheelController();
    const samples = [
      ...repeated(20, 5, 16),
      ...repeated(20, 5, 16, 240),
    ];

    const result = drive(controller, samples);

    expect(result.steps).toEqual([
      { direction: 1, at: 16 },
      { direction: 1, at: 256 },
    ]);
  });

  it('does not wind up movement beyond the first or last stop', () => {
    const topController = new SectionWheelController();
    const top = drive(topController, [
      ...repeated(-100, 8, 80),
      ...repeated(100, 6, 80, 640),
    ]);
    expect(top.steps).toEqual([
      { direction: 1, at: 720 },
      { direction: 1, at: 880 },
      { direction: 1, at: 1040 },
    ]);

    const bottomController = new SectionWheelController();
    const bottom = drive(bottomController, [
      ...repeated(20, 20, 16),
      ...repeated(-20, 5, 16, 400),
    ], 8, 8);
    expect(bottom.steps).toEqual([{ direction: -1, at: 400 }]);
  });

  it('reset discards partial coarse and smooth gestures', () => {
    const coarse = new SectionWheelController();
    drive(coarse, repeated(100, 1, 80));
    coarse.reset();
    expect(drive(coarse, [{ deltaY: 100, deltaMode: 0, timeStamp: 80 }]).steps).toEqual([]);

    const smooth = new SectionWheelController();
    drive(smooth, repeated(20, 2, 16));
    smooth.reset();
    expect(drive(smooth, repeated(20, 1, 16, 64)).steps).toEqual([]);
  });
});
