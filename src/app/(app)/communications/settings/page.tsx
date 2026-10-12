import { AdminSearch, AlertSettingsList, CompanySettingsForm, PreferencesForm } from "@/components/communications/settings-forms";
import { CommunicationsTabs } from "@/components/communications/tabs";
import { CommunicationsUnavailable } from "@/components/communications/unavailable";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/auth";
import { loadAlertCounts, loadAlertSettings, loadPreferences, loadSettings } from "@/server/data/communications";

export const metadata = { title: "Communications settings" };

export default async function CommunicationsSettingsPage() {
  const access = await requireAccess();
  const admin = can(access, "comms.admin");
  const [prefs, settings, alerts, counts] = await Promise.all([
    loadPreferences(),
    admin ? loadSettings() : Promise.resolve(null),
    admin ? loadAlertSettings() : Promise.resolve(null),
    loadAlertCounts(),
  ]);
  if (!prefs) return <CommunicationsUnavailable title="Communications settings" />;
  return (
    <>
      <PageHeader title="Communications settings" description="Your notifications, and — for administrators — the company's rules. Taviron sends no email or text for Communications." />
      <CommunicationsTabs active="settings" counts={{ alerts: counts?.open, critical: counts?.critical }} />
      <div className="space-y-5">
        <Card>
          <CardHeader title="My notifications" />
          <CardBody><PreferencesForm initial={prefs} /></CardBody>
        </Card>
        {admin && settings && (
          <Card>
            <CardHeader title="Company rules" description="Changes are recorded in the audit log." />
            <CardBody><CompanySettingsForm initial={settings} /></CardBody>
          </Card>
        )}
        {admin && alerts && (
          <Card>
            <CardHeader title="Alert policies" description="Each alert type has a safety minimum priority that cannot be lowered. Changes are recorded in the audit log." />
            <AlertSettingsList rows={alerts} />
          </Card>
        )}
        {admin && (
          <Card>
            <CardHeader title="Administrative search" description="Searches every conversation in the company, including ones you are not in. Each search and its reason are recorded in the audit log." />
            <CardBody><AdminSearch /></CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
