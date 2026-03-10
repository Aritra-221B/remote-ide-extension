import { sseManager } from './sse';

/** Tracks whether the agent has pending edits awaiting user review. */

let awaitingEdits = false;   // prompt was sent, waiting for file changes
let pendingReview = false;   // file changes detected, user should accept/reject

/** Call when a prompt is sent to the agent. */
export function markPromptSent() {
    awaitingEdits = true;
}

/** Call when a file is edited (dirty) while awaiting edits. */
export function markFileEdited() {
    if (awaitingEdits && !pendingReview) {
        pendingReview = true;
        sseManager.broadcast('pending-review', { pending: true });
    }
}

/** Call when the user accepts or rejects changes. */
export function markReviewed() {
    pendingReview = false;
    awaitingEdits = false;
    sseManager.broadcast('pending-review', { pending: false });
}

/** Returns current pending-review state. */
export function isPendingReview(): boolean {
    return pendingReview;
}
