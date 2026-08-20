/*
 * entangle — permission prompt
 * ------------------------------------------------------------------
 * THE reason this whole feature exists. When a tool needs approval the desktop
 * TUI blocks on a prompt; a user who walked away with only their phone has no
 * way to answer it and the agent sits wedged until they come back.
 *
 * Consequently this popup is NOT dismissable — no backdrop tap, Escape, or
 * swipe. Any of those would return the user to a composer whose messages can
 * never be processed, which looks exactly like the app being broken. The only
 * exits are the three buttons.
 */

import type { PermissionDto, PermissionReply } from "../lib/protocol";
import PickerModal from "./PickerModal";
import "../styles/controls.css";

export type PermissionResponse = PermissionReply["response"];

interface PermissionSheetProps {
  /** `permission` from the store. Undefined renders nothing. */
  permission?: PermissionDto;
  onRespond: (response: PermissionResponse, permission: PermissionDto) => void;
}

/** Keys opencode puts the human-readable payload under, most specific first. */
const DETAIL_KEYS = ["command", "pattern", "filePath", "filepath", "path", "url", "description"];

function permissionDetail(permission: PermissionDto): string | undefined {
  const metadata = permission.metadata;
  if (!metadata) return undefined;
  for (const key of DETAIL_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export default function PermissionSheet({ permission, onRespond }: PermissionSheetProps) {
  if (!permission) return null;

  const detail = permissionDetail(permission);

  return (
    <PickerModal
      open
      dismissable={false}
      testId="permission-modal"
      title="Permission required"
    >
      <div className="sheet__body">
        <div className="permission" data-permission={permission.id}>
          <h3 className="permission__title">{permission.title}</h3>
          {detail ? <pre className="permission__detail">{detail}</pre> : null}
          <p className="permission__note">
            Your agent is paused until you answer. This choice cannot be dismissed.
          </p>
        </div>
      </div>

      {/*
        Pinned OUTSIDE the scroll port: a long tool title must never be able to
        push the only three exits below the fold.
      */}
      <div className="permission__actions">
        <button
          type="button"
          className="permission__button permission__button--once"
          data-testid="perm-once"
          onClick={() => onRespond("once", permission)}
        >
          Allow once
        </button>
        <button
          type="button"
          className="permission__button"
          data-testid="perm-always"
          onClick={() => onRespond("always", permission)}
        >
          Always allow
        </button>
        <button
          type="button"
          className="permission__button permission__button--reject"
          data-testid="perm-reject"
          onClick={() => onRespond("reject", permission)}
        >
          Reject
        </button>
      </div>
    </PickerModal>
  );
}
