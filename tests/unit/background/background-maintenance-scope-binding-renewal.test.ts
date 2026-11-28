/**
 * Dispatch-liveness scope-binding renewal — field class 2.23 / 3.18
 * (2026-11-25 / 2026-11-28).
 *
 * A delegated coder round's claimed binding carries a hard wall-clock TTL
 * that only verified in-scope FILE mutations re-arm (scope-lease-renewal).
 * A verification phase that legitimately performs none for longer than the
 * TTL — strict serial test runs, replays, background shells — let the
 * binding lapse MID-ROUND: the next write/shell was refused with
 * SCOPE_BINDING_EXPIRED (2.23: report write after a ~25 min serial
 * verification phase; 3.18: shell channel after 260 s collector runs),
 * burning a provably live dispatch on a round-trip re-declare. The
 * delegation maintenance pass now re-arms the claimed binding for every
 * reservation it renews on proven owner activity, outside the store locks,
 * best-effort: the binding TTL and the authorization gate's bounded
 * idle-revival (#2271) remain the authority — a live dispatch's binding
 * simply must not die of old age.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDelegationHealthArtifact } from '../../../src/background/delegation-health';
import {
	bindBackgroundCoderReservation,
	maintainBackgroundDelegations,
	type RecordPendingInput,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import {
	clearScopeBindings,
	createScopeBinding,
	type ScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	renewClaimedScopeBindingForDelegation,
} from '../../../src/scope/scope-persistence';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = 1_000_000;
const PARENT = 'parent_1';
const CHILD = 'ses_a';
const TASK = '1.1';
const CALL = 'call_1';

function makeProject(): { dir: string; plan: Plan } {
	const dir = canonicalMkdtemp('scope-deleg-renew-');
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Delegation renewal',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: TASK,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Long verification round',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
	return { dir, plan };
}

async function seedClaimedBinding(
	dir: string,
	plan: Plan,
): Promise<ScopeBinding> {
	const declaration = createScopeBinding({
		directory: dir,
		plan,
		taskId: TASK,
		files: ['src/a.ts'],
		ownerSessionId: PARENT,
		ownerMessageId: CALL,
		dispatchCallId: CALL,
		activation: 'pending_child',
		source: 'plan',
	});
	if (!declaration) throw new Error('declaration fixture failed');
	expect(await persistAndRegisterScopeBinding(dir, declaration)).toMatchObject({
		ok: true,
	});
	const claim = await claimScopeBindingForChildDurably({
		directory: dir,
		parentSessionId: PARENT,
		childSessionId: CHILD,
		dispatchCallId: CALL,
	});
	if (!claim.ok) throw new Error(claim.message);
	return claim.value.claimed;
}

async function seedLiveRound(dir: string): Promise<string | null> {
	const claim = await reserveBackgroundCoderSlot(dir, {
		parentSessionId: PARENT,
		planTaskId: TASK,
		callID: CALL,
		maxConcurrent: 4,
		generation: 1,
		now: NOW,
	});
	if (!claim.ok) return null;
	const bound = await bindBackgroundCoderReservation(dir, {
		reservationId: claim.reservation.reservationId,
		parentSessionId: PARENT,
		planTaskId: TASK,
		callID: CALL,
		correlationId: CHILD,
		generation: 1,
		now: NOW,
	});
	return bound?.reservationId ?? null;
}

async function seedPendingRecord(
	dir: string,
	reservationId: string | null,
): Promise<void> {
	const input: RecordPendingInput = {
		correlationId: CHILD,
		jobId: 'job_a',
		subagentSessionId: CHILD,
		parentSessionId: PARENT,
		callID: CALL,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: TASK,
		evidenceTaskId: TASK,
		coderReservationId: reservationId ?? undefined,
	};
	const record = await recordPendingDelegation(dir, input);
	expect(record).not.toBeNull();
}

function durableBinding(dir: string, generationId: string): ScopeBinding {
	const scopesDir = path.join(dir, '.swarm', 'scopes');
	const match = fs
		.readdirSync(scopesDir)
		.filter((entry) => entry.endsWith('.json'))
		.map(
			(entry) =>
				JSON.parse(
					fs.readFileSync(path.join(scopesDir, entry), 'utf-8'),
				) as ScopeBinding,
		)
		.find((binding) => binding.generationId === generationId);
	if (!match) throw new Error('durable binding not found');
	return match;
}

describe('dispatch-liveness scope-binding renewal (field class 2.23/3.18)', () => {
	let dir = '';
	let plan: Plan;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({ fixedNow: NOW });
		({ dir, plan } = makeProject());
	});

	afterEach(() => {
		clearScopeBindings();
		restoreClock();
		closeAllProjectDbs();
		safeRmRecursive(dir);
	});

	it('re-arms the claimed binding when maintenance renews a live round', async () => {
		const claimed = await seedClaimedBinding(dir, plan);
		const reservationId = await seedLiveRound(dir);
		expect(reservationId).not.toBeNull();
		await seedPendingRecord(dir, reservationId);
		// The binding was claimed at NOW with a 60 min TTL; the maintenance
		// pass runs at NOW+20 min (reservation lease expired, record fresh)
		// with 40 min of binding TTL left — the round is mid-verification
		// with no file mutations, exactly the 2.23/3.18 field shape.
		const maintenanceNow = NOW + 20 * 60_000;
		const result = await maintainBackgroundDelegations(dir, {
			now: maintenanceNow,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.status).toBe('ok');
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);

		const binding = durableBinding(dir, claimed.generationId);
		expect(binding.revision).toBe(claimed.revision + 1);
		expect(binding.expiresAt).toBeGreaterThan(maintenanceNow);
		expect(binding.lifecycleState).toBe('live');

		const facts = readDelegationHealthArtifact(dir)?.maintenance?.facts ?? [];
		expect(
			facts.some(
				(fact) =>
					fact.kind === 'scope-binding-renewal' &&
					fact.reservationId === reservationId &&
					fact.reason === 'claimed binding lease re-armed',
			),
		).toBe(true);
	});

	it('records a skip fact when the dispatch has no claimed binding', async () => {
		const reservationId = await seedLiveRound(dir);
		expect(reservationId).not.toBeNull();
		await seedPendingRecord(dir, reservationId);
		const maintenanceNow = NOW + 20 * 60_000;
		const result = await maintainBackgroundDelegations(dir, {
			now: maintenanceNow,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
		const facts = readDelegationHealthArtifact(dir)?.maintenance?.facts ?? [];
		expect(
			facts.some(
				(fact) =>
					fact.kind === 'scope-binding-renewal' &&
					fact.reservationId === reservationId &&
					fact.reason === 'no claimed binding for this dispatch',
			),
		).toBe(true);
	});

	it('never revives an already-expired binding — that stays the authorization gate’s decision (#2271)', async () => {
		const claimed = await seedClaimedBinding(dir, plan);
		const reservationId = await seedLiveRound(dir);
		expect(reservationId).not.toBeNull();
		await seedPendingRecord(dir, reservationId);
		// The binding already lapsed before maintenance ran (patch the
		// authoritative coordination row AND the shadow file, like the
		// #2271 suite's patchDurable).
		const scopesDir = path.join(dir, '.swarm', 'scopes');
		for (const entry of fs
			.readdirSync(scopesDir)
			.filter((e) => e.endsWith('.json'))) {
			const filePath = path.join(scopesDir, entry);
			const parsed = JSON.parse(
				fs.readFileSync(filePath, 'utf-8'),
			) as ScopeBinding;
			if (parsed.generationId === claimed.generationId) {
				parsed.expiresAt = NOW - 1000;
				getProjectDb(dir).run(
					`UPDATE coordination_state
					 SET revision = ?, status = ?, payload = ?, updated_at = CURRENT_TIMESTAMP
					 WHERE namespace = 'scope-binding' AND entity_key = ?`,
					[
						parsed.revision,
						parsed.lifecycleState,
						JSON.stringify(parsed),
						parsed.generationId,
					],
				);
				fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
			}
		}
		const maintenanceNow = NOW + 20 * 60_000;
		const result = await maintainBackgroundDelegations(dir, {
			now: maintenanceNow,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.renewed).toEqual([{ reservationId, generation: 1 }]);
		const binding = durableBinding(dir, claimed.generationId);
		// The durable file above was hand-patched; the refusal must not have
		// written a revived row on top of it.
		expect(binding.revision).toBe(claimed.revision);
		const facts = readDelegationHealthArtifact(dir)?.maintenance?.facts ?? [];
		expect(
			facts.some(
				(fact) =>
					fact.kind === 'scope-binding-renewal' &&
					fact.reservationId === reservationId &&
					fact.reason.startsWith('renewal refused: SCOPE_BINDING_EXPIRED'),
			),
		).toBe(true);
	});

	it('renewClaimedScopeBindingForDelegation returns null for a foreign dispatch', async () => {
		await seedClaimedBinding(dir, plan);
		const renewal = await renewClaimedScopeBindingForDelegation({
			directory: dir,
			childSessionId: CHILD,
			taskId: TASK,
			dispatchCallId: 'call_some_other_dispatch',
		});
		expect(renewal).toBeNull();
	});

	it('a reservation lease that is still unexpired is not renewed — and neither is its binding', async () => {
		const claimed = await seedClaimedBinding(dir, plan);
		const reservationId = await seedLiveRound(dir);
		expect(reservationId).not.toBeNull();
		await seedPendingRecord(dir, reservationId);
		// Maintenance at NOW+5 min: the 15 min reservation lease is still
		// live, so Phase B neither renews the reservation nor touches the
		// binding (no scope-binding-renewal fact at all).
		const result = await maintainBackgroundDelegations(dir, {
			now: NOW + 5 * 60_000,
			staleTimeoutMs: 30 * 60_000,
		});
		expect(result.renewed).toEqual([]);
		const scan = scanBackgroundCoderReservationsForAdmission(dir);
		expect(scan.status).toBe('ok');
		const binding = durableBinding(dir, claimed.generationId);
		expect(binding.revision).toBe(claimed.revision);
	});
});
