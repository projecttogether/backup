/** A person signed in through the web app. Only admins sign in. */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  image: string | null;
  isAdmin: boolean;
};

export type Principal = UserPrincipal;

const OPERATOR = Symbol("operator");

/**
 * Whoever runs the operator command (`cli …`) on the server, with an admin's
 * rights over what the admin pages set. Only the command creates one
 * (src/cli): a request carries no symbol, so no route can stand for it.
 */
export type OperatorPrincipal = {
  readonly [OPERATOR]: true;
  /** The command without its body, e.g. `cli settings apply target`, for the audit log. */
  readonly command: string;
};

/** Who changes something: a signed-in admin or the operator command. */
export type Actor = UserPrincipal | OperatorPrincipal;

/** The operator running `command`. Command line only. */
export function operator(command: string): OperatorPrincipal {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is OperatorPrincipal {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}
