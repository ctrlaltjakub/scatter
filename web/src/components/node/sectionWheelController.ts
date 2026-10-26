export interface SectionWheelSample {
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
}

type Direction = -1 | 1;
type InputMode = 'undecided' | 'coarse' | 'smooth';

const COARSE_THRESHOLD = 200;
const DEFAULT_SMOOTH_THRESHOLD = 200;
export const NODE_SMOOTH_THRESHOLD = 200;
const SMOOTH_TIME_FALLBACK_MS = 100;
const SMOOTH_TIME_FALLBACK_MIN_DISTANCE = 25;
const SMOOTH_GESTURE_GAP_MS = 160;
const SMOOTH_CANDIDATE_GAP_MS = SMOOTH_GESTURE_GAP_MS;
const COARSE_PIXEL_DELTA = 80;
const TAIL_PEAK_RATIO = 0.6;
const TAIL_WINDOW_SAMPLES = 6;
const TAIL_TREND_RATIO = 0.85;
const TAIL_REARM_RATIO = 1.8;
const TAIL_REARM_MIN_DELTA = 12;
const TAIL_SLOW_REARM_SAMPLES = 3;
const TAIL_SLOW_REARM_MIN_DELTA = 1;

interface SectionWheelControllerOptions {
  smoothThreshold?: number;
}

/**
 * Turns raw wheel samples into at most one neighboring section step.
 *
 * Chunky mouse-wheel input uses a fixed 200-unit accumulator.
 * Rapid, small pixel deltas use a configurable distance threshold, a guarded
 * time fallback for very slow movement, and a momentum-tail filter suitable
 * for precision trackpads.
 */
export class SectionWheelController {
  private readonly smoothThreshold: number;
  private coarseAccum = 0;
  private mode: InputMode = 'undecided';
  private candidate: SectionWheelSample | null = null;
  private lastEventAt: number | null = null;

  private smoothAccum = 0;
  private smoothDirection: Direction | 0 = 0;
  private smoothWindowStartedAt: number | null = null;
  private smoothHasStepped = false;
  private smoothPeak = 0;
  private smoothMagnitudes: number[] = [];
  private smoothTailLocked = false;
  private smoothTailFloor = Number.POSITIVE_INFINITY;
  private smoothTailRearmMagnitudes: number[] = [];

  constructor(options: SectionWheelControllerOptions = {}) {
    this.smoothThreshold = options.smoothThreshold ?? DEFAULT_SMOOTH_THRESHOLD;
  }

  consume(sample: SectionWheelSample, currentStop: number, lastStop: number): -1 | 0 | 1 {
    if (!Number.isFinite(sample.deltaY) || sample.deltaY === 0) return 0;

    const gap = this.lastEventAt === null
      ? Number.POSITIVE_INFINITY
      : sample.timeStamp - this.lastEventAt;
    const expiredCandidate = gap >= SMOOTH_GESTURE_GAP_MS || gap < 0
      ? this.candidate
      : null;
    if (gap >= SMOOTH_GESTURE_GAP_MS || gap < 0) {
      this.resetSmoothGesture();
      this.mode = 'undecided';
      this.candidate = null;
    }
    this.lastEventAt = sample.timeStamp;
    const isDefinitelyCoarse =
      sample.deltaMode !== 0 || Math.abs(sample.deltaY) >= COARSE_PIXEL_DELTA;

    // One isolated sub-80px event is a small/coarsely-spaced wheel step, not a
    // smooth gesture. Flush THAT old event into the coarse accumulator, but let
    // the current event begin a fresh gesture instead of forcing both coarse.
    if (expiredCandidate !== null) {
      const expiredStep = this.consumeCoarse(expiredCandidate.deltaY, currentStop, lastStop);
      if (expiredStep !== 0) {
        const nextStop = Math.max(0, Math.min(lastStop, currentStop + expiredStep));
        if (isDefinitelyCoarse) {
          this.mode = 'coarse';
          this.accumulateCoarse(sample.deltaY, nextStop, lastStop);
        } else {
          this.candidate = sample;
        }
        return expiredStep;
      }
    }

    if (this.mode === 'coarse') {
      return this.consumeCoarse(sample.deltaY, currentStop, lastStop);
    }
    if (this.mode === 'smooth') {
      return this.consumeSmooth(sample, currentStop, lastStop);
    }

    if (isDefinitelyCoarse) {
      this.mode = 'coarse';
      const bufferedDelta = this.candidate?.deltaY ?? 0;
      this.candidate = null;
      return this.consumeCoarse(bufferedDelta + sample.deltaY, currentStop, lastStop);
    }

    if (
      this.candidate !== null
      && sample.timeStamp - this.candidate.timeStamp <= SMOOTH_CANDIDATE_GAP_MS
    ) {
      this.mode = 'smooth';
      const first = this.candidate;
      this.candidate = null;
      // If the two samples disagree, treat the newest direction as the actual
      // gesture start. This prevents a one-event wobble from producing two
      // opposite immediate steps during classification.
      if (Math.sign(first.deltaY) !== Math.sign(sample.deltaY)) {
        return this.consumeSmooth(sample, currentStop, lastStop);
      }
      const firstStep = this.consumeSmooth(first, currentStop, lastStop);
      if (firstStep !== 0) {
        // The first recognized direction steps immediately. Preserve the
        // classifier-confirming sample toward the next step without allowing
        // two section changes from this one browser event.
        const nextStop = Math.max(0, Math.min(lastStop, currentStop + firstStep));
        this.smoothWindowStartedAt = sample.timeStamp;
        this.consumeSmooth(sample, nextStop, lastStop, false);
        return firstStep;
      }
      return this.consumeSmooth(sample, currentStop, lastStop);
    }

    if (this.candidate !== null) {
      this.mode = 'coarse';
      const bufferedDelta = this.candidate.deltaY + sample.deltaY;
      this.candidate = null;
      return this.consumeCoarse(bufferedDelta, currentStop, lastStop);
    }

    this.candidate = sample;
    return 0;
  }

