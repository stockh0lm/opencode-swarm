/**
 * .swarm/ runtime-state zone authority (the 2026-11-23
 * swarm_communication_debug AUTHORITY_POLICY_DENY wedge).
 *
 * The loop skill instructs the architect to write
 * `.swarm/loop/<run>/state.json` after every gate transition. The zone
 * classifier used to send every `.json` path to the `config` zone, and the
 * architect's default `blockedZones: ['generated', 'config']` denied the
 * write — with no config escape, because zone blocks cannot be overridden by
 * allow rules. These tests pin the reclassification contract end-to-end:
 * swarm runtime state is its own `state` zone, the architect may write it,
 * and every pre-existing .swarm/ protection (plan projections, the coder's
 * .swarm/ prefix block) still holds.
 *
 * The keep-the-why block below pins the sibling wedge from the same log:
 * the containment exemption for `~/.keep-the-why/` (the keep-the-why
 * skill's sanctioned personal memory store) plus the `state` zone for
 * `.keep-the-why/` paths, with the exemption's planted-symlink hardening
 * and the explicit-consumer lockdown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkFileAuthority } from '../../../src/hooks/guardrails';
import { _internals as authorityInternals } from '../../../src/hooks/guardrails/file-authority';

function isDenied(
	result: ReturnType<typeof checkFileAuthority>,
): result is { allowed: false; reason: string } {
	return !result.allowed;
}

describe('guardrails swarm state-zone authority', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-state-zone-'));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('allows the architect to write .swarm/loop run state (previously config-zone denied)', () => {
		const result = checkFileAuthority(
			'architect',
			'.swarm/loop/mainstream-model-20261121T1646Z/state.json',
			tempDir,
		);
		expect(result.allowed).toBe(true);
	});

	it('allows the architect to write .swarm/loop run state via absolute path', () => {
		const absolutePath = path.join(
			tempDir,
			'.swarm',
			'loop',
			'mainstream-model-20261121T1646Z',
			'state.json',
		);
		const result = checkFileAuthority('architect', absolutePath, tempDir);
		expect(result.allowed).toBe(true);
	});

	it('still denies the architect the plan projections (exact-path block, not zone)', () => {
		for (const planPath of ['.swarm/plan.md', '.swarm/plan.json']) {
			const result = checkFileAuthority('architect', planPath, tempDir);
			expect(result.allowed).toBe(false);
		}
	});

	it('still denies the coder every .swarm/ path (prefix block)', () => {
		const result = checkFileAuthority(
			'coder',
			'.swarm/loop/mainstream-model-20261121T1646Z/state.json',
			tempDir,
		);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.reason).toContain('Path blocked');
		}
	});

	it('still denies the architect real config-zone files (the #894 lint-bypass protection)', () => {
		for (const configPath of [
			'biome.json',
			'tsconfig.json',
			'.oxlintrc.json',
		]) {
			const result = checkFileAuthority('architect', configPath, tempDir);
			expect(result.allowed).toBe(false);
		}
	});

	it('still denies the architect generated-zone files', () => {
		const result = checkFileAuthority('architect', 'lib/math.wasm', tempDir);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.zone).toBe('generated');
		}
	});

	it('honors an explicit blockedZones:["state"] override for consumers that must lock runtime state down', () => {
		// The authority config can still deny the state zone explicitly — the
		// reclassification only removes the accidental default block.
		const result = checkFileAuthority(
			'architect',
			'.swarm/loop/run/state.json',
			tempDir,
			{ rules: { architect: { blockedZones: ['state'] } } },
		);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.reason).toContain('state');
		}
	});
});

describe('guardrails keep-the-why containment exemption', () => {
	let workspace: string;
	let homeDir: string;
	const realHomedir = authorityInternals.homedir;
	const realLstatSync = authorityInternals.lstatSync;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ktw-workspace-'));
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktw-home-'));
		// The exemption resolves `~` through the #3606-style seam so the real
		// host home is never a test operand; restored in afterEach.
		authorityInternals.homedir = () => homeDir;
	});

	afterEach(async () => {
		authorityInternals.homedir = realHomedir;
		authorityInternals.lstatSync = realLstatSync;
		try {
			await fs.rm(workspace, { recursive: true, force: true });
			await fs.rm(homeDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('allows the architect to author the keep-the-why personal memory file under ~', async () => {
		await fs.mkdir(path.join(homeDir, '.keep-the-why'), { recursive: true });
		const result = checkFileAuthority(
			'architect',
			path.join(
				homeDir,
				'.keep-the-why',
				'andreasschuldei---wirtschaftssimulation.md',
			),
			workspace,
		);
		expect(result.allowed).toBe(true);
	});

	it('allows ~/.keep-the-why/projects.json on first-time setup (state zone, not config)', async () => {
		// The base does not exist yet — exactly the 2026-11-23 wedge shape
		// (personal wizard after "Defaults übernehmen"). The .json extension
		// must not reach the config zone through the exemption.
		const result = checkFileAuthority(
			'architect',
			path.join(homeDir, '.keep-the-why', 'projects.json'),
			workspace,
		);
		expect(result.allowed).toBe(true);
	});

	it('denies a planted symlink below ~/.keep-the-why that redirects the write', async () => {
		await fs.mkdir(path.join(homeDir, '.keep-the-why'), { recursive: true });
		const planted = path.join(homeDir, '.keep-the-why', 'link');
		const target = path.join(planted, 'note.md'); // new-file write through 'link'
		// Seam-injected symlink stat (host-independent, per the #3606 pattern —
		// real symlink creation needs privileges on Windows CI runners).
		authorityInternals.lstatSync = ((candidate: fsSync.PathLike) => {
			if (String(candidate) === planted) {
				return { isSymbolicLink: () => true } as unknown as fsSync.Stats;
			}
			return realLstatSync(candidate);
		}) as typeof authorityInternals.lstatSync;
		const result = checkFileAuthority('architect', target, workspace);
		expect(result.allowed).toBe(false);
		if (isDenied(result)) {
			expect(result.reason).toContain('outside the working directory');
		}
	});

	it('still denies arbitrary home paths outside the sanctioned store', async () => {
		const result = checkFileAuthority(
			'architect',
			path.join(homeDir, '.bashrc'),
			workspace,
		);
		expect(result.allowed).toBe(false);
	});

	it('classifies workspace-local .keep-the-why memory as state zone (projects.json not config-blocked)', () => {
		expect(
			checkFileAuthority('architect', '.keep-the-why/note.md', workspace)
				.allowed,
		).toBe(true);
		expect(
			checkFileAuthority('architect', '.keep-the-why/projects.json', workspace)
				.allowed,
		).toBe(true);
	});

	it('a consumer can still lock the store down explicitly (blockedZones state)', async () => {
		const result = checkFileAuthority(
			'architect',
			path.join(homeDir, '.keep-the-why', 'projects.json'),
			workspace,
			{ rules: { architect: { blockedZones: ['state'] } } },
		);
		expect(result.allowed).toBe(false);
	});
});
