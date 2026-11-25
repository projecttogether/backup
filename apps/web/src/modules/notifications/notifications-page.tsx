import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleCheck, CircleX, HeartPulse, Mail } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { initialSecret, SecretField, secretPayload, type SecretValue } from "@/components/ui/secret-field";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import {
  notificationsInputSchema,
  type Notifications,
  type NotificationsInput,
  type TestResult,
} from "@backup/shared/api/notifications";
import { describedBy, FormErrors, SwitchField, TextField } from "@/components/form-fields";
import { Page, PageHeader } from "@/components/ui/page";
import { ToneBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { ApiError, errorMessage } from "@/lib/api";
import { errorAt, otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { notificationsQuery, useSaveNotifications, useTestEmail, useTestHeartbeat } from "./api";
import { messages } from "./messages";

type Security = Notifications["email"]["security"];

type Values = {
  enabled: boolean;
  host: string;
  port: string;
  security: Security;
  username: string;
  password: SecretValue;
  from: string;
  recipients: string;
  heartbeatUrl: SecretValue;
  notifyRecovery: boolean;
};

function valuesOf(saved: Notifications): Values {
  return {
    enabled: saved.email.enabled,
    host: saved.email.host,
    port: String(saved.email.port),
    security: saved.email.security,
    username: saved.email.username,
    password: initialSecret(saved.email.passwordHint !== null),
    from: saved.email.from,
    recipients: saved.email.recipients.join("\n"),
    heartbeatUrl: initialSecret(saved.heartbeatUrlHint !== null),
    notifyRecovery: saved.notifyRecovery,
  };
}

function inputOf(values: Values): NotificationsInput {
  return {
    email: {
      enabled: values.enabled,
      host: values.host,
      port: values.port.trim() === "" ? Number.NaN : Number(values.port),
      security: values.security,
      username: values.username,
      password: secretPayload(values.password),
      from: values.from.trim(),
      recipients: values.recipients
        .split(/[\n,;]+/)
        .map((line) => line.trim())
        .filter(Boolean),
    },
    heartbeatUrl: secretPayload(values.heartbeatUrl),
    notifyRecovery: values.notifyRecovery,
  };
}

const SHOWN =
  /^(email\.(enabled|host|port|security|username|password|from|recipients(\..+)?)|heartbeatUrl|notifyRecovery)$/;

function Result({ result }: { result: TestResult | null }) {
  if (!result) return null;
  return (
    <Alert variant={result.ok ? "default" : "destructive"} role="status">
      {result.ok ? <CircleCheck className="text-emerald-600" /> : <CircleX />}
      <AlertDescription className="break-words">{result.message}</AlertDescription>
    </Alert>
  );
}

function NotificationsForm({ saved }: { saved: Notifications }) {
  const t = useT(messages);
  const save = useSaveNotifications();
  const testEmail = useTestEmail();
  const testHeartbeat = useTestHeartbeat();
  const [values, setValues] = useState(() => valuesOf(saved));
  const [baseline, setBaseline] = useState(() => JSON.stringify(inputOf(valuesOf(saved))));
  const [checked, setChecked] = useState<FieldErrors>({});
  const [emailResult, setEmailResult] = useState<TestResult | null>(null);
  const [heartbeatResult, setHeartbeatResult] = useState<TestResult | null>(null);
  const errors = { ...serverFieldErrors(save.error), ...checked };
  const dirty = JSON.stringify(inputOf(values)) !== baseline;
  const set =
    <K extends keyof Values>(key: K) =>
    (value: Values[K]) =>
      setValues((current) => ({ ...current, [key]: value }));

  const formMessages = [
    ...(save.error && !(save.error instanceof ApiError && save.error.fields)
      ? [errorMessage(save.error)]
      : []),
    ...otherErrors(errors, SHOWN),
  ];
  if (formMessages.length === 0 && Object.keys(errors).length > 0) formMessages.push(t("checkFields"));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = inputOf(values);
    const invalid = validate(notificationsInputSchema, input);
    setChecked(invalid ?? {});
    if (invalid) return;
    save.mutate(input, {
      onSuccess: (next) => {
        toast.success(t("saved"));
        const fresh = valuesOf(next);
        setValues(fresh);
        setBaseline(JSON.stringify(inputOf(fresh)));
      },
    });
  };

  const runTest = (test: typeof testEmail, show: (result: TestResult | null) => void) => {
    show(null);
    test.mutate(undefined, {
      onSuccess: show,
      onError: (error) => show({ ok: false, message: errorMessage(error) }),
    });
  };

  const recipientsError = errorAt(errors, "email.recipients");
  return (
    <form noValidate onSubmit={submit} className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex items-center gap-2">
              <Mail className="size-4" aria-hidden />
              {t("emailTitle")}
            </h2>
          </CardTitle>
          <CardDescription>{t("emailDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <SwitchField
            id="email-enabled"
            label={t("emailEnabled")}
            checked={values.enabled}
            onChange={set("enabled")}
          />
          <div className="grid gap-6 sm:grid-cols-[1fr_8rem_10rem]">
            <TextField
              id="smtp-host"
              label={t("host")}
              autoComplete="off"
              spellCheck={false}
              placeholder="smtp.example.org"
              value={values.host}
              onChange={set("host")}
              error={errors["email.host"]}
            />
            <TextField
              id="smtp-port"
              label={t("port")}
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={values.port}
              onChange={set("port")}
              error={errors["email.port"]}
            />
            <Field data-invalid={errors["email.security"] ? true : undefined}>
              <FieldLabel htmlFor="smtp-security">{t("security")}</FieldLabel>
              <NativeSelect
                id="smtp-security"
                wrapperClassName="w-full"
                value={values.security}
                onChange={(event) => set("security")(event.target.value as Security)}
              >
                <NativeSelectOption value="tls">{t("securityTls")}</NativeSelectOption>
                <NativeSelectOption value="starttls">{t("securityStarttls")}</NativeSelectOption>
                <NativeSelectOption value="none">{t("securityNone")}</NativeSelectOption>
              </NativeSelect>
              {errors["email.security"] ? <FieldError>{errors["email.security"]}</FieldError> : null}
            </Field>
          </div>
          <p className="text-muted-foreground -mt-4 text-sm">{t("securityHint")}</p>
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField
              id="smtp-username"
              label={t("username")}
              autoComplete="off"
              value={values.username}
              onChange={set("username")}
              error={errors["email.username"]}
            />
            <SecretField
              id="smtp-password"
              label={t("password")}
              stored={saved.email.passwordHint !== null}
              hint={saved.email.passwordHint}
              value={values.password}
              onChange={set("password")}
              error={errors["email.password"]}
            />
          </div>
          <TextField
            id="smtp-from"
            label={t("from")}
            hint={t("fromHint")}
            type="email"
            autoComplete="off"
            value={values.from}
            onChange={set("from")}
            error={errors["email.from"]}
          />
          <Field data-invalid={recipientsError ? true : undefined}>
            <FieldLabel htmlFor="smtp-recipients">{t("recipients")}</FieldLabel>
            <Textarea
              id="smtp-recipients"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              value={values.recipients}
              aria-invalid={recipientsError ? true : undefined}
              aria-describedby={describedBy("smtp-recipients", true, recipientsError)}
              onChange={(event) => set("recipients")(event.target.value)}
            />
            <FieldDescription id="smtp-recipients-hint">{t("recipientsHint")}</FieldDescription>
            {recipientsError ? <FieldError id="smtp-recipients-error">{recipientsError}</FieldError> : null}
          </Field>
          <SwitchField
            id="notify-recovery"
            label={t("recovery")}
            checked={values.notifyRecovery}
            onChange={set("notifyRecovery")}
          />
          <div className="grid gap-3">
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={testEmail.isPending}
                onClick={() => runTest(testEmail, setEmailResult)}
              >
                {testEmail.isPending ? <Spinner /> : <Mail />}
                {t("testEmail")}
              </Button>
            </div>
            <Result result={emailResult} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex items-center gap-2">
              <HeartPulse className="size-4" aria-hidden />
              {t("heartbeatTitle")}
            </h2>
          </CardTitle>
          <CardDescription>{t("heartbeatDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {/* The URL is the monitor's credential: whoever has it can send pings. */}
          <SecretField
            id="heartbeat-url"
            label={t("heartbeatUrl")}
            stored={saved.heartbeatUrlHint !== null}
            hint={saved.heartbeatUrlHint}
            value={values.heartbeatUrl}
            onChange={set("heartbeatUrl")}
            removable
            placeholder="https://hc-ping.com/…"
            description={t("heartbeatUrlHint")}
            error={errors["heartbeatUrl"]}
          />
          <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground text-xs">{t("lastCall")}</span>
            {saved.heartbeat ? (
              <span className="flex flex-wrap items-center gap-2">
                <ToneBadge tone={saved.heartbeat.ok ? "success" : "danger"}>
                  {saved.heartbeat.ok ? t("lastCallOk") : t("lastCallFailed")}
                </ToneBadge>
                <When value={saved.heartbeat.at} />
                {saved.heartbeat.message ? (
                  <span className="text-muted-foreground break-words">{saved.heartbeat.message}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("noCall")}</span>
            )}
          </div>
          <div className="grid gap-3">
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={testHeartbeat.isPending || saved.heartbeatUrlHint === null}
                onClick={() => runTest(testHeartbeat, setHeartbeatResult)}
              >
                {testHeartbeat.isPending ? <Spinner /> : <HeartPulse />}
                {t("testHeartbeat")}
              </Button>
            </div>
            <Result result={heartbeatResult} />
          </div>
        </CardContent>
      </Card>
      <FormErrors messages={formMessages} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty ? <p className="text-muted-foreground text-sm">{t("unsaved")}</p> : null}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner /> : null}
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** /settings/notifications */
export function NotificationsPage() {
  const t = useT(messages);
  const notifications = useQuery(notificationsQuery());
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("title")} description={t("description")} />
      {notifications.isLoading ? (
        <LoadingState />
      ) : notifications.isError || !notifications.data ? (
        <ErrorState error={notifications.error} onRetry={() => void notifications.refetch()} />
      ) : (
        <NotificationsForm saved={notifications.data} />
      )}
    </Page>
  );
}
