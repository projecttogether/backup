import type { BucketProtection, RepositoryState } from "@backup/shared/api/target";
import { ToneBadge, type Tone } from "@/components/status";
import { useT } from "@/i18n";
import { messages } from "./messages";

const STATE_TONES: Record<RepositoryState, Tone> = {
  unknown: "muted",
  missing: "warning",
  ready: "success",
  wrong_password: "danger",
  error: "danger",
};

const STATE_LABELS = {
  unknown: "stateUnknown",
  missing: "stateMissing",
  ready: "stateReady",
  wrong_password: "stateWrongPassword",
  error: "stateError",
} as const satisfies Record<RepositoryState, keyof typeof messages.en>;

export function RepositoryStateBadge({ state }: { state: RepositoryState }) {
  const t = useT(messages);
  return <ToneBadge tone={STATE_TONES[state]}>{t(STATE_LABELS[state])}</ToneBadge>;
}

/** All three cleanup rules are set; null when the provider does not say. */
export function lifecycleComplete(protection: BucketProtection | null): boolean | null {
  const lifecycle = protection?.lifecycle ?? null;
  if (lifecycle === null) return null;
  return (
    lifecycle.noncurrentDays !== null &&
    lifecycle.expiredDeleteMarkers &&
    lifecycle.abortMultipartDays !== null
  );
}
