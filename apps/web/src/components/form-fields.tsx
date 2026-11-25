import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Switch } from "@/components/ui/switch";

/** The ids of a field's hint and error, for aria-describedby. */
export function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

/** A labelled text input with its hint and error. A password stays hidden until its eye button shows it. */
export function TextField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  type,
  ...input
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<ComponentProps<"input">, "id" | "value" | "onChange">) {
  const control = {
    id,
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, hint, error),
    ...input,
  };
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {type === "password" ? <SecretInput {...control} /> : <Input type={type} {...control} />}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A switch with its label and hint beside it. */
export function SwitchField(props: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch
        id={props.id}
        checked={props.checked}
        onCheckedChange={props.onChange}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      <FieldContent>
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        {props.hint ? <FieldDescription id={`${props.id}-hint`}>{props.hint}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

/** Errors that belong to no field of the form. */
export function FormErrors({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="list-disc pl-4">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
