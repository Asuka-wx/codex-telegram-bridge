import type { SessionSnapshot } from "../types/domain.js";
import {
  type LinkedApprovalSelection,
  selectLinkedApprovalForTarget,
} from "./linked-approval.js";

export interface LinkedApprovalDispatch {
  target: SessionSnapshot;
  selection: Exclude<LinkedApprovalSelection, { kind: "none" }>;
}

export interface LinkedApprovalSkip {
  target: SessionSnapshot;
  selection: Extract<LinkedApprovalSelection, { kind: "none" }>;
}

export interface LinkedApprovalPlan {
  dispatches: LinkedApprovalDispatch[];
  skips: LinkedApprovalSkip[];
}

export const buildLinkedApprovalPlan = (
  structuredSession: SessionSnapshot | undefined,
  linkedTargets: SessionSnapshot[],
): LinkedApprovalPlan => {
  const dispatches: LinkedApprovalDispatch[] = [];
  const skips: LinkedApprovalSkip[] = [];

  for (const target of linkedTargets) {
    const selection = selectLinkedApprovalForTarget(structuredSession, target);
    if (selection.kind === "none") {
      skips.push({ target, selection });
      continue;
    }

    dispatches.push({ target, selection });
  }

  return {
    dispatches,
    skips,
  };
};
