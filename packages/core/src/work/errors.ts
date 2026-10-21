/** The Work Item does not exist, or not for the project or caller asking. */
export class WorkItemNotFoundError extends Error {
  override readonly name = "WorkItemNotFoundError";
}
/** The caller may not record this approval under the project's policy. */
export class ApprovalForbiddenError extends Error {
  override readonly name = "ApprovalForbiddenError";
}
/** The Work Item changed or left the expected state; inspect it again. */
export class WorkConflictError extends Error {
  override readonly name = "WorkConflictError";
}
