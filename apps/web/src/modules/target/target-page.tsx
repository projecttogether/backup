import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  CircleCheck,
  CircleHelp,
  Download,
  Link2,
  Plug,
  Play,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { initialSecret, SecretField, secretPayload } from "@/components/ui/secret-field";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState, LoadingState } from "@/components/ui/states";
import {
  maintenanceInputSchema,
  targetInputSchema,
  type RepositoryState,
  type Target,
} from "@backup/shared/api/target";
import { Detail, Details } from "@/components/detail";
import { FormErrors, TextField } from "@/components/form-fields";
import { Page, PageHeader } from "@/components/ui/page";
import { ToneBadge } from "@/components/status";
import { When } from "@/components/when";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { otherErrors, serverFieldErrors, validate, type FieldErrors } from "@/lib/form";
import {
  recoveryKitUrl,
  targetQuery,
  useConfirmRecoveryKit,
  useConnectTarget,
  useInitializeTarget,
  useRunMaintenance,
  useSaveMaintenance,
  useSaveTarget,
  useTestTarget,
} from "./api";
import { messages } from "./messages";
import { lifecycleComplete, RepositoryStateBadge } from "./parts";

type Translate = ReturnType<typeof useT<typeof messages.en>>;

/** Messages of a failed request that no field shows. */
function requestErrors(error: unknown, shown: RegExp): string[] {
  if (!error) return [];
  if (error instanceof ApiError && error.fields) return otherErrors(error.fields, shown);
  return [errorMessage(error)];
}

