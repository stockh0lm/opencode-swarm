/**
 * Coder-settlement ownership expiry (2026-11-24 swarm_communication_debug,
 * restart-aftermath wedge): a leaked in-process dispatch registration — its
 * drain path (settle, abort, or the pending-timeout transfer) never ran after
 * a session close or host restart — used to block `/swarm recover`
 * indefinitely and demand `--force` for a dispatch that could no longer be
 * legitimately in flight. A non-terminal WAL whose dispatch timestamp is
 * older than the configured background pending timeout plus grace now
 * auto-expires the registration (`releaseReason: 'ownership-expired'`).
 * The conservative contracts are pinned unchanged: fresh registrations still
 * refuse, unparsable timestamps never expire, and a foreign live pid is
 * never auto-released from this process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { canonicalRootKeyFresh } from '../../../src/utils/canonical-root';
import {
	coderDispatchOwnershipIsStale,
	recoverStaleCoderSettlements,
	_internals as settlementInternals,
} from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const PENDING_TIMEOUT_MINUTES = 30;
const GRACE_MINUTES = 10;

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

function readWal(
	directory: string,
	taskId: string,
): {
	state: string;
	transitionId: string;
	recordedAt?: string;
	processId?: number;
} {
	return JSON.parse(fs.readFileSync(walPath(directory, taskId), 'utf8')) as {
		state: string;
		transitionId: string;
		recordedAt?: string;
		processId?: number;
	};
}

function rewriteWalField(
	directory: string,
	taskId: string,
	mutate: (wal: Record<string, unknown>) => void,
): void {
	const file = walPath(directory, taskId);
	const wal = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
		string,
		unknown
	>;
	mutate(wal);
	fs.writeFileSync(file, JSON.stringify(wal));
}

function dispatchKeyFor(
	directory: string,
	taskId: string,
	transitionId: string,
): string {
	return `${canonicalRootKeyFresh(directory)}\u0000${taskId}\u0000${transitionId}`;
}

describe('coderDispatchOwnershipIsStale (pure expiry bound)', () => {
	const NOW = Date.parse('2026-11-24T14:30:00.000Z');
	const BOUND_MS = (PENDING_TIMEOUT_MINUTES + GRACE_MINUTES) * 60_000; // 40 min

	test('DISPATCHED beyond timeout+grace is stale', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: '2026-11-24T12:00:00.000Z' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(true);
	});

	test('exactly at the bound is NOT stale (strictly older required)', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: '2026-11-24T13:50:00.000Z' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
	});

	test('DISPATCHED inside the bound is fresh', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: '2026-11-24T14:00:00.000Z' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
	});

	test('PREPARED beyond the bound is stale (a settle that died mid-flight)', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'PREPARED', recordedAt: '2026-11-24T11:00:00.000Z' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(true);
	});

	test('terminal states are not ownership questions', () => {
		for (const state of ['ABORTED', 'COMMITTED'] as const) {
			expect(
				coderDispatchOwnershipIsStale(
					{ state, recordedAt: '2026-11-24T11:00:00.000Z' },
					PENDING_TIMEOUT_MINUTES,
					NOW,
				),
			).toBe(false);
		}
	});

	test('missing or unparsable recordedAt never expires (fail closed)', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: undefined },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: '' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'DISPATCHED', recordedAt: 'not-a-date' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
	});

	test('unreadable WALs never expire', () => {
		expect(
			coderDispatchOwnershipIsStale(
				{ state: 'unreadable', recordedAt: '2026-11-24T11:00:00.000Z' },
				PENDING_TIMEOUT_MINUTES,
				NOW,
			),
		).toBe(false);
	});
});

describe('recoverStaleCoderSettlements ownership expiry', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('ownership-expiry-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['add', '.']);
		git(directory, ['commit', '-m', 'seed']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
	});

	afterEach(() => {
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	async function beginRealDispatch(
		callID: string,
		taskId = '1.1',
	): Promise<string> {
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
			{ id: '1.2', files: ['src/feature.ts'] },
		]);
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = taskId;
		const hook = createDelegationGateHook(config, directory);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID },
			{
				args: {
					subagent_type: 'coder',
					task_id: taskId,
					prompt: `TASK: ${taskId}\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified`,
				},
			},
		);
		return `coder:${callID}`;
	}

	test('a leaked in-process registration beyond timeout+grace auto-releases and recovers without --force', async () => {
		const transitionId = await beginRealDispatch('expire-me');
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
		expect(
			settlementInternals.liveDispatches.has(
				dispatchKeyFor(directory, '1.1', transitionId),
			),
		).toBe(true);

		// The drain path never ran (session closed / host restarted): the WAL's
		// dispatch timestamp is far beyond the legitimate pending lifetime.
		rewriteWalField(directory, '1.1', (wal) => {
			wal.recordedAt = new Date(
				Date.now() - (PENDING_TIMEOUT_MINUTES + 60) * 60_000,
			).toISOString();
		});

		const { results } = await recoverStaleCoderSettlements(directory, {
			pendingTimeoutMinutes: PENDING_TIMEOUT_MINUTES,
		});
		expect(results).toHaveLength(1);
		const outcome = results[0];
		expect(outcome.outcome).toBe('recovered');
		if (outcome.outcome === 'recovered') {
			expect(outcome.forced).toBe(true);
			expect(outcome.releaseReason).toBe('ownership-expired');
			expect(outcome.accepted).toBe(false);
		}
		expect(readWal(directory, '1.1').state).toBe('COMMITTED');
		// The leaked registration was drained, not just bypassed.
		expect(
			settlementInternals.liveDispatches.has(
				dispatchKeyFor(directory, '1.1', transitionId),
			),
		).toBe(false);
	});

	test('a fresh registration still refuses without --force (conservative window holds)', async () => {
		const transitionId = await beginRealDispatch('fresh-me');
		const { results } = await recoverStaleCoderSettlements(directory, {
			pendingTimeoutMinutes: PENDING_TIMEOUT_MINUTES,
		});
		expect(results[0]?.outcome).toBe('owned_in_process');
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
		expect(
			settlementInternals.liveDispatches.has(
				dispatchKeyFor(directory, '1.1', transitionId),
			),
		).toBe(true);
	});

	test('an unparsable recordedAt never auto-expires (fail closed)', async () => {
		await beginRealDispatch('bad-date');
		rewriteWalField(directory, '1.1', (wal) => {
			wal.recordedAt = 'not-a-date';
		});
		const { results } = await recoverStaleCoderSettlements(directory, {
			pendingTimeoutMinutes: PENDING_TIMEOUT_MINUTES,
		});
		expect(results[0]?.outcome).toBe('owned_in_process');
	});

	test('a foreign live pid is never auto-released, even when expired', async () => {
		await beginRealDispatch('foreign-me');
		rewriteWalField(directory, '1.1', (wal) => {
			wal.processId = process.ppid;
			wal.recordedAt = new Date(
				Date.now() - (PENDING_TIMEOUT_MINUTES + 60) * 60_000,
			).toISOString();
		});
		settlementInternals.liveDispatches.clear();
		const { results } = await recoverStaleCoderSettlements(directory, {
			pendingTimeoutMinutes: PENDING_TIMEOUT_MINUTES,
		});
		expect(results[0]?.outcome).toBe('owned_by_live_foreign_pid');
		expect(readWal(directory, '1.1').state).toBe('DISPATCHED');
	});

	test('--force on a fresh registration reports the force release reason', async () => {
		await beginRealDispatch('force-me');
		const { results } = await recoverStaleCoderSettlements(directory, {
			force: true,
			pendingTimeoutMinutes: PENDING_TIMEOUT_MINUTES,
		});
		const outcome = results[0];
		expect(outcome.outcome).toBe('recovered');
		if (outcome.outcome === 'recovered') {
			expect(outcome.releaseReason).toBe('force');
		}
	});

	test('the schema default (60 min + grace) anchors the expiry when no timeout is passed', async () => {
		const transitionId = await beginRealDispatch('default-bound');
		// 80 minutes old: beyond 60 + 10, expired under the DEFAULT bound.
		rewriteWalField(directory, '1.1', (wal) => {
			wal.recordedAt = new Date(Date.now() - 80 * 60_000).toISOString();
		});
		const expired = await recoverStaleCoderSettlements(directory);
		expect(expired.results[0]?.outcome).toBe('recovered');

		// A second task at 50 minutes: inside the default bound, still owned.
		const transitionId2 = await beginRealDispatch('default-bound-2', '1.2');
		expect(transitionId2).toBe('coder:default-bound-2');
		rewriteWalField(directory, '1.2', (wal) => {
			wal.recordedAt = new Date(Date.now() - 50 * 60_000).toISOString();
		});
		const fresh = await recoverStaleCoderSettlements(directory, {
			taskIds: ['1.2'],
		});
		expect(fresh.results[0]?.outcome).toBe('owned_in_process');
	});
});
