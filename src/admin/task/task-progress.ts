export function taskParentState(
  children: { status: string; approvalDecision: string }[],
) {
  if (!children.length) return undefined;
  const complete = children.every(
    (child) =>
      child.status === 'completed' && child.approvalDecision === 'approved',
  );
  const review = children.every(
    (child) => child.status === 'review' || child.status === 'completed',
  );
  const pending = children.every(
    (child) => child.status === 'pending' || child.status === 'in_active',
  );
  return {
    status: complete
      ? ('completed' as const)
      : review
        ? ('review' as const)
        : pending
          ? ('pending' as const)
          : ('in_progress' as const),
    completionDecision: complete ? ('approved' as const) : ('pending' as const),
  };
}