function BucketCard({ target }: { target: Target }) {
  const t = useT(messages);
  const save = useSaveTarget();
  const [values, setValues] = useState({
    endpoint: target.endpoint ?? "",
    region: target.region,
    bucket: target.bucket ?? "",
    prefix: target.prefix,
    accessKeyId: target.accessKeyId ?? "",
  });
  const [secret, setSecret] = useState(() => initialSecret(target.secretAccessKeyHint !== null));
  const [checked, setChecked] = useState<FieldErrors>({});
  const errors = { ...serverFieldErrors(save.error), ...checked };
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...values, secretAccessKey: secretPayload(secret) };
    const invalid = validate(targetInputSchema, input);
    setChecked(invalid ?? {});
    if (invalid) return;
    save.mutate(input, {
      onSuccess: (saved) => {
        toast.success(t("saved"));
        setSecret(initialSecret(saved.secretAccessKeyHint !== null));
      },
    });
  };
  const formMessages = requestErrors(
    save.error,
    /^(endpoint|region|bucket|prefix|accessKeyId|secretAccessKey)$/,
  );
  return (
    <Card>
      <form noValidate onSubmit={submit} className="contents">
        <CardHeader>
          <CardTitle>
            <h2>{t("bucketTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("bucketDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField
              id="target-endpoint"
              label={t("endpoint")}
              hint={t("endpointHint")}
              type="url"
              autoComplete="off"
              placeholder="https://fsn1.your-objectstorage.com"
              value={values.endpoint}
              onChange={set("endpoint")}
              error={errors["endpoint"]}
            />
          </div>
          <TextField
            id="target-region"
            label={t("region")}
            hint={t("regionHint")}
            autoComplete="off"
            placeholder="fsn1"
            value={values.region}
            onChange={set("region")}
            error={errors["region"]}
          />
          <TextField
            id="target-bucket"
            label={t("bucket")}
            autoComplete="off"
            spellCheck={false}
            value={values.bucket}
            onChange={set("bucket")}
            error={errors["bucket"]}
          />
          <TextField
            id="target-prefix"
            label={t("prefix")}
            hint={t("prefixHint")}
            autoComplete="off"
            spellCheck={false}
            value={values.prefix}
            onChange={set("prefix")}
            error={errors["prefix"]}
          />
          <TextField
            id="target-access-key"
            label={t("accessKey")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={values.accessKeyId}
            onChange={set("accessKeyId")}
            error={errors["accessKeyId"]}
          />
          <div className="sm:col-span-2">
            <SecretField
              id="target-secret-key"
              label={t("secretKey")}
              stored={target.secretAccessKeyHint !== null}
              hint={target.secretAccessKeyHint}
              value={secret}
              onChange={setSecret}
              error={errors["secretAccessKey"]}
            />
          </div>
          <div className="sm:col-span-2">
            <FormErrors messages={formMessages} />
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t("save")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const connect = useConnectTarget();
  const [password, setPassword] = useState("");
  const fieldError = serverFieldErrors(connect.error)["password"];
  const close = (next: boolean) => {
    if (connect.isPending) return;
    if (!next) {
      setPassword("");
      connect.reset();
    }
    onOpenChange(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate(password, {
      onSuccess: (target) => {
        if (target.repository.state === "ready") toast.success(t("connected"));
        close(false);
      },
    });
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("connectTitle")}</DialogTitle>
            <DialogDescription>{t("connectText")}</DialogDescription>
          </DialogHeader>
          <TextField
            id="repository-password"
            label={t("password")}
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={setPassword}
            error={fieldError}
          />
          <FormErrors messages={requestErrors(connect.error, /^password$/)} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={connect.isPending} onClick={() => close(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={connect.isPending || password === ""}>
              {connect.isPending ? <Spinner /> : null}
              {t("connectButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepositoryCard({ target }: { target: Target }) {
  const t = useT(messages);
  const test = useTestTarget();
  const initialize = useInitializeTarget();
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const { state, message, checkedAt } = target.repository;
  const runTest = () =>
    test.mutate(undefined, {
      onSuccess: () => toast.success(t("tested")),
      onError: (error) => toast.error(errorMessage(error)),
    });
  const hint: Record<RepositoryState, string | null> = {
    unknown: t("unknownHint"),
    missing: t("missingHint"),
    ready: t("readyHint"),
    wrong_password: t("wrongPasswordHint"),
    error: null,
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("repositoryTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("repositoryDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!target.configured ? (
          <p className="text-muted-foreground text-sm">{t("notConfigured")}</p>
        ) : (
          <>
            <Details>
              <Detail label={t("state")}>
                <span className="flex flex-wrap items-center gap-2">
                  <RepositoryStateBadge state={state} />
                  {checkedAt ? (
                    <span className="text-muted-foreground text-xs">
                      <When value={checkedAt} />
                    </span>
                  ) : null}
                </span>
              </Detail>
              {target.repositoryUrl ? (
                <Detail label={t("address")} className="sm:col-span-2">
                  <code className="font-mono text-xs break-all">{target.repositoryUrl}</code>
                </Detail>
              ) : null}
            </Details>
            {hint[state] || message ? (
              <Alert variant={state === "error" || state === "wrong_password" ? "destructive" : "default"}>
                {state === "ready" ? <CircleCheck className="text-emerald-600" /> : <TriangleAlert />}
                <AlertDescription>
                  {hint[state] ? <p>{hint[state]}</p> : null}
                  {message ? <p className="break-words">{message}</p> : null}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={test.isPending} onClick={runTest}>
                {test.isPending ? <Spinner /> : <Plug />}
                {t("testConnection")}
              </Button>
              {state === "missing" ? (
                <>
                  <Button type="button" onClick={() => setCreating(true)}>
                    <ShieldCheck />
                    {t("create")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setConnecting(true)}>
                    <Link2 />
                    {t("connect")}
                  </Button>
                </>
              ) : null}
              {state === "wrong_password" ? (
                <Button type="button" onClick={() => setConnecting(true)}>
                  <Link2 />
                  {t("connect")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={creating}
        onOpenChange={setCreating}
        title={t("createTitle")}
        description={t("createText")}
        confirmLabel={t("create")}
        onConfirm={() =>
          initialize.mutateAsync().then(
            () => toast.success(t("created")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
      <ConnectDialog open={connecting} onOpenChange={setConnecting} />
    </Card>
  );
}

function RecoveryKitCard({ target }: { target: Target }) {
  const t = useT(messages);
  const confirm = useConfirmRecoveryKit();
  const confirmed = target.recoveryKitConfirmedAt;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("kitTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("kitText")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!target.repository.hasPassword ? (
          <p className="text-muted-foreground text-sm">{t("kitNoPassword")}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              {confirmed ? (
                <>
                  <ToneBadge tone="success">{t("kitStored")}</ToneBadge>
                  <span className="text-muted-foreground">
                    {t("kitConfirmedAt")} <When value={confirmed} />
                  </span>
                </>
              ) : (
                <ToneBadge tone="warning">{t("kitNotStored")}</ToneBadge>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant={confirmed ? "outline" : "default"}>
                <a href={recoveryKitUrl()} download>
                  <Download />
                  {t("kitDownload")}
                </a>
              </Button>
              {confirmed ? null : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={confirm.isPending}
                  onClick={() =>
                    confirm.mutate(undefined, {
                      onSuccess: () => toast.success(t("kitConfirmed")),
                      onError: (error) => toast.error(errorMessage(error)),
                    })
                  }
                >
                  {confirm.isPending ? <Spinner /> : <CircleCheck />}
                  {t("kitConfirm")}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProtectionRow(props: {
  ok: boolean | null;
  label: string;
  value: ReactNode;
  /** Shown when the setting is missing. */
  tip?: ReactNode;
  /** Shown whenever it is given. */
  note?: ReactNode;
}) {
  const Icon = props.ok === null ? CircleHelp : props.ok ? CircleCheck : TriangleAlert;
  const color =
    props.ok === null ? "text-muted-foreground" : props.ok ? "text-emerald-600" : "text-amber-600";
  return (
    <li className="flex gap-3">
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} aria-hidden />
      <div className="grid min-w-0 gap-1 text-sm">
        <div>
          <span className="font-medium">{props.label}: </span>
          {props.value}
        </div>
        {props.tip && props.ok === false ? <div className="text-muted-foreground">{props.tip}</div> : null}
        {props.note ? <div className="text-muted-foreground">{props.note}</div> : null}
      </div>
    </li>
  );
}

function objectLockText(t: Translate, lock: NonNullable<NonNullable<Target["protection"]>["objectLock"]>) {
  if (!lock.enabled) return t("off");
  const mode = lock.mode ? lock.mode.charAt(0) + lock.mode.slice(1).toLowerCase() : null;
  if (mode && lock.days !== null) return `${t("on")} (${t("objectLockMode", { mode, days: lock.days })})`;
  if (mode) return `${t("on")} (${mode})`;
  return t("on");
}

function ProtectionCard({ target }: { target: Target }) {
  const t = useT(messages);
  const protection = target.protection;
  const lifecycle = protection?.lifecycle ?? null;
  // The rules of docs/deployment.md, inline, so that the command runs as shown.
  const command = [
    "aws s3api put-bucket-lifecycle-configuration \\",
    `  --endpoint-url ${target.endpoint ?? "<endpoint>"} \\`,
    `  --region ${target.region || "us-east-1"} \\`,
    `  --bucket ${target.bucket ?? "<bucket>"} \\`,
    `  --lifecycle-configuration '{"Rules":[`,
    `    {"ID":"old-versions","Status":"Enabled","Filter":{"Prefix":""},`,
    `     "NoncurrentVersionExpiration":{"NoncurrentDays":31},`,
    `     "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}},`,
    `    {"ID":"delete-markers","Status":"Enabled","Filter":{"Prefix":""},`,
    `     "Expiration":{"ExpiredObjectDeleteMarker":true}}]}'`,
  ].join("\n");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("protectionTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("protectionDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!protection ? (
          <p className="text-muted-foreground text-sm">{t("protectionUnknown")}</p>
        ) : (
          <>
            <ul className="grid gap-3">
              <ProtectionRow
                ok={protection.versioning === null ? null : protection.versioning === "enabled"}
                label={t("versioning")}
                value={
                  protection.versioning === null
                    ? t("unknown")
                    : protection.versioning === "enabled"
                      ? t("on")
                      : protection.versioning === "suspended"
                        ? t("versioningSuspended")
                        : t("off")
                }
                tip={t("versioningTip")}
              />
              <ProtectionRow
                ok={protection.objectLock === null ? null : protection.objectLock.enabled}
                label={t("objectLock")}
                value={
                  protection.objectLock === null ? t("unknown") : objectLockText(t, protection.objectLock)
                }
                tip={t("objectLockTip")}
                note={
                  protection.objectLock?.enabled && protection.objectLock.mode === "GOVERNANCE"
                    ? t("governanceNote")
                    : undefined
                }
              />
              <ProtectionRow
                ok={lifecycleComplete(protection)}
                label={t("lifecycle")}
                value={
                  lifecycle === null ? (
                    t("unknown")
                  ) : (
                    <ul className="text-muted-foreground mt-1 grid gap-0.5">
                      <li>
                        {lifecycle.noncurrentDays !== null
                          ? t("noncurrent", { days: lifecycle.noncurrentDays })
                          : t("noncurrentMissing")}
                      </li>
                      <li>
                        {lifecycle.expiredDeleteMarkers ? t("deleteMarkers") : t("deleteMarkersMissing")}
                      </li>
                      <li>
                        {lifecycle.abortMultipartDays !== null
                          ? t("multipart", { days: lifecycle.abortMultipartDays })
                          : t("multipartMissing")}
                      </li>
                    </ul>
                  )
                }
                tip={
                  <div className="grid gap-2">
                    <span>{t("lifecycleTip")}</span>
                    <pre className="bg-muted text-foreground overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
                      {command}
                    </pre>
                  </div>
                }
              />
            </ul>
            {protection.error ? (
              <p className="text-destructive text-sm">
                {t("protectionError", { message: protection.error })}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              <When value={protection.checkedAt} />
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatsCard({ target }: { target: Target }) {
  const t = useT(messages);
  const format = useFormatter();
  const check = target.lastCheck;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("statsTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Details>
          <Detail label={t("storedBytes")}>
            {target.stats?.storedBytes != null ? format.bytes(target.stats.storedBytes) : "—"}
          </Detail>
          <Detail label={t("snapshots")}>
            {target.stats?.snapshots != null ? format.number(target.stats.snapshots) : "—"}
          </Detail>
          <Detail label={t("lastCheck")}>
            {check ? (
              <span className="grid gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <ToneBadge tone={check.ok ? "success" : "danger"}>
                    {check.ok ? t("checkOk") : t("checkFailed")}
                  </ToneBadge>
                  <When value={check.at} />
                </span>
                <span className="text-muted-foreground text-xs">
                  {check.readData ? t("readData", { share: check.readData }) : t("structureOnly")}
                </span>
                {check.message ? <span className="text-xs break-words">{check.message}</span> : null}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("never")}</span>
            )}
          </Detail>
        </Details>
      </CardContent>
    </Card>
  );
}

function UpkeepCard({ target }: { target: Target }) {
  const t = useT(messages);
  const saveTime = useSaveMaintenance();
  const run = useRunMaintenance();
  const [time, setTime] = useState(target.maintenanceTime);
  const [checked, setChecked] = useState<FieldErrors>({});
  const [startedRun, setStartedRun] = useState<string | null>(null);
  const errors = { ...serverFieldErrors(saveTime.error), ...checked };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const invalid = validate(maintenanceInputSchema, { maintenanceTime: time });
    setChecked(invalid ?? {});
    if (invalid) return;
    saveTime.mutate(time, {
      onSuccess: () => toast.success(t("saved")),
      onError: (error) => {
        if (!(error instanceof ApiError && error.fields)) toast.error(errorMessage(error));
      },
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("upkeepTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("upkeepDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <TextField
              id="upkeep-time"
              label={t("upkeepTime")}
              type="time"
              required
              value={time}
              onChange={setTime}
              error={errors["maintenanceTime"]}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={saveTime.isPending || time === target.maintenanceTime}
          >
            {saveTime.isPending ? <Spinner /> : null}
            {t("saveTime")}
          </Button>
        </form>
        <p className="text-muted-foreground -mt-2 text-sm">
          {t("upkeepTimeHint", { zone: target.timezone })}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={run.isPending || !target.configured}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: (started) => {
                  setStartedRun(started.id);
                  toast.success(t("upkeepStarted"));
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {run.isPending ? <Spinner /> : <Play />}
            {t("runUpkeep")}
          </Button>
          {startedRun ? (
            <Link
              to="/runs/$id"
              params={{ id: startedRun }}
              className="text-link text-sm font-medium underline underline-offset-4"
            >
              {t("viewRun")}
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** /settings/target */
export function TargetPage() {
  const t = useT(messages);
  const target = useQuery(targetQuery());
  return (
    <Page className="max-w-4xl">
      <PageHeader title={t("title")} description={t("description")} />
      {target.isLoading ? (
        <LoadingState />
      ) : target.isError || !target.data ? (
        <ErrorState error={target.error} onRetry={() => void target.refetch()} />
      ) : (
        <>
          <BucketCard target={target.data} />
          <RepositoryCard target={target.data} />
          {target.data.configured ? (
            <>
              <RecoveryKitCard target={target.data} />
              <ProtectionCard target={target.data} />
              <StatsCard target={target.data} />
            </>
          ) : null}
          <UpkeepCard target={target.data} />
        </>
      )}
    </Page>
  );
}
