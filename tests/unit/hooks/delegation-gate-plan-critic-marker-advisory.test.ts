/**
 * Plan-critic dispatch-time marker advisory (2026-11-24
 * swarm_communication_debug, 3rd recorder miss for one plan — also under the
 * fixed runtime).
 *
 * The auto-approve predicate is deliberately narrow (audit P2-1): only a
 * dispatch carrying the explicit `critic-gate` marker creates the durable
 * plan-critic dispatch binding whose existence is the precondition for ANY
 * automatic approval recording. An architect plan review dispatched without
 * the marker therefore yields an APPROVED verdict that is never recorded
 * mechanically, and the next coder dispatch hits
 * PLAN_CRITIC_GATE_VIOLATION. The fix is advisory at dispatch time — never a
 * widened auto-record: a critic dispatch that READS like a plan review but
 * lacks the marker gets a non-blocking advisory naming both sanctioned exits
 * (re-dispatch with the marker, or approve_plan_critic after the fact).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		delegation_gate: true,
		background_subagents: true,
		background_pending_timeout_minutes: 30,
	},
	worktree: { policy: 'disabled' },
} as Parameters<typeof createDelegationGateHook>[0];

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Marker Advisory Plan',
		swarm: 'marker-advisory',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

interface Dispatch {
	input: {
		tool: string;
		sessionID: string;
		callID: string;
		args: { subagent_type: string; background?: boolean; prompt: string };
	};
}

function criticDispatch(
	prompt: string,
	callID: string,
	background = false,
): Dispatch {
	return {
		input: {
			tool: 'Task',
			sessionID: 'parent-architect',
			callID,
			args: background
				? { subagent_type: 'critic', background: true, prompt }
				: { subagent_type: 'critic', prompt },
		},
	};
}

function pendingAdvisories(): string[] {
	const session = swarmState.agentSessions.get('parent-architect');
	return session?.pendingAdvisoryMessages ?? [];
}

describe('plan-critic dispatch-time marker advisory', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-marker-advisory-'));
		writePlan(dir, makePlan());
		ensureAgentSession('parent-architect', 'architect', dir);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		cleanup();
	});

	test('a plan review without the critic-gate marker gets the advisory and is NOT blocked', async () => {
		const hook = createDelegationGateHook(config, dir);
		const { input } = criticDispatch(
			// Plan-review signals from PLAN_CRITIC_TASK_SIGNALS ('review the
			// plan below', 'before implementation') — but no `critic-gate`
			// marker: exactly the 2026-11-24 incident shape.
			'Review the plan below before implementation and return VERDICT.',
			'call-unmarked',
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		const advisories = pendingAdvisories();
		expect(
			advisories.some((message) =>
				message.includes('PLAN-CRITIC DISPATCH ADVISORY'),
			),
		).toBe(true);
		expect(
			advisories.some((message) => message.includes('MODE: CRITIC-GATE')),
		).toBe(true);
		expect(
			advisories.some((message) => message.includes('approve_plan_critic')),
		).toBe(true);
	});

	test('an explicit MODE: CRITIC-GATE dispatch gets NO advisory (the binding path)', async () => {
		const hook = createDelegationGateHook(config, dir);
		const { input } = criticDispatch(
			'MODE: CRITIC-GATE\nReview the full plan before EXECUTE and return VERDICT.',
			'call-gated',
			true,
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		expect(
			pendingAdvisories().some((message) =>
				message.includes('PLAN-CRITIC DISPATCH ADVISORY'),
			),
		).toBe(false);
	});

	test('an ordinary critic code review (no plan signals) gets NO advisory', async () => {
		const hook = createDelegationGateHook(config, dir);
		const { input } = criticDispatch(
			'Review the diff for correctness and edge cases.',
			'call-ordinary',
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: input.sessionID, callID: input.callID },
			{ args: input.args },
		);
		expect(
			pendingAdvisories().some((message) =>
				message.includes('PLAN-CRITIC DISPATCH ADVISORY'),
			),
		).toBe(false);
	});
});
