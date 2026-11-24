// Technician field steps and arrival verification (§8.3, §8.4, §17.2, §17.4)
export { confirmArrival } from "./arrive";
export type { ArrivalResult } from "./arrive";
export { startWork } from "./start-work";
export type { StartWorkResult } from "./start-work";
export { recordNavigationOpened } from "./navigation";
export { verifyArrival } from "./verify";
export { listJobArrivals } from "./read";
export { ARRIVAL_FIELD_MAP, ARRIVAL_CONFIDENCES } from "./fields";
export type { ArrivalConfidence } from "./fields";

export { ARRIVAL_TRIGGERS, jobIdParams, arrivalParams, arriveSchema, startWorkSchema, navigationOpenedSchema, verifyArrivalSchema } from "./schemas";
export type { ArriveInput, StartWorkInput, NavigationOpenedInput, VerifyArrivalInput } from "./schemas";
