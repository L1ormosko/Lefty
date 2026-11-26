// Course catalog
export { listCourses, getCourse, createCourse, updateCourse, archiveCourse } from "./courses";

// Assignments (Task 5 creates RECOMMENDATION assignments with `createTrainingAssignmentInTx`)
export {
  assignTraining,
  createTrainingAssignmentInTx,
  updateAssignment,
  startAssignment,
  cancelAssignment,
  getAssignment,
  listAssignments,
  ALREADY_OPEN as TRAINING_ASSIGNMENT_ALREADY_OPEN,
} from "./assignments";
export type { CreateTrainingAssignmentInput } from "./assignments";

// Completions and HR's verification
export { recordCompletion, getRecord, listRecords } from "./records";
export { verifyRecord, rejectRecord, revokeRecord } from "./verification";

// Expiry, overdue, notifications
export { listExpiringRecords, findExpiringTrainingRecords, findOverdueTrainingAssignments } from "./expiry";
export type { ExpiringTrainingRecord, OverdueTrainingAssignment } from "./expiry";
export { sweepTraining, sweepAllTraining } from "./sweep";
export type { TrainingSweepResult } from "./sweep";
export { registerTrainingNotificationTargets } from "./notify";

// Self-service (`/api/v1/me/training/*`): the caller's own assignments and records (no module permission).
export { listOwnAssignments, listOwnRecords, ownAssignmentsQuerySchema, ownRecordsQuerySchema } from "./self-service";
export type { OwnAssignmentsQuery, OwnRecordsQuery, OwnAssignmentView, OwnRecordView } from "./self-service";

export type { AssignmentView, CourseView, RecordView } from "./views";
export {
  idParams as trainingIdParams,
  createCourseSchema,
  updateCourseSchema,
  archiveCourseSchema,
  listCoursesQuerySchema,
  assignTrainingSchema,
  updateAssignmentSchema,
  startAssignmentSchema,
  cancelAssignmentSchema,
  listAssignmentsQuerySchema,
  recordCompletionSchema,
  verifyRecordSchema,
  decisionReasonSchema as trainingDecisionReasonSchema,
  listRecordsQuerySchema,
  expiringRecordsQuerySchema,
  TRAINING_ASSIGNMENT_STATUSES,
  TRAINING_RECORD_STATUSES,
} from "./schemas";
