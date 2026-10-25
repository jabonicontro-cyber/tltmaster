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
      <h2 id="ai">Optional AI features</h2>
      <p>
        Some features, such as Ask Taviron, use artificial intelligence. They are off unless a company chooses to turn them on. When a person uses one, the question
        and the operational data needed to answer it (for example order and load references, dates, quantities and statuses) are sent to OpenAI, our AI provider.
        Before anything is sent, names of people and customers, email addresses and phone numbers are removed or replaced, and internal record identifiers are never sent.
      </p>
      <ul>
        <li>OpenAI does not use this data to train its models.</li>
        <li>OpenAI may keep requests for up to 30 days to detect abuse, then deletes them, unless the law requires longer.</li>
        <li>Taviron does not store the questions or the answers. We keep only usage counts, to apply limits and track cost.</li>
        <li>AI answers are labelled as AI-generated, are checked against the company&apos;s records before they are shown, and never change anything on their own.</li>
      </ul>
      <h2>Service providers</h2>
      <p>We use these providers to run Taviron. Each receives only what it needs for its part of the service:</p>
      <ul>
        <li><strong>Vercel</strong> hosts the website and the app.</li>
        <li><strong>Supabase</strong> hosts the database, sign-in and stored files.</li>
        <li><strong>Resend</strong> delivers the emails Taviron sends, such as sign-in links and replies to forms.</li>
        <li><strong>HERE</strong> calculates truck routes and finds addresses when a company uses route planning. It receives map coordinates or the address being looked up, never names.</li>
        <li><strong>OpenAI</strong> answers questions in the optional AI features, as described above.</li>
      </ul>
      <h2>Where it is stored</h2>
      <p>Data is held with the providers above on their infrastructure. The locations and retention periods will be listed here before general availability.</p>
      <h2>Your choices</h2>
      <p>You can ask us to correct or delete what you sent through this website. Use the contact form and say what you would like changed.</p>
    </LegalPage>
  );
}
