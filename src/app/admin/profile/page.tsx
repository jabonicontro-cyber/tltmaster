import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { PhotoUploader } from "@/components/people/photo-uploader";
import { ProfileForm } from "@/components/people/profile-form";
import { getMyProfile, photoUrl, staffRoleTitle } from "@/server/data/profile";
import { requirePlatformStaff } from "@/server/platform";
import { SecuritySection } from "@/components/security/security-section";

export const metadata = { title: "My profile" };

/**
 * The platform team member's own profile: the same photo and display name used in the console, in every company they
 * open and in demos. Changing them never changes a permission; team membership is given by an Admin (Administration).
 */
export default async function AdminProfilePage() {
  const me = await requirePlatformStaff();
  const profile = await getMyProfile();
  const name = profile?.displayName || profile?.fullName || me.email;
  return (
    <div className="max-w-3xl">
      <PageHeader title="My profile" description="How you appear in the platform console, in customer companies you open and in demos." crumbs={[{ label: me.level === "admin" ? "Launchpad" : "Company access", href: me.level === "admin" ? "/admin" : "/staff" }, { label: "My profile" }]} />
      {!profile ? (
        <Notice tone="warning" title="Profile editing is not available yet">This server&apos;s database has not been updated for profile photos and display names.</Notice>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Photo" description="JPEG, PNG or WebP. It is cropped to a square and made small before it is sent. Without a photo, your initials are shown." />
            <div className="px-5 pb-5 sm:px-6">
              <PhotoUploader name={name} src={photoUrl(profile.userId, profile.photoUpdatedAt)} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Your details" description="The name shown next to your photo." />
            <div className="px-5 pb-5 sm:px-6">
              <ProfileForm displayName={profile.displayName} phone={profile.phone} fullName={profile.fullName} />
            </div>
          </Card>
        </div>
      )}
      <SecuritySection />
      <Card className="mt-5">
        <CardHeader title="Platform access" description="Given and removed by a Taviron Admin under Administration, Taviron team (or by an operator with server access); it cannot be changed here." />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 pb-5 text-sm sm:grid-cols-2 sm:px-6">
          <div><dt className="text-muted">Role</dt><dd className="font-medium">{staffRoleTitle(me.level)}</dd></div>
          <div><dt className="text-muted">Sign-in</dt><dd className="font-medium break-all">{me.email}</dd></div>
        </dl>
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <Link href="/forgot-password" className={buttonClasses("secondary")}>Change password (sends a reset link)</Link>
        </div>
      </Card>
    </div>
  );
}
