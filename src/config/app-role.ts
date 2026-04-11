export const APP_ROLES = [
  "all",
  "receiver",
  "workers",
  "order_worker",
  "reaction_worker",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

const APP_ROLE_SET = new Set<string>(APP_ROLES);

export function parseAppRole(value: string | undefined): AppRole {
  const normalized = String(value ?? "all").trim().toLowerCase();
  return isAppRole(normalized) ? normalized : "all";
}

export function isAppRole(value: string): value is AppRole {
  return APP_ROLE_SET.has(value);
}

export function roleHasReceiver(role: AppRole): boolean {
  return role === "all" || role === "receiver";
}

export function roleHasOrderWorker(role: AppRole): boolean {
  return role === "all" || role === "workers" || role === "order_worker";
}

export function roleHasReactionWorker(role: AppRole): boolean {
  return role === "all" || role === "workers" || role === "reaction_worker";
}

export function roleRequiresPdfReadiness(role: AppRole): boolean {
  return roleHasOrderWorker(role);
}
