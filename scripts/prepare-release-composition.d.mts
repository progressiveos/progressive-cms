export function prepareReleaseComposition(input: {
  sourceRepo: string;
  recipePath: string;
  out: string;
}): { root: string; compositionId: string; coreCommit: string };
export function sealReleaseComposition(root: string, sourceRepo: string): string;
