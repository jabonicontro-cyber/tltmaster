import "server-only";
import type { ActionResult } from "@/lib/action-result";
import type { RequestKind } from "@/server/support/request";
import { inviteEmployee } from "@/app/(app)/employees/actions";
import {
  createEmployeeSignIn, deactivateEmployeeSignIn, emailEmployeeSetup, reactivateEmployeeSignIn, reissueEmployeeSignIn,
} from "@/app/(app)/employees/account-actions";
import { removeDriverPasskeys } from "@/app/(app)/fleet/drivers/phone-sign-in-actions";
import { inviteUser, setRolePermission, updateUserAccess } from "@/app/(app)/settings/actions";
import { changeAccountantAccess, inviteAccountant } from "@/app/(app)/settings/accountant-actions";
import {
  createPortalSignIn, emailPortalSetup, reissuePortalSignIn, turnOffPortalSignIn, turnOnPortalSignIn,
} from "@/app/(app)/customer-portal/account-actions";
import { invitePortalCustomer, revokePortalAccount } from "@/app/(app)/customer-portal/actions";

// The approving owner's run of a support change request (SA2): the same server action the screen calls, with the
// stored arguments, in the owner's own session, so every permission and rule is checked again as the owner.

const str = (v: unknown) => String(v ?? "");
const form = (v: unknown) => (v instanceof FormData ? v : new FormData());

export const REQUEST_RUNNERS: Record<RequestKind, (args: unknown[]) => Promise<ActionResult<unknown>>> = {
  "people.invite": ([fd]) => inviteUser(form(fd)),
  "people.invite_person": ([id, role]) => inviteEmployee(str(id), str(role)),
  "people.access": ([u, fd]) => updateUserAccess(str(u), form(fd)),
  "people.permission": ([role, permission, granted]) => setRolePermission(str(role), str(permission), granted === true),
  "signin.create": ([fd]) => createEmployeeSignIn(form(fd)),
  "signin.reissue": ([u]) => reissueEmployeeSignIn(str(u)),
  "signin.email": ([u]) => emailEmployeeSetup(str(u)),
  "signin.off": ([u]) => deactivateEmployeeSignIn(str(u)),
  "signin.on": ([u]) => reactivateEmployeeSignIn(str(u)),
  "signin.passkeys_remove": ([u]) => removeDriverPasskeys(str(u)),
  "portal.signin_create": ([fd]) => createPortalSignIn(form(fd)),
  "portal.signin_reissue": ([u]) => reissuePortalSignIn(str(u)),
  "portal.signin_email": ([u]) => emailPortalSetup(str(u)),
  "portal.signin_off": ([u]) => turnOffPortalSignIn(str(u)),
  "portal.signin_on": ([u]) => turnOnPortalSignIn(str(u)),
  "portal.invite": ([fd]) => invitePortalCustomer(form(fd)),
  "portal.revoke": ([fd]) => revokePortalAccount(form(fd)),
  "accountant.invite": ([fd]) => inviteAccountant(form(fd)),
  "accountant.change": ([fd]) => changeAccountantAccess(form(fd)),
};
