/**
 * Tendril lifecycle management.
 * Tendrils are the exploratory pseudopods of the organism.
 */

import type { Tendril, TendrilStatus } from "./types.ts";

let tendrilCounter = 0;

export function createTendril(
  direction: string,
  parentId: string | null = null,
  depth: number = 0,
  energy: number = 1.0
): Tendril {
  return {
    id: `t${++tendrilCounter}`,
    headNodeId: null,
    trail: [],
    energy,
    totalNutrient: 0,
    status: "exploring",
    starvation: 0,
    direction,
    depth,
    parentId,
  };
}

export function drainEnergy(tendril: Tendril, amount: number): void {
  tendril.energy = Math.max(0, tendril.energy - amount);
}

export function awardEnergy(tendril: Tendril, amount: number): void {
  tendril.energy = Math.min(2.0, tendril.energy + amount);
}

export function starve(tendril: Tendril): void {
  tendril.starvation++;
}

export function feed(tendril: Tendril): void {
  tendril.starvation = 0;
}

export function kill(tendril: Tendril, reason: string): string {
  tendril.status = "dead";
  tendril.energy = 0;
  return reason;
}

export function isActive(tendril: Tendril): boolean {
  return tendril.status === "exploring" || tendril.status === "sensing";
}

export function getActiveTendrils(tendrils: Tendril[]): Tendril[] {
  return tendrils.filter(isActive);
}

export function resetCounters(): void {
  tendrilCounter = 0;
}
