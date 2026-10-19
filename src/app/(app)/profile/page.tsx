import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { PhotoUploader } from "@/components/people/photo-uploader";
import { ProfileForm } from "@/components/people/profile-form";
import { ROLE_LABELS } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { getMyProfile, photoUrl } from "@/server/data/profile";

export const metadata = { title: "My profile" };

/**
 * Self-service: every signed-in person can change their photo, the name they
 * are shown by and their phone. Employment details, company membership, role
 * and permissions are managed by the company (People → Sign-ins & roles) and only shown.
 */
export default async function ProfilePage() {
  const access = await requireAccess();
  const profile = await getMyProfile();
  const name = profile?.displayName || access.fullName || access.email;
  return (
    <div className="max-w-3xl">
      <PageHeader title="My profile" description="How you appear in Taviron. Your role and company access are managed by your company administrator." />
      {!profile ? (
        <Notice tone="warning" title="Profile editing is not available yet">
          This server&apos;s database has not been updated for profile photos and display names. Your account works as before.
        </Notice>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Photo" />
            <div className="px-4 pb-5 sm:px-5">
              <PhotoUploader name={name} src={photoUrl(profile.userId, profile.photoUpdatedAt)} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Your details" />
            <div className="px-4 pb-5 sm:px-5">
              <ProfileForm displayName={profile.displayName} phone={profile.phone} fullName={profile.fullName} />
            </div>
          </Card>
        </div>
      )}
      <Card className="mt-5">
        <CardHeader title="Managed by your company" description="Ask your company administrator to change these." />
        <dl className="grid gap-x-6 gap-y-3 px-4 pb-5 text-sm sm:grid-cols-2 sm:px-5">
          <div><dt className="text-muted">Full name on record</dt><dd className="font-medium">{access.fullName || "—"}</dd></div>
          <div><dt className="text-muted">Sign-in</dt><dd className="font-medium break-all">{access.email}</dd></div>
          <div><dt className="text-muted">Company</dt><dd className="font-medium">{access.companyName ?? "—"}</dd></div>
          <div><dt className="text-muted">Role</dt><dd className="font-medium">{access.role ? ROLE_LABELS[access.role] : "—"}</dd></div>
        </dl>
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <Link href="/forgot-password" className={buttonClasses("secondary")}>Change password (sends a reset link)</Link>
        </div>
      </Card>
    </div>
  );
}
