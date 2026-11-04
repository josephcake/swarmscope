import type { NetNode } from './types';

/** Team inks (dark, mid, light). Generic roles, shared by the canvas and the panels. */
export const TEAM_INK: Record<string, [string, string, string]> = {
  Coordination: ['#2e1052', '#c77dff', '#ead6ff'],
  Research: ['#4a2b00', '#ff9f1c', '#ffe0b0'],
  Build: ['#003c44', '#00f0ff', '#b8fbff'],
  Review: ['#0a3a28', '#39ff88', '#d4ffe8'],
  Memory: ['#4a0a3f', '#ff2bd6', '#ffc2f2'],
  Ops: ['#0a1f4a', '#4d8dff', '#c9dcff'],
  Room: ['#141a30', '#5d6f93', '#9fb0d0'],
  Agents: ['#1a2744', '#7aa2ff', '#d5e4ff'],
};

export const GRAY: [string, string, string] = ['#1d2130', '#4d5568', '#8a93a8'];

export const nodeInk = (n: NetNode): [string, string, string] =>
  TEAM_INK[n.kind === 'room' ? 'Room' : n.team] ?? TEAM_INK.Agents;
