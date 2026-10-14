import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";

export const metadata: Metadata = { title: "Privacy", description: "How Taviron handles information from this website and the app (draft)." };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice">
      <h2>This website</h2>
      <p>When you send the demo request or contact form, we store what you enter — name, email, and optionally company, phone, role, fleet size and message — so the Taviron team can reply and keep track of the conversation.</p>
      <ul>
        <li>We do not sell this information or use it for advertising.</li>
        <li>To limit abuse, we keep a one-way, keyed fingerprint of the network address a form came from — not the address itself — for a short time.</li>
        <li>This website sets no advertising or analytics cookies.</li>
      </ul>
      <h2>The app</h2>
      <p>
        Companies using Taviron enter their own operational records (customers, orders, loads, delivery tickets, trucks, drivers and users). Each company&apos;s records
        are separated from every other company&apos;s, and are used only to provide the service to that company. Sign-in cookies are used to keep you signed in;
        an early-access cookie remembers that a device was admitted.
      </p>
      <h2>Where it is stored</h2>
      <p>Data is held with our hosting and database providers on their infrastructure. Details of the providers, locations and retention will be listed here before general availability.</p>
      <h2>Your choices</h2>
      <p>You can ask us to correct or delete what you sent through this website. Use the contact form and say what you would like changed.</p>
    </LegalPage>
  );
}
