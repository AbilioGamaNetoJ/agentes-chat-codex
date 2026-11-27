import { Button } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

export interface OutgoingView {
  channelId: string;
  peerId: string;
  name: string;
  video: boolean;
  status: "ringing" | "missed" | "declined" | "busy" | "tooMany" | "error";
}

/**
 * The cards of a ring (ADR 0220): "X está ligando" with Atender and Recusar for the one rung, "Chamando X…" with
 * Cancelar for the caller, and how it ended ("não atendeu", "recusou", "ocupado"). Not modal: the page stays usable.
 */
export function CallCards({
  incoming,
  outgoing,
  onAnswer,
  onDecline,
  onCancel,
  onDismiss,
  onOpenDm,
}: {
  incoming: { channelId: string; name: string; video: boolean } | null;
  outgoing: OutgoingView | null;
  onAnswer: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenDm: (userId: string) => void;
}) {
  const { t } = useTranslation();
  if (!incoming && !outgoing) return null;
  const result: Record<Exclude<OutgoingView["status"], "ringing">, string> = {
    missed: t("call.notAnswered", { name: outgoing?.name }),
    declined: t("call.declined", { name: outgoing?.name }),
    busy: t("call.busy", { name: outgoing?.name }),
    tooMany: t("call.tooMany"),
    error: t("call.failed"),
  };
  return (
    <div className="call-cards">
      {incoming && (
        <section
          className="call-card call-card--incoming"
          role="alert"
          aria-label={t("call.ringing", { name: incoming.name })}
        >
          <p className="call-card__title">
            {t(incoming.video ? "call.ringingVideo" : "call.ringing", { name: incoming.name })}
          </p>
          <div className="call-card__acts">
            <Button size="sm" icon={incoming.video ? "camera" : "callPhone"} onClick={onAnswer}>
              {t("call.answer")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDecline}>
              {t("call.decline")}
            </Button>
          </div>
        </section>
      )}
      {outgoing && (
        <section className="call-card" role="status" aria-live="polite">
          {outgoing.status === "ringing" ? (
            <>
              <p className="call-card__title">{t("call.calling", { name: outgoing.name })}</p>
              <div className="call-card__acts">
                <Button size="sm" variant="ghost" onClick={onCancel}>
                  {t("call.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="call-card__title">{result[outgoing.status]}</p>
              <div className="call-card__acts">
                <Button size="sm" variant="ghost" onClick={() => onOpenDm(outgoing.peerId)}>
                  {outgoing.name}
                </Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  {t("call.close")}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
