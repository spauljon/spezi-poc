import type { WebContract } from "./contract.ts";

/** What a view needs of an Observation's `meta`: the tags only. */
export interface TaggedMeta {
  readonly tag?: ReadonlyArray<{ readonly system?: string; readonly code?: string }>;
}

/**
 * The data-quality flags an Observation STORED, in the contract's flag system, in the order stored. A flag is only ever
 * read from `meta.tag`: this never looks at a value, so an implausible value nobody flagged shows no flag. The absence of
 * a flag means "none stored", not "checked and good" (contract assumption A31).
 */
export function qualityFlagsOf(meta: TaggedMeta | undefined, contract: WebContract): string[] {
  const system = contract.dataQualityFlag.system;
  return (meta?.tag ?? []).filter((t) => t.system === system && typeof t.code === "string").map((t) => t.code as string);
}

/** A flag in words (never by colour alone). A code this app does not know is shown as unrecognised, not hidden. */
export function flagLabel(contract: WebContract, code: string): string {
  const f = contract.dataQualityFlag;
  if (code === f.artifactSuspected) return "artifact suspected";
  if (code === f.duplicateResolved) return "duplicate resolved";
  if (code === f.lateArrival) return "late arrival";
  if (code === f.userEntered) return "entered by hand, not measured by a device";
  return `unrecognised flag "${code}"`;
}
