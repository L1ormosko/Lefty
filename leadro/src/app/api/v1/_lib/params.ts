import { z } from "zod";

/** Path parameter schemas shared by the `/api/v1` routes (the folder is private to Next: `_lib`). */
const id = z.string().trim().min(1).max(64);

export const idParams = z.object({ id });
export const unitManagerParams = z.object({ id, managerId: id });
export const employeeAssignmentParams = z.object({ id, assignmentId: id });
