/** Result of a form server action. Messages are already translated (clients hold no catalogs). */
export interface FormState {
  error?: string;
  success?: string;
  /**
   * Non-secret values to put back into the form. React 19 resets uncontrolled inputs after every
   * action, so without this a failed login would make the user retype the company code and email.
   * Never put passwords or codes here.
   */
  fields?: Record<string, string>;
}

export const INITIAL_FORM_STATE: FormState = {};
