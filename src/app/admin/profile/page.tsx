import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { PhotoUploader } from "@/components/people/photo-uploader";
import { ProfileForm } from "@/components/people/profile-form";
import { PLATFORM_ROLE_TITLE, getMyProfile, photoUrl } from "@/server/data/profile";
import { requirePlatformAdmin } from "@/server/platform";

export const metadata = { title: "My profile" };

/**
 * The platform team member's own profile: the same photo and display name used in the console, in every company they
 * open and in demos. Changing them never changes a permission; the platform role is granted only by an operator.
 */
export default async function AdminProfilePage() {
  const me = await requirePlatformAdmin();
  const profile = await getMyProfile();
  const name = profile?.displayName || profile?.fullName || me.email;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="My profile" description="How you appear in the platform console, in customer companies you open and in demos." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "My profile" }]} />
      {!profile ? (
        <Notice tone="warning" title="Profile editing is not available yet">This server&apos;s database has not been updated for profile photos and display names.</Notice>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Photo" description="JPEG, PNG or WebP. It is cropped to a square and made small before it is sent. Without a photo, your initials are shown." />
            <div className="px-4 pb-5 sm:px-5">
              <PhotoUploader name={name} src={photoUrl(profile.userId, profile.photoUpdatedAt)} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Your details" description="The name shown next to your photo." />
            <div className="px-4 pb-5 sm:px-5">
              <ProfileForm displayName={profile.displayName} phone={profile.phone} fullName={profile.fullName} />
            </div>
          </Card>
        </div>
      )}
      <Card className="mt-5">
        <CardHeader title="Platform access" description="Granted and revoked only by an operator with server access (scripts/platform-admin.mjs); it cannot be changed here." />
        <dl className="grid gap-x-6 gap-y-3 px-4 pb-5 text-sm sm:grid-cols-2 sm:px-5">
          <div><dt className="text-muted">Role</dt><dd className="font-medium">{PLATFORM_ROLE_TITLE}</dd></div>
          <div><dt className="text-muted">Sign-in</dt><dd className="font-medium break-all">{me.email}</dd></div>
        </dl>
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <Link href="/forgot-password" className={buttonClasses("secondary")}>Change password (sends a reset link)</Link>
        </div>
      </Card>
    </div>
  );
}
