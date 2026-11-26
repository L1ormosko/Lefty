# customer-feedback

Customer feedback recorded by hand by Customer Relations (spec 5.9, 10.2 "customer feedback"). There is no survey
provider, so the channel is always `MANUAL`. Routes: `/api/v1/customer-feedback/**` (`docs/API_REFERENCE.md` "Customer
feedback"). Decisions: `docs/DECISIONS.md` "Phase 5 Task 6" and "Phase 5 Task 1" ruling 10.

Public API (`index.ts`):
- `recordCustomerFeedback` (`customer_feedback.create` over the JOB's org unit): rating 1-5 and / or a comment, optionally
  about one employee who was assigned to the job. The customer and the org unit are copied from the job.
- `voidCustomerFeedback` (`customer_feedback.edit`): once, with a reason; a second void is a 409.
- `getCustomerFeedback`, `listCustomerFeedback` (`customer_feedback.view`; voided entries only with `includeVoided=true`).

Invariants:
1. What the customer said (job, customer, employee, rating, comment, time) never changes (DB trigger); a voided entry stays
   voided (DB trigger); nothing is deleted (DB trigger).
2. Scope = the job's org unit at recording time (`orgUnitId`), like follow-up tasks; an out-of-scope or unknown job is a 404.
3. No free text in audit events: the comment and the void reason are audited as SHA-256 digests.
4. Feedback is a performance input only through a published `CUSTOMER_FEEDBACK_AVERAGE` definition (non-voided, rated
   entries about the employee). This module imports nothing from performance and nothing in dispatch, eligibility or
   compensation imports it (spec 10.3).
