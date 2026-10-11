import type { Metadata } from "next";
import { LegalPage } from "@/components/site/legal";

export const metadata: Metadata = { title: "Terms", description: "Terms for using the Taviron website and early access (draft)." };

export default function TermsPage() {
  return (
    <LegalPage eyebrow="Legal" title="Terms of use">
      <h2>Early access</h2>
      <p>Taviron is in early access. Features may change, and some described as planned may not be built. Access to the app is by invitation and may be withdrawn.</p>
      <h2>Pricing</h2>
      <p>Pricing shown on this website is proposed and subject to confirmation. It is not an offer. Nothing is charged through this website, and no subscription starts from it. Commercial terms are set only in a written agreement signed by both parties.</p>
      <h2>Your data</h2>
      <p>Your company&apos;s records remain your company&apos;s. You are responsible for what your users enter, and for keeping sign-in details private.</p>
      <h2>Demo data</h2>
      <p>Everything shown in the demo company and in screenshots on this website is fictional. Any resemblance to real companies or people is coincidental.</p>
      <h2>No warranty during early access</h2>
      <p>During early access the service is provided as it is, while it is being developed. Keep your existing procedures in place while you evaluate it.</p>
    </LegalPage>
  );
}
