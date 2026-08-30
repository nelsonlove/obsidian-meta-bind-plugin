/**
 * Drives {@link MetadataManager.cycle}.
 *
 * The metadata manager owns the lifecycle: it calls {@link CycleScheduler.start} as soon as there is
 * outstanding work and {@link CycleScheduler.stop} once every cache item has drained. A platform only
 * has to supply the timer.
 *
 * Both `start` and `stop` must be idempotent.
 */
export interface CycleScheduler {
	/**
	 * Begin running the cycle callback on the sync interval.
	 * Must be a no-op if the scheduler is already running.
	 */
	start(): void;

	/**
	 * Stop running the cycle callback and release the underlying timer.
	 * Must be a no-op if the scheduler is not running.
	 */
	stop(): void;

	/**
	 * Whether the scheduler currently holds a live timer.
	 */
	isRunning(): boolean;
}

/**
 * A {@link CycleScheduler} backed by `setInterval`.
 *
 * The interval is created on `start` and fully cleared on `stop`, so an idle vault causes no timer
 * wake-ups at all. This is the whole point of the gate: the cycle period is denominated in ticks by
 * the external write lock and the cache GC, so it can not be lengthened, only switched off.
 */
export class IntervalCycleScheduler implements CycleScheduler {
	private readonly callback: () => void;
	private readonly interval: number;
	private handle: number | undefined;

	constructor(callback: () => void, interval: number) {
		this.callback = callback;
		this.interval = interval;
		this.handle = undefined;
	}

	public start(): void {
		if (this.handle !== undefined) {
			return;
		}

		this.handle = window.setInterval(this.callback, this.interval);
	}

	public stop(): void {
		if (this.handle === undefined) {
			return;
		}

		window.clearInterval(this.handle);
		this.handle = undefined;
	}

	public isRunning(): boolean {
		return this.handle !== undefined;
	}
}