  reset(): void {
    this.coarseAccum = 0;
    this.mode = 'undecided';
    this.candidate = null;
    this.lastEventAt = null;
    this.resetSmoothGesture();
  }

  private consumeCoarse(deltaY: number, currentStop: number, lastStop: number): -1 | 0 | 1 {
    this.accumulateCoarse(deltaY, currentStop, lastStop);

    if (Math.abs(this.coarseAccum) < COARSE_THRESHOLD) return 0;

    const direction: Direction = this.coarseAccum > 0 ? 1 : -1;
    this.coarseAccum = 0;
    const next = Math.max(0, Math.min(lastStop, currentStop + direction));
    return next === currentStop ? 0 : direction;
  }

  private accumulateCoarse(deltaY: number, currentStop: number, lastStop: number): void {
    this.coarseAccum += deltaY;
    if (currentStop === 0 && this.coarseAccum < 0) this.coarseAccum = 0;
    if (currentStop === lastStop && this.coarseAccum > 0) this.coarseAccum = 0;
  }

  private consumeSmooth(
    sample: SectionWheelSample,
    currentStop: number,
    lastStop: number,
    allowStep = true,
  ): -1 | 0 | 1 {
    const direction: Direction = sample.deltaY > 0 ? 1 : -1;
    const magnitude = Math.abs(sample.deltaY);
    const startedDirection = direction !== this.smoothDirection;

    if (startedDirection) {
      this.resetSmoothMotion();
      this.smoothDirection = direction;
    }

    if ((currentStop === 0 && direction < 0) || (currentStop === lastStop && direction > 0)) {
      this.smoothAccum = 0;
      this.smoothWindowStartedAt = null;
      return 0;
    }

    if (startedDirection && allowStep) {
      this.smoothHasStepped = true;
      this.smoothPeak = magnitude;
      this.smoothMagnitudes = [magnitude];
      this.smoothWindowStartedAt = sample.timeStamp;
      const next = Math.max(0, Math.min(lastStop, currentStop + direction));
      return next === currentStop ? 0 : direction;
    }

    if (this.smoothTailLocked) {
      this.smoothTailFloor = Math.min(this.smoothTailFloor, magnitude);
      const rearmAt = Math.max(
        TAIL_REARM_MIN_DELTA,
        this.smoothTailFloor * TAIL_REARM_RATIO,
      );
      this.smoothTailRearmMagnitudes.push(magnitude);
      if (this.smoothTailRearmMagnitudes.length > TAIL_SLOW_REARM_SAMPLES) {
        this.smoothTailRearmMagnitudes.shift();
      }
      const [first = 0, middle = 0, last = 0] = this.smoothTailRearmMagnitudes;
      const slowRenewal =
        this.smoothTailRearmMagnitudes.length === TAIL_SLOW_REARM_SAMPLES
        && last >= TAIL_SLOW_REARM_MIN_DELTA
        && middle >= first
        && last >= middle;
      const strongRenewal = magnitude >= rearmAt;
      if (!strongRenewal && !slowRenewal) return 0;

      this.smoothTailLocked = false;
      this.smoothAccum = slowRenewal
        ? direction * this.smoothTailRearmMagnitudes
          .slice(0, -1)
          .reduce((sum, value) => sum + value, 0)
        : 0;
      this.smoothPeak = slowRenewal
        ? Math.max(...this.smoothTailRearmMagnitudes)
        : magnitude;
      this.smoothMagnitudes = slowRenewal
        ? [...this.smoothTailRearmMagnitudes]
        : [magnitude];
      this.smoothTailRearmMagnitudes = [];
      // Renewed deliberate movement after a fading tail is a new movement
      // start, even when it continues in the same direction.
      if (allowStep) {
        this.smoothAccum = 0;
        this.smoothWindowStartedAt = sample.timeStamp;
        this.smoothHasStepped = true;
        this.smoothPeak = magnitude;
        this.smoothMagnitudes = [magnitude];
        const next = Math.max(0, Math.min(lastStop, currentStop + direction));
        return next === currentStop ? 0 : direction;
      }
    } else {
      this.smoothPeak = Math.max(this.smoothPeak, magnitude);
      this.smoothMagnitudes.push(magnitude);
      if (this.smoothMagnitudes.length > TAIL_WINDOW_SAMPLES) {
        this.smoothMagnitudes.shift();
      }

      const half = TAIL_WINDOW_SAMPLES / 2;
      const earlierAverage = this.smoothMagnitudes.length === TAIL_WINDOW_SAMPLES
        ? this.smoothMagnitudes.slice(0, half).reduce((sum, value) => sum + value, 0) / half
        : 0;
      const recentAverage = this.smoothMagnitudes.length === TAIL_WINDOW_SAMPLES
        ? this.smoothMagnitudes.slice(half).reduce((sum, value) => sum + value, 0) / half
        : 0;
      const recentStart = this.smoothMagnitudes[half] ?? 0;
      const recentEnd = this.smoothMagnitudes.at(-1) ?? 0;
      const isFading =
        this.smoothMagnitudes.length === TAIL_WINDOW_SAMPLES
        && recentAverage <= this.smoothPeak * TAIL_PEAK_RATIO
        && recentAverage <= earlierAverage * TAIL_TREND_RATIO
        && recentEnd <= recentStart * TAIL_TREND_RATIO;

      if (isFading && this.smoothHasStepped) {
        this.smoothTailLocked = true;
        this.smoothTailFloor = magnitude;
        this.smoothTailRearmMagnitudes = [];
        this.smoothAccum = 0;
        this.smoothWindowStartedAt = null;
        return 0;
      }
    }

    if (this.smoothWindowStartedAt === null) {
      this.smoothWindowStartedAt = sample.timeStamp;
    }
    this.smoothAccum += sample.deltaY;
    const distance = Math.abs(this.smoothAccum);
    const recentMagnitudes = this.smoothMagnitudes.slice(-4);
    const isEarlyFadingTail =
      this.smoothHasStepped
      && recentMagnitudes.length === 4
      && recentMagnitudes.slice(1).every(
        (value, index) => value <= recentMagnitudes[index]!,
      )
      && recentMagnitudes.at(-1)! <= recentMagnitudes[0]! * TAIL_PEAK_RATIO;
    const reachedDistanceThreshold = distance >= this.smoothThreshold;
    const reachedTimeFallback =
      sample.timeStamp - this.smoothWindowStartedAt >= SMOOTH_TIME_FALLBACK_MS
      && distance >= SMOOTH_TIME_FALLBACK_MIN_DISTANCE
      && !isEarlyFadingTail;
    if (!reachedDistanceThreshold && !reachedTimeFallback) return 0;
    if (!allowStep) return 0;

    this.smoothAccum = 0;
    this.smoothWindowStartedAt = sample.timeStamp;
    this.smoothHasStepped = true;
    const next = Math.max(0, Math.min(lastStop, currentStop + direction));
    return next === currentStop ? 0 : direction;
  }

  private resetSmoothGesture(): void {
    this.resetSmoothMotion();
    this.smoothDirection = 0;
  }

  private resetSmoothMotion(): void {
    this.smoothAccum = 0;
    this.smoothWindowStartedAt = null;
    this.smoothHasStepped = false;
    this.smoothPeak = 0;
    this.smoothMagnitudes = [];
    this.smoothTailLocked = false;
    this.smoothTailFloor = Number.POSITIVE_INFINITY;
    this.smoothTailRearmMagnitudes = [];
  }
}
