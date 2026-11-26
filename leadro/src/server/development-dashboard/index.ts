// The manager development dashboard of one employee (spec 10.4): a read model composed from the performance, coaching and
// development modules' public read functions. Development use only: nothing that decides work, pay or employment imports it.
export { getEmployeeDevelopment } from "./dashboard";
export type { EmployeeDevelopmentView, DevelopmentMetricView, DevelopmentPeriodView, DevelopmentSeriesRef } from "./dashboard";
