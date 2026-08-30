import { beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test';
import type { CycleScheduler } from 'meta-bind-core/src/metadata/CycleScheduler';
import { GlobalMetadataSource, TestMetadataSource } from 'meta-bind-core/src/metadata/InternalMetadataSources';
import {
	METADATA_CACHE_EXTERNAL_WRITE_LOCK_DURATION,
	METADATA_CACHE_INACTIVE_CYCLE_THRESHOLD,
	hasUpdateOverlap,
	metadataPathHasUpdateOverlap,
	MetadataManager,
} from 'meta-bind-core/src/metadata/MetadataManager';
import { type Metadata } from 'meta-bind-core/src/metadata/MetadataSource';
import { MetadataSubscription } from 'meta-bind-core/src/metadata/MetadataSubscription';
import {
	type BindTargetDeclaration,
	BindTargetStorageType,
} from 'meta-bind-core/src/parsers/bindTargetParser/BindTargetDeclaration';
import { MetaBindBindTargetError } from 'meta-bind-core/src/utils/errors/MetaBindErrors';
import { parsePropPath } from 'meta-bind-core/src/utils/prop/PropParser';
import { type ListenerCallback, Signal } from 'meta-bind-core/src/utils/Signal';
import { getUUID } from 'meta-bind-core/src/utils/Utils';

const testFilePath = 'testFile';
const otherFilePath = 'otherFile';

function subscribe(
	manager: MetadataManager,
	bindTarget: BindTargetDeclaration,
): { subscription: MetadataSubscription; signal: Signal<unknown>; spy: Mock<ListenerCallback<unknown>> } {
	const signal = new Signal<unknown>(undefined);
	const spy = spyOn(signal, 'set');
	const subscription = manager.subscribe(getUUID(), signal, bindTarget, () => {});
	return {
		subscription: subscription,
		signal: signal,
		spy: spy,
	};
}

function createBindTarget(file: string, path: string[], listenToChildren: boolean = false): BindTargetDeclaration {
	return {
		storageType: BindTargetStorageType.FRONTMATTER,
		storagePath: file,
		storageProp: parsePropPath(path),
		listenToChildren: listenToChildren,
	};
}

function externalUpdate(manager: MetadataManager, filePath: string, value: Metadata): void {
	const source = manager.sources.get(BindTargetStorageType.FRONTMATTER);
	if (source) {
		manager.onExternalUpdate(source, filePath, value);
	}
}

describe('metadata manager', () => {
	let manager: MetadataManager;

	beforeEach(() => {
		manager = new MetadataManager();
		const testSource = new TestMetadataSource(BindTargetStorageType.FRONTMATTER, manager, {
			[testFilePath]: { var1: 1, var2: 2 },
			[otherFilePath]: { var1: 1, var2: 2 },
		});
		manager.registerSource(testSource);
	});

	test('subscribing should change the signal value to the current cache value', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);
		expect(s1.spy.mock.calls).toEqual([[1]]);
	});

	test('unsubscribing should not change the signal value', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		s1.subscription.unsubscribe();

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);
		expect(s1.spy.mock.calls).toEqual([[1]]);
	});

	test('should update on external update', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);
		expect(s1.spy.mock.calls).toEqual([[1]]);

		externalUpdate(manager, testFilePath, { var1: 5 });

		expect(s1.signal.get()).toBe(5);
		expect(s1.spy).toHaveBeenCalledTimes(2);
		expect(s1.spy.mock.calls).toEqual([[1], [5]]);
	});

	test('should not update on external update after unsubscribing', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		s1.subscription.unsubscribe();

		externalUpdate(manager, testFilePath, { var1: 5 });

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);
		expect(s1.spy.mock.calls).toEqual([[1]]);
	});

	test('should update all changed subscriptions on external update', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		const s2 = subscribe(manager, createBindTarget(testFilePath, ['var2']));

		externalUpdate(manager, testFilePath, { var1: 5, var2: 6 });

		expect(s1.signal.get()).toBe(5);
		expect(s1.spy).toHaveBeenCalledTimes(2);
		expect(s1.spy.mock.calls).toEqual([[1], [5]]);

		expect(s2.signal.get()).toBe(6);
		expect(s2.spy).toHaveBeenCalledTimes(2);
		expect(s2.spy.mock.calls).toEqual([[2], [6]]);
	});

	test('should update only changed subscriptions on external update', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		const s2 = subscribe(manager, createBindTarget(testFilePath, ['var2']));

		externalUpdate(manager, testFilePath, { var1: 5, var2: 2 });

		expect(s1.signal.get()).toBe(5);
		expect(s1.spy).toHaveBeenCalledTimes(2);
		expect(s1.spy.mock.calls).toEqual([[1], [5]]);

		expect(s2.signal.get()).toBe(2);
		expect(s2.spy).toHaveBeenCalledTimes(1);
		expect(s2.spy.mock.calls).toEqual([[2]]);
	});

	test('should not update self', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		s1.subscription.write(5);

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);
		expect(s1.spy.mock.calls).toEqual([[1]]);
	});

	test('should update different values independently', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		const s2 = subscribe(manager, createBindTarget(otherFilePath, ['var1']));

		externalUpdate(manager, testFilePath, { var1: 5 });

		expect(s1.signal.get()).toBe(5);
		expect(s1.spy).toHaveBeenCalledTimes(2);
		expect(s1.spy.mock.calls).toEqual([[1], [5]]);

		expect(s2.signal.get()).toBe(1);
		expect(s2.spy).toHaveBeenCalledTimes(1);
		expect(s2.spy.mock.calls).toEqual([[1]]);
	});

	test('should delete inactive cache items after threshold cycles', async () => {
		const source = manager.getSource(BindTargetStorageType.FRONTMATTER);
		if (source === undefined) {
			throw new Error('source not found');
		}

		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		s1.subscription.unsubscribe();

		expect(source.getCacheItemForStoragePath(testFilePath)).toBeDefined();

		for (let i = 0; i <= METADATA_CACHE_INACTIVE_CYCLE_THRESHOLD; i++) {
			await manager.cycle();
		}

		expect(source.getCacheItemForStoragePath(testFilePath)).toBeUndefined();
	});

	test('should ignore external updates while external write lock is active', async () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		s1.subscription.write(10);
		externalUpdate(manager, testFilePath, { var1: 99 });

		expect(s1.signal.get()).toBe(1);
		expect(s1.spy).toHaveBeenCalledTimes(1);

		for (let i = 0; i < METADATA_CACHE_EXTERNAL_WRITE_LOCK_DURATION; i++) {
			await manager.cycle();
		}

		externalUpdate(manager, testFilePath, { var1: 99 });

		expect(s1.signal.get()).toBe(99);
		expect(s1.spy).toHaveBeenCalledTimes(2);
		expect(s1.spy.mock.calls).toEqual([[1], [99]]);
	});

	test('should throw when setting unknown default source', () => {
		expect(() => manager.setDefaultSource('does-not-exist')).toThrow();
	});

	test('should delete all subscriptions for a storage path deletion', () => {
		const callbacks = {
			onDelete1: () => {},
			onDelete2: () => {},
		};
		const onDelete1Spy = spyOn(callbacks, 'onDelete1');
		const onDelete2Spy = spyOn(callbacks, 'onDelete2');

		const s1 = manager.subscribe(
			getUUID(),
			new Signal<unknown>(undefined),
			createBindTarget(testFilePath, ['var1']),
			callbacks.onDelete1,
		);
		const s2 = manager.subscribe(
			getUUID(),
			new Signal<unknown>(undefined),
			createBindTarget(testFilePath, ['var2']),
			callbacks.onDelete2,
		);

		manager.onStoragePathDeleted(testFilePath);

		expect(s1.deleted).toBe(true);
		expect(s2.deleted).toBe(true);
		expect(onDelete1Spy).toHaveBeenCalledTimes(1);
		expect(onDelete2Spy).toHaveBeenCalledTimes(1);
	});

	test('should delete all subscriptions for a storage path rename', () => {
		const callbacks = {
			onDelete1: () => {},
			onDelete2: () => {},
		};
		const onDelete1Spy = spyOn(callbacks, 'onDelete1');
		const onDelete2Spy = spyOn(callbacks, 'onDelete2');

		const s1 = manager.subscribe(
			getUUID(),
			new Signal<unknown>(undefined),
			createBindTarget(testFilePath, ['var1']),
			callbacks.onDelete1,
		);
		const s2 = manager.subscribe(
			getUUID(),
			new Signal<unknown>(undefined),
			createBindTarget(testFilePath, ['var2']),
			callbacks.onDelete2,
		);

		manager.onStoragePathRenamed(testFilePath, 'renamedFile');

		expect(s1.deleted).toBe(true);
		expect(s2.deleted).toBe(true);
		expect(onDelete1Spy).toHaveBeenCalledTimes(1);
		expect(onDelete2Spy).toHaveBeenCalledTimes(1);
	});

	test('should detect a derived subscription dependency loop', () => {
		manager.subscribeDerived(
			'd1',
			createBindTarget(testFilePath, ['var1']),
			[createBindTarget(testFilePath, ['var2'])],
			[new Signal<unknown>(undefined)],
			() => 1,
			() => {},
		);

		expect(() =>
			manager.subscribeDerived(
				'd2',
				createBindTarget(testFilePath, ['var2']),
				[createBindTarget(testFilePath, ['var1'])],
				[new Signal<unknown>(undefined)],
				() => 2,
				() => {},
			),
		).toThrow(MetaBindBindTargetError);
	});

	test('should cascade derived subscriptions', async () => {
		const targetA = createBindTarget(testFilePath, ['a']);
		const targetB = createBindTarget(testFilePath, ['b']);
		const targetC = createBindTarget(testFilePath, ['c']);
		const targetD = createBindTarget(testFilePath, ['d']);

		manager.write(1, targetA);

		const signalA = new Signal<unknown>(undefined);
		const signalB = new Signal<unknown>(undefined);
		const signalC = new Signal<unknown>(undefined);

		const cWrites: unknown[] = [];
		const dWrites: unknown[] = [];

		manager.subscribe(getUUID(), new Signal<unknown>(undefined), targetC, () => {});
		manager.subscribe(getUUID(), new Signal<unknown>(undefined), targetD, () => {});

		manager.subscribeDerived(
			'b',
			targetB,
			[targetA],
			[signalA],
			async () => {
				await new Promise(resolve => setTimeout(resolve, 0));
				return Number(signalA.get()) + 1;
			},
			() => {},
		);

		manager.subscribeDerived(
			'c',
			targetC,
			[targetB],
			[signalB],
			() => {
				const value = Number(signalB.get() ?? 0) + 1;
				cWrites.push(value);
				return value;
			},
			() => {},
		);

		manager.subscribeDerived(
			'd',
			targetD,
			[targetC],
			[signalC],
			() => {
				const value = Number(signalC.get() ?? 0) + 1;
				dWrites.push(value);
				return value;
			},
			() => {},
		);

		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		expect(manager.read(targetB)).toBe(2);
		expect(manager.read(targetC)).toBe(3);
		expect(manager.read(targetD)).toBe(4);

		expect(cWrites).toEqual([1, 3]);
		expect(dWrites).toEqual([1, 2, 4]);
	});
});

