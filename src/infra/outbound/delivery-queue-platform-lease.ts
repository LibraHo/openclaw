import {
  claimDeliveryQueueEntryPlatformSend,
  dispatchDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
} from "../delivery-queue-sqlite-claim.js";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";

/** Atomically transfer a stable pending producer intent to one platform sender. */
export async function claimDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  reconciledPlatformSendStartedAt?: number,
  reconciledPlatformSendAttemptId?: string,
  allowUnknownSendReplay?: true,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    ...(allowUnknownSendReplay ? { allowUnknownSendReplay } : {}),
    ...(reconciledPlatformSendStartedAt !== undefined ? { reconciledPlatformSendStartedAt } : {}),
    ...(reconciledPlatformSendAttemptId !== undefined ? { reconciledPlatformSendAttemptId } : {}),
  });
}

/** Claim and atomically upgrade a live reusable producer to renewable ownership. */
export async function claimReusableDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    requiresProducerClaim: true,
  });
}

/** Extend the exact active producer lease without changing ownership. */
export async function renewDeliveryPlatformSendLease(
  id: string,
  stateDir: string | undefined,
  claimId: string,
): Promise<number | undefined> {
  return renewDeliveryQueueEntryPlatformSendLease({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    claimId,
  });
}

/** Promote or refresh the exact live owner at recipient-visible dispatch. */
export function markOwnedDeliveryPlatformSendDispatched(
  id: string,
  stateDir: string | undefined,
  route: { replyToId?: string | null } | undefined,
  claimId: string,
): void {
  const dispatched = dispatchDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    route,
    claimId,
  });
  if (!dispatched) {
    throw new Error(`Delivery platform claim was lost: ${id}`);
  }
}

/** Lease owner eligibility shared by admission and recovery inspection. */
export function hasActiveDeliveryOwner(entry: DeliveryQueueEntryState, now: number): boolean {
  return (
    (typeof entry.completionRetention === "object" ||
      entry.completionRetention === "permanent" ||
      entry.requiresProducerClaim === true) &&
    (entry.recoveryState === "producer_claimed" ||
      ((entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
        entry.requiresProducerClaim === true)) &&
    typeof entry.availableAt === "number" &&
    entry.availableAt > now
  );
}
