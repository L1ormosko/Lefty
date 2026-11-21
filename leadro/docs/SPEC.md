MASTER PRODUCT SPECIFICATION
Enterprise Field Operations Platform
Version: 1.0 – Consolidated Product & Engineering Specification Product Type: Multi-Tenant Enterprise SaaS Initial Market: United States Target Organization Size: 100–1,000+ employees Initial Languages: English, Spanish, Hebrew Development Environment: Claude Code Specification Language: English Status: Functional baseline for detailed implementation planning
DOCUMENT CONTROL
Purpose
This document defines the product requirements, system behavior, user experiences, organizational architecture, permissions, financial logic, operational workflows, database structure, API boundaries, security requirements and implementation standards for the Enterprise Field Operations Platform.
It is intended to serve as the central product specification for product development.
It is not permission to generate the entire application in one uncontrolled coding session.
Claude Code must use this specification as the source of truth, implement the platform incrementally, and maintain consistency between all modules.
Requirement Classification
Requirements are classified as:
MUST: Mandatory platform behavior.
SHOULD: Strongly recommended behavior.
CONFIGURABLE: Behavior that individual companies may customize.
OPTIONAL: Capability that can be activated when needed.
FUTURE: Planned capability not required for the initial release.
If a requirement conflicts with another requirement, security, financial integrity and data correctness take precedence.
PART 1 — PRODUCT VISION AND STRATEGY
1.1 Product Definition
Build a comprehensive Enterprise Field Operations Platform for companies that provide services through distributed field employees.
The platform must manage the complete operating lifecycle:
Company setup.
Organizational hierarchy.
Employee management.
Lead intake.
Customer management.
Lead distribution.
Job creation.
Employee qualification.
Dispatch and scheduling.
Navigation and arrival verification.
Field job execution.
Job outcome reporting.
Lead recovery.
Customer follow-up.
Revenue and expense recording.
Commission and compensation calculations.
Management approvals.
Employee development.
Financial reconciliation.
Executive reporting.
The platform must replace disconnected operational systems through one shared and consistent business data model.
1.2 Target Customer
The initial target customer is a field service company operating in the United States with:
100–1,000+ employees.
Multiple operating states.
Multiple regions and cities.
Multiple branches.
Centralized or distributed lead operations.
Field technicians and sales representatives.
Several management levels.
Complex employee compensation arrangements.
Different job categories.
Different qualification requirements.
Central financial oversight.
The platform must remain flexible enough to support smaller organizations and future international customers.
1.3 Product Differentiation Hypothesis
The proposed competitive advantage is advanced organizational and operational flexibility.
The platform should make it possible to configure complex business structures and operating policies without custom development for every company.
Potential differentiators:
Configurable multi-level organizational structures.
Flexible permission scopes.
Advanced compensation and commission policies.
Unified lead-to-job-to-financial workflows.
Qualification-aware dispatch.
Integrated lead recovery.
Employee development analytics.
Centralized operational and financial visibility.
Configurable automation across organizational levels.
These differentiators must be validated against competitors and customer interviews. They must not be presented as proven market gaps.
1.4 Core Product Principles
One tenant must never access another tenant’s private data.
Every operational record must have a clear owner and lifecycle.
Every sensitive action must be permission-checked on the backend.
Every financial result must be reproducible.
Historical financial records must not silently change.
Organizational hierarchy must be configurable.
Roles and data scopes must be separate concepts.
Employee performance must not automatically determine access to work.
Professional eligibility must be separate from performance evaluation.
AI must provide explainable recommendations.
Critical financial and employment decisions must retain human oversight.
The mobile experience must be simple enough for field use.
Every major workflow must have defined error and recovery behavior.
All modules must use shared business records.
The platform must support multiple languages from the beginning.
PART 2 — SYSTEM ARCHITECTURE
2.1 Application Structure
The platform consists of three primary application experiences.
A. Enterprise Web Application
For management, administration, finance, dispatch, lead operations and customer relations.
Primary characteristics:
Desktop-first.
Responsive tablet support.
Advanced tables and filters.
Management dashboards.
Detailed configuration screens.
Approval workflows.
Reporting and exports.
B. Technician Mobile Application
For technicians, sales representatives, field supervisors and team leaders.
Primary characteristics:
Mobile-first.
Minimal navigation.
Large touch targets.
Simple job workflows.
Navigation integration.
Controlled location access.
Camera and attachment support.
Push notifications.
Limited offline capability.
C. Customer Communication Layer
For outbound and inbound customer interactions.
Initial capabilities:
SMS.
Email.
Phone call logging.
Follow-up tasks.
Customer communication history.
A separate customer portal is optional and should not delay the operational platform.
2.2 Backend Architecture
The backend must be divided into clear functional modules:
Identity and Authentication.
Tenant Management.
Organization Management.
User and Employee Management.
Authorization.
Customer Management.
Lead Management.
Job Management.
Dispatch and Scheduling.
Field Operations.
Qualification.
Performance and Development.
Lead Recovery.
Financial Management.
Compensation and Commissions.
Notifications.
Workflow Automation.
Analytics and Reporting.
Integrations.
Audit and Compliance.
Localization.
2.3 Architecture Strategy
Start with a modular monolith unless technical evidence justifies separate services.
The application must have clear internal module boundaries and stable interfaces.
Do not introduce microservices merely because the platform is intended for Enterprise customers.
The initial system should support:
Transactional database operations.
Background job queues.
Event-driven internal workflows.
Centralized authorization.
Structured logging.
API versioning.
Automated testing.
Monitoring.
Database migrations.
Heavy reporting and route optimization should be designed so that they can later be separated from the main transactional workload.
2.4 Suggested Technology Stack
The following is a candidate stack, subject to technical review.
Layer
Candidate
Web frontend
React / Next.js / TypeScript
Mobile application
React Native
Backend
Node.js / TypeScript
Database
PostgreSQL
Authentication
Managed identity provider
File storage
Private object storage
Background jobs
Managed queue or job processor
Maps
Google Maps Platform
Navigation
Google Maps and Waze deep links
Notifications
APNs / Firebase / SMS / Email providers
Monitoring
Error tracking and application monitoring
Hosting
Managed cloud infrastructure
Claude Code must not change the approved stack without documenting the reason and obtaining approval.
PART 3 — MULTI-TENANT ORGANIZATION ENGINE
3.1 Tenant Model
Each customer company is a tenant.
A tenant must have independent:
Employees.
Customers.
Leads.
Jobs.
Financial records.
Organizational structure.
Permissions.
Compensation policies.
Configuration.
Documents.
Audit history.
Integrations.
Every tenant-owned database record must have a tenant identifier.
Tenant isolation must be enforced through server-side authorization and database-level controls where supported.
Frontend filtering is never sufficient.
3.2 Legal Entities and Business Units
A tenant may contain multiple legal entities and operating units.
Example:
Company Group
Legal Entity A
Texas Operations
Florida Operations
Legal Entity B
California Operations
Nevada Operations
The system must distinguish:
Tenant.
Legal entity.
Operational business unit.
State.
Region.
City.
Branch.
Department.
Team.
These concepts must not be treated as interchangeable.
3.3 Organizational Hierarchy
The hierarchy must be configurable.
Example:
Owner / CEO
COO
State Manager
Regional Manager
City Manager
Team Leader
Technician
Additional departments:
Finance.
Human Resources.
Lead Operations.
Dispatch.
Customer Relations.
Compliance.
Administration.
The system must support:
One manager supervising multiple regions.
Multiple managers sharing responsibility.
Centralized dispatch across multiple states.
Finance access across all states.
Temporary employee assignments.
Employees belonging to operational teams without changing their legal employer.
3.4 Organization Administration Screens
Screen: Company Overview
Displays:
Company identity.
Legal entities.
Active states.
Number of employees.
Number of branches.
Company defaults.
Subscription and module status.
Actions:
Edit company profile.
Add legal entity.
Configure company defaults.
View organization structure.
Screen: Organization Structure
Displays a searchable hierarchical tree.
Users with appropriate permissions can:
Add organizational units.
Rename units.
Move units.
Assign managers.
Assign employees.
View reporting relationships.
View assignment history.
A move must validate that it does not create an invalid hierarchy or circular reporting relationship.
Screen: Branch Management
Displays:
Branch name.
Address.
State and region.
Manager.
Employees.
Operating hours.
Supported service categories.
Active status.
Screen: Organization History
Displays historical changes with:
Previous assignment.
New assignment.
Effective date.
User responsible.
Reason.
Historical reports must use the appropriate historical organizational assignment.
PART 4 — USER MANAGEMENT AND ACCESS CONTROL
4.1 Authentication
The system must support:
Secure login.
Password reset.
Account invitations.
Multi-factor authentication for sensitive roles.
Session management.
Account lockout protections.
User deactivation.
Login history.
Employees must not share accounts.
4.2 RBAC and ABAC
Use both:
Role-Based Access Control: defines what actions a user may perform.
Attribute-Based Access Control: defines which records the user may access.
Authorization must consider:
Tenant.
Legal entity.
State.
Region.
City.
Branch.
Department.
Team.
Assigned jobs.
Assigned customers.
Sensitive data category.
4.3 Permission Actions
Standard permission actions:
View.
Create.
Edit.
Archive.
Assign.
Approve.
Reject.
Export.
Manage.
Configure.
Sensitive actions may require additional approval.
4.4 Initial Role Templates
Roles are configurable templates, not fixed system identities.
Owner / CEO
Access:
Company-wide overview.
Financial summaries.
Organization structure.
Executive reports.
High-level approvals.
System configuration.
COO / VP Operations
Access:
Operational performance.
States and regions.
Dispatch oversight.
Job lifecycle reporting.
Operational policies.
Finance Director
Access:
Financial records.
Compensation calculations.
Commission policies.
Adjustments.
Reconciliation.
Financial approvals.
Finance access does not automatically grant operational management permissions.
State Manager
Access:
Assigned state.
Regional managers.
City managers.
State employees.
State jobs and leads.
Authorized financial summaries.
Regional Manager
Access:
Assigned regions.
Cities within scope.
Employees and jobs within scope.
Regional performance.
City Manager
Access:
Assigned city.
Employees and teams.
Local jobs.
Local leads.
Employee development information.
Team Leader
Access:
Assigned team.
Team schedules.
Team jobs.
Team performance.
Approved operational actions.
Lead Operations Manager
Access:
Lead queues.
Lead employees.
Assignment and follow-up.
Lead recovery.
Lead analytics.
Dispatcher
Access:
Dispatch board.
Employee availability.
Assigned territories.
Job assignments.
Scheduling.
Operational status.
Customer Relations
Access:
Customer information within assigned scope.
Customer interaction history.
Complaints.
Follow-up tasks.
HR Manager
Access:
Employee records.
Employment information.
Training.
Certifications.
Development records.
Technician / Sales Representative
Access:
Own profile.
Own shift.
Assigned jobs.
Necessary customer information.
Navigation.
Job execution.
Own compensation statements.
Own performance information.
4.5 Permission Matrix
The following matrix defines default access. Actual permissions must remain configurable.
Module
CEO
COO
Finance
State Manager
City Manager
Dispatcher
Lead Ops
Technician
Company settings
Full
Limited
No
No
No
No
No
No
Organization
Full
View
No
Scoped
Scoped
No
No
No
Employees
Full
Scoped
Financial fields
Scoped
Scoped
Availability
Lead team
Own
Customers
Full
Scoped
Billing fields
Scoped
Scoped
Job-related
Lead-related
Assigned jobs
Leads
Full
View
No
Scoped
Scoped
Dispatch-related
Full scope
Assigned
Dispatch
Full
Full
No
Scoped
Scoped
Full scope
Limited
Own jobs
Jobs
Full
Full
Financial view
Scoped
Scoped
Operational
Recovery-related
Assigned
Compensation
Full
View
Full
Configurable
Limited
No
No
Own statements
Financial reports
Full
View
Full
Scoped
Limited
No
No
Own summary
Performance
Full
View
No
Scoped
Scoped
No
Lead team
Own
Permissions
Full
Limited
No
No
No
No
No
No
“Full” and “Scoped” still remain subject to tenant isolation and configured approval requirements.
4.6 Access Administration Screen
Administrators must be able to:
Create roles.
Clone roles.
Assign permissions.
Define data scope.
Set temporary access.
Revoke access.
Review effective access.
View permission history.
The application must provide a “Why can this user access this record?” diagnostic for authorized administrators.
PART 5 — USER WORKSPACES AND SCREEN SPECIFICATIONS
Every role must receive a workspace appropriate to its responsibilities.
5.1 Executive Workspace
Navigation:
Overview.
Organization.
Operations.
Financial Overview.
Performance.
Reports.
Approvals.
Administration.
Home screen widgets:
Revenue.
Collected revenue.
Outstanding balances.
Jobs completed.
Lead conversion.
State comparisons.
Regional comparisons.
Recovery results.
Pending approvals.
Operational alerts.
Filters:
Date range.
Legal entity.
State.
Region.
Branch.
Service category.
All widgets must respect user permissions.
5.2 COO Workspace
Navigation:
Operations Overview.
States.
Dispatch Overview.
Workforce.
Job Performance.
Operational Exceptions.
Reports.
Widgets:
Active jobs.
Unassigned jobs.
Delayed jobs.
Technician availability.
State performance.
Regional productivity.
Workload distribution.
Operational bottlenecks.
Actions:
Review state operations.
Escalate operational problems.
Approve authorized operational policies.
Review dispatch performance.
5.3 State Manager Workspace
Navigation:
State Dashboard.
Regions and Cities.
Employees.
Leads.
Jobs.
Dispatch.
Financial Summary.
Compensation Policies.
Performance.
Approvals.
Widgets:
State revenue.
Job volume.
Conversion rate.
City comparisons.
Employee activity.
Material costs.
Commission summaries.
Recovery cases.
Pending approvals.
Actions:
Assign regional responsibilities.
Review local operations.
Propose compensation policies.
Review material cost tables.
Approve actions within delegated authority.
A State Manager must not automatically have permission to approve their own financial policy changes if dual approval is required.
5.4 City Manager Workspace
Navigation:
City Overview.
Team.
Employees.
Leads.
Jobs.
Schedule.
Performance.
Customer Issues.
Widgets:
Available employees.
Today’s jobs.
Open jobs.
Unconverted jobs.
Recovery activity.
Employee development alerts.
Local revenue.
Actions:
Review employees.
Assign jobs where authorized.
Escalate customer issues.
Recommend training.
Review performance evidence.
5.5 Dispatcher Workspace
Navigation:
Dispatch Board.
Unassigned Jobs.
Schedule.
Employee Availability.
Map.
Delays.
Assignment History.
Main dispatch screen:
Central job list.
Employee availability panel.
Geographic map.
Calendar or timeline.
Job detail drawer.
Recommended assignment panel.
Actions:
Assign job.
Reassign job.
Reschedule.
Change priority.
Review employee qualifications.
View estimated travel time.
Add dispatch notes.
The system must display the reason for every recommended assignment.
5.6 Lead Operations Workspace
Navigation:
Lead Dashboard.
New Leads.
Unassigned Leads.
Assigned Leads.
Contact Queue.
Lead Recovery.
Follow-up Tasks.
Lead Sources.
Reports.
Widgets:
New leads.
Uncontacted leads.
Average response time.
Lead conversion.
Lost leads.
Recovery queue.
Successful recoveries.
Actions:
Assign leads.
Reassign leads.
Record contact attempts.
Create follow-up.
Call customer through an approved integration.
Escalate cases.
5.7 Finance Workspace
Navigation:
Financial Overview.
Transactions.
Revenue.
Expenses.
Materials.
Compensation Policies.
Commission Calculations.
Employee Statements.
Adjustments.
Refunds.
Reconciliation.
Approvals.
Reports.
Widgets:
Revenue.
Collected amount.
Outstanding balance.
Direct costs.
Gross profit.
Pending compensation.
Reconciliation exceptions.
Policy changes awaiting approval.
Actions:
Review transactions.
Approve adjustments.
Review compensation calculations.
Reconcile payments.
Export authorized reports.
5.8 HR Workspace
Navigation:
Employee Directory.
Employee Profiles.
Qualifications.
Certifications.
Training.
Development Plans.
Employment Status.
Reports.
Actions:
Invite employee.
Update employment records.
Record training.
Review certification expiry.
Create development plans.
Review employee-submitted corrections.
Sensitive personal information must be access-controlled.
5.9 Customer Relations Workspace
Navigation:
Customer Directory.
Customer Search.
Interactions.
Complaints.
Follow-up Tasks.
Service History.
Actions:
Contact customer.
Record complaint.
Create follow-up.
Review previous jobs.
Escalate unresolved issues.
5.10 Technician Mobile Workspace
Primary navigation:
Home.
My Jobs.
Schedule.
Earnings.
Profile.
Home screen:
Shift status.
Start or end shift.
Current job.
Next job.
Customer address.
Navigation.
Job status.
Urgent notifications.
The mobile application must avoid unnecessary management and administrative screens.
5.11 Employee Self-Service Workspace
Employees may access:
Personal profile.
Work schedule.
Shift history.
Job history.
Compensation statements.
Approved performance metrics.
Training records.
Certification status.
Notifications.
Language preferences.
Employees must not see other employees’ confidential financial or personal information.
PART 6 — CUSTOMER AND LEAD MANAGEMENT
6.1 Customer Record
Customer information:
Customer ID.
Name.
Phone.
Email.
Service addresses.
Preferred language.
Communication preferences.
Customer notes.
Historical leads.
Historical jobs.
Payments.
Complaints.
Attachments.
Customer information must be accessible only to authorized users.
6.2 Lead Intake
Lead sources:
Manual entry.
Phone.
Website.
Marketing campaign.
External CRM.
API.
Import.
Approved integration.
Lead fields:
Lead ID.
Customer.
Service address.
Service category.
Requested work.
Lead source.
Campaign.
Priority.
Preferred time.
Notes.
Attachments.
Current owner.
Current status.
6.3 Lead Lifecycle
Suggested statuses:
New.
Unassigned.
Assigned.
Contact Attempted.
Contacted.
Qualified.
Scheduled.
Dispatched.
Converted.
Lost.
Duplicate.
Cancelled.
All transitions must be validated.
Status changes must record:
Previous status.
New status.
User or system responsible.
Timestamp.
Reason where applicable.
6.4 Duplicate Detection
Use configurable matching based on:
Phone.
Email.
Address.
Customer identity.
Recent history.
Possible duplicates must be flagged.
Automatic merging must not be enabled by default.
PART 7 — JOB MANAGEMENT AND DISPATCH
7.1 Job Creation
A job may be created from:
A converted lead.
A recurring service agreement.
A manual administrative action.
An external integration.
A customer follow-up.
A job must have:
Job ID.
Customer.
Service address.
Job category.
Job description.
Required skills.
Required equipment.
Priority.
Appointment window.
Estimated duration.
Assigned employee or team.
Current status.
7.2 Job Lifecycle
Default lifecycle:
Created.
Pending Assignment.
Assigned.
Scheduled.
En Route.
Arrived.
In Progress.
Completed.
Awaiting Review where required.
Closed.
Alternative terminal or exceptional statuses:
Cancelled.
Customer Unavailable.
Rescheduled.
Failed.
On Hold.
Requires Return Visit.
Not every job must pass through every status.
The company may configure certain workflows, but invalid transitions must remain blocked.
7.3 Dispatch Eligibility
Hard eligibility requirements:
Active employee.
Valid required license.
Valid required certification.
Required skills.
Approved service territory.
Required equipment.
Available time slot.
Soft matching factors:
Travel time.
Workload.
Experience.
Customer preference.
Job complexity.
Historical quality.
Route efficiency.
Performance metrics must not independently remove access to ordinary work.
7.4 Dispatch Recommendation
Each recommendation should include:
Recommended employee.
Estimated arrival.
Required skill match.
Availability.
Distance or travel time.
Existing workload.
Explanation.
Any conflicts.
The dispatcher may approve, reject or modify the recommendation.
Manual overrides must be recorded.
7.5 Dispatch Modes
Manual.
AI-assisted with human approval.
Rule-based automatic.
Advanced automatic optimization.
AI-assisted with human approval is the initial default.
PART 8 — TECHNICIAN MOBILE APPLICATION
8.1 Shift Start
The technician selects Start Shift.
The system records:
Employee.
Timestamp.
Device.
Shift status.
Location event if authorized.
Relevant exception information.
The technician must be able to see whether the shift started successfully.
8.2 Assigned Jobs
The technician sees:
Job priority.
Customer.
Address.
Service type.
Appointment window.
Instructions.
Estimated duration.
Required equipment.
Job status.
8.3 Navigation
Actions:
Open Google Maps.
Open Waze where supported.
View address.
Copy address.
Opening navigation must not be interpreted as proof of arrival.
8.4 Arrival
Arrival may be confirmed by:
Technician action.
Authorized geofence event.
Manager verification.
The application must show the recorded arrival time and its verification method.
GPS accuracy must not be represented as absolute certainty.
8.5 Work Execution
The technician can:
Start work.
Pause where supported.
Add notes.
Upload photographs.
Record materials.
Record work performed.
Record additional work requested.
Record customer approval.
Complete or report incomplete work.
8.6 Job Completion Form
The completion form must be configurable by job category.
Potential fields:
Outcome.
Quoted amount.
Approved amount.
Final charged amount.
Amount collected.
Payment method.
Payment status.
Materials.
Quantity.
Photos.
Notes.
Customer signature.
Follow-up requirement.
Do not force every job type to use identical fields.
8.7 Offline Behavior
The application should support limited offline use.
Permitted offline operations may include:
Viewing previously synchronized jobs.
Recording notes.
Capturing photos.
Recording selected status events.
Offline events must be queued and synchronized when connectivity returns.
The user must see synchronization status.
The backend must handle duplicate submissions safely.
PART 9 — JOB OUTCOME AND LEAD RECOVERY
9.1 Outcome Reporting
After each customer visit, the technician must report the outcome.
Primary choices:
Job Sold / Accepted.
Job Not Sold / Not Accepted.
Customer Unavailable.
Reschedule Required.
Work Not Possible.
Additional Approval Required.
The system must require a reason for relevant unsuccessful outcomes.
9.2 Lost Job Reasons
Configurable reasons:
Price too high.
Customer wants to think.
Customer declined.
Customer unavailable.
Customer requested another appointment.
Missing materials.
Missing equipment.
Work outside service capabilities.
Technical issue.
Other.
9.3 Lead Recovery Workflow
When a job is not converted:
Save the outcome.
Create a recovery case when the configured rules apply.
Notify the responsible Lead Operations team.
Check technician presence if location information is available.
Display the case in the recovery dashboard.
Allow authorized follow-up.
Record communication attempts.
Record final outcome.
Link recovered work to the original customer and opportunity.
9.4 Recovery Dashboard
Each case should display:
Customer.
Job.
Technician.
Lost reason.
Job outcome time.
Technician presence status.
Assigned recovery employee.
Priority.
Contact attempts.
Final status.
Priority may be based on:
Customer still present.
Estimated opportunity value.
Time sensitivity.
Customer request.
Company-defined rules.
9.5 Recovery Statuses
New.
Assigned.
Contacting.
Customer Reached.
Follow-up Required.
Recovered.
Not Recovered.
Closed.
9.6 Recovery Automation
Example rule:
When:
Job outcome = Not Sold.
Reason = Price Too High.
Technician still appears to be at the location.
Then:
Create urgent recovery case.
Notify Lead Operations.
Display technician presence.
Recommend a customer call.
The system must not automatically offer an unauthorized discount.
9.7 Recovery Attribution
Track:
Initial job value.
Recovery attempts.
Recovery employee.
Recovery timestamp.
Result.
Final sold amount.
Collected amount.
Reports must distinguish confirmed recovered revenue from estimates of revenue attribution.
PART 10 — EMPLOYEE QUALIFICATION AND DEVELOPMENT
10.1 Qualification Engine
This engine determines professional eligibility.
It must support:
Skills.
Experience.
Licenses.
Certifications.
Training.
Equipment qualifications.
Job-category permissions.
Geographic restrictions.
Mandatory requirements must be enforced before dispatch recommendations.
10.2 Performance Engine
This engine measures performance for development and management purposes.
Possible dimensions:
Work quality.
Repeat visits.
Customer feedback.
Timeliness.
Documentation.
Productivity.
Sales performance where relevant.
Training progress.
Metrics must be contextualized by job type, complexity and available opportunities.
10.3 Employee Protection
Performance scores must not automatically:
Reduce work assignments.
Remove eligibility.
Change compensation.
Reduce commissions.
Suspend employees.
Legal qualifications and safety requirements are handled separately through the Qualification Engine.
10.4 Manager Development Dashboard
Display:
Employee strengths.
Development opportunities.
Training recommendations.
Historical improvement.
Evidence behind metrics.
Coaching notes.
Review history.
Managers must be able to add context.
Employees must have an appropriate way to challenge inaccurate information.
A single universal score must not be the sole basis for employee evaluation.
PART 11 — FINANCIAL ENGINE
11.1 Financial Definitions
The system must distinguish:
Quoted Amount.
Approved Amount.
Charged Amount.
Collected Amount.
Outstanding Balance.
Refund.
Chargeback.
Direct Material Cost.
Other Direct Cost.
Gross Profit.
Compensation.
Adjustment.
The exact accounting treatment must be configurable and reviewed by qualified finance professionals.
Gross profit must not be represented as net profit.
11.2 Compensation Models
Support:
Commission percentage.
Fixed commission.
Hourly compensation.
Hybrid compensation.
Bonuses.
Team-based compensation.
Manager-level incentives.
Multiple compensation components.
Compensation rules may vary by:
Employee.
Role.
Job category.
Region.
State.
Legal entity.
Effective date.
11.3 Commission Basis
The system must support selectable commission bases:
Sold amount.
Approved amount.
Charged amount.
Collected amount.
Defined gross profit.
Fixed amount per job.
The selected basis must be explicitly defined in each compensation policy.
11.4 Material Costs
Authorized managers may maintain material cost tables.
Each material should have:
Material ID.
Name.
Unit.
Cost.
Supplier where relevant.
Effective date.
Active status.
Historical versions.
A change in material cost must not silently rewrite historical job costs.
11.5 Commission Policy Workflow
Authorized manager creates a draft.
System validates the configuration.
Financial preview is generated.
Required approvers review.
Policy is approved.
Policy becomes active on its effective date.
All affected calculations reference the applicable policy version.
The system must support dual approval where configured.
11.6 Commission Calculation
For every calculation, preserve:
Original job.
Revenue basis.
Material cost basis.
Policy version.
Calculation inputs.
Calculation output.
Calculation timestamp.
Rounding method.
Approvals.
Adjustments.
The calculation must be reproducible.
11.7 Refunds and Adjustments
Refunds, cancellations and chargebacks must be represented as explicit financial events.
The system must not simply delete or rewrite a previous commission.
Possible handling:
Reverse unpaid commission.
Record adjustment.
Create recovery balance where legally and contractually permitted.
Flag for finance review.
No automatic deduction from employee wages should be implemented without appropriate legal review and approved policy.
11.8 Financial Ledger
Use append-only financial events from the application perspective.
Corrections must be represented through adjustment or reversal transactions.
Financial calculations must use precise decimal or integer-based monetary values.
Never use ordinary floating-point arithmetic for money.
11.9 Payroll Boundary
The platform may calculate commission statements and compensation estimates.
It must not claim to be a compliant US payroll engine until tax, wage, overtime, deduction and state-specific requirements have been independently implemented and validated.
Payroll-provider integration should be supported.
PART 12 — EMPLOYEE EARNINGS AND STATEMENTS
12.1 Employee Earnings Screen
Each employee should see authorized personal information:
Completed jobs.
Compensation components.
Commission basis.
Hourly totals where applicable.
Bonuses.
Adjustments.
Pending amounts.
Approved statements.
Payment status.
The employee must be able to distinguish:
Estimated earnings.
Pending approval.
Approved earnings.
Paid earnings.
An estimate must never be displayed as guaranteed payment.
12.2 Compensation Statement
Each statement should include:
Period.
Employee.
Compensation model.
Included jobs.
Calculation details.
Adjustments.
Total approved amount.
Payment status.
Employees may submit a question or dispute through an authorized workflow.
PART 13 — ANALYTICS AND REPORTING
13.1 Executive Analytics
Metrics:
Revenue.
Collections.
Outstanding balance.
Job volume.
Conversion rate.
Direct costs.
Gross profit.
Compensation.
Employee productivity.
State comparisons.
Region comparisons.
Lead source performance.
Recovery outcomes.
13.2 Operational Analytics
Metrics:
Lead response time.
Time to assignment.
Time to arrival.
Job duration.
Jobs per employee.
Completed jobs.
Revisit rate.
Cancellation rate.
Unassigned jobs.
Dispatch efficiency.
13.3 Financial Analytics
Metrics:
Sold revenue.
Charged revenue.
Collected revenue.
Outstanding amounts.
Material costs.
Direct costs.
Commission expense.
Refunds.
Adjustments.
Reconciliation exceptions.
13.4 Metric Definitions
Every KPI must have:
Formal definition.
Calculation formula.
Source records.
Time period.
Applicable organizational scope.
Responsible data owner.
The same KPI must not have different meanings across dashboards without explicit labeling.
13.5 Report Builder
Authorized users should be able to:
Select report type.
Select date range.
Filter organizational scope.
Choose available columns.
Save views.
Export permitted records.
Exports must respect permissions and be audited.
PART 14 — NOTIFICATION ENGINE
14.1 Notification Channels
In-app.
Push.
Email.
SMS.
The company may configure available channels.
Users may configure non-critical preferences.
Mandatory security and operational notifications must follow company policy.
14.2 Notification Events
Examples:
New lead assigned.
Job assigned.
Job reassigned.
Shift reminder.
Job delayed.
Arrival confirmed.
Job completed.
Job not converted.
Recovery case created.
Recovery case assigned.
Compensation policy submitted.
Compensation policy approved.
Certification expiring.
Financial adjustment pending.
14.3 Notification Reliability
Each notification must track:
Event ID.
Recipient.
Channel.
Creation time.
Delivery attempt.
Provider response.
Failure reason.
Retry status.
Use idempotency keys to prevent duplicate business actions.
Notification delivery failure must not reverse a successfully completed business transaction.
PART 15 — WORKFLOW AUTOMATION
15.1 Automation Engine
Administrators may configure event-based rules.
Each rule contains:
Trigger.
Conditions.
Actions.
Scope.
Approval requirements.
Priority.
Active status.
Version.
Example:
Trigger: Job marked Not Sold.
Conditions: Reason = Price Too High.
Actions: Create recovery case. Notify Lead Operations. Assign priority. Create follow-up task.
15.2 Automation Safety
Rules must be:
Auditable.
Versioned.
Testable.
Scoped.
Idempotent where applicable.
The system must prevent circular automation loops.
High-impact automation must require approval before activation.
PART 16 — MULTILINGUAL PLATFORM
16.1 Supported Languages
Initial:
English (en-US).
Spanish (es-US).
Hebrew (he-IL).
The architecture must allow additional languages without changes to business logic.
16.2 Language Selection
Language preferences:
Company default.
Branch default.
Individual user.
Customer communication.
Individual preference overrides company default for the user’s interface.
16.3 Translation System
All user-facing text must use translation keys.
Example:
JOB_COMPLETED
English: Completed
Spanish: Completado
Hebrew: הושלמה
Database identifiers and internal statuses must remain language-neutral.
16.4 RTL and LTR
Support:
Left-to-right layouts.
Right-to-left layouts.
Mixed-direction content.
Correct forms and navigation.
Correct numbers and currency rendering.
RTL must be tested on every major application workspace.
16.5 Regional Formatting
Support:
Time zones.
Dates.
Numbers.
Currency.
Phone numbers.
Addresses.
Measurement units.
Store timestamps consistently and display them in the appropriate business context.
Do not assume all employees work in the same time zone.
16.6 Translation Administration
Support:
Translation files.
Fallback language.
Missing-key detection.
Translation versioning.
Reviewed translation updates.
Machine-translated legal and financial content must not be published without human review.
PART 17 — MOBILE LOCATION AND GPS
17.1 Location Principles
The platform must not use unnecessary continuous tracking.
Location collection should be limited to defined operational purposes.
Potential events:
Shift start.
Arrival.
Departure.
Shift end.
Approved location verification.
17.2 Location Verification
Support:
User confirmation.
Geofence event.
Server-recorded timestamp.
Accuracy information.
Manual exception.
The system must not treat GPS as infallible evidence.
17.3 Battery and Background Behavior
The mobile application must minimize background location requests.
Use platform-appropriate geofencing and event-driven location updates where possible.
Do not implement frequent polling as the default solution.
The application must explain location permissions to users.
17.4 Location Exceptions
Examples:
GPS disabled.
Permission denied.
Poor signal.
Device offline.
User outside geofence.
Location event delayed.
These cases must support manual verification or an authorized exception workflow.
PART 18 — INTEGRATION FRAMEWORK
18.1 Integration Management
The platform must centralize external integrations.
Each integration must have:
Provider.
Tenant configuration.
Connection status.
Credentials reference.
Permissions.
Webhook settings.
Error logs.
Retry policy.
Secrets must never be stored in frontend code.
18.2 Initial Integration Categories
Maps.
Navigation.
SMS.
Email.
Telephony.
Payment processing.
Payroll.
Accounting.
Marketing lead sources.
External CRM systems.
18.3 Integration Reliability
The system must handle:
Provider outages.
Rate limits.
Duplicate webhooks.
Invalid payloads.
Delayed responses.
Authentication expiry.
Partial failures.
All external events must be validated before modifying core records.
PART 19 — DATABASE ARCHITECTURE
19.1 Core Entity Inventory
Organization
Tenant.
LegalEntity.
BusinessUnit.
State.
Region.
City.
Branch.
Department.
Team.
OrganizationalAssignment.
Identity and Access
User.
Employee.
Role.
Permission.
RoleAssignment.
AccessScope.
Session.
AuthenticationEvent.
Customer and Leads
Customer.
CustomerAddress.
Lead.
LeadSource.
LeadAssignment.
LeadStatusHistory.
LeadInteraction.
LeadRecoveryCase.
Jobs
Job.
JobType.
JobAssignment.
JobStatusHistory.
JobEvent.
JobMaterial.
JobAttachment.
JobPayment.
JobOutcome.
Workforce
Shift.
Availability.
Skill.
Certification.
EmployeeQualification.
PerformanceMetric.
CoachingRecord.
TrainingRecord.
Finance
FinancialTransaction.
MaterialCostVersion.
CompensationPolicy.
CompensationPolicyVersion.
CompensationCalculation.
CompensationStatement.
Adjustment.
Refund.
Reconciliation.
Approval.
Platform
Notification.
NotificationDelivery.
AuditEvent.
WorkflowRule.
WorkflowExecution.
Integration.
WebhookEvent.
TranslationResource.
19.2 Database Rules
Every tenant-owned entity must be tenant-scoped.
Use foreign keys.
Use appropriate unique constraints.
Use indexes for common query patterns.
Use transactional operations for financial changes.
Use soft deletion only where appropriate.
Preserve historical financial events.
Restrict direct modification of audit records.
Define retention rules.
Use migrations for schema changes.
The logical entity list is not a substitute for a finalized relational schema. Claude Code must produce an approved schema design before implementing production financial and authorization modules.
PART 20 — API AND BACKEND CONTRACTS
20.1 API Principles
All API operations must:
Authenticate the caller.
Verify tenant membership.
Check permissions.
Validate input.
Validate business state.
Return structured errors.
Record relevant audit events.
20.2 API Organization
Suggested API groups:
/auth
/tenants
/organization
/users
/employees
/roles
/permissions
/customers
/leads
/lead-recovery
/jobs
/dispatch
/shifts
/qualifications
/performance
/materials
/financial
/compensation
/approvals
/reports
/notifications
/integrations
/settings
These are logical API groups. The final URL structure may use versioning, such as /api/v1.
20.3 API Reliability
For operations that may be retried:
Use idempotency keys.
Prevent duplicate job creation.
Prevent duplicate financial transactions.
Validate state transitions.
Record request correlation IDs.
20.4 Error Handling
Use structured errors with:
Error code.
Human-readable message.
Relevant field.
Retryability.
Correlation ID.
Do not expose internal stack traces or sensitive information to users.
PART 21 — AUDIT AND APPROVAL ENGINE
21.1 Audit Events
Record important events:
Login.
Failed access.
Permission changes.
Employee changes.
Job assignment.
Job reassignment.
Lead ownership change.
Job completion.
Financial changes.
Compensation policy changes.
Approvals.
Exports.
Integration configuration changes.
21.2 Audit Record
Each audit event should include:
Event ID.
Tenant.
Actor.
Action.
Target record.
Timestamp.
Relevant previous value.
Relevant new value.
Reason where applicable.
Source application.
Correlation ID.
Sensitive values must be redacted where necessary.
21.3 Approval Engine
Approval workflows must be configurable.
Possible approvals:
Compensation policy.
Material cost changes.
Financial adjustments.
Refunds.
High-value discounts.
Permission changes.
Organizational changes.
The system must prevent users from approving their own actions when separation of duties is required.
PART 22 — SECURITY AND PRIVACY
22.1 Security Requirements
Implement:
Secure authentication.
MFA for sensitive roles.
Backend authorization.
Tenant isolation.
Encryption in transit.
Encryption at rest.
Secure file storage.
Rate limiting.
Session controls.
Audit logging.
Backup and recovery.
Monitoring.
Vulnerability management.
22.2 Sensitive Information
Restrict access to:
Personal employee records.
Compensation details.
Customer payment information.
Financial reports.
Authentication data.
Location history.
22.3 US Legal Review
Before production, obtain legal review for applicable requirements concerning:
Employment and wage laws.
Overtime.
Employee monitoring.
State privacy laws.
Automated employment decisions.
Customer communication consent.
Payment processing.
Data retention.
Industry-specific licenses.
Do not claim legal or regulatory compliance without validation.
PART 23 — NON-FUNCTIONAL REQUIREMENTS
23.1 Performance
The application should:
Paginate large datasets.
Index common searches.
Avoid unnecessary database queries.
Process heavy jobs asynchronously.
Cache appropriate read-only data.
Monitor slow queries.
Performance targets must be established through testing, not invented in marketing material.
23.2 Scalability
Design for growth to thousands of employees and high volumes of operational events.
Test realistic scenarios:
Simultaneous shift starts.
Bulk lead intake.
Large dispatch operations.
Concurrent job updates.
Financial statement generation.
Notification bursts.
Multi-state reporting.
23.3 Reliability
Define:
Availability objectives.
Recovery Time Objective.
Recovery Point Objective.
Backup schedule.
Restore testing.
Incident response.
Monitoring and alerting.
Do not claim uptime guarantees before infrastructure validation.
23.4 Accessibility
Support:
Keyboard navigation.
Clear labels.
Appropriate contrast.
Screen reader compatibility where practical.
Accessible forms.
Responsive layouts.
PART 24 — DESIGN SYSTEM
24.1 Visual Principles
The platform should look like a professional Enterprise operations application.
Use:
Clear information hierarchy.
Consistent typography.
Restrained color palette.
Consistent spacing.
Reusable components.
Clear status labels.
Responsive tables.
Accessible controls.
Avoid unnecessary animations and decorative UI.
24.2 Shared Components
Build reusable components:
Sidebar.
Top navigation.
Search.
Filter panel.
Data table.
Pagination.
Status badge.
User profile card.
Job card.
Lead card.
Approval panel.
Notification center.
Dialog.
Drawer.
Form.
Date picker.
Chart.
Audit timeline.
Map panel.
24.3 UX Rules
Every screen must have a clear primary action.
Destructive actions require confirmation.
Long forms must be grouped logically.
Errors must identify the problem and correction.
Empty states must explain what to do next.
Tables must support filtering and pagination.
Important information must not rely on color alone.
Every major workflow must provide visible status feedback.
PART 25 — EDGE CASES AND FAILURE SCENARIOS
25.1 Lead Scenarios
Duplicate lead.
Lead assigned to unavailable employee.
Lead with incomplete address.
Customer requests cancellation.
Lead assigned to wrong region.
Lead reassigned while another employee is contacting the customer.
External lead provider sends duplicate webhook.
Expected behavior:
Preserve history, prevent duplicate records where possible, and require authorized resolution for conflicting assignments.
25.2 Dispatch Scenarios
No eligible technician.
Technician becomes unavailable.
Job duration exceeds appointment window.
Technician is delayed.
Job requires additional qualification.
Manager manually overrides recommendation.
Route optimization fails.
Expected behavior:
Display the conflict, preserve the job and provide a safe manual resolution path.
25.3 Technician Scenarios
Phone loses connectivity.
GPS is disabled.
Technician starts the wrong job.
Customer is unavailable.
Technician cannot complete work.
Customer refuses payment.
Materials are unavailable.
Technician accidentally submits twice.
Expected behavior:
Prevent duplicate financial and job events, retain valid offline records and require appropriate exception handling.
25.4 Financial Scenarios
Payment partially collected.
Payment fails.
Customer receives refund.
Chargeback occurs.
Commission policy changes.
Material cost changes.
Job is reopened.
Duplicate payment webhook.
Calculation requires correction.
Expected behavior:
Preserve original records, generate explicit adjustments and maintain calculation reproducibility.
25.5 Permission Scenarios
Manager loses organizational assignment.
Employee changes branch.
User is terminated.
Temporary permission expires.
User attempts cross-tenant access.
User tries to approve their own restricted action.
Expected behavior:
Re-evaluate authorization on every request and preserve historical records.
PART 26 — TESTING AND ACCEPTANCE CRITERIA
26.1 Testing Categories
Every module requires:
Unit tests.
Integration tests.
API tests.
Permission tests.
Tenant isolation tests.
Workflow tests.
Financial tests where relevant.
UI tests.
Mobile tests.
Localization tests.
Load tests where relevant.
26.2 Tenant Isolation Acceptance
A user from Tenant A must be unable to access Tenant B records through:
Direct API requests.
Modified identifiers.
Search.
Exports.
File URLs.
Background jobs.
Reporting endpoints.
26.3 Permission Acceptance
A City Manager must not access another city’s employee records unless explicitly authorized.
A Finance Director must not automatically gain dispatch permissions.
A Technician must not access another technician’s private compensation statement.
A Dispatcher must not change financial policies unless separately authorized.
26.4 Financial Acceptance
Given the same transaction inputs and policy version, the system must reproduce the same calculation.
Historical calculations must remain reproducible after policy changes.
Duplicate webhook events must not create duplicate payments or commissions.
26.5 Lead Recovery Acceptance
When an eligible job is marked Not Sold:
The system creates a recovery case according to configuration.
The correct Lead Operations scope receives the notification.
The case displays the correct reason.
The technician presence status is shown only when supported by valid location data.
Follow-up actions are recorded.
Final conversion is linked to the original opportunity.
26.6 Localization Acceptance
The application must function in English, Spanish and Hebrew.
RTL must work across:
Navigation.
Forms.
Tables.
Dashboards.
Notifications.
Dialogs.
Mobile screens.
No missing translation should silently display a broken interface.
26.7 Definition of Done
A module is complete only when:
Requirements are implemented.
Permissions are tested.
Data integrity is verified.
API behavior is documented.
UI behavior is tested.
Edge cases are covered.
Relevant audit events are implemented.
Acceptance tests pass.
Known limitations are documented.
PART 27 — DEVELOPMENT ROADMAP
Phase 0: Requirements and Architecture
Deliverables:
Approved business rules.
Technical architecture.
Entity relationship diagram.
Permission model.
API conventions.
Design system.
Development environment.
Test environment.
Phase 1: Platform Foundation
Build:
Authentication.
Tenant management.
Company structure.
Users.
Employees.
Roles.
Permissions.
Audit engine.
Localization.
Phase 2: Operational Core
Build:
Customers.
Leads.
Lead assignment.
Job creation.
Job lifecycle.
Dispatch board.
Technician mobile application.
Basic notifications.
Phase 3: Field Operations and Recovery
Build:
Shift management.
Arrival verification.
Navigation integration.
Job completion.
Job outcome reporting.
Lead Recovery Engine.
Follow-up tasks.
Phase 4: Financial Core
Build:
Materials.
Revenue records.
Payment status.
Compensation policies.
Commission calculations.
Approval workflows.
Financial ledger.
Employee statements.
Phase 5: Workforce Intelligence
Build:
Qualifications.
Certifications.
Performance metrics.
Development plans.
Training recommendations.
Phase 6: Enterprise Analytics
Build:
Executive dashboards.
State and regional dashboards.
Finance reports.
Lead reports.
Operational analytics.
Report builder.
Phase 7: Integrations and Automation
Build:
External integrations.
Workflow automation.
Advanced notifications.
Payroll integration.
Accounting integration.
Phase 8: Enterprise Readiness
Complete:
Security review.
Penetration testing.
Load testing.
Disaster recovery.
Mobile reliability testing.
Compliance review.
Customer onboarding.
Production monitoring.
PART 28 — CLAUDE CODE IMPLEMENTATION CONTRACT
28.1 Source of Truth
This document is the central product specification.
However, more detailed approved module specifications may extend it.
If two specifications conflict:
Identify the conflict.
Explain the consequences.
Request clarification for material business decisions.
Do not silently choose a behavior.
28.2 Before Coding
Claude Code must:
Inspect the existing repository.
Identify the current stack.
Review existing files and architecture.
Identify reusable components.
Identify missing modules.
Propose a development plan.
Avoid overwriting working functionality without review.
28.3 During Coding
Claude Code must:
Work incrementally.
Use typed interfaces.
Follow module boundaries.
Keep business rules centralized.
Validate all sensitive operations on the backend.
Write tests.
Maintain documentation.
Avoid hardcoded translations.
Avoid duplicate business logic.
Avoid exposing secrets.
Avoid fake integrations.
28.4 Before Implementing Financial Logic
Claude Code must receive an approved detailed compensation specification.
It must not invent commission formulas.
28.5 Before Implementing Permissions
Claude Code must receive an approved permission matrix and data-scope rules.
It must not assume that role names alone determine access.
28.6 Before Implementing AI
Claude Code must define:
Input data.
Recommendation logic.
Confidence or uncertainty handling.
Explanation.
Human approval.
Audit history.
Failure behavior.
AI must not become an uncontrolled authority over employee livelihood or financial decisions.
28.7 Milestone Reporting
At the end of each milestone, report:
Implemented features.
Changed files.
Database changes.
API changes.
Tests executed.
Tests passed.
Tests failed.
Known limitations.
Security implications.
Remaining tasks.
Do not claim production readiness based on a working prototype.
PART 29 — REMAINING DECISIONS AND CONFIGURATION DEFAULTS
The platform should avoid unnecessary blocking decisions by providing safe initial defaults.
The following defaults are proposed for the first implementation.
Area
Initial default
Tenant structure
One customer company per tenant
Legal entities
Multiple entities supported
Organizational hierarchy
Configurable
User roles
Customizable templates
Permission model
RBAC + ABAC
Dispatch
AI-assisted, human approval
Automatic assignment
Disabled initially
Location tracking
Event-based, not continuous
Job outcome
Required after each completed visit
Lead recovery
Triggered by configured lost reasons
Recovery contact
Human-approved
Employee performance
Development use
Performance-based job exclusion
Prohibited by default
Qualification restrictions
Enforced
Compensation policies
Versioned and approval-controlled
Financial corrections
Adjustment/reversal events
Payroll
External integration initially
Languages
English, Spanish, Hebrew
RTL
Supported
Offline mobile
Limited, controlled synchronization
Architecture
Modular monolith initially
These defaults must be configurable where appropriate and must not override legal requirements.
PART 30 — FINAL PRODUCT DEFINITION
The completed platform must function as one integrated operating system for complex field service organizations.
It must connect:
The executive team.
State and regional management.
Finance.
Dispatch.
Lead operations.
Customer relations.
HR.
Field employees.
Every department must work from shared operational records while seeing only the information and actions authorized for its role.
A lead must be traceable from intake through assignment, customer contact, job execution, financial outcome and possible recovery.
A job must be traceable from creation through completion, payment, costs and compensation.
An employee must have a consistent profile containing employment information, qualifications, assigned work, personal statements and development information.
A manager must be able to understand their operational scope without accessing unrelated confidential information.
The company must be able to change its organizational structure, compensation rules and workflows without rebuilding the platform.
The objective is not simply to create a collection of CRM and field-service features. It is to build a unified, configurable and auditable Enterprise operating platform for companies whose field operations, workforce and financial structures are too complex to manage efficiently through disconnected systems.