describe('metadata overlap helpers', () => {
	test('metadataPathHasUpdateOverlap should respect listenToChildren for parent listeners', () => {
		const parent = parsePropPath(['foo', 'bar']);
		const child = parsePropPath(['foo', 'bar', 'baz']);

		expect(metadataPathHasUpdateOverlap(parent, child, false)).toBe(true);
		expect(metadataPathHasUpdateOverlap(child, parent, false)).toBe(false);
		expect(metadataPathHasUpdateOverlap(child, parent, true)).toBe(true);
	});

	test('hasUpdateOverlap should return false for different storage path or type', () => {
		const base = createBindTarget(testFilePath, ['foo']);
		const differentPath = createBindTarget(otherFilePath, ['foo']);
		const differentType: BindTargetDeclaration = {
			...base,
			storageType: BindTargetStorageType.MEMORY,
		};

		expect(hasUpdateOverlap(base, differentPath)).toBe(false);
		expect(hasUpdateOverlap(base, differentType)).toBe(false);
	});
});

/**
 * Records start/stop calls so tests can assert that the cycle timer is only alive while the
 * metadata manager has work. Behaves like a real scheduler: start/stop are idempotent.
 */
class TestCycleScheduler implements CycleScheduler {
	running: boolean = false;
	startCount: number = 0;
	stopCount: number = 0;

	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.startCount += 1;
	}

	stop(): void {
		if (!this.running) {
			return;
		}
		this.running = false;
		this.stopCount += 1;
	}

	isRunning(): boolean {
		return this.running;
	}
}

