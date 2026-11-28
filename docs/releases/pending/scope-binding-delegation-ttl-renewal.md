# Delegated coder rounds no longer lose their scope binding to the 60-minute wall-clock TTL during verification phases

## What changed

The delegation maintenance pass now re-arms the claimed scope binding of every dispatch whose reservation it renews on proven owner activity:

- **Before:** a claimed binding's 60-minute TTL only re-armed on verified in-scope FILE mutations. A coder round in a verification phase that legitimately performs none for longer than the TTL — strict serial test runs, replays, background shells — let the binding lapse mid-round, and the next write/shell was refused with `SCOPE_BINDING_EXPIRED` (recovery contract: architect `declare_scope` with `replace_existing=true` plus a re-dispatch), burning a provably live round. Two field incidents of exactly this shape: task 2.23 (2026-11-25, report write blocked after a ~25-minute serial verification phase) and task 3.18 (2026-11-28, the shell channel wedged after long collector runs; the round was lost to a two-strike stop).
- **Now:** `maintainBackgroundDelegations` collects every reservation it renews (the existing `exact owner record still active` liveness proof, ~every 15 minutes) and refreshes the dispatch's claimed binding via the new `renewClaimedScopeBindingForDelegation` — best-effort, outside the store locks, recorded as a `scope-binding-renewal` maintenance fact. Every `refreshScopeBindingLease` CAS and deny-ledger guard applies unchanged; an already-expired generation is deliberately NOT revived here (the authorization gate's bounded idle-revival, #2271, keeps that decision). When a round ends (consumed/stale/settled), renewals stop and the binding decays naturally.
- The maintenance health artifact's fact schema gains the `scope-binding-renewal` kind (zod + TypeScript union, mirrored).

## Why

Binding authority should be bounded by the dispatch's liveness, not by a blind wall clock that ignores legitimately idle background-wait phases. The reservation machinery already proves dispatch liveness on owner activity; the binding TTL now follows that proof instead of forcing a round-trip re-declare on every long verification phase.

## Rollback caveat

The `scope-binding-renewal` fact kind is additive to the maintenance health artifact schema. An older build reading a newer artifact (with such facts) rejects the artifact's maintenance section schema and falls back to its absent/last-known state — health is advisory, never authorization state, so this degrades diagnostics only. A rollback therefore loses renewal (the pre-fix behavior returns) plus the newest maintenance observations, nothing else.
