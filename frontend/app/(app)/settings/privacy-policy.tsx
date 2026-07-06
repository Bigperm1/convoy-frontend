import React from "react";
import LegalPage from "../../../src/components/LegalPage";

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="—"
      intro="Convoy (“we”, “us”) built this app for driving together in a group. This policy explains what we collect, why, and the choices you have. Replace this placeholder with your finalized policy."
      sections={[
        { heading: "Information We Collect", body: "Account details (your email), your car profile, and location data while you use navigation and convoy features. [Placeholder — list your actual data categories.]" },
        { heading: "How We Use Location", body: "Your location powers the live convoy map, turn-by-turn navigation, and the CarPlay map. It is only shared inside communities you’ve joined — never with strangers outside your crew. [Placeholder.]" },
        { heading: "Sharing & Third Parties", body: "We do not sell your personal data. Describe any processors here (e.g. map/routing and push-notification providers). [Placeholder.]" },
        { heading: "Data Retention & Deletion", body: "How long we keep your data and how to request that your account and data be deleted. [Placeholder.]" },
        { heading: "Your Choices", body: "Control visibility with Avatar Live, and location access in iOS Settings → Convoy → Location. [Placeholder.]" },
        { heading: "Contact", body: "Questions about privacy? Email support@convoy.app. [Placeholder.]" },
      ]}
    />
  );
}