function createGlobalBindTarget(path: string[]): BindTargetDeclaration {
	return {
		storageType: BindTargetStorageType.GLOBAL_MEMORY,
		storagePath: '',
		storageProp: parsePropPath(path),
		listenToChildren: false,
	};
}

describe('metadata manager cycle gate', () => {
	let manager: MetadataManager;
	let testSource: TestMetadataSource;
	let scheduler: TestCycleScheduler;

	beforeEach(() => {
		manager = new MetadataManager();
		testSource = new TestMetadataSource(BindTargetStorageType.FRONTMATTER, manager, {
			[testFilePath]: { var1: 1, var2: 2 },
			[otherFilePath]: { var1: 1, var2: 2 },
		});
		manager.registerSource(testSource);
		// the global memory source always reports exactly one cache item, which is why the cycle used
		// to have something to iterate over even with nothing bound
		manager.registerSource(new GlobalMetadataSource(BindTargetStorageType.GLOBAL_MEMORY, manager));

		scheduler = new TestCycleScheduler();
		manager.setCycleScheduler(scheduler);
	});

	test('should not run the cycle timer when nothing is bound', () => {
		expect(manager.hasCycleWork()).toBe(false);
		expect(scheduler.isRunning()).toBe(false);
		expect(scheduler.startCount).toBe(0);
	});

	test('should not be kept alive by the permanent global memory cache item', async () => {
		// the global cache item is never deletable, so it must not keep the timer running on its own
		await manager.cycle();

		expect(scheduler.isRunning()).toBe(false);
	});

	test('should start the cycle timer on the first subscription', () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		expect(scheduler.isRunning()).toBe(true);
		expect(scheduler.startCount).toBe(1);

		// a second subscription must not restart an already running timer
		subscribe(manager, createBindTarget(testFilePath, ['var2']));

		expect(scheduler.startCount).toBe(1);

		s1.subscription.unsubscribe();
	});

	test('should keep the cycle timer running while a subscription is alive', async () => {
		subscribe(manager, createBindTarget(testFilePath, ['var1']));

		for (let i = 0; i < METADATA_CACHE_INACTIVE_CYCLE_THRESHOLD + 10; i++) {
			await manager.cycle();
		}

		expect(scheduler.isRunning()).toBe(true);
		expect(scheduler.stopCount).toBe(0);
	});

	test('should stop the cycle timer once the last cache item has been garbage collected', async () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		expect(scheduler.isRunning()).toBe(true);

		s1.subscription.unsubscribe();

		// the cache item still exists and still has to age into the cache GC, so the timer keeps going
		expect(scheduler.isRunning()).toBe(true);

		for (let i = 0; i < METADATA_CACHE_INACTIVE_CYCLE_THRESHOLD; i++) {
			await manager.cycle();
			expect(scheduler.isRunning()).toBe(true);
		}

		// this cycle pushes cyclesWithoutListeners past the threshold and deletes the cache item
		await manager.cycle();

		expect(testSource.getCacheItems().length).toBe(0);
		expect(manager.hasCycleWork()).toBe(false);
		expect(scheduler.isRunning()).toBe(false);
		expect(scheduler.stopCount).toBe(1);
	});

	test('should restart the cycle timer when a field is bound again', async () => {
		const s1 = subscribe(manager, createBindTarget(testFilePath, ['var1']));
		s1.subscription.unsubscribe();

		for (let i = 0; i <= METADATA_CACHE_INACTIVE_CYCLE_THRESHOLD; i++) {
			await manager.cycle();
		}
		expect(scheduler.isRunning()).toBe(false);

		const s2 = subscribe(manager, createBindTarget(testFilePath, ['var1']));

		expect(scheduler.isRunning()).toBe(true);
		expect(scheduler.startCount).toBe(2);
		// the fresh cache item starts its inactivity count from zero, so the restarted timer does not
		// immediately garbage collect it
		expect(testSource.getCacheItems()[0].cyclesWithoutListeners).toBe(0);
		expect(s2.signal.get()).toBe(1);
	});

	test('should not stop the cycle timer while a write-back is still pending', async () => {
		const bindTarget = createBindTarget(testFilePath, ['var1']);
		const s1 = subscribe(manager, bindTarget);

		manager.write(42, bindTarget);
		s1.subscription.unsubscribe();

		// the last field just unmounted, but the value has not reached the external source yet
		const cacheItem = testSource.getCacheItems()[0];
		expect(cacheItem.dirty).toBe(true);
		expect(manager.hasCycleWork()).toBe(true);
		expect(scheduler.isRunning()).toBe(true);

		await manager.cycle();

		expect(cacheItem.dirty).toBe(false);
		expect(testSource.externalMetadata[testFilePath].var1).toBe(42);
		expect(scheduler.isRunning()).toBe(true);
	});

	test('should keep cycling a non deletable cache item until its write lock has expired', async () => {
		// the global memory cache item is never deleted, so it isolates the dirty/write lock drain
		const bindTarget = createGlobalBindTarget(['var1']);

		manager.write(42, bindTarget);

		expect(scheduler.isRunning()).toBe(true);
		expect(scheduler.startCount).toBe(1);

		// one cycle clears `dirty`, but the external write lock still has to count down
		for (let i = 0; i < METADATA_CACHE_EXTERNAL_WRITE_LOCK_DURATION - 1; i++) {
			await manager.cycle();
			expect(scheduler.isRunning()).toBe(true);
		}

		await manager.cycle();

		expect(manager.hasCycleWork()).toBe(false);
		expect(scheduler.isRunning()).toBe(false);
		expect(scheduler.stopCount).toBe(1);
	});

	test('should stop the previous scheduler when a new one is attached and on destroy', () => {
		subscribe(manager, createBindTarget(testFilePath, ['var1']));
		expect(scheduler.isRunning()).toBe(true);

		const replacement = new TestCycleScheduler();
		manager.setCycleScheduler(replacement);

		expect(scheduler.isRunning()).toBe(false);
		expect(replacement.isRunning()).toBe(true);

		manager.destroy();

		expect(replacement.isRunning()).toBe(false);
		expect(manager.getCycleScheduler()).toBe(undefined);
	});

	test('should tolerate having no scheduler attached', async () => {
		const bare = new MetadataManager();
		bare.registerSource(new TestMetadataSource(BindTargetStorageType.FRONTMATTER, bare, {}));

		expect(bare.getCycleScheduler()).toBe(undefined);
		expect(() => subscribe(bare, createBindTarget(testFilePath, ['var1']))).not.toThrow();
		await bare.cycle();
	});
});
