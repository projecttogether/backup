import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SecretField } from "@/components/ui/secret-field";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { HOURLY_STEPS, type Retention } from "@backup/shared/api/schedule";
import { sourceInputSchema, type Source, type SourceKind } from "@backup/shared/api/sources";
import { describedBy, FormErrors, SwitchField, TextField } from "@/components/form-fields";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { errorAt, otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import { targetQuery } from "@/modules/target/api";
import { useCreateSource, useUpdateSource } from "./api";
import {
  folderRow,
  initialValues,
  readServiceAccountKey,
  RETENTION_KEYS,
  toSourceInput,
  type HourlyStep,
  type SourceFormValues,
} from "./form";
import { messages } from "./messages";
import { AgentTokenDialog, useDayName, useRetentionList } from "./parts";

/** The OAuth scope the service account needs (domain-wide delegation). */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Paths of the fields this form shows; other messages go above the buttons. */
const SHOWN =
  /^(name|enabled|schedule(\..+)?|retention(\..+)?|config\.(.+)|secrets\.(serviceAccountKey|clientSecret|secretAccessKey))$/;

const RETENTION_LABELS = {
  daily: "keepDaily",
  weekly: "keepWeekly",
  monthly: "keepMonthly",
  yearly: "keepYearly",
} as const satisfies Record<keyof Retention, keyof typeof messages.en>;

type Change = <K extends keyof SourceFormValues>(key: K, value: SourceFormValues[K]) => void;
type Part = { values: SourceFormValues; change: Change; errors: FieldErrors };

function ScheduleCard({ values, change, errors, timezone }: Part & { timezone: string | undefined }) {
  const t = useT(messages);
  const dayName = useDayName();
  const repeatError = errors["schedule"] ?? errors["schedule.type"];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("schedule")}</h2>
        </CardTitle>
        <CardDescription>
          {timezone ? t("timezone", { zone: timezone }) : t("timezoneUnknown")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <Field data-invalid={repeatError ? true : undefined}>
          <FieldLabel htmlFor="schedule-type">{t("repeat")}</FieldLabel>
          <NativeSelect
            id="schedule-type"
            wrapperClassName="w-full"
            value={values.scheduleType}
            onChange={(event) =>
              change("scheduleType", event.target.value as SourceFormValues["scheduleType"])
            }
          >
            <NativeSelectOption value="hourly">{t("hourly")}</NativeSelectOption>
            <NativeSelectOption value="daily">{t("daily")}</NativeSelectOption>
            <NativeSelectOption value="weekly">{t("weekly")}</NativeSelectOption>
          </NativeSelect>
          {repeatError ? <FieldError>{repeatError}</FieldError> : null}
        </Field>
        {values.scheduleType === "hourly" ? (
          <>
            <Field data-invalid={errors["schedule.every"] ? true : undefined}>
              <FieldLabel htmlFor="schedule-every">{t("every")}</FieldLabel>
              <NativeSelect
                id="schedule-every"
                wrapperClassName="w-full"
                value={String(values.every)}
                onChange={(event) => change("every", Number(event.target.value) as HourlyStep)}
              >
                {HOURLY_STEPS.map((step) => (
                  <NativeSelectOption key={step} value={step}>
                    {t("hours", { count: step })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {errors["schedule.every"] ? <FieldError>{errors["schedule.every"]}</FieldError> : null}
            </Field>
            <TextField
              id="schedule-minute"
              label={t("minute")}
              hint={t("minuteHint")}
              type="number"
              inputMode="numeric"
              min={0}
              max={59}
              value={values.minute}
              onChange={(value) => change("minute", value)}
              error={errors["schedule.minute"]}
            />
          </>
        ) : (
          <>
            {values.scheduleType === "weekly" ? (
              <Field data-invalid={errors["schedule.day"] ? true : undefined}>
                <FieldLabel htmlFor="schedule-day">{t("day")}</FieldLabel>
                <NativeSelect
                  id="schedule-day"
                  wrapperClassName="w-full"
                  value={String(values.day)}
                  onChange={(event) => change("day", Number(event.target.value))}
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <NativeSelectOption key={day} value={day}>
                      {dayName(day)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {errors["schedule.day"] ? <FieldError>{errors["schedule.day"]}</FieldError> : null}
              </Field>
            ) : null}
            <TextField
              id="schedule-time"
              label={t("time")}
              type="time"
              required
              value={values.time}
              onChange={(value) => change("time", value)}
              error={errors["schedule.time"]}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RetentionCard({ values, change, errors }: Part) {
  const t = useT(messages);
  const retentionList = useRetentionList();
  const counts = Object.fromEntries(
    RETENTION_KEYS.map((key) => [key, Number(values.retention[key]) || 0]),
  ) as Retention;
  const summary = retentionList(counts);
  const error = errorAt(errors, "retention");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("retention")}</h2>
        </CardTitle>
        <CardDescription id="retention-hint">{t("retentionHint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {RETENTION_KEYS.map((key) => (
            <Field key={key} data-invalid={errors[`retention.${key}`] ? true : undefined}>
              <FieldLabel htmlFor={`retention-${key}`}>{t(RETENTION_LABELS[key])}</FieldLabel>
              <Input
                id={`retention-${key}`}
                type="number"
                inputMode="numeric"
                min={0}
                value={values.retention[key]}
                aria-invalid={errors[`retention.${key}`] ? true : undefined}
                aria-describedby="retention-hint retention-summary"
                onChange={(event) => change("retention", { ...values.retention, [key]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        <p id="retention-summary" className="text-muted-foreground text-sm" aria-live="polite">
          {summary ? t("retentionSummary", { list: summary }) : t("retentionNone")}
        </p>
        {error ? <FieldError>{error}</FieldError> : null}
      </CardContent>
    </Card>
  );
}

function DriveCard({ values, change, errors, source }: Part & { source?: Source }) {
  const t = useT(messages);
  const stored = source?.kind === "google_drive" ? source.config : null;
  const pasted = readServiceAccountKey(values.serviceAccountKey);
  const clientId = pasted?.clientId ?? stored?.serviceAccountClientId ?? null;
  const keyError = errors["secrets.serviceAccountKey"];
  const foldersError = errors["config.scope.folders"];
  const storedEmail = stored?.serviceAccountEmail ?? null;
  const setFolder = (index: number, part: "id" | "label", value: string) =>
    change(
      "folders",
      values.folders.map((folder, i) => (i === index ? { ...folder, [part]: value } : folder)),
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("driveTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <TextField
          id="drive-subject"
          label={t("subject")}
          hint={t("subjectHint")}
          type="email"
          autoComplete="off"
          value={values.subject}
          onChange={(value) => change("subject", value)}
          error={errors["config.subject"]}
        />
        <FieldSet>
          <FieldLegend variant="label">{t("scope")}</FieldLegend>
          <RadioGroup
            value={values.scopeType}
            onValueChange={(value) => change("scopeType", value as SourceFormValues["scopeType"])}
            className="flex flex-wrap gap-6"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="scope-shared-drive" value="shared_drive" />
              <Label htmlFor="scope-shared-drive">{t("scopeSharedDrive")}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="scope-folders" value="folders" />
              <Label htmlFor="scope-folders">{t("scopeFolders")}</Label>
            </div>
          </RadioGroup>
          {values.scopeType === "shared_drive" ? (
            <TextField
              id="drive-id"
              label={t("driveId")}
              hint={t("driveIdHint")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={values.driveId}
              onChange={(value) => change("driveId", value)}
              error={errors["config.scope.driveId"]}
            />
          ) : (
            <div className="grid gap-3">
              <p className="text-muted-foreground text-sm" id="folders-hint">
                {t("foldersHint")}
              </p>
              <div className="text-muted-foreground hidden grid-cols-[1fr_1fr_auto] gap-2 text-sm font-medium sm:grid">
                <span>{t("folderId")}</span>
                <span>{t("folderLabel")}</span>
                <span className="w-9" />
              </div>
              {values.folders.map((folder, index) => {
                const idError = errors[`config.scope.folders.${index}.id`];
                const labelError = errors[`config.scope.folders.${index}.label`];
                return (
                  <div key={folder.key} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div className="grid gap-1">
                      <Input
                        aria-label={t("folderIdNumbered", { index: index + 1 })}
                        placeholder={t("folderId")}
                        className="font-mono"
                        spellCheck={false}
                        autoComplete="off"
                        value={folder.id}
                        aria-invalid={idError ? true : undefined}
                        onChange={(event) => setFolder(index, "id", event.target.value)}
                      />
                      {idError ? <FieldError>{idError}</FieldError> : null}
                    </div>
                    <div className="grid gap-1">
                      <Input
                        aria-label={t("folderLabelNumbered", { index: index + 1 })}
                        placeholder={t("folderLabel")}
                        autoComplete="off"
                        value={folder.label}
                        aria-invalid={labelError ? true : undefined}
                        onChange={(event) => setFolder(index, "label", event.target.value)}
                      />
                      {labelError ? <FieldError>{labelError}</FieldError> : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("removeFolder", { index: index + 1 })}
                      disabled={values.folders.length <= 1}
                      onClick={() =>
                        change(
                          "folders",
                          values.folders.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              {foldersError ? <FieldError>{foldersError}</FieldError> : null}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={values.folders.length >= 50}
                  onClick={() => change("folders", [...values.folders, folderRow()])}
                >
                  <Plus />
                  {t("addFolder")}
                </Button>
              </div>
            </div>
          )}
        </FieldSet>
        <Field data-invalid={keyError ? true : undefined}>
          <FieldLabel htmlFor="drive-key">{t("serviceAccountKey")}</FieldLabel>
          <SecretInput
            id="drive-key"
            autoComplete="off"
            inputClassName="font-mono text-xs"
            placeholder={'{ "type": "service_account", … }'}
            value={values.serviceAccountKey}
            aria-invalid={keyError ? true : undefined}
            aria-describedby={describedBy("drive-key", true, keyError)}
            onChange={(event) => change("serviceAccountKey", event.target.value)}
          />
          <FieldDescription id="drive-key-hint">
            {storedEmail ? t("keyStored", { email: storedEmail }) : t("keyHint")}
          </FieldDescription>
          {keyError ? <FieldError id="drive-key-error">{keyError}</FieldError> : null}
        </Field>
        <section
          className="bg-muted/50 grid gap-3 rounded-lg border p-4 text-sm"
          aria-labelledby="delegation"
        >
          <h3 id="delegation" className="font-medium">
            {t("delegationTitle")}
          </h3>
          <p className="text-muted-foreground">{t("delegationText")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="bg-background rounded-md border px-2 py-1 font-mono text-xs break-all">
              {DRIVE_SCOPE}
            </code>
            <CopyButton text={DRIVE_SCOPE} />
          </div>
          <div className="grid gap-1">
            <span className="font-medium">{t("clientId")}</span>
            {clientId ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="bg-background rounded-md border px-2 py-1 font-mono text-xs">
                  {clientId}
                </code>
                <CopyButton text={clientId} />
              </div>
            ) : (
              <span className="text-muted-foreground">{t("clientIdUnknown")}</span>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function PersonioCard({ values, change, errors, source }: Part & { source?: Source }) {
  const t = useT(messages);
  const hint = source?.kind === "personio" ? source.config.clientSecretHint : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("personioTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("personioHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <TextField
          id="personio-url"
          label={t("baseUrl")}
          hint={t("baseUrlHint")}
          type="url"
          autoComplete="off"
          value={values.baseUrl}
          onChange={(value) => change("baseUrl", value)}
          error={errors["config.baseUrl"]}
        />
        <TextField
          id="personio-client-id"
          label={t("personioClientId")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={values.clientId}
          onChange={(value) => change("clientId", value)}
          error={errors["config.clientId"]}
        />
        <SecretField
          id="personio-secret"
          label={t("clientSecret")}
          stored={hint !== null}
          hint={hint}
          value={values.clientSecret}
          onChange={(value) => change("clientSecret", value)}
          error={errors["secrets.clientSecret"]}
        />
        <SwitchField
          id="personio-documents"
          label={t("documents")}
          hint={t("documentsHint")}
          checked={values.documents}
          onChange={(checked) => change("documents", checked)}
        />
      </CardContent>
    </Card>
  );
}

function S3BucketCard({ values, change, errors, source }: Part & { source?: Source }) {
  const t = useT(messages);
  const hint = source?.kind === "s3_bucket" ? source.config.secretAccessKeyHint : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("s3Title")}</h2>
        </CardTitle>
        <CardDescription>{t("s3Help")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            id="s3-endpoint"
            label={t("s3Endpoint")}
            hint={t("s3EndpointHint")}
            type="url"
            autoComplete="off"
            placeholder="https://fsn1.your-objectstorage.com"
            value={values.endpoint}
            onChange={(value) => change("endpoint", value)}
            error={errors["config.endpoint"]}
          />
        </div>
        <TextField
          id="s3-region"
          label={t("s3Region")}
          hint={t("s3RegionHint")}
          autoComplete="off"
          placeholder="fsn1"
          value={values.region}
          onChange={(value) => change("region", value)}
          error={errors["config.region"]}
        />
        <TextField
          id="s3-bucket"
          label={t("s3Bucket")}
          autoComplete="off"
          spellCheck={false}
          value={values.bucket}
          onChange={(value) => change("bucket", value)}
          error={errors["config.bucket"]}
        />
        <TextField
          id="s3-prefix"
          label={t("s3Prefix")}
          hint={t("s3PrefixHint")}
          autoComplete="off"
          spellCheck={false}
          value={values.prefix}
          onChange={(value) => change("prefix", value)}
          error={errors["config.prefix"]}
        />
        <TextField
          id="s3-access-key"
          label={t("s3AccessKey")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={values.accessKeyId}
          onChange={(value) => change("accessKeyId", value)}
          error={errors["config.accessKeyId"]}
        />
        <div className="sm:col-span-2">
          <SecretField
            id="s3-secret-key"
            label={t("s3SecretKey")}
            stored={hint !== null}
            hint={hint}
            value={values.secretAccessKey}
            onChange={(value) => change("secretAccessKey", value)}
            error={errors["secrets.secretAccessKey"]}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** Adds a source of a kind, or changes one (`source`). */
export function SourceForm({ kind, source }: { kind: SourceKind; source?: Source }) {
  const t = useT(messages);
  const navigate = useNavigate();
  const timezone = useQuery(targetQuery()).data?.timezone;
  const create = useCreateSource();
  const update = useUpdateSource();
  const mutation = source ? update : create;
  const [values, setValues] = useState(() => initialValues(source));
  const [checked, setChecked] = useState<FieldErrors>({});
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const errors = { ...serverFieldErrors(mutation.error), ...checked };
  const change: Change = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  // Messages no field shows: a failed request without fields, or fields this form lacks.
  const formMessages = [
    ...(mutation.error && !(mutation.error instanceof ApiError && mutation.error.fields)
      ? [mutation.error.message]
      : []),
    ...otherErrors(errors, SHOWN),
  ];
  if (formMessages.length === 0 && Object.keys(errors).length > 0) formMessages.push(t("checkFields"));

  const done = (id: string) => void navigate({ to: "/sources/$id", params: { id } });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = toSourceInput(kind, values);
    const invalid = validate(sourceInputSchema, input);
    setChecked(invalid ?? {});
    if (invalid) return;
    if (source) {
      update.mutate(
        { id: source.id, input },
        {
          onSuccess: (saved) => {
            toast.success(t("saved"));
            done(saved.id);
          },
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: (created) => {
          toast.success(t("created"));
          if (created.token) setToken({ id: created.source.id, token: created.token });
          else done(created.source.id);
        },
      });
    }
  };

  const part = { values, change, errors };
  return (
    <>
      <form noValidate onSubmit={submit} className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("general")}</h2>
            </CardTitle>
            {kind === "app" && !source ? <CardDescription>{t("appText")}</CardDescription> : null}
          </CardHeader>
          <CardContent className="grid gap-6">
            <TextField
              id="source-name"
              label={t("name")}
              hint={t("nameHint")}
              maxLength={100}
              autoComplete="off"
              value={values.name}
              onChange={(value) => change("name", value)}
              error={errors["name"]}
            />
            <SwitchField
              id="source-enabled"
              label={t("enabled")}
              hint={t("enabledHint")}
              checked={values.enabled}
              onChange={(checked) => change("enabled", checked)}
            />
          </CardContent>
        </Card>
        <ScheduleCard {...part} timezone={timezone} />
        <RetentionCard {...part} />
        {kind === "google_drive" ? <DriveCard {...part} source={source} /> : null}
        {kind === "personio" ? <PersonioCard {...part} source={source} /> : null}
        {kind === "s3_bucket" ? <S3BucketCard {...part} source={source} /> : null}
        <FormErrors messages={formMessages} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => (source ? done(source.id) : void navigate({ to: "/sources" }))}
          >
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {source ? t("save") : t("create")}
          </Button>
        </div>
      </form>
      <AgentTokenDialog
        token={token?.token ?? null}
        onDone={() => {
          if (token) done(token.id);
          setToken(null);
        }}
      />
    </>
  );
}
